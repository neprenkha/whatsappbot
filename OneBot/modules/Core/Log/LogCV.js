'use strict';

const LogV2 = require('./LogV2');

module.exports.init = async function init(meta) {
  const implConf = meta && meta.implConf ? meta.implConf : {};
  const logv2 = new LogV2(meta, implConf);
  return logv2.build();
};
