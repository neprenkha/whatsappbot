'use strict';

// InboundDedupeHub
// Standard hub style: use meta.loadConfRel to load implConfig from bot config root.
// Pass implConf via meta.implConf and call impl.init(meta2).

const path = require('path');

module.exports.init = async function init(meta) {
  const hub = meta.hubConf || {};
  const implFileRel = String(hub.implFile || '').trim();
  const implConfRel = String(hub.implConfig || '').trim();

  if (!implFileRel) {
    throw new Error('[InboundDedupeHub] implFile missing');
  }

  const implPath = path.isAbsolute(implFileRel) ? implFileRel : path.join(meta.codeRoot, implFileRel);
  const impl = require(implPath);

  if (!impl || typeof impl.init !== 'function') {
    throw new Error('[InboundDedupeHub] impl.init not found: ' + implPath);
  }

  let implConf = {};
  if (implConfRel) {
    try {
      const loaded = (typeof meta.loadConfRel === 'function') ? meta.loadConfRel(implConfRel) : null;
      implConf = (loaded && loaded.conf) ? loaded.conf : {};
    } catch (e) {
      if (typeof meta.log === 'function') {
        meta.log('InboundDedupeHub', 'warn: failed loading implConfig, file=' + implConfRel + ', error=' + String(e && e.message ? e.message : e));
      }
      implConf = {};
    }
  }

  const meta2 = Object.assign({}, meta, { implConf });
  return impl.init(meta2);
};
