'use strict';

/**
 * WorkGroupsStateStoreV1
 * - Handles state persistence for Work Groups.
 * - Supports memory, file, and jsonstore storage types.
 */

function createMemoryStoreV1() {
  let state = { groups: [] };

  function deduplicate(groups) {
    const seen = new Set();
    return groups.filter(group => {
      const key = String(group.name).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  return {
    load() {
      if (!state || !Array.isArray(state.groups)) state = { groups: [] };
      // Deduplicate groups on load
      state.groups = deduplicate(state.groups);
      return state;
    },
    save(next) {
      if (!next || typeof next !== 'object') return false;
      state = next;
      if (!Array.isArray(state.groups)) state.groups = [];
      // Ensure deduplication on save
      state.groups = deduplicate(state.groups);
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
      try {
        const v = store.get(ns, key, null);
        if (!v || !Array.isArray(v.groups)) return { groups: [] };
        return v;
      } catch (e) {
        meta.log('WorkGroupsStateStoreV1', `warn: Failed to load JSON store: ${e.message}`);
        return { groups: [] };
      }
    },
    save(state) {
      try {
        store.set(ns, key, state || { groups: [] });
        return true;
      } catch (e) {
        meta.log('WorkGroupsStateStoreV1', `warn: Failed to save JSON store: ${e.message}`);
        return false;
      }
    }
  };
}

function createFileStoreV1(meta, cfg) {
  const fs = require('fs');
  const path = require('path');
  const file = cfg.storeFile || path.join(meta.dataRoot, 'WorkGroups', 'state.json');
  let isInitialized = false;

  function ensureDir() {
    if (isInitialized) return;
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    isInitialized = true;
  }

  return {
    load() {
      try {
        ensureDir();
        if (!fs.existsSync(file)) return { groups: [] };
        const raw = fs.readFileSync(file, 'utf8');
        const v = JSON.parse(raw || '{}');
        if (!v || !Array.isArray(v.groups)) return { groups: [] };
        return v;
      } catch (e) {
        meta.log('WorkGroupsStateStoreV1', `warn: Failed to load file store: ${e.message}`);
        return { groups: [] };
      }
    },
    save(state) {
      try {
        ensureDir();
        fs.writeFileSync(file, JSON.stringify(state || { groups: [] }, null, 2), 'utf8');
        return true;
      } catch (e) {
        meta.log('WorkGroupsStateStoreV1', `warn: Failed to save file store: ${e.message}`);
        return false;
      }
    }
  };
}

function createStateStoreV1(meta, cfg) {
  const type = String(cfg.store || 'jsonstore').toLowerCase();

  if (type === 'none' || type === 'memory' || type === 'mem') {
    return createMemoryStoreV1();
  }

  if (type === 'file') {
    return createFileStoreV1(meta, cfg);
  }

  try {
    return createJsonStoreV1(meta, cfg);
  } catch (e) {
    meta.log('WorkGroupsStateStoreV1', `warn: JSON store unavailable, falling back to memory: ${e.message}`);
    return createMemoryStoreV1();
  }
}

module.exports = { createStateStoreV1 };