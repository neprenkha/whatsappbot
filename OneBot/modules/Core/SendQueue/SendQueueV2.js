// SendQueueV2.js
// - MUST register service "send" as a FUNCTION (not object)
// - MUST keep signature send(chatId, content, options)
// - Fixes: baseSend is not a function, chatId=[object Object]

const fs = require('fs');
const path = require('path');

function toInt(v, d) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : d;
}

function toStr(v, d) {
  const s = (v === undefined || v === null) ? '' : String(v);
  return s.trim() ? s : d;
}

function isPlainObject(x) {
  return x && typeof x === 'object' && !Array.isArray(x);
}

function normalizeChatId(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;

  if (isPlainObject(v)) {
    if (typeof v._serialized === 'string') return v._serialized;
    if (typeof v.id === 'string') return v.id;
    if (typeof v.chatId === 'string') return v.chatId;
  }
  return String(v);
}

function isLikelyMedia(content) {
  if (!content) return false;
  if (!isPlainObject(content)) return false;
  // whatsapp-web.js MessageMedia shape usually has mimetype/data/filename
  if ('mimetype' in content) return true;
  if ('data' in content && 'type' in content) return true;
  if ('filename' in content && 'data' in content) return true;
  return false;
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

module.exports = function init(meta) {
  const tag = 'SendQueueV2';

  const delayMs = toInt(meta.implConf?.delayMs, 250);
  const delayMediaMs = toInt(meta.implConf?.delayMediaMs, 1200);
  const maxQueue = toInt(meta.implConf?.maxQueue, 500);

  const dataDir = meta.paths?.dataDir || process.cwd();
  const stateDir = path.join(dataDir, 'SendQueue');
  const stateFile = path.join(stateDir, 'state.json');

  ensureDir(stateDir);

  let q = [];
  let processing = false;
  let sentCount = 0;
  let lastSendAt = 0;
  const recentSends = new Map(); // for deduplication

  function makeDedupeKey(chatId, content) {
    const cid = String(chatId || '').trim();
    let contentKey = '';
    if (typeof content === 'string') {
      contentKey = content.slice(0, 100); // first 100 chars
    } else if (isPlainObject(content) && content.mimetype) {
      // For media, use mimetype + size if available
      contentKey = `media:${content.mimetype}:${content.data ? content.data.length : 0}`;
    } else {
      contentKey = JSON.stringify(content).slice(0, 100);
    }
    return `${cid}:${contentKey}`;
  }

  function isDuplicate(chatId, content, dedupeMs = 3000) {
    const key = makeDedupeKey(chatId, content);
    const now = Date.now();
    
    // Clean old entries
    for (const [k, t] of recentSends.entries()) {
      if (now - t > dedupeMs * 2) recentSends.delete(k);
    }
    
    const lastSeen = recentSends.get(key);
    if (lastSeen && (now - lastSeen) < dedupeMs) {
      return true;
    }
    recentSends.set(key, now);
    return false;
  }

  function loadState() {
    try {
      if (!fs.existsSync(stateFile)) return;
      const raw = fs.readFileSync(stateFile, 'utf8');
      const st = JSON.parse(raw);
      if (Array.isArray(st.queue)) q = st.queue;
      sentCount = toInt(st.sentCount, 0);
      lastSendAt = toInt(st.lastSendAt, 0);
    } catch (e) {
      meta.log(tag, `state.load failed: ${e && e.message ? e.message : e}`);
    }
  }

  function saveState() {
    try {
      const st = {
        sentCount,
        lastSendAt,
        queue: q.slice(0, 50) // keep small snapshot only
      };
      fs.writeFileSync(stateFile, JSON.stringify(st, null, 2), 'utf8');
    } catch (_) {}
  }

  loadState();

  function pickDelay(content, options) {
    if (options && Number.isFinite(Number(options.delayMs))) {
      return Math.max(0, Number(options.delayMs));
    }
    if (isLikelyMedia(content)) return delayMediaMs;
    return delayMs;
  }

  async function pump() {
    if (processing) return;
    processing = true;

    try {
      while (q.length > 0) {
        const job = q.shift();

        const chatId = normalizeChatId(job.chatId);
        const content = job.content;
        const options = job.options || {};

        if (!chatId) {
          meta.log(tag, `drop job: empty chatId`);
          continue;
        }

        meta.log(tag, `processing chatId=${chatId} queueLen=${q.length}`);

        const waitMs = pickDelay(content, options);
        const now = Date.now();

        // basic pacing
        const sinceLast = now - lastSendAt;
        if (sinceLast < waitMs) {
          await new Promise(r => setTimeout(r, waitMs - sinceLast));
        }

        try {
          // transport.sendDirect(chatId, content, options)
          await meta.services.transport.sendDirect(chatId, content, options);
          sentCount += 1;
          lastSendAt = Date.now();
          meta.log(tag, `sent success chatId=${chatId} sentCount=${sentCount}`);
        } catch (e) {
          const errMsg = e && e.message ? e.message : e;
          meta.log(tag, `send error chatId=${chatId} err=${errMsg}`);
          // continue next job (do not freeze queue)
          lastSendAt = Date.now();
        }
      }
    } finally {
      processing = false;
      saveState();
    }
  }

  async function send(chatId, content, options) {
    const cid = normalizeChatId(chatId);
    if (!cid) {
      meta.log(tag, `drop: empty chatId after normalization`);
      return false;
    }

    // Check for duplicates
    if (isDuplicate(cid, content, 3000)) {
      meta.log(tag, `drop duplicate chatId=${cid} dedupeMs=3000`);
      return true; // return true to indicate it was handled (deduplicated)
    }

    if (q.length >= maxQueue) {
      meta.log(tag, `queue full drop chatId=${cid} len=${q.length}`);
      return false;
    }

    q.push({
      chatId: cid,
      content,
      options: options || {},
      at: Date.now()
    });

    meta.log(tag, `enqueued chatId=${cid} queueLen=${q.length}`);

    // async pump
    setTimeout(pump, 0);
    return true;
  }

  // IMPORTANT: register "send" as FUNCTION
  meta.registerService('send', send);
  meta.registerService('sendqueue.stats', () => ({
    queued: q.length,
    processing,
    sentCount,
    lastSendAt
  }));

  meta.log(tag, `ready delayMs=${delayMs} delayMediaMs=${delayMediaMs} maxQueue=${maxQueue} deduplication=enabled`);

  return { onMessage: async () => {}, onEvent: async () => {} };
};
