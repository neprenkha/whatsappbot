'use strict';

const fs = require('fs');
const path = require('path');

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

function asciiSafe(input) {
  const s = String(input === undefined || input === null ? '' : input);
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    out += (c >= 32 && c <= 126) ? s[i] : '?';
  }
  return out;
}

function clamp(input, maxLen) {
  const s = String(input === undefined || input === null ? '' : input);
  if (maxLen <= 0) return '';
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen);
}

function resolveLogDir(meta, cfgDir) {
  const configured = toStr(cfgDir, '');
  if (configured) return configured;
  return path.join(String(meta.dataRoot || ''), 'bots', String(meta.botName || ''), 'logs');
}

function loadGlobalConf(meta, cfg, bugLog) {
  const rel = toStr(cfg.globalConfRel, '');
  if (!rel) {
    if (bugLog && meta && typeof meta.log === 'function') {
      meta.log('LogCV', 'global_conf_missing_key globalConfRel');
    }
    return {};
  }
  if (!meta || typeof meta.loadConfRel !== 'function') {
    if (bugLog && meta && typeof meta.log === 'function') {
      meta.log('LogCV', 'global_conf_loader_unavailable');
    }
    return {};
  }
  try {
    const loaded = meta.loadConfRel(rel);
    const conf = loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
    return conf;
  } catch (e) {
    if (bugLog && meta && typeof meta.log === 'function') {
      meta.log('LogCV', 'global_conf_load_failed err=' + String(e && e.message ? e.message : e));
    }
    return {};
  }
}

function formatTs(meta, fallbackState) {
  const now = new Date();
  const tzSvc = meta && typeof meta.getService === 'function' ? meta.getService('timezone') : null;
  if (tzSvc && typeof tzSvc.format === 'function') {
    try {
      const raw = String(tzSvc.format(now) || '');
      if (raw) return asciiSafe(raw);
    } catch (e) {
      if (!fallbackState.tzErrorLogged && fallbackState.bugLog && meta && typeof meta.log === 'function') {
        fallbackState.tzErrorLogged = true;
        meta.log('LogCV', 'timezone_format_failed err=' + String(e && e.message ? e.message : e));
      }
    }
  } else if (!fallbackState.tzMissingLogged && fallbackState.bugLog && meta && typeof meta.log === 'function') {
    fallbackState.tzMissingLogged = true;
    meta.log('LogCV', 'timezone_service_missing using_iso_fallback');
  }
  return now.toISOString().replace('T', ' ').replace('Z', '');
}

module.exports.init = async function init(meta) {
  const cfg = meta && meta.implConf ? meta.implConf : {};

  const enabled = toBool(cfg.enabled, true);
  const moduleLog = toBool(cfg.moduleLog, true);
  const bugLog = toBool(cfg.bugLog, true);
  const detailLog = toBool(cfg.detailLog, false);
  const traceLog = toBool(cfg.traceLog, false);

  if (!enabled) {
    if (moduleLog && meta && typeof meta.log === 'function') meta.log('LogCV', 'disabled');
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  const globalConf = loadGlobalConf(meta, cfg, bugLog);
  void globalConf;

  const fileEnabled = toBool(cfg.fileEnabled, 1);
  const logMessages = toBool(cfg.logMessages, 1);
  const logEvents = toBool(cfg.logEvents, 1);
  const asciiOnly = toBool(cfg.asciiOnly, 1);
  const messagePreviewLen = toInt(cfg.messagePreviewLen, 200);
  const metaMaxLen = toInt(cfg.metaMaxLen, 600);
  const dir = resolveLogDir(meta || {}, cfg.dir);

  const fallbackState = {
    bugLog,
    tzMissingLogged: false,
    tzErrorLogged: false,
  };

  if (fileEnabled) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      if (bugLog && meta && typeof meta.log === 'function') {
        meta.log('LogCV', 'mkdir_failed err=' + String(e && e.message ? e.message : e));
      }
    }
  }

  function writeLine(line) {
    if (!fileEnabled) return;
    const dateKey = new Date().toISOString().slice(0, 10);
    const fp = path.join(dir, 'onebot-' + dateKey + '.log');
    try {
      fs.appendFileSync(fp, line + '\n', 'utf8');
    } catch (e) {
      if (bugLog && meta && typeof meta.log === 'function') {
        meta.log('LogCV', 'append_failed err=' + String(e && e.message ? e.message : e));
      }
    }
  }

  function logLine(kind, text, metaObj) {
    const msg = asciiOnly ? asciiSafe(text) : String(text);
    let metaText = '';
    if (metaObj !== undefined && metaObj !== null) {
      const raw = JSON.stringify(metaObj);
      metaText = ' meta=' + (asciiOnly ? asciiSafe(clamp(raw, metaMaxLen)) : clamp(raw, metaMaxLen));
    }
    const line = formatTs(meta, fallbackState) + ' [' + kind + '] ' + msg + metaText;
    writeLine(line);
  }

  if (moduleLog && meta && typeof meta.log === 'function') {
    meta.log('LogCV', 'ready fileEnabled=' + (fileEnabled ? '1' : '0') + ' dir=' + dir + ' detailLog=' + (detailLog ? '1' : '0') + ' traceLog=' + (traceLog ? '1' : '0'));
  }

  return {
    onMessage: async (ctx) => {
      if (!logMessages || !ctx) return;
      const sender = ctx.sender || {};
      const base = {
        chatId: String(ctx.chatId || ''),
        isGroup: !!ctx.isGroup,
        senderId: String(sender.id || ''),
        senderLid: String(sender.lid || ''),
      };
      const preview = clamp(String(ctx.text || ''), messagePreviewLen);
      logLine('message', 'text=' + preview, detailLog ? base : null);
    },
    onEvent: async (ctx) => {
      if (!logEvents || !ctx) return;
      const kind = String((ctx.data && ctx.data.type) || ctx.event || 'event');
      if (traceLog) {
        logLine('event', 'type=' + kind, ctx.data || null);
      } else {
        logLine('event', 'type=' + kind, null);
      }
    },
  };
};