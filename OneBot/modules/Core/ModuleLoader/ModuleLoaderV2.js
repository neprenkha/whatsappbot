// ModuleLoaderV2.js
// Loads only "base module" conf files (e.g., TimeZone.conf) and ignores Hub/V* conf helpers.
// Prevents duplicates and noisy init_failed when Core folder contains Hub/V1/V2 conf files.

const fs = require("fs");
const path = require("path");

function parseConfText(text) {
  const out = {};
  const lines = (text || "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    out[k] = v;
  }
  return out;
}

function toBool(v, def = true) {
  if (v === undefined || v === null || v === "") return def;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function toInt(v, def = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function isBaseModuleConf(filename) {
  // accept: Something.conf
  // ignore: SomethingHub.conf, SomethingV1.conf, SomethingV2.conf, etc.
  const lower = filename.toLowerCase();
  if (!lower.endsWith(".conf")) return false;

  const base = path.basename(filename, ".conf"); // e.g. TimeZoneHub, TimeZoneV1, TimeZone
  if (/hub$/i.test(base)) return false;
  if (/v\d+$/i.test(base)) return false;

  // ignore hidden/backup
  if (base.startsWith(".") || base.startsWith("_")) return false;

  return true;
}

module.exports = class ModuleLoaderV2 {
  constructor(meta, conf) {
    this.meta = meta;
    this.conf = conf || {};
    this.skipIds = new Set();
    this.loadedIds = new Set();
  }

  init() {
    const meta = this.meta;

    // skipIds from implConfig
    const skip = (this.conf.skipIds || "").split(",").map(s => s.trim()).filter(Boolean);
    for (const id of skip) this.skipIds.add(id);

    const botName = meta?.paths?.botName || "ONEBOT";
    const dataRoot = meta?.paths?.dataRoot || "X:\\OneData";

    const coreDir = path.join(dataRoot, "bots", botName, "config", "modules", "Core");
    const featDir = path.join(dataRoot, "bots", botName, "config", "modules", "Features");

    this._scanAndLoad(coreDir);
    this._scanAndLoad(featDir);

    meta.log?.info?.(`[ModuleLoaderV2] ready core="${coreDir}" features="${featDir}" loadedIds=${this.loadedIds.size} skipIds=${this.skipIds.size}`);
  }

  _scanAndLoad(dirPath) {
    const meta = this.meta;

    if (!fs.existsSync(dirPath)) {
      meta.log?.warn?.(`[ModuleLoaderV2] dir missing: ${dirPath}`);
      return;
    }

    const files = fs.readdirSync(dirPath)
      .filter(isBaseModuleConf)
      .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));

    for (const f of files) {
      const confPath = path.join(dirPath, f);

      let text = "";
      try {
        text = fs.readFileSync(confPath, "utf8");
      } catch (e) {
        meta.log?.warn?.(`[ModuleLoaderV2] read fail: ${confPath} err=${e.message}`);
        continue;
      }

      const c = parseConfText(text);
      const id = (c.id || "").trim();
      if (!id) {
        meta.log?.warn?.(`[ModuleLoaderV2] skip conf missing id: ${confPath}`);
        continue;
      }

      if (this.skipIds.has(id)) continue;

      const enabled = toBool(c.enabled, true);
      if (!enabled) continue;

      // de-dup by module id
      if (this.loadedIds.has(id)) {
        meta.log?.warn?.(`[ModuleLoaderV2] duplicate id="${id}" conf=${confPath} (ignored)`);
        continue;
      }

      // quick validate required fields (Kernel will validate again too)
      const file = (c.file || "").trim();
      if (!file) {
        meta.log?.warn?.(`[ModuleLoaderV2] skip conf missing file: id="${id}" conf=${confPath}`);
        continue;
      }

      this.loadedIds.add(id);

      try {
        // keep same API used by ModuleLoaderV1 (your Kernel has this)
        meta.kernel.addModuleFromConfig(confPath);
      } catch (e) {
        meta.log?.warn?.(`[ModuleLoaderV2] load failed id="${id}" conf=${confPath} err=${e.message}`);
      }
    }
  }
};
