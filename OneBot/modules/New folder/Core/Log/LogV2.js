'use strict';

/**
 * LogV2 (Core)
 * - Captures stdout/stderr into file under:
 *     X:\OneData\bots\ONEBOT\logs\
 * - Writes EVERY line with Malaysia time (configurable via implConf.timeZone)
 * - Optionally strips existing leading timestamps (UTC) from Kernel lines.
 *
 * IMPORTANT:
 * - No changes to Kernel/Connector/Start.cmd required.
 */

const fs = require('fs');
const path = require('path');

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (_) {} }
function toBool(v, defVal) {
  if (v === undefined || v === null || v === '') return defVal;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'on';
}
function safeStr(x) {
  if (typeof x === 'string') return x;
  try { return JSON.stringify(x); } catch (_) { return String(x); }
}

// ---- Timezone formatter (NO hardcode in code: read from conf) ----
function makeTzFormatter({ timeZone, locale }) {
  const tz = String(timeZone || '').trim() || 'Asia/Kuala_Lumpur';
  const loc = String(locale || '').trim() || 'en-GB'; // en-GB avoids "24:xx"
  const dtf = new Intl.DateTimeFormat(loc, {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });

  function parts(d) {
    const map = {};
    for (const p of dtf.formatToParts(d)) {
      if (p.type !== 'literal') map[p.type] = p.value;
    }
    return map;
  }

  function stamp(d) {
    const p = parts(d);
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}.${ms}`;
  }

  function yyyymmdd(d) {
    const p = parts(d);
    return `${p.year}${p.month}${p.day}`;
  }

  return { tz, loc, stamp, yyyymmdd };
}

// Remove leading timestamps like:
// 2025-12-23 16:20:35.044 [kernel] ...
// 2025-12-23 16:20:35 [kernel] ...
function stripLeadingTs(line) {
  return line.replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d{3})?\s+/, '');
}

// ---- File writer ----
function createLineWriter({ baseDir, fileMode, fileName, filePrefix, tzFmt, stripTs }) {
  ensureDir(baseDir);

  let stream = null;
  let currentKey = ''; // date key for daily
  const mode = String(fileMode || 'daily').trim().toLowerCase(); // daily | single

  function resolvePath(now) {
    if (mode === 'single') {
      const fn = String(fileName || 'log.txt').trim() || 'log.txt';
      return path.join(baseDir, fn);
    }
    // daily: logYYYYMMDD.txt (letters+numbers+dot only)
    const dateKey = tzFmt.yyyymmdd(now);
    const prefix = String(filePrefix || 'log').trim() || 'log';
    currentKey = dateKey;
    return path.join(baseDir, `${prefix}${dateKey}.txt`);
  }

  function open(now) {
    const p = resolvePath(now);
    stream = fs.createWriteStream(p, { flags: 'a' });
    return p;
  }

  function close() {
    try { if (stream) stream.end(); } catch (_) {}
    stream = null;
  }

  // Ensure stream exists and in correct daily file
  function ensure(now) {
    if (!stream) return open(now);
    if (mode !== 'daily') return null;
    const dateKey = tzFmt.yyyymmdd(now);
    if (dateKey !== currentKey) {
      close();
      return open(now);
    }
    return null;
  }

  function write(rawLine) {
    const now = new Date();
    ensure(now);

    let line = String(rawLine || '').replace(/\r?\n$/, '');
    if (!line.trim()) return;

    if (stripTs) line = stripLeadingTs(line);

    const out = `${tzFmt.stamp(now)} ${line}\n`;
    try { stream.write(out); } catch (_) {}
  }

  function stop() { close(); }

  return { write, stop };
}

// ---- Hook stdout/stderr line-by-line ----
function hookStdStreams(writer) {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);

  let bufOut = '';
  let bufErr = '';

  function handleChunk(chunk, which) {
    const s = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (which === 'out') bufOut += s;
    else bufErr += s;

    const buf = which === 'out' ? bufOut : bufErr;
    const lines = buf.split(/\r?\n/);

    // keep last partial
    const tail = lines.pop() ?? '';
    if (which === 'out') bufOut = tail;
    else bufErr = tail;

    for (const ln of lines) writer.write(ln);
  }

  process.stdout.write = (chunk, encoding, cb) => {
    try { handleChunk(chunk, 'out'); } catch (_) {}
    return origOut(chunk, encoding, cb);
  };

  process.stderr.write = (chunk, encoding, cb) => {
    try { handleChunk(chunk, 'err'); } catch (_) {}
    return origErr(chunk, encoding, cb);
  };

  return () => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  };
}

// ---- Main ----
function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

module.exports.init = async function init(meta) {
  const conf = meta.implConf || {};

  const logEvents = String(conf.logEvents || '1').trim() !== '0';
  const logMessages = String(conf.logMessages || '1').trim() !== '0';

  const fileEnabled = toBool(conf.fileEnabled, true);
  const logsDirName = String(conf.logsDir || 'logs').trim() || 'logs';

  const fileMode = String(conf.fileMode || 'daily').trim(); // daily | single
  const fileName = String(conf.fileName || 'log.txt').trim() || 'log.txt'; // used when single
  const filePrefix = String(conf.filePrefix || 'log').trim() || 'log'; // used when daily: logYYYYMMDD.txt

  const stripTs = toBool(conf.stripExistingTimestamp, true);

  const timeZone = String(conf.timeZone || 'Asia/Kuala_Lumpur').trim() || 'Asia/Kuala_Lumpur';
  const timeLocale = String(conf.timeLocale || 'en-GB').trim() || 'en-GB';

  const baseDir = path.join(meta.dataRoot, 'bots', meta.botName, logsDirName);
  ensureDir(baseDir);

  const tzFmt = makeTzFormatter({ timeZone, locale: timeLocale });

  let writer = null;
  let unhook = null;

  if (fileEnabled) {
    writer = createLineWriter({
      baseDir,
      fileMode,
      fileName,
      filePrefix,
      tzFmt,
      stripTs,
    });
    unhook = hookStdStreams(writer);

    // Write a boot marker (will be re-timestamped to MY time in file)
    console.log(`[LogV2] fileEnabled=1 dir=${baseDir} mode=${fileMode} tz=${tzFmt.tz}`);
  } else {
    console.log('[LogV2] fileEnabled=0');
  }

  process.on('exit', () => {
    try { console.log('[process] exit'); } catch (_) {}
    try { if (unhook) unhook(); } catch (_) {}
    try { if (writer) writer.stop(); } catch (_) {}
  });

  // Return a valid instance so Kernel counts module as loaded (avoid module.init_failed)
  return {
    onEvent: async (ctx) => {
      if (!logEvents) return;
      console.log(`[event] keys=${Object.keys(ctx.data || {}).join(',')}`);
    },
    onMessage: async (ctx) => {
      if (!logMessages) return;
      const info = pick(ctx, ['chatId', 'isGroup', 'text']);
      const sender = pick(ctx.sender || {}, ['id', 'phone', 'lid', 'name']);
      console.log(`[msg] chatId=${info.chatId} isGroup=${info.isGroup} sender=${safeStr(sender)} text=${safeStr(info.text)}`);
    },
  };
};
