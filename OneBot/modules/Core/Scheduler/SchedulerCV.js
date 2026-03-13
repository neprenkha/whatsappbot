'use strict';

function text(value) {
  return String(value ?? '').trim();
}

function keyText(value) {
  return text(value).toLowerCase();
}

function toBool(value) {
  const s = keyText(value);
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function toInt(value, fallback) {
  const n = Number.parseInt(text(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function fill(template, vars) {
  let out = String(template || '');
  Object.keys(vars).forEach((name) => {
    out = out.split(`{${name}}`).join(String(vars[name] ?? ''));
  });
  return out;
}

module.exports = {
  init: async (meta) => {
    const logTag = 'SchedulerCV';
    const cfg = meta.implConf || {};

    const requiredKeys = [
      'globalConfRel',
      'storeNs',
      'storeKey',
      'storeSeqKey',
      'intervalMs',
      'jobIdPrefix',
      'cmdSchedule',
      'actionCreate',
      'actionList',
      'actionPause',
      'actionResume',
      'actionCancel',
      'targetTypeStaff',
      'targetTypeCustomer',
      'defaultTargetType',
      'defaultWorkgroupKey',
      'defaultDelayMinutes',
      'minRoleManage',
      'replyNoAccess',
      'replyGroupOnly',
      'replyUsage',
      'replyCreateNeedWorkgroup',
      'replyCreateNeedMessage',
      'replyCreateNeedDelay',
      'replyCreateInvalidDelay',
      'replyCreateNeedTarget',
      'replyWorkgroupNotFound',
      'replyCreateOk',
      'replyListEmpty',
      'replyListHeader',
      'replyListItemTemplate',
      'replyJobNotFound',
      'replyPauseOk',
      'replyResumeOk',
      'replyCancelOk',
      'replyUnknownAction',
      'staffTaskTemplate',
      'suppressionEventName',
      'cmdScheduleHelp',
    ];

    const missing = requiredKeys.filter((k) => !text(cfg[k]));
    const bugLogEnabled = toBool(cfg.bugLog);
    if (missing.length) {
      if (bugLogEnabled) meta.log(logTag, `config invalid missing=${missing.join(',')}`);
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const loadedGlobal = typeof meta.loadConfRel === 'function'
      ? (meta.loadConfRel(text(cfg.globalConfRel)) || {})
      : {};
    const globalConf = loadedGlobal && loadedGlobal.conf && typeof loadedGlobal.conf === 'object'
      ? loadedGlobal.conf
      : (loadedGlobal && typeof loadedGlobal === 'object' ? loadedGlobal : {});

    const command = meta.getService('command');
    const access = meta.getService('access');
    const preferredSendService = String(globalConf.sendPrefer || '')
      .split(',')
      .map((x) => text(x))
      .filter(Boolean)[0] || '';
    const sendSvc = meta.getService('send') || (preferredSendService ? meta.getService(preferredSendService) : null);
    const workgroups = meta.getService('workgroups');
    const jsonstore = meta.getService('jsonstore');
    const journal = meta.getService('messagejournal');

    if (!command || typeof command.register !== 'function') {
      if (bugLogEnabled) meta.log(logTag, 'missing command service');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }
    let sendFn = null;
    if (typeof sendSvc === 'function') {
      sendFn = async (chatId, payload, options) => await sendSvc(chatId, payload, options || {});
    } else if (sendSvc && typeof sendSvc.send === 'function') {
      sendFn = async (chatId, payload, options) => await sendSvc.send(chatId, payload, options || {});
    }
    if (!sendFn) {
      if (bugLogEnabled) meta.log(logTag, 'missing send service');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }
    if (!jsonstore || typeof jsonstore.open !== 'function') {
      if (bugLogEnabled) meta.log(logTag, 'missing jsonstore service');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const store = jsonstore.open(text(cfg.storeNs));
    const intervalMs = Math.max(1000, toInt(cfg.intervalMs, 60000));

    async function canAccess(ctx) {
      const minRole = text(cfg.minRoleManage);
      if (!minRole) return false;
      if (!access) return false;

      if (typeof access.hasRole === 'function') return !!(await access.hasRole(ctx, minRole));
      if (typeof access.isAllowed === 'function') return !!(await access.isAllowed(ctx, minRole));
      if (typeof access.check === 'function') return !!(await access.check(ctx, minRole));
      if (typeof access.meetsMinRole === 'function') return !!(await access.meetsMinRole(ctx, minRole));
      return false;
    }

    async function sendReply(ctx, payload) {
      const message = text(payload);
      if (!message) return;

      if (ctx && typeof ctx.reply === 'function') {
        await ctx.reply(message);
        return;
      }

      const chatId = text(ctx && ctx.chatId);
      if (!chatId) return;
      await sendFn(chatId, message, { isAuto: 0 });
    }

    async function loadJobs() {
      const raw = await store.get(text(cfg.storeKey), { jobs: [] });
      return Array.isArray(raw && raw.jobs) ? raw.jobs : [];
    }

    async function saveJobs(jobs) {
      await store.set(text(cfg.storeKey), { jobs: Array.isArray(jobs) ? jobs : [] });
    }

    async function nextJobId() {
      const raw = await store.get(text(cfg.storeSeqKey), { value: 0 });
      const current = Number.isFinite(Number(raw && raw.value)) ? Number(raw.value) : 0;
      const next = current + 1;
      await store.set(text(cfg.storeSeqKey), { value: next });
      return `${text(cfg.jobIdPrefix)}${next}`;
    }

    async function resolveWorkgroupChatId(workgroupKey) {
      const key = text(workgroupKey);
      if (!key || !workgroups) return '';

      if (typeof workgroups.resolve === 'function') {
        const r = await workgroups.resolve(key);
        return text((r && r.chatId) || (r && r.groupChatId) || r);
      }
      if (typeof workgroups.getByKey === 'function') {
        const r = await workgroups.getByKey(key);
        return text((r && r.chatId) || (r && r.groupChatId) || r);
      }
      if (typeof workgroups.get === 'function') {
        const r = await workgroups.get(key);
        return text((r && r.chatId) || (r && r.groupChatId) || r);
      }
      if (typeof workgroups.list === 'function') {
        const arr = await workgroups.list();
        if (Array.isArray(arr)) {
          const found = arr.find((x) => keyText(x && x.key) === keyText(key) || keyText(x && x.name) === keyText(key));
          return text(found && (found.chatId || found.groupChatId));
        }
      }
      return '';
    }

    async function isCustomerActive(customerChatId) {
      const id = text(customerChatId);
      if (!id) return true;
      if (!journal) return true;

      if (typeof journal.isActive === 'function') return !!(await journal.isActive(id));
      if (typeof journal.hasRecentInbound === 'function') return !!(await journal.hasRecentInbound(id));
      if (typeof journal.isCustomerActive === 'function') return !!(await journal.isCustomerActive(id));
      return true;
    }

    function choosePrefix(ctx) {
      const fromCtx = text(ctx && ctx.command && ctx.command.prefix);
      if (fromCtx) return fromCtx;
      return text(globalConf.prefix);
    }

    function normalizeTargetType(value) {
      const t = keyText(value);
      if (t === keyText(cfg.targetTypeStaff)) return text(cfg.targetTypeStaff);
      if (t === keyText(cfg.targetTypeCustomer)) return text(cfg.targetTypeCustomer);
      return text(cfg.defaultTargetType);
    }

    async function createJobFromCommand(ctx, args) {
      const workgroupKey = text(args[1] || cfg.defaultWorkgroupKey);
      if (!workgroupKey) {
        await sendReply(ctx, cfg.replyCreateNeedWorkgroup);
        return;
      }

      const delayMinutesRaw = text(args[2] || cfg.defaultDelayMinutes);
      if (!delayMinutesRaw) {
        await sendReply(ctx, cfg.replyCreateNeedDelay);
        return;
      }

      const delayMinutes = toInt(delayMinutesRaw, -1);
      if (delayMinutes < 0) {
        await sendReply(ctx, cfg.replyCreateInvalidDelay);
        return;
      }

      const targetType = normalizeTargetType(args[3] || cfg.defaultTargetType);
      const targetId = text(args[4] || '');
      if (keyText(targetType) === keyText(cfg.targetTypeCustomer) && !targetId) {
        await sendReply(ctx, cfg.replyCreateNeedTarget);
        return;
      }

      const message = text(args.slice(5).join(' '));
      if (!message) {
        await sendReply(ctx, cfg.replyCreateNeedMessage);
        return;
      }

      const workgroupChatId = await resolveWorkgroupChatId(workgroupKey);
      if (!workgroupChatId) {
        await sendReply(ctx, cfg.replyWorkgroupNotFound);
        return;
      }

      const now = Date.now();
      const jobId = await nextJobId();
      const job = {
        jobId,
        status: 'active',
        workgroupKey,
        workgroupChatId,
        targetType,
        targetId,
        message,
        dueAt: now + (delayMinutes * 60000),
        createdAt: now,
        createdBy: text((ctx && ctx.senderId) || (ctx && ctx.author) || (ctx && ctx.from)),
        suppressIfActive: keyText(targetType) === keyText(cfg.targetTypeCustomer) ? 1 : 0,
      };

      const jobs = await loadJobs();
      jobs.push(job);
      await saveJobs(jobs);

      await sendReply(ctx, fill(cfg.replyCreateOk, {
        JOBID: jobId,
        WORKGROUP: workgroupKey,
      }));
    }

    async function listJobs(ctx) {
      const jobs = await loadJobs();
      if (!jobs.length) {
        await sendReply(ctx, cfg.replyListEmpty);
        return;
      }

      const lines = jobs.map((job) => fill(cfg.replyListItemTemplate, {
        JOBID: text(job.jobId),
        STATUS: text(job.status),
        WORKGROUP: text(job.workgroupKey),
        TARGETTYPE: text(job.targetType),
        TARGETID: text(job.targetId),
        DUEAT: String(job.dueAt || 0),
      }));

      await sendReply(ctx, `${text(cfg.replyListHeader)}\n${lines.join('\n')}`);
    }

    async function updateJobStatus(ctx, jobId, nextStatus, replyTemplate) {
      const id = text(jobId);
      const jobs = await loadJobs();
      const found = jobs.find((j) => text(j.jobId) === id);
      if (!found) {
        await sendReply(ctx, cfg.replyJobNotFound);
        return;
      }
      found.status = nextStatus;
      found.updatedAt = Date.now();
      await saveJobs(jobs);
      await sendReply(ctx, fill(replyTemplate, { JOBID: id }));
    }

    async function runTick() {
      const jobs = await loadJobs();
      if (!jobs.length) return;

      const now = Date.now();
      let changed = false;

      for (const job of jobs) {
        if (keyText(job.status) !== 'active') continue;
        if (Number(job.dueAt || 0) > now) continue;

        const targetType = keyText(job.targetType);
        const isCustomerTarget = targetType === keyText(cfg.targetTypeCustomer);

        if (isCustomerTarget) {
          const active = await isCustomerActive(job.targetId);
          if (active) {
            job.status = 'deferred';
            job.deferReason = text(cfg.suppressionEventName);
            job.updatedAt = now;
            changed = true;
            continue;
          }
        }

        const destinationChatId = text(job.workgroupChatId);
        if (!destinationChatId) {
          job.status = 'error';
          job.updatedAt = now;
          changed = true;
          continue;
        }

        const staffMessage = fill(cfg.staffTaskTemplate, {
          JOBID: text(job.jobId),
          WORKGROUP: text(job.workgroupKey),
          TARGETTYPE: text(job.targetType),
          TARGETID: text(job.targetId),
          MESSAGE: text(job.message),
          DUEAT: String(job.dueAt || 0),
        });

        await sendFn(destinationChatId, staffMessage, { isAuto: 1 });
        job.status = 'done';
        job.sentAt = now;
        job.updatedAt = now;
        changed = true;
      }

      if (changed) await saveJobs(jobs);
    }

    const cmdSchedule = keyText(cfg.cmdSchedule);
    const actionCreate = keyText(cfg.actionCreate);
    const actionList = keyText(cfg.actionList);
    const actionPause = keyText(cfg.actionPause);
    const actionResume = keyText(cfg.actionResume);
    const actionCancel = keyText(cfg.actionCancel);

    command.register(cmdSchedule, async (ctx) => {
      if (!ctx || !ctx.isGroup) {
        await sendReply(ctx, cfg.replyGroupOnly);
        return;
      }

      if (!(await canAccess(ctx))) {
        await sendReply(ctx, cfg.replyNoAccess);
        return;
      }

      const args = ctx && ctx.command && Array.isArray(ctx.command.args)
        ? ctx.command.args.map((v) => text(v))
        : [];

      const action = keyText(args[0]);
      const prefix = choosePrefix(ctx);

      if (!action) {
        await sendReply(ctx, fill(cfg.replyUsage, {
          PREFIX: prefix,
          CMD: cmdSchedule,
          CREATE: actionCreate,
          LIST: actionList,
          PAUSE: actionPause,
          RESUME: actionResume,
          CANCEL: actionCancel,
        }));
        return;
      }

      if (action === actionCreate) {
        await createJobFromCommand(ctx, args);
        return;
      }

      if (action === actionList) {
        await listJobs(ctx);
        return;
      }

      if (action === actionPause) {
        await updateJobStatus(ctx, args[1], 'paused', cfg.replyPauseOk);
        return;
      }

      if (action === actionResume) {
        await updateJobStatus(ctx, args[1], 'active', cfg.replyResumeOk);
        return;
      }

      if (action === actionCancel) {
        await updateJobStatus(ctx, args[1], 'cancelled', cfg.replyCancelOk);
        return;
      }

      await sendReply(ctx, cfg.replyUnknownAction);
    }, {
      owner: logTag,
      help: cfg.cmdScheduleHelp,
      minRole: text(cfg.minRoleManage),
    });

    setInterval(() => {
      runTick().catch((e) => {
        if (bugLogEnabled) meta.log(logTag, `tick error err=${text(e && e.message ? e.message : e)}`);
      });
    }, intervalMs);

    meta.log(logTag, `ready cmdSchedule=${cmdSchedule}`);
    return { onMessage: async () => {}, onEvent: async () => {} };
  },
};