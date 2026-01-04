'use strict';

function toStr(v, defVal) {
  const s = String(v ?? '').trim();
  return s ? s : defVal;
}
function toBool(v, defVal) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return defVal;
  return !(s === '0' || s === 'false' || s === 'no' || s === 'off');
}
function toInt(v, defVal) {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : defVal;
}

module.exports.init = async function init(meta) {
  const enabled = toBool(meta.implConf.enabled, true);
  if (!enabled) return { onEvent: async () => {}, onMessage: async () => {} };

  const controlGroupId = toStr(meta.implConf.controlGroupId, '');
  const cmdTest = toStr(meta.implConf.cmdTest, 'schedtest').toLowerCase();
  const cmdList = toStr(meta.implConf.cmdList, 'schedlist').toLowerCase();
  const cmdCancel = toStr(meta.implConf.cmdCancel, 'schedcancel').toLowerCase();

  const handlerId = toStr(meta.implConf.handlerId, 'SchedulerTestV1.fire');
  const jobIdPrefix = toStr(meta.implConf.jobIdPrefix, 'SchedTest');

  const sched = meta.getService('scheduler') || meta.getService('sched');
  const cmd = meta.getService('command') || meta.getService('commands');
  const sendSvc = meta.getService('send');

  async function send(chatId, text) {
    if (typeof sendSvc === 'function') {
      return sendSvc(chatId, String(text || '').trim(), {});
    }
  }

  if (!sched) {
    meta.log('SchedulerTestV1', 'error missing scheduler service');
    return { onEvent: async () => {}, onMessage: async () => {} };
  }
  if (!cmd || typeof cmd.register !== 'function') {
    meta.log('SchedulerTestV1', 'error missing command service');
    return { onEvent: async () => {}, onMessage: async () => {} };
  }

  // Handler fires when job due
  sched.registerHandler(handlerId, async (job) => {
    const payload = job?.data || {};
    const chatId = String(payload.chatId || '').trim() || controlGroupId;
    const msg = String(payload.msg || '').trim() || '(no message)';
    await send(chatId, `⏰ Scheduler fired\njobId: ${job.id}\nmsg: ${msg}`);
  });

  cmd.register(cmdTest, async (ctx) => {
    if (controlGroupId && String(ctx.chatId || '') !== controlGroupId) return;

    const sec = toInt(ctx.command?.args?.[0], 10);
    const msg = String((ctx.command?.args || []).slice(1).join(' ') || '').trim() || `Hello in ${sec}s`;

    const jobId = `${jobIdPrefix}.${Date.now()}`;
    sched.scheduleIn({
      id: jobId,
      delayMs: sec * 1000,
      handlerId,
      data: { chatId: controlGroupId, msg },
      owner: 'SchedulerTestV1',
    });

    return ctx.reply(`✅ Scheduled\njobId: ${jobId}\nIn: ${sec}s`);
  }, { owner: 'SchedulerTestV1', help: 'Schedule a test job: !schedtest <sec> <msg>' });

  cmd.register(cmdList, async (ctx) => {
    if (controlGroupId && String(ctx.chatId || '') !== controlGroupId) return;
    const list = sched.list({ owner: 'SchedulerTestV1' }) || [];
    if (!list.length) return ctx.reply('No SchedulerTest jobs.');
    const lines = list.slice(0, 20).map(j => `• ${j.id} atMs=${j.atMs}`);
    return ctx.reply(`SchedulerTest jobs (${list.length}):\n${lines.join('\n')}`);
  }, { owner: 'SchedulerTestV1', help: 'List test jobs.' });

  cmd.register(cmdCancel, async (ctx) => {
    if (controlGroupId && String(ctx.chatId || '') !== controlGroupId) return;
    const jobId = String(ctx.command?.args?.[0] || '').trim();
    if (!jobId) return ctx.reply('❗ Usage: !schedcancel <jobId>');
    const ok = sched.cancel(jobId);
    return ctx.reply(ok ? `✅ Canceled ${jobId}` : `Not found: ${jobId}`);
  }, { owner: 'SchedulerTestV1', help: 'Cancel a test job.' });

  meta.log('SchedulerTestV1', `ready controlGroupId=${controlGroupId} handlerId=${handlerId}`);

  return { onEvent: async () => {}, onMessage: async () => {} };
};
