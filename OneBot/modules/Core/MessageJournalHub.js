'use strict';

const path = require('path');

function safeRequire(absPath) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(absPath);
  } catch (err) {
    return null;
  }
}

module.exports.init = async (meta) => {
  const hubConf = meta.hubConf || {};
  const implFile = hubConf.implFile || 'Modules/Core/MessageJournalV1.js';
  const implConfigRel = hubConf.implConfig || 'modules/Core/MessageJournalV1.conf';

  let conf;
  try {
    conf = meta.loadConfRel(implConfigRel) || {};
  } catch (e) {
    meta.log('MessageJournalHub', `Error loading config file: ${implConfigRel}, error=${e.message}`);
    conf = {};
  }

  const enabled = meta.asBool
    ? meta.asBool(conf.enabled, true)
    : String(conf.enabled ?? '1') !== '0';

  if (!enabled) {
    meta.log('MessageJournalHub', `Disabled via config: ${implConfigRel}`);
    return {};
  }

  const absImpl = path.join(meta.codeRoot, implFile);
  const impl = safeRequire(absImpl);

  if (!impl || typeof impl.init !== 'function') {
    meta.log('MessageJournalHub', `Invalid implementation in file: ${implFile}`);
    return {};
  }

  return impl.init(meta, conf);
};