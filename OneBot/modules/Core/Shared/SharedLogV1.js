'use strict';

/*
  SharedLogV1
  - Standard logger wrapper for ONEBOT modules
  - Primary sink: meta.log(tag, message) (Log module pipeline)
  - Fallback sink: console.log (only if meta.log missing)
  - Supports debug/trace gating via opts.debugEnabled / opts.traceEnabled
*/

function safeStr(v) {
  return String(v == null ? '' : v);
}

function nowIso() {
  try { return new Date().toISOString(); } catch (_) { return ''; }
}

function makeSink(meta) {
  if (meta && typeof meta.log === 'function') {
    return (tag, msg) => meta.log(tag, msg);
  }

  // Optional: if in future you expose a log service, we can detect it here.
  // For now, fallback to console.
  return (tag, msg) => {
    // Keep ASCII only
    const line = `${nowIso()} [${tag}] ${msg}`;
    console.log(line);
  };
}

function create(meta, tag, opts) {
  const o = opts || {};
  const sink = makeSink(meta);

  const debugEnabled = !!o.debugEnabled;
  const traceEnabled = !!o.traceEnabled;

  function emit(level, msg) {
    const t = safeStr(tag).trim() || 'Log';
    const m = safeStr(msg).trim();
    if (!m) return;
    // Put level inside message so Log module stays the single output format owner
    sink(t, `${level} ${m}`);
  }

  return {
    info: (msg) => emit('info', msg),
    warn: (msg) => emit('warn', msg),
    error: (msg) => emit('error', msg),
    debug: (msg) => { if (debugEnabled) emit('debug', msg); },
    trace: (msg) => { if (traceEnabled) emit('trace', msg); },

    // helper: build a child logger that prefixes messages
    child: (prefix) => {
      const p = safeStr(prefix).trim();
      return {
        info: (msg) => emit('info', p ? `${p} ${safeStr(msg)}` : msg),
        warn: (msg) => emit('warn', p ? `${p} ${safeStr(msg)}` : msg),
        error: (msg) => emit('error', p ? `${p} ${safeStr(msg)}` : msg),
        debug: (msg) => { if (debugEnabled) emit('debug', p ? `${p} ${safeStr(msg)}` : msg); },
        trace: (msg) => { if (traceEnabled) emit('trace', p ? `${p} ${safeStr(msg)}` : msg); },
      };
    }
  };
}

module.exports = { create };
