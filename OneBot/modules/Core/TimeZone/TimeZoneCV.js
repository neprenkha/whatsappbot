'use strict';

const V1 = require('./TimeZoneV1');

async function init(meta) {
  return V1.init(meta);
}

module.exports = { init };
