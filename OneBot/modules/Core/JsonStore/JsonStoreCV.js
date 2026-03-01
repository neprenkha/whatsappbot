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

function toStr(v, d) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return s || d;
}

function toInt(v, d) {
  const n = parseInt(String(v === undefined || v === null ? '' : v), 10);
  return Number.isFinite(n) ? n : d;
}

function sanitizeSegment(name, fallback) {
  const raw = toStr(name, fallback);
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe || fallback;
}

function loadGlobalConf(meta, cfg, bugLog) {
  const rel = toStr(cfg.globalConfRel, '');
  if (!rel) {
    if (bugLog && meta && typeof meta.log === 'function') {
      meta.log('JsonStoreCV', 'global_conf_missing_key globalConfRel');
    }
    return {};
  }
  if (!meta || typeof meta.loadConfRel !== 'function') {
    if (bugLog && meta && typeof meta.log === 'function') {
      meta.log('JsonStoreCV', 'global_conf_loader_unavailable');
    }
    return {};
  }
  try {
    const loaded = meta.loadConfRel(rel);
    const conf = loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
    return conf;
  } catch (e) {
    if (bugLog && meta && typeof meta.log === 'function') {
      meta.log('JsonStoreCV', 'global_conf_load_failed err=' + String(e && e.message ? e.message : e));
    }
    return {};
  }
}

function safeReadJson(absPath, fallbackObj) {
  try {
    const txt = fs.readFileSync(absPath, 'utf8');
    const parsed = JSON.parse(txt);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) {}
  return fallbackObj;
}

function safeWriteJson(absPath, obj) {
  const txt = JSON.stringify(obj, null, 2);
  fs.writeFileSync(absPath, txt, 'utf8');
}

module.exports.init = async function init(meta) {
  const cfg = meta && meta.implConf ? meta.implConf : {};

  const enabled = toBool(cfg.enabled, true);
  const moduleLog = toBool(cfg.moduleLog, true);
  const bugLog = toBool(cfg.bugLog, true);
  const detailLog = toBool(cfg.detailLog, false);
  const traceLog = toBool(cfg.traceLog, false);

  if (!enabled) {
    if (moduleLog && meta && typeof meta.log === 'function') meta.log('JsonStoreCV', 'disabled');
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  const globalConf = loadGlobalConf(meta, cfg, bugLog);

  const baseDirRel = toStr(cfg.baseDirRel, toStr(globalConf.jsonStoreBaseDirRel, 'JsonStore'));
  const defaultNamespace = sanitizeSegment(toStr(cfg.namespace, 'core'), 'core');
  const flushDelayMs = Math.max(0, toInt(cfg.flushDelayMs, 0));

  const rootDir = path.join(String(meta.dataRootBot || ''), baseDirRel);
  try {
    fs.mkdirSync(rootDir, { recursive: true });
  } catch (e) {
    if (bugLog && meta && typeof meta.log === 'function') {
      meta.log('JsonStoreCV', 'mkdir_failed err=' + String(e && e.message ? e.message : e));
    }
  }

  const pendingTimers = new Map();

  function nsDir(nsInput) {
    const ns = sanitizeSegment(nsInput, defaultNamespace);
    return path.join(rootDir, ns);
  }

  function keyPath(nsInput, keyInput) {
    const nsAbs = nsDir(nsInput);
    const key = sanitizeSegment(keyInput, 'state');
    return path.join(nsAbs, key + '.json');
  }

  function ensureNs(nsInput) {
    const abs = nsDir(nsInput);
    fs.mkdirSync(abs, { recursive: true });
    return abs;
  }

  function scheduleWrite(absPath, value, logTag) {
    const run = () => {
      pendingTimers.delete(absPath);
      try {
        safeWriteJson(absPath, value);
      } catch (e) {
        if (bugLog && meta && typeof meta.log === 'function') {
          meta.log(logTag, 'write_failed file=' + absPath + ' err=' + String(e && e.message ? e.message : e));
        }
      }
    };
    if (flushDelayMs <= 0) {
      run();
      return;
    }
    const old = pendingTimers.get(absPath);
    if (old) clearTimeout(old);
    const t = setTimeout(run, flushDelayMs);
    pendingTimers.set(absPath, t);
  }

  function createNamespace(nsInput) {
    const ns = sanitizeSegment(nsInput, defaultNamespace);
    ensureNs(ns);

    return {
      async get(key, fallbackValue) {
        const abs = keyPath(ns, key);
        const fallback = fallbackValue === undefined ? {} : fallbackValue;
        return safeReadJson(abs, fallback);
      },

      async set(key, value) {
        const abs = keyPath(ns, key);
        ensureNs(ns);
        scheduleWrite(abs, value, 'JsonStoreCV');
        return true;
      },

      async del(key) {
        const abs = keyPath(ns, key);
        try {
          fs.unlinkSync(abs);
          return true;
        } catch (_) {
          return false;
        }
      },

      async has(key) {
        const abs = keyPath(ns, key);
        try {
          fs.accessSync(abs, fs.constants.F_OK);
          return true;
        } catch (_) {
          return false;
        }
      },
    };
  }

  const service = {
    open: (nsInput) => createNamespace(nsInput),
    ns: (nsInput) => createNamespace(nsInput),
    rootDir,
  };

  if (meta && typeof meta.registerService === 'function') {
    meta.registerService('jsonstore', service);
  }

  if (moduleLog && meta && typeof meta.log === 'function') {
    meta.log('JsonStoreCV', 'ready rootDir=' + rootDir + ' namespace=' + defaultNamespace + ' flushDelayMs=' + String(flushDelayMs));
  }

  if (detailLog && traceLog && meta && typeof meta.log === 'function') {
    meta.log('JsonStoreCV', 'detail_and_trace_enabled=1');
  }

  return { onMessage: async () => {}, onEvent: async () => {} };
};