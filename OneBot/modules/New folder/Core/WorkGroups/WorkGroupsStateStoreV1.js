'use strict';

function createMemoryStoreV1() {
  let state = { groups: [] };
  return {
    load() {
      if (!state || !Array.isArray(state.groups)) state = { groups: [] };
      return state;
    },
    save(next) {
      state = (next && typeof next === 'object') ? next : { groups: [] };
      if (!Array.isArray(state.groups)) state.groups = [];
      return true;
    }
  };
}

function createJsonStoreV1(meta, cfg) {
  const store = meta.requireService('jsonstore');
  const ns = cfg.storeNs || 'core';
  const key = cfg.storeKey || 'WorkGroups/state.json';
  return {
    load() {
      const v = store.get(ns, key, null);
      if (!v || !Array.isArray(v.groups)) return { groups: [] };
      return v;
    },
    save(state) {
      store.set(ns, key, state || { groups: [] });
      return true;
    }
  };
}

function createFileStoreV1(meta, cfg) {
  const fs = require('fs');
  const path = require('path');
  const file = cfg.storeFile || path.join(meta.dataRoot, 'WorkGroups', 'state.json');

  function ensureDir() {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  return {
    load() {
      try {
        if (!fs.existsSync(file)) return { groups: [] };
        const raw = fs.readFileSync(file, 'utf8');
        const v = JSON.parse(raw || '{}');
        if (!v || !Array.isArray(v.groups)) return { groups: [] };
        return v;
      } catch (_) {
        return { groups: [] };
      }
    },
    save(state) {
      try {
        ensureDir();
        fs.writeFileSync(file, JSON.stringify(state || { groups: [] }, null, 2), 'utf8');
        return true;
      } catch (_) {
        return false;
      }
    }
  };
}

function createStateStoreV1(meta, cfg) {
  const type = String(cfg.store || 'jsonstore').toLowerCase();

  // IMPORTANT: store=none => still must work (in-memory)
  if (type === 'none' || type === 'memory' || type === 'mem') {
    return createMemoryStoreV1();
  }

  if (type === 'file') {
    return createFileStoreV1(meta, cfg);
  }

  // default jsonstore (fallback to memory if jsonstore missing)
  try {
    return createJsonStoreV1(meta, cfg);
  } catch (e) {
    meta.log('WorkGroupsStateStoreV1', `warn: jsonstore not available, fallback memory: ${e && e.message ? e.message : e}`);
    return createMemoryStoreV1();
  }
}

module.exports = { createStateStoreV1 };
