'use strict';

/*
  ModuleLoaderV1 (CORE, VERSIONED)
  - Loads modules by reading per-module .conf files:
      X:\OneData\bots\<BOTNAME>\config\modules\Core\*.conf
      X:\OneData\bots\<BOTNAME>\config\modules\Features\*.conf
  - Each module conf points to its Hub + Hub conf (not logic)
*/

const fs = require('fs');
const path = require('path');

function safeReadText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

function parseKV(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (!k) continue;
    out[k] = v;
  }
  return out;
}

function isTrue(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function resolveMaybeAbsolute(baseRoot, maybePath) {
  if (!maybePath) return '';
  if (path.isAbsolute(maybePath)) return maybePath;
  return path.join(baseRoot, maybePath);
}

function listConfFiles(dirPath) {
  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    return items
      .filter(d => d.isFile() && d.name.toLowerCase().endsWith('.conf'))
      .map(d => path.join(dirPath, d.name));
  } catch {
    return [];
  }
}

function loadModuleEntry(confPath) {
  const raw = parseKV(safeReadText(confPath));
  const id = String(raw.id || '').trim();
  const file = String(raw.file || '').trim();
  if (!id || !file) return null;

  return {
    id,
    enabled: isTrue(raw.enabled ?? '1'),
    priority: Number(raw.priority ?? 0) || 0,
    file,
    config: String(raw.config || '').trim(), // hub conf path (relative to bot config root)
    raw,
    confPath
  };
}

module.exports = function ModuleLoaderV1(meta, services) {
  const kernel = services.kernel;
  const cfg = meta?.config || {};

  const skipIds = new Set(
    String(cfg.skipIds || 'ModuleLoader')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  );

  const loader = {
    moduleId: meta?.moduleId || 'ModuleLoader',
    priority: Number(meta?.priority ?? 9999) || 9999,
    _booted: false,
    _loaded: [],

    async init() {
      if (loader._booted) return;
      loader._booted = true;

      const botConfigRoot = path.join(kernel.dataRoot, 'bots', kernel.botName, 'config');
      const coreDir = path.join(botConfigRoot, 'modules', 'Core');
      const featDir = path.join(botConfigRoot, 'modules', 'Features');

      ensureDir(coreDir);
      ensureDir(featDir);

      const coreFiles = listConfFiles(coreDir);
      const featFiles = listConfFiles(featDir);

      const entries = [...coreFiles, ...featFiles]
        .map(loadModuleEntry)
        .filter(Boolean)
        .filter(m => m.enabled)
        .filter(m => !skipIds.has(m.id));

      entries.sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return String(a.id).localeCompare(String(b.id));
      });

      const loaded = [];

      for (const m of entries) {
        const hubJsAbs = resolveMaybeAbsolute(kernel.codeRoot, m.file);

        const hubConfAbs = m.config
          ? resolveMaybeAbsolute(botConfigRoot, m.config)
          : '';

        const hubConfKV = hubConfAbs ? parseKV(safeReadText(hubConfAbs)) : {};

        try {
          const exported = require(hubJsAbs);

          const inst = (typeof exported === 'function')
            ? exported(
                {
                  moduleId: m.id,
                  priority: m.priority,
                  raw: m.raw,
                  config: hubConfKV,
                  configPath: hubConfAbs
                },
                services
              )
            : exported;

          if (!inst) throw new Error('Hub returned empty instance');

          inst.moduleId = inst.moduleId || m.id;
          inst.priority = Number(inst.priority ?? m.priority) || 0;

          if (typeof inst.init === 'function') {
            try { await inst.init(); }
            catch (e) { console.log(`[loader] module.init.error id=${inst.moduleId} err=${e?.message || e}`); }
          }

          loaded.push(inst);
          console.log(`[loader] module.loaded id=${m.id} file=${m.file} prio=${inst.priority}`);
        } catch (e) {
          console.log(`[loader] module.error id=${m.id} file=${m.file} err=${e?.message || e}`);
        }
      }

      loader._loaded = loaded;
      console.log(`[loader] ready modules=${loader._loaded.length}`);
    },

    async handleEvent(ctx) {
      for (const mod of loader._loaded) {
        if (typeof mod.handleEvent !== 'function') continue;
        try {
          const res = await mod.handleEvent(ctx);
          if (res && res.stop === true) break;
          if (ctx.stop) break;
        } catch (e) {
          console.log(`[loader] module.event.error id=${mod.moduleId} err=${e?.message || e}`);
        }
      }
    },

    async handleMessage(ctx) {
      for (const mod of loader._loaded) {
        if (typeof mod.handleMessage !== 'function') continue;
        try {
          const res = await mod.handleMessage(ctx);
          if (res && res.stop === true) break;
          if (ctx.stop) break;
        } catch (e) {
          console.log(`[loader] module.msg.error id=${mod.moduleId} err=${e?.message || e}`);
        }
      }
    }
  };

  return loader;
};
