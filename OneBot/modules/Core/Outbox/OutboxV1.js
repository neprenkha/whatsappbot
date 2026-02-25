// OneBot/modules/Core/Outbox/OutboxV1.js
/**
 * OutboxV1.js
 * Persistent outbox queue for delayed outbound sending.
 *
 * Goals:
 * - Must not crash the bot on missing config/services.
 * - Must not allow one window-blocked item to block the whole queue.
 * - ASCII-only.
 */
'use strict';

function toBool(v, dflt) {
  if (v === undefined || v === null || v === '') return !!dflt;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return !!dflt;
}

function toInt(v, dflt) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : dflt;
}

function splitCsv(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseJsonStoreSpec(spec) {
  const s = String(spec || '').trim();
  if (!s.toLowerCase().startsWith('jsonstore:')) return null;

  const rest = s.substring('jsonstore:'.length).trim();
  const parts = rest.split('/').filter(Boolean);
  if (parts.length < 2) return null;

  const ns = parts[0].trim();
  const file = parts.slice(1).join('/').trim();
  const key = file.replace(/\.json$/i, '');

  return { ns, key };
}

function safeJson(x) {
  try { return JSON.stringify(x); } catch (e) { return String(x); }
}

function confGet(cfg, key, dflt) {
  if (!cfg) return dflt;
  if (typeof cfg.get === 'function') return cfg.get(key, dflt);
  if (Object.prototype.hasOwnProperty.call(cfg, key)) return cfg[key];
  return dflt;
}

module.exports = function init(meta) {
  const tag = 'OutboxV1';
  const log = meta.log || function () {};
  const cfg = meta.implConf || null;

  const enabled = toBool(confGet(cfg, 'enabled', '0'), false);
  if (!enabled) {
    log(tag, 'disabled enabled=0');
    return {};
  }

  const moduleLog = toBool(confGet(cfg, 'moduleLog', '1'), true);
  const bugLog = toBool(confGet(cfg, 'bugLog', '1'), true);
  const detailLog = toBool(confGet(cfg, 'detailLog', '0'), false);
  const traceLog = toBool(confGet(cfg, 'traceLog', '0'), false);

  const serviceName = String(confGet(cfg, 'serviceName', 'outbox') || 'outbox').trim();
  const storeSpec = String(confGet(cfg, 'store', '') || '').trim();
  const tickMs = Math.max(250, toInt(confGet(cfg, 'tickMs', 2000), 2000));
  const batchMax = Math.max(1, toInt(confGet(cfg, 'batchMax', 5), 5));
  const sendPrefer = splitCsv(confGet(cfg, 'sendPrefer', '') || '');
  const rateLimitLogDebounceMs = Math.max(1000, toInt(confGet(cfg, 'rateLimitLogDebounceMs', 30000), 30000));
  const rateLimitLogTrackerMaxSize = Math.max(100, toInt(confGet(cfg, 'rateLimitLogTrackerMaxSize', 1000), 1000));

  const storeInfo = parseJsonStoreSpec(storeSpec);
  const jsonstore = meta.getService('jsonstore');

  if (!storeInfo) {
    if (bugLog) log(tag, 'missing.storeSpec ' + safeJson({ store: storeSpec }));
    return {};
  }
  if (!jsonstore || typeof jsonstore.open !== 'function') {
    if (bugLog) log(tag, 'missing.jsonstore');
  }

  let q = [];
  let lastId = 0;
  let running = false;
  let timer = null;
  let ready = false;

  const warnMap = new Map();

  function shouldWarn(chatId) {
    const now = Date.now();
    const key = String(chatId || '').trim();
    const prev = warnMap.get(key);
    if (!prev || (now - prev) >= rateLimitLogDebounceMs) {
      warnMap.set(key, now);
      if (warnMap.size > rateLimitLogTrackerMaxSize) {
        const firstKey = warnMap.keys().next().value;
        warnMap.delete(firstKey);
      }
      return true;
    }
    return false;
  }

  function pickSender() {
    for (const name of sendPrefer) {
      const s = meta.getService(name);
      if (typeof s === 'function') return s;
    }
    return null;
  }

  async function loadState() {
    if (!jsonstore || typeof jsonstore.open !== 'function') {
      ready = true;
      return;
    }
    const store = jsonstore.open(storeInfo.ns);
    const st = await store.get(storeInfo.key);
    if (st && Array.isArray(st.q)) q = st.q;
    if (st && typeof st.lastId === 'number') lastId = st.lastId;
    ready = true;
  }

  async function saveState() {
    if (!jsonstore || typeof jsonstore.open !== 'function') return;
    const store = jsonstore.open(storeInfo.ns);
    await store.set(storeInfo.key, { q, lastId });
  }

  function normalizeItem(item) {
    const it = item && typeof item === 'object' ? item : {};
    if (!Number.isFinite(Number(it.id))) it.id = ++lastId;
    if (!Number.isFinite(Number(it.at))) it.at = Date.now();
    if (!Number.isFinite(Number(it.notBeforeAt))) it.notBeforeAt = 0;
    if (!Number.isFinite(Number(it.retryCount))) it.retryCount = 0;
    if (!it.opts || typeof it.opts !== 'object') it.opts = {};
    if (it.chatId !== undefined && it.chatId !== null) it.chatId = String(it.chatId).trim();
    return it;
  }

  async function enqueue(chatId, text, opts) {
    const item = normalizeItem({
      id: ++lastId,
      chatId: String(chatId || '').trim(),
      text,
      opts: opts || {},
      at: Date.now(),
      notBeforeAt: 0,
      retryCount: 0,
    });
    q.push(item);
    await saveState();
    return item.id;
  }

  function deferWindowBlocked(item, waitMs) {
    const wait = Math.max(1000, Number(waitMs || 0));
    item.notBeforeAt = Date.now() + wait;
    item.retryCount = Number(item.retryCount || 0) + 1;
    q.push(item);
  }

  async function tick() {
    if (!ready) return;
    if (running) return;
    running = true;

    try {
      const sender = pickSender();
      if (!sender) return;

      let sent = 0;
      let changed = false;

      // Scan budget prevents infinite rotate loops.
      let scanBudget = q.length;

      while (q.length > 0 && sent < batchMax && scanBudget > 0) {
        const raw = q.shift();
        const item = normalizeItem(raw);
        const now = Date.now();
        const notBeforeAt = Number(item.notBeforeAt || 0);

        if (notBeforeAt > now) {
          q.push(item);
          changed = true;
          scanBudget--;
          continue;
        }

        try {
          await sender(item.chatId, item.text, item.opts || {});
          sent++;
          changed = true;

          // After a success, allow a fresh scan of remaining queue.
          scanBudget = q.length;

          if (traceLog) {
            log(tag, 'trace sent chatId=' + String(item.chatId || '') + ' retryCount=' + Number(item.retryCount || 0));
          }
        } catch (e) {
          const code = e && e.code ? String(e.code) : '';
          const reason = e && e.reason ? String(e.reason) : '';
          const waitMs = e && Number.isFinite(Number(e.waitMs)) ? Number(e.waitMs) : 0;

          if (code === 'ratelimit.block' && reason === 'window' && waitMs > 0) {
            deferWindowBlocked(item, waitMs);
            changed = true;
            scanBudget--;

            if (moduleLog && shouldWarn(item.chatId)) {
              log(
                tag,
                'warn deferred.window chatId=' + String(item.chatId || '') +
                ' waitMs=' + waitMs +
                ' queue=' + q.length
              );
            }
            continue;
          }

          // Non-window failure: keep at head and stop this tick.
          q.unshift(item);
          changed = true;
          if (bugLog) {
            const msg = e && e.message ? e.message : String(e);
            log(tag, 'send.failed chatId=' + String(item.chatId || '') + ' err=' + msg);
          }
          break;
        }
      }

      if (changed) await saveState();
      if ((detailLog || traceLog) && sent > 0) {
        log(tag, 'tick.sent count=' + sent + ' remaining=' + q.length);
      }
    } finally {
      running = false;
    }
  }

  function startTimer() {
    if (timer) clearInterval(timer);
    timer = setInterval(async () => {
      try { await tick(); } catch (_) {}
    }, tickMs);
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  const svc = {
    send: async (chatId, text, opts) => await enqueue(chatId, text, opts),
    size: () => q.length,
    flush: async () => await tick(),
    stop: () => stopTimer(),
  };

  meta.registerService(serviceName, svc);

  (async () => {
    try {
      await loadState();
      startTimer();
      if (moduleLog) {
        log(
          tag,
          'ready enabled=1 service=' + serviceName +
          ' store=' + storeSpec +
          ' tickMs=' + tickMs +
          ' batchMax=' + batchMax +
          ' sendPrefer=' + sendPrefer.join(',')
        );
      }
    } catch (e) {
      ready = true;
      startTimer();
      if (bugLog) {
        const msg = e && e.message ? e.message : String(e);
        log(tag, 'ready.with.error err=' + msg);
      }
    }
  })();

  return {};
};
