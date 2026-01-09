const sender = pickSender(meta, cfg, log);
try {
  const res = await sender.fn(toChatId, built.payload, options);
  log.info('fb.media.reply.sent', { ok: res?.ok });
} catch (e) {
  log.warn('fb.media.reply.fail', { err: e.message });
}