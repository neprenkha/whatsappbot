'use strict';

const fs = require('fs');
const path = require('path');

// REWRITTEN: standalone CV implementation with file-based journaling.

function toBool(v, d) {
  if (v === undefined || v === null || v === '') return d;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return d;
}

function toInt(v, d) {
  const n = parseInt(String(v === undefined || v === null ? '' : v), 10);
  return Number.isFinite(n) ? n : d;
}

function toStr(v, d) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return s || d;
}

function loadGlobalConf(meta, cfg, bugLog) {
  const rel = toStr(cfg.globalConfRel, '');
  if (!rel) {
    if (bugLog) meta.log('MessageJournalCV', 'global_conf_missing_key globalConfRel');
    return {};
  }
  try {
    const loaded = meta.loadConfRel(rel);
    return loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
  } catch (e) {
    if (bugLog) meta.log('MessageJournalCV', 'global_conf_load_failed err=' + String(e && e.message ? e.message : e));
    return {};
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch (e) {
    return '{"_error":"json_stringify_failed"}';
  }
}

function clip(v, maxLen) {
  const s = String(v === undefined || v === null ? '' : v);
  if (maxLen <= 0) return '';
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function resolveTimeService(meta) {
  return meta.getService('timezone');
}

function nowTs(meta) {
  const svc = resolveTimeService(meta);
  if (svc && typeof svc.now === 'function') {
    const n = svc.now();
    if (Number.isFinite(n)) return n;
  }
  return Date.now();
}

function nowIso(meta, ts) {
  const svc = resolveTimeService(meta);
  if (svc && typeof svc.isoNow === 'function' && ts === undefined) {
    const iso = svc.isoNow();
    if (iso) return String(iso);
  }
  return new Date(Number(ts)).toISOString();
}

module.exports.init = async function init(meta) {
  const cfg = meta && meta.implConf ? meta.implConf : {};

  const enabled = toBool(cfg.enabled, true);
  const moduleLog = toBool(cfg.moduleLog, true);
  const bugLog = toBool(cfg.bugLog, true);
  const detailLog = toBool(cfg.detailLog, false);
  const traceLog = toBool(cfg.traceLog, false);

  if (!enabled) {
    if (moduleLog) meta.log('MessageJournalCV', 'disabled');
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  const globalConf = loadGlobalConf(meta, cfg, bugLog);
  void globalConf;

  const dataDirRel = toStr(cfg.dataDirRel, 'MessageJournal');
  const includeMessages = toBool(cfg.includeMessages, true);
  const includeEvents = toBool(cfg.includeEvents, true);
  const maxTextLen = Math.max(1, toInt(cfg.maxTextLen, 600));

  const baseRoot = toStr(meta.dataRootBot, '');
  if (!baseRoot) {
    throw new Error('messagejournal.dataRootBot_missing');
  }

  const dataDir = path.join(baseRoot, dataDirRel);
  ensureDir(dataDir);

  let writeChain = Promise.resolve();

  function dateKeyFromTs(ts) {
    const d = new Date(ts);
    const y = String(d.getUTCFullYear());
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function appendRecord(record) {
    const line = safeJson(record) + '\n';
    const fp = path.join(dataDir, record.dateKey + '.jsonl');
    writeChain = writeChain.then(function runWrite() {
      return fs.promises.appendFile(fp, line, 'utf8');
    }).catch(function onWriteErr(e) {
      if (bugLog) meta.log('MessageJournalCV', 'append_failed err=' + String(e && e.message ? e.message : e));
    });
    return writeChain;
  }

  function senderFrom(ctx) {
    const s = ctx && ctx.sender ? ctx.sender : {};
    return {
      id: toStr(s.id, ''),
      phone: toStr(s.phone, ''),
      lid: toStr(s.lid, ''),
      name: toStr(s.name, '')
    };
  }

  async function onMessage(ctx) {
    if (!includeMessages) return;

    const ts = nowTs(meta);
    const rec = {
      v: 1,
      kind: 'message',
      ts: ts,
      iso: nowIso(meta, ts),
      dateKey: dateKeyFromTs(ts),
      chatId: toStr(ctx && ctx.chatId, ''),
      isGroup: !!(ctx && ctx.isGroup),
      sender: senderFrom(ctx),
      text: clip(ctx && ctx.text, maxTextLen)
    };

    await appendRecord(rec);

    if (traceLog) {
      meta.log('MessageJournalCV', 'write_message chatId=' + rec.chatId);
    }
  }

  async function onEvent(ctx) {
    if (!includeEvents) return;

    const ts = nowTs(meta);
    const rec = {
      v: 1,
      kind: 'event',
      ts: ts,
      iso: nowIso(meta, ts),
      dateKey: dateKeyFromTs(ts),
      event: toStr(ctx && ctx.event, 'unknown')
    };

    await appendRecord(rec);

    if (traceLog) {
      meta.log('MessageJournalCV', 'write_event name=' + rec.event);
    }
  }

  if (moduleLog || detailLog) {
    meta.log(
      'MessageJournalCV',
      'ready dataDir=' + dataDir +
        ' includeMessages=' + (includeMessages ? '1' : '0') +
        ' includeEvents=' + (includeEvents ? '1' : '0') +
        ' maxTextLen=' + String(maxTextLen)
    );
  }

  return {
    onMessage,
    onEvent
  };
};