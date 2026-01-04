'use strict';

function toInt(v, def) {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : def;
}
function toBool(v, def) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return def;
}

function roleRank(role) {
  const r = String(role || '').toLowerCase();
  const map = { controller: 5, admin: 4, staff: 3, guest: 2, none: 1 };
  return map[r] || 0;
}

function getSenderKey(ctx) {
  const s = ctx?.sender || {};
  const id = String(s.id || '').trim();     // e.g. "828...@lid"
  const lid = String(s.lid || '').trim();   // sometimes empty
  const phone = String(s.phone || '').trim();

  if (id.endsWith('@lid')) return `lid:${id.replace('@lid', '')}`;
  if (lid) return `lid:${lid}`;
  if (phone) return `phone:${phone}`;
  return '';
}

module.exports.init = async function init(meta) {
  const cfg = meta.moduleConf || {};
  const enabled = toBool(cfg.enabled, true);

  const controlGroupId = String(cfg.controlGroupId || '').trim(); // optional
  const requiredRole = String(cfg.requiredRole || 'staff').trim();

  const cmdAdd = String(cfg.cmdAdd || 'obadd').trim();
  const cmdList = String(cfg.cmdList || 'oblist').trim();
  const cmdRun = String(cfg.cmdRun || 'obrun').trim();
  const cmdCancel = String(cfg.cmdCancel || 'obcancel').trim();
  const cmdClear = String(cfg.cmdClear || 'obclear').trim();

  const cmdSvc = meta.getService('command');
  const outbox = meta.getService('outbox');
  const access = meta.getService('access');

  const sendFn = meta.getService('sendout') || meta.getService('outsend') || meta.getService('send');

  if (!enabled) {
    meta.log('OutboxTestV1', 'disabled');
    return;
  }
  if (!cmdSvc || typeof cmdSvc.register !== 'function') {
    meta.log('OutboxTestV1', 'error missing Command service (load Command first)');
    return;
  }
  if (!outbox || typeof outbox.enqueueText !== 'function') {
    meta.log('OutboxTestV1', 'error missing Outbox service (load Outbox core first)');
    return;
  }
  if (!sendFn || typeof sendFn !== 'function') {
    meta.log('OutboxTestV1', 'error missing send service');
    return;
  }

  async function reply(ctx, text) {
    return sendFn(ctx.chatId, String(text || ''), { source: 'OutboxTestV1' });
  }

  function allow(ctx) {
    if (controlGroupId && ctx.chatId !== controlGroupId) return false;
    if (!access || typeof access.getRole !== 'function') return true; // fallback allow if no access svc

    const key = getSenderKey(ctx);
    const role = access.getRole(key) || 'none';
    return roleRank(role) >= roleRank(requiredRole);
  }

  // !obadd <sec> <text...> [key=ABC]
  cmdSvc.register(cmdAdd, async (ctx) => {
    if (!allow(ctx)) return reply(ctx, '⛔ Not allowed.');

    const raw = String(ctx.argsRaw || '').trim();
    const parts = raw.split(/\s+/).filter(Boolean);

    const sec = toInt(parts[0], 0);
    const rest = parts.slice(1).join(' ').trim();

    if (!rest) {
      return reply(ctx, `Usage: !${cmdAdd} <sec> <text>  (example: !${cmdAdd} 10 hello)`);
    }

    // optional key=...
    let text = rest;
    let dedupeKey = '';
    const m = rest.match(/\skey=([A-Za-z0-9._:-]+)\s*$/);
    if (m) {
      dedupeKey = m[1];
      text = rest.replace(/\skey=([A-Za-z0-9._:-]+)\s*$/, '').trim();
    }

    const res = await outbox.enqueueText(ctx.chatId, text, { delaySec: sec, dedupeKey });
    if (res && res.deduped) return reply(ctx, '✅ Deduped (same key already pending).');

    const id = res && res.id ? res.id : '';
    return reply(ctx, `✅ Queued ${id || ''} (delay ${sec}s).`);
  });

  // !oblist [n]
  cmdSvc.register(cmdList, async (ctx) => {
    if (!allow(ctx)) return reply(ctx, '⛔ Not allowed.');

    const n = toInt(String(ctx.argsRaw || '').trim(), 10);
    const items = await outbox.list({ limit: n > 0 ? n : 10 });

    if (!items.length) return reply(ctx, '📭 Outbox empty.');

    const lines = items.map(it => {
      const due = it.notBefore ? new Date(it.notBefore).toLocaleString('en-MY') : '-';
      return `• ${it.id} [${it.status}] attempts=${it.attempts || 0} due=${due}`;
    });

    return reply(ctx, `📦 Outbox (latest ${items.length}):\n${lines.join('\n')}`);
  });

  // !obrun
  cmdSvc.register(cmdRun, async (ctx) => {
    if (!allow(ctx)) return reply(ctx, '⛔ Not allowed.');
    await outbox.flush();
    return reply(ctx, '✅ Outbox flush triggered.');
  });

  // !obcancel <id>
  cmdSvc.register(cmdCancel, async (ctx) => {
    if (!allow(ctx)) return reply(ctx, '⛔ Not allowed.');
    const id = String(ctx.argsRaw || '').trim();
    if (!id) return reply(ctx, `Usage: !${cmdCancel} <id>`);
    const res = await outbox.cancel(id);
    if (res && res.ok) return reply(ctx, '✅ Cancelled.');
    return reply(ctx, '❌ Not found.');
  });

  // !obclear
  cmdSvc.register(cmdClear, async (ctx) => {
    if (!allow(ctx)) return reply(ctx, '⛔ Not allowed.');
    await outbox.clearAll();
    return reply(ctx, '✅ Outbox cleared.');
  });

  meta.log('OutboxTestV1', `ready controlGroupId=${controlGroupId || '(any)'} requiredRole=${requiredRole}`);
};
