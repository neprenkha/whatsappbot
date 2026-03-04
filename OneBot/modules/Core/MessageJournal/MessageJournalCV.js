'use strict';

const fs = require('fs');
const path = require('path');

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return !!fallback;
  const text = String(value).trim().toLowerCase();
  if (text === '1' || text === 'true' || text === 'yes' || text === 'on') return true;
  if (text === '0' || text === 'false' || text === 'no' || text === 'off') return false;
  return !!fallback;
}

function toText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function toNowMs(timezone) {
  if (timezone && typeof timezone.now === 'function') {
    const n = Number(timezone.now());
    if (Number.isFinite(n)) return n;
  }
  return Date.now();
}

function toDateKey(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function getRaw(ctx) {
  return ctx && ctx.raw && typeof ctx.raw === 'object' ? ctx.raw : {};
}

function getMsgId(ctx) {
  const raw = getRaw(ctx);
  const idObj = raw.id && typeof raw.id === 'object' ? raw.id : null;
  const v1 = toText(ctx && ctx.msgId);
  if (v1) return v1;
  if (idObj) {
    const v2 = toText(idObj._serialized);
    if (v2) return v2;
    const v3 = toText(idObj.id);
    if (v3) return v3;
  }
  const v4 = toText(raw.id);
  if (v4) return v4;
  return toText(ctx && ctx.id);
}

function getType(ctx) {
  const raw = getRaw(ctx);
  const v1 = toText(ctx && ctx.type).toLowerCase();
  if (v1) return v1;
  const v2 = toText(raw.type).toLowerCase();
  if (v2) return v2;
  return toText(ctx && ctx.event).toLowerCase();
}

function getChatId(ctx) {
  const raw = getRaw(ctx);
  const v1 = toText(ctx && ctx.chatId);
  if (v1) return v1;
  const v2 = toText(raw.from);
  if (v2) return v2;
  return toText(raw.to);
}

function getFromMe(ctx) {
  const raw = getRaw(ctx);
  if (raw.fromMe === true) return '1';
  if (raw.fromMe === false) return '0';
  if (ctx && ctx.fromMe === true) return '1';
  if (ctx && ctx.fromMe === false) return '0';
  return '';
}

function getTicketId(ctx) {
  const raw = getRaw(ctx);
  const v1 = toText(ctx && ctx.ticketId);
  if (v1) return v1;
  return toText(raw.ticketId);
}

function resolveDirFromEvent(ctx) {
  const v1 = toText(ctx && ctx.dir).toLowerCase();
  if (v1 === 'in' || v1 === 'out') return v1;
  const v2 = toText(ctx && ctx.direction).toLowerCase();
  if (v2 === 'in' || v2 === 'out') return v2;
  const name = toText(ctx && ctx.event).toLowerCase();
  if (name.indexOf('out') >= 0) return 'out';
  if (name.indexOf('in') >= 0) return 'in';
  return '';
}

module.exports = {
  init: async (meta) => {
    const cfg = meta && meta.implConf ? meta.implConf : {};
    const log = meta && typeof meta.log === 'function' ? meta.log : () => {};
    const tag = 'MessageJournalCV';

    const enabled = toBool(cfg.enabled, true);
    const moduleLog = toBool(cfg.moduleLog, true);
    const bugLog = toBool(cfg.bugLog, true);
    const detailLog = toBool(cfg.detailLog, false);
    const traceLog = toBool(cfg.traceLog, false);

    if (!enabled) {
      if (moduleLog) log(tag, 'disabled enabled=0');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const dataDirRel = toText(cfg.dataDirRel) || 'MessageJournal';
    const filePrefix = toText(cfg.filePrefix) || 'journal';
    const includeMessages = toBool(cfg.includeMessages, true);
    const includeEvents = toBool(cfg.includeEvents, true);

    const baseRoot = toText(meta && meta.dataRootBot);
    if (!baseRoot) {
      if (bugLog) log(tag, 'disabled missing_dataRootBot');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const dataDir = path.join(baseRoot, dataDirRel);
    ensureDir(dataDir);

    const timezone = meta && typeof meta.getService === 'function' ? meta.getService('timezone') : null;
    let writeChain = Promise.resolve();

    function appendLine(record) {
      const nowMs = toNowMs(timezone);
      const dateKey = toDateKey(nowMs);
      const fileName = filePrefix + '-' + dateKey + '.jsonl';
      const filePath = path.join(dataDir, fileName);
      const line = JSON.stringify(record) + '\n';
      writeChain = writeChain.then(async () => {
        await fs.promises.appendFile(filePath, line, 'utf8');
      }).catch((err) => {
        if (bugLog) log(tag, 'append_failed err=' + String(err && err.message ? err.message : err));
      });
      return writeChain;
    }

    async function writeJournal(dir, ctx) {
      const nowMs = toNowMs(timezone);
      const rec = {
        ts: nowMs,
        dir: dir,
        chatId: getChatId(ctx),
        msgId: getMsgId(ctx),
        type: getType(ctx),
      };

      const fromMe = getFromMe(ctx);
      if (fromMe !== '') rec.fromMe = fromMe;

      const ticketId = getTicketId(ctx);
      if (ticketId) rec.ticketId = ticketId;

      await appendLine(rec);

      if (traceLog) {
        log(tag, 'write dir=' + dir + ' chatId=' + rec.chatId + ' type=' + rec.type);
      }
    }

    async function onMessage(ctx) {
      if (!includeMessages) return;
      await writeJournal('in', ctx);
      if (detailLog) {
        log(tag, 'in chatId=' + getChatId(ctx) + ' type=' + getType(ctx));
      }
    }

    async function onEvent(ctx) {
      if (!includeEvents) return;
      const dir = resolveDirFromEvent(ctx);
      if (!dir) return;
      await writeJournal(dir, ctx);
      if (detailLog) {
        log(tag, dir + ' chatId=' + getChatId(ctx) + ' type=' + getType(ctx));
      }
    }

    if (moduleLog) {
      log(tag, 'ready enabled=1 dataDirRel=' + dataDirRel + ' filePrefix=' + filePrefix + ' includeMessages=' + (includeMessages ? '1' : '0') + ' includeEvents=' + (includeEvents ? '1' : '0'));
    }

    return { onMessage, onEvent };
  },
};