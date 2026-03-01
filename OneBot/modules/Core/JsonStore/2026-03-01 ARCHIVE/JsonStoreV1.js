'use strict';

const fs = require('fs');
const path = require('path');

const TAG = 'JsonStoreV1';

function safePart(input) {
  const s = String(input ?? '').trim();
  // Only letters, numbers, dot. (keep data filenames clean)
  let out = s.replace(/[^A-Za-z0-9.]/g, '.');
  out = out.replace(/\.{2,}/g, '.');
  out = out.replace(/^\.+/, '').replace(/\.+$/, '');
  return out || 'key';
}

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function readJson(filePath) {
  const txt = await fs.promises.readFile(filePath, 'utf8');
  return JSON.parse(txt);
}

async function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tmp = `${filePath}.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`;
  const payload = JSON.stringify(data, null, 2);

  await fs.promises.writeFile(tmp, payload, 'utf8');
  await fs.promises.rename(tmp, filePath);
}

function makeLocker() {
  const locks = new Map();

  async function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();

    // Chain in order, and keep map clean
    const next = prev.then(fn, fn).finally(() => {
      if (locks.get(key) === next) locks.delete(key);
    });

    locks.set(key, next);
    return next;
  }

  return { withLock };
}

module.exports.init = async function init(meta) {
  const hub = meta.hubConf || {};
  const cfg = meta.implConf || {};

  const baseDir = cfg.dir ? String(cfg.dir) : path.join(meta.dataRoot, 'JsonStore');
  const defaultNs = cfg.namespace ? safePart(cfg.namespace) : 'core';

  const serviceName = hub.serviceName ? String(hub.serviceName).trim() : 'jsonstore';

  await ensureDir(baseDir);

  const locker = makeLocker();

  function nsDir(ns) {
    return path.join(baseDir, safePart(ns));
  }

  function keyFile(ns, key) {
    const k = safePart(key);
    return path.join(nsDir(ns), `${k}.json`);
  }

  function buildStore(ns) {
    const namespace = safePart(ns);

    return {
      namespace,

      async get(key, defaultValue = null) {
        const k = safePart(key);
        const file = keyFile(namespace, k);

        return locker.withLock(`${namespace}:${k}`, async () => {
          try {
            return await readJson(file);
          } catch (err) {
            if (err && err.code === 'ENOENT') return defaultValue;
            throw err;
          }
        });
      },

      async set(key, value) {
        const k = safePart(key);
        const file = keyFile(namespace, k);

        return locker.withLock(`${namespace}:${k}`, async () => {
          await writeJsonAtomic(file, value);
          return value;
        });
      },

      async del(key) {
        const k = safePart(key);
        const file = keyFile(namespace, k);

        return locker.withLock(`${namespace}:${k}`, async () => {
          try {
            await fs.promises.unlink(file);
            return true;
          } catch (err) {
            if (err && err.code === 'ENOENT') return false;
            throw err;
          }
        });
      },

      async keys(prefix = '') {
        const pfx = safePart(prefix);
        const dir = nsDir(namespace);

        try {
          const items = await fs.promises.readdir(dir, { withFileTypes: true });
          const list = items
            .filter(d => d.isFile() && d.name.endsWith('.json'))
            .map(d => d.name.slice(0, -5)); // remove .json

          if (!pfx) return list;
          return list.filter(k => k.startsWith(pfx));
        } catch (err) {
          if (err && err.code === 'ENOENT') return [];
          throw err;
        }
      },

      async update(key, updaterFn, defaultValue = null) {
        const k = safePart(key);
        return locker.withLock(`${namespace}:${k}`, async () => {
          const cur = await this.get(k, defaultValue);
          const next = await updaterFn(cur);
          await this.set(k, next);
          return next;
        });
      },
    };
  }

  // Root service: default namespace + open(ns)
  const rootStore = buildStore(defaultNs);
  const svc = {
    ...rootStore,
    open(ns) {
      return buildStore(ns);
    },
  };

  meta.registerService(serviceName, svc);

  meta.log(TAG, `ready service=${serviceName} dir=${baseDir} defaultNs=${defaultNs}`);

  return {
    id: 'JsonStoreV1',
    priority: Number.isFinite(Number(hub.priority)) ? Number(hub.priority) : 9640,
  };
};
