'use strict';

/**
 * SchedulerV1 (Core)
 * Single responsibility:
 * - Run one-shot jobs at specific epoch ms (UTC ms)
 * - Persist jobs into OneData
 * - Provide service for other modules to register handlers + schedule/cancel/list
 *
 * NO send logic, NO rate limit logic, NO timezone logic.
 */

const fs = require('fs');
const path = require('path');

function toInt(v, defVal) {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : defVal;
}

function toBool(v, defVal) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return defVal;
  return !(s === '0' || s === 'false' || s === 'no' || s === 'off');
}

function toStr(v, defVal) {
  const s = String(v ?? '').trim();
  return s ? s : defVal;
}

function safeJsonParse(txt, defVal) {
  try { return JSON.parse(txt); } catch { return defVal; }
}

function safeReadText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function nowMs() {
  return Date.now();
}

module.exports.init = async function init(meta) {
  const enabled = toBool(meta.implConf.enabled, true);

  const tickMs = Math.max(250, toInt(meta.implConf.tickMs, 1000));
  const maxJobs = Math.max(10, toInt(meta.implConf.maxJobs, 5000));
  const dueBatchMax = Math.max(1, toInt(meta.implConf.dueBatchMax, 25));

  const maxAttempts = Math.max(0, toInt(meta.implConf.maxAttempts, 2));
  const retryDelayMs = Math.max(0, toInt(meta.implConf.retryDelayMs, 5000));

  const dataDirRel = toStr(meta.implConf.dataDirRel, 'data/Scheduler');
  const jobsFileName = toStr(meta.implConf.jobsFileName, 'jobs.json');
  const persistDebounceMs = Math.max(0, toInt(meta.implConf.persistDebounceMs, 400));

  const dataDirAbs = path.isAbsolute(dataDirRel)
    ? dataDirRel
    : path.join(meta.dataRootBot, dataDirRel);

  const jobsFileAbs = path.join(dataDirAbs, jobsFileName);

  const handlers = new Map(); // handlerId -> fn
  const jobs = new Map();     // jobId -> jobObj
  let timer = null;

  let dirty = false;
  let persistTimer = null;

  function log(msg) {
    meta.log('SchedulerV1', msg);
  }

  function persistSoon() {
    if (!dirty) dirty = true;
    if (persistDebounceMs <= 0) return persistNow();

    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow();
    }, persistDebounceMs);
  }

  function persistNow() {
    if (!dirty) return;
    dirty = false;

    const arr = Array.from(jobs.values())
      .sort((a, b) => (a.atMs || 0) - (b.atMs || 0))
      .map(j => ({ ...j }));

    atomicWriteJson(jobsFileAbs, {
      version: 1,
      savedAtMs: nowMs(),
      jobs: arr,
    });
  }

  function loadJobs() {
    ensureDir(dataDirAbs);
    const raw = safeReadText(jobsFileAbs);
    const obj = safeJsonParse(raw, { version: 1, jobs: [] });
    const list = Array.isArray(obj.jobs) ? obj.jobs : [];

    for (const it of list) {
      const id = String(it?.id || '').trim();
      const handlerId = String(it?.handlerId || '').trim();
      const atMsVal = Number(it?.atMs || 0);

      if (!id || !handlerId || !Number.isFinite(atMsVal) || atMsVal <= 0) continue;

      jobs.set(id, {
        id,
        handlerId,
        atMs: atMsVal,
        data: (it && typeof it.data !== 'undefined') ? it.data : null,
        owner: String(it?.owner || '').trim(),
        createdAtMs: Number(it?.createdAtMs || nowMs()),
        updatedAtMs: Number(it?.updatedAtMs || nowMs()),
        attempts: Number(it?.attempts || 0),
      });
    }
  }

  function upsertJob(job) {
    if (jobs.size >= maxJobs && !jobs.has(job.id)) {
      throw new Error(`maxJobs reached (${maxJobs})`);
    }
    jobs.set(job.id, job);
    persistSoon();
  }

  async function runDueJobs() {
    const n = nowMs();

    // collect due jobs (simple scan, capped per tick)
    const due = [];
    for (const j of jobs.values()) {
      if (due.length >= dueBatchMax) break;
      if (j.atMs <= n) due.push(j);
    }

    if (!due.length) return;

    // run oldest first
    due.sort((a, b) => a.atMs - b.atMs);

    for (const job of due) {
      const fn = handlers.get(job.handlerId);

      // If no handler registered, drop job (avoid infinite loop)
      if (typeof fn !== 'function') {
        log(`job.drop_missing_handler id=${job.id} handlerId=${job.handlerId}`);
        jobs.delete(job.id);
        persistSoon();
        continue;
      }

      try {
        // remove before execute to avoid duplicate if handler schedules again
        jobs.delete(job.id);
        persistSoon();

        await fn({
          id: job.id,
          handlerId: job.handlerId,
          atMs: job.atMs,
          data: job.data,
          owner: job.owner,
          attempts: job.attempts || 0,
        }, {
          nowMs: n,
          scheduler: schedulerSvc,
        });

        log(`job.done id=${job.id} handlerId=${job.handlerId}`);
      } catch (e) {
        const err = String(e?.message || e || 'error');
        const nextAttempts = (job.attempts || 0) + 1;

        if (nextAttempts <= maxAttempts) {
          const nextAt = nowMs() + retryDelayMs;
          const retryJob = {
            ...job,
            attempts: nextAttempts,
            atMs: nextAt,
            updatedAtMs: nowMs(),
          };
          upsertJob(retryJob);
          log(`job.retry id=${job.id} handlerId=${job.handlerId} attempts=${nextAttempts} nextAtMs=${nextAt} err=${err}`);
        } else {
          log(`job.dead id=${job.id} handlerId=${job.handlerId} attempts=${nextAttempts} err=${err}`);
          // dropped permanently (trace remains in log file)
        }
      }
    }
  }

  function start() {
    if (!enabled) {
      log('disabled');
      return;
    }
    if (timer) return;

    timer = setInterval(() => {
      runDueJobs().catch(() => {});
    }, tickMs);

    log(`ready tickMs=${tickMs} maxJobs=${maxJobs} dueBatchMax=${dueBatchMax} data=${jobsFileAbs}`);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    persistNow();
  }

  // ---- Scheduler Service (technical + stable) ----
  const schedulerSvc = {
    // aliases
    version: 1,

    registerHandler(handlerId, fn) {
      const hid = String(handlerId || '').trim();
      if (!hid || typeof fn !== 'function') return false;
      handlers.set(hid, fn);
      return true;
    },

    unregisterHandler(handlerId) {
      const hid = String(handlerId || '').trim();
      return handlers.delete(hid);
    },

    scheduleAt({ id, atMs, handlerId, data = null, owner = '' }) {
      const jid = String(id || '').trim();
      const hid = String(handlerId || '').trim();
      const t = Number(atMs || 0);

      if (!enabled) throw new Error('scheduler disabled');
      if (!jid) throw new Error('missing job id');
      if (!hid) throw new Error('missing handlerId');
      if (!Number.isFinite(t) || t <= 0) throw new Error('invalid atMs');

      const now = nowMs();
      const job = jobs.get(jid) || {
        id: jid,
        handlerId: hid,
        createdAtMs: now,
        attempts: 0,
      };

      job.handlerId = hid;
      job.atMs = t;
      job.data = data;
      job.owner = String(owner || '').trim();
      job.updatedAtMs = now;

      upsertJob(job);
      return true;
    },

    scheduleIn({ id, delayMs, handlerId, data = null, owner = '' }) {
      const d = Math.max(0, Number(delayMs || 0));
      return schedulerSvc.scheduleAt({
        id,
        atMs: nowMs() + d,
        handlerId,
        data,
        owner,
      });
    },

    cancel(id) {
      const jid = String(id || '').trim();
      if (!jid) return false;
      const ok = jobs.delete(jid);
      if (ok) persistSoon();
      return ok;
    },

    get(id) {
      const jid = String(id || '').trim();
      const j = jobs.get(jid);
      return j ? { ...j } : null;
    },

    list({ owner = '' } = {}) {
      const own = String(owner || '').trim();
      const arr = Array.from(jobs.values())
        .filter(j => !own || String(j.owner || '').trim() === own)
        .sort((a, b) => (a.atMs || 0) - (b.atMs || 0))
        .map(j => ({ ...j }));
      return arr;
    },

    stats() {
      const n = nowMs();
      let due = 0;
      for (const j of jobs.values()) if (j.atMs <= n) due++;
      return {
        enabled,
        tickMs,
        totalJobs: jobs.size,
        dueJobs: due,
        handlers: handlers.size,
        dataFile: jobsFileAbs,
      };
    },

    flush() { persistNow(); },
  };

  // register services (two names, same impl)
  meta.registerService('scheduler', schedulerSvc);
  meta.registerService('sched', schedulerSvc);

  loadJobs();
  start();

  // flush on exit
  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });

  return {
    onEvent: async () => {},
    onMessage: async () => {},
  };
};
