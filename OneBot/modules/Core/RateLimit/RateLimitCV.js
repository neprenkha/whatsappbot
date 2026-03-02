'use strict';

const fs = require('fs');
const path = require('path');

function toBool(v, dflt) {
  if (v === undefined || v === null || v === '') return !!dflt;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return !!dflt;
}

function toInt(v, dflt) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : dflt;
}

function toNum(v, dflt) {
  const n = Number(String(v));
  return Number.isFinite(n) ? n : dflt;
}

function toStr(v, dflt) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return s || dflt;
}

function splitCsv(v) {
  return String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
}

function readJson(filePath, dflt) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return dflt;
  }
}

function writeJsonAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = path.join(dir, '.' + path.basename(filePath) + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function parseHm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function parseWindow(s) {
  const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const a = parseHm(m[1]);
  const b = parseHm(m[2]);
  if (a === null || b === null) return null;
  return { startMin: a, endMin: b };
}

function inWindow(minNow, w) {
  if (!w) return false;
  if (w.endMin > w.startMin) return minNow >= w.startMin && minNow < w.endMin;
  if (w.endMin < w.startMin) return minNow >= w.startMin || minNow < w.endMin;
  return false;
}

function nextWindowWaitMs(minNow, windows) {
  let best = null;
  for (const w of windows) {
    let delta;
    if (w.endMin > w.startMin) {
      if (minNow < w.startMin) delta = w.startMin - minNow;
      else delta = (1440 - minNow) + w.startMin;
    } else if (w.endMin < w.startMin) {
      if (minNow >= w.startMin || minNow < w.endMin) delta = 0;
      else delta = w.startMin - minNow;
    } else {
      continue;
    }
    if (delta === 0) return 0;
    if (best === null || delta < best) best = delta;
  }
  return best === null ? 0 : best * 60000;
}

function getLocalParts(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date())) p[part.type] = part.value;
  const dateKey = (p.year || '1970') + '-' + (p.month || '01') + '-' + (p.day || '01');
  const minNow = (parseInt(p.hour || '0', 10) * 60) + parseInt(p.minute || '0', 10);
  return { dateKey, minNow };
}

function nowMs() {
  return Date.now();
}

function isManualBypass(options) {
  const opts = options && typeof options === 'object' ? options : {};
  return toBool(opts.manualReply, false) || toBool(opts.bypassRateLimit, false);
}

function isAutoMode(options) {
  const opts = options && typeof options === 'object' ? options : {};
  if (opts.isAuto === undefined || opts.isAuto === null || String(opts.isAuto).trim() === '') return false;
  return String(opts.isAuto) === '1';
}

