'use strict';

const fs = require('fs');
const path = require('path');

function toBool(v, defVal) {
  if (v === undefined || v === null || v === '') return defVal;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return defVal;
}

function toInt(v, defVal) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : defVal;
}

function trunc(s, maxLen) {
  const t = (s === undefined || s === null) ? '' : String(s);
  if (maxLen <= 0) return '';
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen - 1) + '…';
}

function safeJson(obj) {
  try { return JSON.stringify(obj); } catch (e) { return '{"_error":"json_stringify_failed"}'; }
}

function fmtDateKey(now, timeZone) {
  // en-CA => YYYY-MM-DD (very convenient)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function fmtLocal(now, timeZone) {
  // 24h local timestamp for readability
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const map = {};
  parts.forEach((p) => { map[p.type] = p.value; });
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

function ensureDirSync(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function filePathForDateKey(baseDir, dateKey) {
  return path.join(baseDir, `${dateKey}.jsonl`);
}

module.exports.init = async (meta, conf) => {
  const timeZone = conf.timeZone || 'Asia/Kuala_Lumpur';
  const subdir = conf.subdir || 'MessageJournal';
  const maxTextLen = toInt(conf.maxTextLen, 600);
  const includeEvents = toBool(conf.includeEvents, true);
  const includeMessages = toBool(conf.includeMessages, true);

  const dataDir = path.join(meta.dataRoot, 'bots', meta.botName, 'data', subdir);
  ensureDirSync(dataDir);

  // Simple sequential write chain to keep order
  let writeChain = Promise.resolve();

  function appendLine(line) {
    const now = new Date();
    const dateKey = fmtDateKey(now, timeZone);
    const fp = filePathForDateKey(dataDir, dateKey);

    writeChain = writeChain.then(() => fs.promises.appendFile(fp, `${line}\n`, 'utf8'))
      .catch((err) => {
        meta.log('MessageJournalV1', `append failed: ${err && err.message ? err.message : String(err)}`);
      });

    return writeChain;
  }

  function normalizeSender(ctx) {
    const s = ctx && ctx.sender ? ctx.sender : {};
    return {
      id: s.id || '',
      phone: s.phone || '',
      lid: s.lid || '',
      name: s.name || '',
    };
  }

  function appendInboundMessage(ctx) {
    const now = new Date();
    const rec = {
      v: 1,
      dir: 'in',
      ts: Date.now(),
      dt: fmtLocal(now, timeZone),
      chatId: ctx.chatId || '',
      isGroup: !!ctx.isGroup,
      sender: normalizeSender(ctx),
      text: trunc(ctx.text || '', maxTextLen),
    };
    return appendLine(safeJson(rec));
  }

  function appendEvent(ctx) {
    const now = new Date();
    const rec = {
      v: 1,
      dir: 'evt',
      ts: Date.now(),
      dt: fmtLocal(now, timeZone),
      event: ctx && ctx.event ? String(ctx.event) : 'unknown',
    };
    return appendLine(safeJson(rec));
  }

  // Expose a small service so later Features (CRM/Commission/Ticketing) can reuse
  const service = {
    getDir: () => dataDir,
    getTimeZone: () => timeZone,
    getDateKeyNow: () => fmtDateKey(new Date(), timeZone),
    getFilePathForDate: (dateKey) => filePathForDateKey(dataDir, dateKey),
    appendRaw: (obj) => appendLine(safeJson(obj)),
  };
  meta.registerService('journal', service);
  meta.registerService('messagejournal', service);

  meta.log('MessageJournalV1', `ready dir=${dataDir} tz=${timeZone} includeMessages=${includeMessages ? 1 : 0} includeEvents=${includeEvents ? 1 : 0}`);

  return {
    onMessage: async (ctx) => {
      if (!includeMessages) return;
      await appendInboundMessage(ctx);
    },
    onEvent: async (ctx) => {
      if (!includeEvents) return;
      await appendEvent(ctx);
    },
  };
};
