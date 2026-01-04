'use strict';

/**
 * RateLimitV1 (Core)
 * Single responsibility:
 * - Decide if an outgoing message is allowed NOW (windows, daily caps, gaps, burst)
 * - Record/commit sends into a persisted state file
 *
 * NO send logic, NO queue logic, NO fallback logic.
 */

const fs = require('fs');
const path = require('path');

function toInt(v, defVal) {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : defVal;
}
function toNum(v, defVal) {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : defVal;
}
function toBool(v, defVal) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return defVal;
  return !(s === '0' || s === 'false' || s === 'no' || s === 'off');
}
function toStr(v, defVal) {
  const s = String(v ?? '').trim();
  return s ? s : defVal;
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}
function safeReadText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}
function safeJsonParse(txt, defVal) {
  try { return JSON.parse(txt); } catch { return defVal; }
}
function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}
function nowMs() { return Date.now(); }

function parseHm(s) {
  const t = String(s || '').trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (hh < 0 || hh > 23) return null;
  if (mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function parseWindow(val) {
  const s = String(val || '').trim();
  const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(s);
  if (!m) return null;
  const a = parseHm(m[1]);
  const b = parseHm(m[2]);
  if (a === null || b === null) return null;
  return { startMin: a, endMin: b };
}

function isWithinWindow(minNow, w) {
  if (!w) return false;
  // normal
  if (w.endMin > w.startMin) return (minNow >= w.startMin && minNow < w.endMin);
  // cross-midnight (e.g. 22:00-02:00)
  if (w.endMin < w.startMin) return (minNow >= w.startMin || minNow < w.endMin);
  // same start/end => closed
  return false;
}

function nextWindowStartDelta(minNow, windows) {
  if (!Array.isArray(windows) || windows.length === 0) return 0;

  let best = null; // minutes delta
  for (const w of windows) {
    if (!w) continue;
    let delta;
    if (w.endMin > w.startMin) {
      if (minNow < w.startMin) delta = w.startMin - minNow;
      else delta = (1440 - minNow) + w.startMin;
    } else if (w.endMin < w.startMin) {
      // cross-midnight: if we're before endMin, we're inside already; else next start is startMin today
      if (minNow < w.endMin) delta = 0;
      else if (minNow < w.startMin) delta = w.startMin - minNow;
      else delta = 0; // already inside (>= startMin)
    } else {
      continue;
    }
    if (delta === 0) return 0;
    if (best === null || delta < best) best = delta;
  }
  return best === null ? 0 : best;
}

function getTimeZoneName(meta, implConf) {
  const tzOverride = toStr(implConf.timeZone, '');
  if (tzOverride) return tzOverride;

  const tzSvc = meta.getService('tz') || meta.getService('timezone');
  if (tzSvc) {
    if (typeof tzSvc.getTimeZone === 'function') {
      const z = String(tzSvc.getTimeZone() || '').trim();
      if (z) return z;
    }
    if (typeof tzSvc.timeZone === 'string' && tzSvc.timeZone.trim()) return tzSvc.timeZone.trim();
    if (typeof tzSvc.tz === 'string' && tzSvc.tz.trim()) return tzSvc.tz.trim();
  }
  return ''; // use system
}

function getLocalParts(timeZone) {
  const d = new Date();
  const opts = {
    timeZone: timeZone || undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  };
  const fmt = new Intl.DateTimeFormat('en-GB', opts);
  const parts = fmt.formatToParts(d);
  const map = {};
  for (const p of parts) map[p.type] = p.value;

  const yyyy = map.year || '1970';
  const mm = map.month || '01';
  const dd = map.day || '01';
  const hh = map.hour || '00';
  const mi = map.minute || '00';

  const dateKey = `${yyyy}-${mm}-${dd}`;
  const minNow = (parseInt(hh, 10) * 60) + parseInt(mi, 10);
  return { dateKey, minNow };
}

module.exports.init = async function init(meta) {
  const enabled = toBool(meta.implConf.enabled, true);

  const enforceWindows = toBool(meta.implConf.enforceWindows, true);

  const dailyMaxGlobal = Math.max(0, toInt(meta.implConf.dailyMaxGlobal, 0));
  const dailyMaxPerChat = Math.max(0, toInt(meta.implConf.dailyMaxPerChat, 0));

  const minGapMsPerChat = Math.max(0, toInt(meta.implConf.minGapMsPerChat, 0));

  const burstWindowMs = Math.max(0, toInt(meta.implConf.burstWindowMs, 60000));
  const burstMaxGlobal = Math.max(0, toInt(meta.implConf.burstMaxGlobal, 0));
  const burstMaxPerChat = Math.max(0, toInt(meta.implConf.burstMaxPerChat, 0));

  const dataDirRel = toStr(meta.implConf.dataDirRel, 'RateLimit');
  const stateFileName = toStr(meta.implConf.stateFileName, 'state.json');
  const persistDebounceMs = Math.max(0, toInt(meta.implConf.persistDebounceMs, 400));

  const maxChatEntries = Math.max(100, toInt(meta.implConf.maxChatEntries, 5000));

  const dataDirAbs = path.isAbsolute(dataDirRel) ? dataDirRel : path.join(meta.dataRootBot, dataDirRel);
  const stateFileAbs = path.join(dataDirAbs, stateFileName);

  let dirty = false;
  let persistTimer = null;

  function log(msg) {
    meta.log('RateLimitV1', msg);
  }

  function persistSoon() {
    if (!dirty) dirty = true;
    if (persistDebounceMs <= 0) return persistNow();
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow();
    }, persistDebounceMs);
  }

  function persistNow() {
    if (!dirty) return;
    dirty = false;
    atomicWriteJson(stateFileAbs, state);
  }

  function loadState() {
    ensureDir(dataDirAbs);
    const raw = safeReadText(stateFileAbs);
    const obj = safeJsonParse(raw, null);
    if (obj && typeof obj === 'object') return obj;
    return null;
  }

  function readWindows(confObj) {
    const arr = [];
    for (const [k, v] of Object.entries(confObj || {})) {
      const key = String(k || '').trim().toLowerCase();
      if (key === 'window' || key.startsWith('window.')) {
        const w = parseWindow(v);
        if (w) arr.push(w);
      }
      if (key.startsWith('windows.')) {
        const w = parseWindow(v);
        if (w) arr.push(w);
      }
    }
    return arr;
  }

  const windows = readWindows(meta.implConf);

  let state = loadState() || {
    version: 1,
    dateKey: '',
    global: { sent: 0, burst: [] },
    chats: {},
  };

  function resetIfNewDay(localDateKey) {
    if (state.dateKey !== localDateKey) {
      state.dateKey = localDateKey;
      state.global = { sent: 0, burst: [] };
      state.chats = {};
      dirty = true;
      persistSoon();
      log(`day.reset dateKey=${localDateKey}`);
    }
  }

  function pruneChatsIfNeeded() {
    const keys = Object.keys(state.chats || {});
    if (keys.length <= maxChatEntries) return;

    const list = keys.map((k) => {
      const it = state.chats[k] || {};
      return { k, lastSeenAtMs: Number(it.lastSeenAtMs || 0) };
    }).sort((a, b) => a.lastSeenAtMs - b.lastSeenAtMs);

    const removeCount = Math.max(1, keys.length - maxChatEntries);
    for (let i = 0; i < removeCount; i++) {
      delete state.chats[list[i].k];
    }
    dirty = true;
    persistSoon();
    log(`chats.prune removed=${removeCount} max=${maxChatEntries}`);
  }

  function cleanBurst(list, n, windowMs) {
    const cutoff = n - windowMs;
    const out = Array.isArray(list) ? list.filter((t) => Number(t || 0) > cutoff) : [];
    return out;
  }

  function getChat(chatId) {
    const id = String(chatId || '').trim();
    if (!id) return null;
    if (!state.chats[id]) state.chats[id] = { sent: 0, lastSentAtMs: 0, burst: [], lastSeenAtMs: 0 };
    return state.chats[id];
  }

  function checkWindow(minNow) {
    if (!enforceWindows) return { ok: true };
    if (!windows.length) return { ok: true };

    for (const w of windows) {
      if (isWithinWindow(minNow, w)) return { ok: true };
    }

    const deltaMin = nextWindowStartDelta(minNow, windows);
    const waitMs = Math.max(0, deltaMin * 60 * 1000);
    return { ok: false, reason: 'window', waitMs };
  }

  function checkGap(n, chat) {
    if (minGapMsPerChat <= 0) return { ok: true };
    const last = Number(chat.lastSentAtMs || 0);
    if (!last) return { ok: true };
    const diff = n - last;
    if (diff >= minGapMsPerChat) return { ok: true };
    return { ok: false, reason: 'gap', waitMs: (minGapMsPerChat - diff) };
  }

  function checkDaily(localDateKey, chat) {
    if (dailyMaxGlobal > 0 && Number(state.global.sent || 0) >= dailyMaxGlobal) {
      return { ok: false, reason: 'daily.global', waitMs: 0 };
    }
    if (dailyMaxPerChat > 0 && Number(chat.sent || 0) >= dailyMaxPerChat) {
      return { ok: false, reason: 'daily.chat', waitMs: 0 };
    }
    return { ok: true };
  }

  function checkBurst(n, chat) {
    if (burstWindowMs <= 0) return { ok: true };

    if (burstMaxGlobal > 0) {
      state.global.burst = cleanBurst(state.global.burst, n, burstWindowMs);
      if (state.global.burst.length >= burstMaxGlobal) return { ok: false, reason: 'burst.global', waitMs: 0 };
    }

    if (burstMaxPerChat > 0) {
      chat.burst = cleanBurst(chat.burst, n, burstWindowMs);
      if (chat.burst.length >= burstMaxPerChat) return { ok: false, reason: 'burst.chat', waitMs: 0 };
    }

    return { ok: true };
  }

  function computeLocal() {
    const tzName = getTimeZoneName(meta, meta.implConf);
    return getLocalParts(tzName);
  }

  const rlSvc = {
    version: 1,

    /**
     * check({chatId, weight})
     * returns { ok, reason, waitMs }
     */
    check({ chatId, weight = 1 } = {}) {
      if (!enabled) return { ok: true, reason: 'disabled', waitMs: 0 };

      const id = String(chatId || '').trim();
      if (!id) return { ok: false, reason: 'missing.chatId', waitMs: 0 };

      const w = Math.max(1, toNum(weight, 1));

      const n = nowMs();
      const { dateKey, minNow } = computeLocal();
      resetIfNewDay(dateKey);

      pruneChatsIfNeeded();

      const chat = getChat(id);
      chat.lastSeenAtMs = n;

      // windows
      const a = checkWindow(minNow);
      if (!a.ok) return a;

      // gap
      const b = checkGap(n, chat);
      if (!b.ok) return b;

      // daily
      const c = checkDaily(dateKey, chat);
      if (!c.ok) return c;

      // burst
      const d = checkBurst(n, chat);
      if (!d.ok) return d;

      // allowed
      return { ok: true, reason: 'ok', waitMs: 0, weight: w };
    },

    /**
     * commit({chatId, weight})
     * increments counters. call ONLY after a successful send
     */
    commit({ chatId, weight = 1 } = {}) {
      if (!enabled) return true;

      const id = String(chatId || '').trim();
      if (!id) return false;

      const w = Math.max(1, toNum(weight, 1));
      const n = nowMs();

      const { dateKey } = computeLocal();
      resetIfNewDay(dateKey);

      pruneChatsIfNeeded();

      const chat = getChat(id);
      chat.lastSeenAtMs = n;

      state.global.sent = Number(state.global.sent || 0) + w;
      chat.sent = Number(chat.sent || 0) + w;

      chat.lastSentAtMs = n;

      if (burstWindowMs > 0) {
        if (!Array.isArray(state.global.burst)) state.global.burst = [];
        if (!Array.isArray(chat.burst)) chat.burst = [];

        state.global.burst = cleanBurst(state.global.burst, n, burstWindowMs);
        chat.burst = cleanBurst(chat.burst, n, burstWindowMs);

        state.global.burst.push(n);
        chat.burst.push(n);
      }

      dirty = true;
      persistSoon();
      return true;
    },

    snapshot() {
      const { dateKey, minNow } = computeLocal();
      resetIfNewDay(dateKey);
      return {
        enabled,
        dateKey,
        minNow,
        windows: windows.map((w) => ({ ...w })),
        globalSent: Number(state.global.sent || 0),
        chats: Object.keys(state.chats || {}).length,
      };
    },

    flush() { persistNow(); },
  };

  meta.registerService('ratelimit', rlSvc);
  meta.registerService('rl', rlSvc);

  // init day
  const { dateKey } = computeLocal();
  resetIfNewDay(dateKey);

  log(`ready enabled=${enabled ? 1 : 0} windows=${windows.length} state=${stateFileAbs}`);
  return { onEvent: async () => {}, onMessage: async () => {} };
};