module.exports = {
  init: async (meta) => {
    const conf = meta.implConf || {};
    const log = typeof meta.log === 'function' ? meta.log : () => {};
    const tag = 'RateLimitCV';

    const enabled = toBool(conf.enabled, true);

    const enforceWindows = toBool(conf.enforceWindows, false);
    const windowBypassGroupChats = toBool(conf.windowBypassGroupChats, false);
    const windowBypassChatIds = new Set(splitCsv(conf.windowBypassChatIds));

    const dailyMaxGlobal = Math.max(0, toInt(conf.dailyMaxGlobal, 500));
    const dailyMaxPerChat = Math.max(0, toInt(conf.dailyMaxPerChat, 80));
    const minGapMsPerChat = Math.max(0, toInt(conf.minGapMsPerChat, 1500));

    const burstWindowMs = Math.max(0, toInt(conf.burstWindowMs, 60000));
    const burstMaxGlobal = Math.max(0, toInt(conf.burstMaxGlobal, 60));
    const burstMaxPerChat = Math.max(0, toInt(conf.burstMaxPerChat, 10));

    const idleMs = Math.max(0, toInt(conf.idleMs, 0));

    const dataDirRel = toStr(conf.dataDirRel, 'RateLimit');
    const stateFileName = toStr(conf.stateFileName, 'state.json');
    const persistDebounceMs = Math.max(0, toInt(conf.persistDebounceMs, 400));
    const maxChatEntries = Math.max(100, toInt(conf.maxChatEntries, 5000));

    const dataDirAbs = path.isAbsolute(dataDirRel) ? dataDirRel : path.join(meta.dataRootBot, dataDirRel);
    const stateFileAbs = path.join(dataDirAbs, stateFileName);

    const tzSvc = meta.getService('timezone');
    const timeZone = (tzSvc && typeof tzSvc.getTimeZone === 'function')
      ? toStr(tzSvc.getTimeZone(), '')
      : toStr(tzSvc && tzSvc.timeZone, '');

    const windows = [];
    for (const [k, v] of Object.entries(conf)) {
      const key = String(k || '').toLowerCase();
      if (key === 'window' || key.indexOf('window.') === 0) {
        const w = parseWindow(v);
        if (w) windows.push(w);
      }
    }

    let state = readJson(stateFileAbs, null);
    if (!state || typeof state !== 'object') {
      state = { version: 1, dateKey: '', global: { sent: 0, burst: [] }, chats: {} };
    }
    if (!state.global || typeof state.global !== 'object') state.global = { sent: 0, burst: [] };
    if (!state.chats || typeof state.chats !== 'object') state.chats = {};

    let dirty = false;
    let persistTimer = null;

    function persistNow() {
      if (!dirty) return;
      dirty = false;
      writeJsonAtomic(stateFileAbs, state);
    }

    function persistSoon() {
      dirty = true;
      if (persistDebounceMs <= 0) return persistNow();
      if (persistTimer) return;
      persistTimer = setTimeout(() => {
        persistTimer = null;
        persistNow();
      }, persistDebounceMs);
    }

    function resetDay(dateKey) {
      if (state.dateKey === dateKey) return;
      state.dateKey = dateKey;
      state.global = { sent: 0, burst: [] };
      state.chats = {};
      persistSoon();
    }

    function cleanBurst(list, n) {
      const src = Array.isArray(list) ? list : [];
      if (burstWindowMs <= 0) return src.slice();
      const cutoff = n - burstWindowMs;
      return src.filter((t) => Number(t || 0) > cutoff);
    }

    function getChat(chatId) {
      const id = String(chatId || '').trim();
      if (!id) return null;
      if (!state.chats[id]) state.chats[id] = { sent: 0, lastSentAtMs: 0, burst: [], lastSeenAtMs: 0 };
      return state.chats[id];
    }

    function pruneChatsIfNeeded() {
      const keys = Object.keys(state.chats || {});
      if (keys.length <= maxChatEntries) return;
      const list = keys.map((k) => ({
        k,
        t: Number((state.chats[k] || {}).lastSeenAtMs || 0),
      })).sort((a, b) => a.t - b.t);
      const removeCount = keys.length - maxChatEntries;
      for (let i = 0; i < removeCount; i += 1) {
        delete state.chats[list[i].k];
      }
      persistSoon();
    }

    function checkWindow(minNow, chatId, options) {
      if (!enforceWindows) return { ok: true, reason: 'ok', waitMs: 0 };
      if (!windows.length) return { ok: true, reason: 'ok', waitMs: 0 };

      const opts = options && typeof options === 'object' ? options : {};
      if (toBool(opts.allowOutsideWindow, false) || toBool(opts.bypassWindow, false)) {
        return { ok: true, reason: 'ok', waitMs: 0 };
      }

      const id = String(chatId || '').trim();
      if (id && windowBypassChatIds.has(id)) return { ok: true, reason: 'ok', waitMs: 0 };
      if (windowBypassGroupChats && id.endsWith('@g.us')) return { ok: true, reason: 'ok', waitMs: 0 };

      for (const w of windows) {
        if (inWindow(minNow, w)) return { ok: true, reason: 'ok', waitMs: 0 };
      }

      return { ok: false, reason: 'window', waitMs: nextWindowWaitMs(minNow, windows) };
    }

    const rl = {
      version: 1,

      check({ chatId, weight = 1, options } = {}) {
        if (!enabled) return { ok: true, reason: 'disabled', waitMs: 0 };

        const id = String(chatId || '').trim();
        if (!id) return { ok: false, reason: 'missing.chatId', waitMs: 0 };

        const w = Math.max(1, toNum(weight, 1));
        const opts = options && typeof options === 'object' ? options : {};

        if (isManualBypass(opts)) return { ok: true, reason: 'manual', waitMs: 0, weight: w };
        if (!isAutoMode(opts)) return { ok: true, reason: 'non_auto', waitMs: 0, weight: w };

        const n = nowMs();
        const local = getLocalParts(timeZone);
        resetDay(local.dateKey);
        pruneChatsIfNeeded();

        const chat = getChat(id);
        chat.lastSeenAtMs = n;

        if (idleMs > 0) {
          const lastInboundAtMs = Number(opts.lastInboundAtMs || 0);
          if (Number.isFinite(lastInboundAtMs) && lastInboundAtMs > 0) {
            const delta = n - lastInboundAtMs;
            if (delta >= 0 && delta < idleMs) {
              return { ok: false, reason: 'active_chat', waitMs: idleMs - delta };
            }
          }
        }

        const a = checkWindow(local.minNow, id, opts);
        if (!a.ok) return a;

        if (minGapMsPerChat > 0) {
          const last = Number(chat.lastSentAtMs || 0);
          const diff = n - last;
          if (last > 0 && diff < minGapMsPerChat) {
            return { ok: false, reason: 'gap', waitMs: minGapMsPerChat - diff };
          }
        }

        if (dailyMaxGlobal > 0 && Number(state.global.sent || 0) >= dailyMaxGlobal) {
          return { ok: false, reason: 'daily.global', waitMs: 0 };
        }

        if (dailyMaxPerChat > 0 && Number(chat.sent || 0) >= dailyMaxPerChat) {
          return { ok: false, reason: 'daily.chat', waitMs: 0 };
        }

        if (burstWindowMs > 0) {
          if (burstMaxGlobal > 0) {
            state.global.burst = cleanBurst(state.global.burst, n);
            if (state.global.burst.length >= burstMaxGlobal) return { ok: false, reason: 'burst.global', waitMs: 0 };
          }
          if (burstMaxPerChat > 0) {
            chat.burst = cleanBurst(chat.burst, n);
            if (chat.burst.length >= burstMaxPerChat) return { ok: false, reason: 'burst.chat', waitMs: 0 };
          }
        }

        return { ok: true, reason: 'ok', waitMs: 0, weight: w };
      },

      commit({ chatId, weight = 1, options } = {}) {
        if (!enabled) return true;

        const id = String(chatId || '').trim();
        if (!id) return false;

        const opts = options && typeof options === 'object' ? options : {};
        if (isManualBypass(opts)) return true;
        if (!isAutoMode(opts)) return true;

        const w = Math.max(1, toNum(weight, 1));
        const n = nowMs();
        const local = getLocalParts(timeZone);
        resetDay(local.dateKey);
        pruneChatsIfNeeded();

        const chat = getChat(id);
        chat.lastSeenAtMs = n;
        chat.lastSentAtMs = n;
        chat.sent = Number(chat.sent || 0) + w;

        state.global.sent = Number(state.global.sent || 0) + w;

        if (burstWindowMs > 0) {
          state.global.burst = cleanBurst(state.global.burst, n);
          chat.burst = cleanBurst(chat.burst, n);
          state.global.burst.push(n);
          chat.burst.push(n);
        }

        persistSoon();
        return true;
      },

      snapshot() {
        const local = getLocalParts(timeZone);
        resetDay(local.dateKey);
        return {
          enabled,
          dateKey: local.dateKey,
          minNow: local.minNow,
          windows: windows.map((w) => ({ startMin: w.startMin, endMin: w.endMin })),
          globalSent: Number(state.global.sent || 0),
          chats: Object.keys(state.chats || {}).length,
        };
      },

      flush() {
        persistNow();
      },
    };

    meta.registerService('ratelimit', rl);

    const local = getLocalParts(timeZone);
    resetDay(local.dateKey);

    log(tag, 'ready enabled=' + (enabled ? 1 : 0) + ' windows=' + windows.length + ' state=' + stateFileAbs);
    return { onEvent: async () => {}, onMessage: async () => {} };
  },
};