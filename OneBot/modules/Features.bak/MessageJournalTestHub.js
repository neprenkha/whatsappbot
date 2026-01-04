'use strict';

const path = require('path');

function safeRequire(absPath) {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(absPath);
}

module.exports.init = async (meta) => {
  const hubConf = meta.hubConf || {};
  const implFile = hubConf.implFile || 'Modules/Features/MessageJournalTestV1.js';
  const implConfigRel = hubConf.implConfig || 'modules/Features/MessageJournalTestV1.conf';

  const conf = meta.loadConfRel(implConfigRel) || {};
  const enabled = (meta.asBool ? meta.asBool(conf.enabled, true) : (String(conf.enabled ?? '1') !== '0'));
  if (!enabled) {
    meta.log('MessageJournalTestHub', `disabled via ${implConfigRel}`);
    return {};
  }

  const absImpl = path.join(meta.codeRoot, implFile);
  const impl = safeRequire(absImpl);

  if (!impl || typeof impl.init !== 'function') {
    meta.log('MessageJournalTestHub', `invalid impl: ${implFile}`);
    return {};
  }

  return impl.init(meta, conf);
};
