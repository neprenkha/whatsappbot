'use strict';

const fs = require('fs');

function toInt(v, defVal) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : defVal;
}

function trunc(s, maxLen) {
  const t = (s === undefined || s === null) ? '' : String(s);
  if (maxLen <= 0) return '';
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen - 1) + '…';
}

function isAllowed(meta, ctx, controlGroupId, requiredRole) {
  const access = meta.getService('access');
  if (!access) return false;

  if (controlGroupId && ctx.chatId !== controlGroupId) return false;

  const need = requiredRole || 'staff';
  return access.hasAtLeast(ctx, need);
}

async function readTailLines(filePath, n) {
  // simple & safe (for test usage). if file grows huge later, we can optimize.
  const txt = await fs.promises.readFile(filePath, 'utf8');
  const lines = txt.split('\n').filter(Boolean);
  return lines.slice(Math.max(0, lines.length - n));
}

module.exports.init = async (meta, conf) => {
  const controlGroupId = conf.controlGroupId || '';
  const requiredRole = conf.requiredRole || 'staff';
  const maxTail = toInt(conf.maxTail, 20);
  const maxLineLen = toInt(conf.maxLineLen, 240);

  const cmd = meta.getService('command');
  const journal = meta.getService('journal');

  if (!cmd) {
    meta.log('MessageJournalTestV1', 'command service missing');
    return {};
  }
  if (!journal) {
    meta.log('MessageJournalTestV1', 'journal service missing');
    return {};
  }

  function deny(ctx) {
    return ctx.reply('⛔ Not allowed.\n\nTips:\n- !help — Show available commands.\n- !roles — Show role counts.');
  }

  cmd.register('jpath', async (ctx) => {
    if (!isAllowed(meta, ctx, controlGroupId, requiredRole)) return deny(ctx);
    return ctx.reply(`MessageJournal path:\n${journal.getDir()}`);
  });

  cmd.register('jstat', async (ctx) => {
    if (!isAllowed(meta, ctx, controlGroupId, requiredRole)) return deny(ctx);

    const dateKey = journal.getDateKeyNow();
    const fp = journal.getFilePathForDate(dateKey);

    if (!fs.existsSync(fp)) {
      return ctx.reply(`No journal file yet for today.\nDateKey: ${dateKey}`);
    }

    const st = await fs.promises.stat(fp);
    const lines = (await fs.promises.readFile(fp, 'utf8')).split('\n').filter(Boolean).length;

    return ctx.reply(
      `MessageJournal today\n` +
      `dateKey: ${dateKey}\n` +
      `file: ${fp}\n` +
      `size: ${st.size} bytes\n` +
      `lines: ${lines}`
    );
  });

  cmd.register('jtail', async (ctx, args) => {
    if (!isAllowed(meta, ctx, controlGroupId, requiredRole)) return deny(ctx);

    const want = Math.max(1, Math.min(maxTail, toInt((args && args[0]) ? args[0] : maxTail, maxTail)));
    const dateKey = journal.getDateKeyNow();
    const fp = journal.getFilePathForDate(dateKey);

    if (!fs.existsSync(fp)) {
      return ctx.reply(`No journal file yet for today.\nDateKey: ${dateKey}`);
    }

    const lines = await readTailLines(fp, want);
    const out = lines.map((l) => trunc(l, maxLineLen)).join('\n');

    return ctx.reply(
      `MessageJournal tail (${want})\n` +
      `dateKey: ${dateKey}\n` +
      `---\n` +
      `${out}`
    );
  });

  meta.log('MessageJournalTestV1', `ready controlGroupId=${controlGroupId || '(any)'} requiredRole=${requiredRole}`);

  return {
    onMessage: async () => {},
    onEvent: async () => {},
  };
};
