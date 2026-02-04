'use strict';

function makeLog(raw, tag) {
  const t = tag || 'FallbackMediaForwardQueueV1';
  const base = raw || console;

  function _fmt(msg, obj) {
    if (!obj) return msg;
    try { return msg + ' ' + JSON.stringify(obj); } catch (_e) { return msg; }
  }

  function _call(fnName, fallbackName, msg, obj) {
    const fn = base && typeof base[fnName] === 'function' ? base[fnName]
      : (base && typeof base[fallbackName] === 'function' ? base[fallbackName] : null);

    const line = '[' + t + '] ' + _fmt(msg, obj);
    if (fn) return fn.call(base, line);
    if (typeof console.log === 'function') console.log(line);
  }

  return {
    info: (msg, obj) => _call('info', 'log', msg, obj),
    warn: (msg, obj) => _call('warn', 'log', msg, obj),
    error: (msg, obj) => _call('error', 'log', msg, obj),
  };
}

function toBool(v, d) {
  if (v === true || v === 1 || v === '1') return true;
  if (v === false || v === 0 || v === '0') return false;
  return d;
}
function toInt(v, d) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
function toStr(v, d) {
  const s = (v === undefined || v === null) ? '' : String(v);
  return s ? s : d;
}
function _asString(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err && err.stack) return String(err.stack);
  return String(err);
}
function _guessMime(rawMsg) {
  try {
    const mt = rawMsg && rawMsg._data && rawMsg._data.mimetype ? String(rawMsg._data.mimetype) : '';
    return mt;
  } catch (_e) {
    return '';
  }
}
function _normalizeMedia(rawMsg, media) {
  if (!media) return null;
  const data = media.data ? String(media.data) : '';
  const mimetype = media.mimetype ? String(media.mimetype) : _guessMime(rawMsg);
  if (!data) return null;
  if (!mimetype) return null;
  try {
    media.mimetype = mimetype;
    return media;
  } catch (_e) {
    return null;
  }
}

class FallbackMediaForwardQueueV1 {
  constructor(meta, cfg) {
    this._meta = meta;
    this._cfg = cfg || {};
    this._log = makeLog(meta && meta.log ? meta.log : null, 'FallbackMediaForwardQueueV1');
    this._enabled = toBool(this._cfg.enabled, true);
    this._queueMax = toInt(this._cfg.queueMax, 200);
    this._items = [];
    this._running = false;
    this._sender = null;

    const sendPrefer = toStr(this._cfg.sendPrefer, 'outsend,sendout,send');
    this._sendPrefer = sendPrefer.split(',').map(s => s.trim()).filter(Boolean);
  }

  _pickSender() {
    if (this._sender) return this._sender;
    const services = this._meta && this._meta.getServices ? this._meta.getServices() : (this._meta && this._meta.services ? this._meta.services : {});
    for (const name of this._sendPrefer) {
      if (services && typeof services[name] === 'function') {
        this._sender = services[name];
        return this._sender;
      }
    }
    const t = services && services.transport ? services.transport : null;
    if (t && typeof t.sendDirect === 'function') {
      this._sender = async (chatId, payload, opts) => t.sendDirect(chatId, payload, opts);
      return this._sender;
    }
    return null;
  }

  async enqueue(item) {
    if (!this._enabled) return { ok: false, reason: 'disabled' };
    if (!item || !item.rawMsg) return { ok: false, reason: 'invalid_item' };
    if (this._items.length >= this._queueMax) return { ok: false, reason: 'queue_full' };

    this._items.push(item);
    if (!this._running) {
      this._running = true;
      this._run().catch((e) => {
        this._log.error('run.error', { err: _asString(e) });
      });
    }
    return { ok: true };
  }

  async _run() {
    while (this._items.length > 0) {
      const item = this._items.shift();
      if (!item) continue;

      const sender = this._pickSender();
      if (!sender) throw new Error('no_sender');

      const rawMsg = item.rawMsg;
      const chatId = toStr(this._cfg.controlGroupId, '');
      if (!chatId) throw new Error('missing_controlGroupId');

      let media = null;
      try {
        media = await rawMsg.downloadMedia();
      } catch (e) {
        throw new Error('download_fail ' + _asString(e));
      }

      media = _normalizeMedia(rawMsg, media);
      if (!media) throw new Error('empty_media');

      const caption = item.caption ? String(item.caption) : '';
      const sendOpts = { caption: caption };

      const t = rawMsg && rawMsg.type ? String(rawMsg.type) : '';
      sendOpts.sendMediaAsDocument = (t === 'document');

      const res = await sender(chatId, media, sendOpts);
      this._log.info('sent', {
        ticketId: item.ticketId || '',
        kind: item.kind || '',
        ok: res && res.ok === false ? 0 : 1,
        mime: media.mimetype || '',
        filename: media.filename || '',
        capLen: caption.length,
      });
    }

    this._running = false;
  }
}

module.exports = FallbackMediaForwardQueueV1;
