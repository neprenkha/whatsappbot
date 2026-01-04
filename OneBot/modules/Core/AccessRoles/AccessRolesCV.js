'use strict';

const V1 = require('./AccessRolesV1');

async function init(meta) {
  return V1.init(meta);
}

module.exports = { init };
