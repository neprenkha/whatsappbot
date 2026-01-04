'use strict';

/**
 * CommandHub (Core - Load with flexible prefixes)
 * Purpose: Load command handler following the meta.services + route system.
 */

const path = require('path');

module.exports = {
  async init(meta) {
    const hubConf = meta.hubConf || {};
    const implRel = hubConf.implFile;
    const implConfRel = hubConf.implConfig;

    if (!implRel) {
      meta.log('CommandHub', `disabled: missing implFile in ${meta.hubConfPath}`);
      return { enabled: false };
    }

    const implAbs = path.isAbsolute(implRel) ? implRel : path.join(meta.codeRoot, implRel);
    let impl;
    try {
      impl = require(implAbs);
    } catch (e) {
      meta.log('CommandHub', `disabled: require failed for ${implAbs}, error=${e.message}`);
      return { enabled: false };
    }

    if (!impl || typeof impl.init !== 'function') {
      meta.log('CommandHub', 'disabled: Implementation missing init() function.');
      return { enabled: false };
    }

    let implConf = {};
    if (implConfRel) {
      try {
        const loaded = meta.loadConfRel(implConfRel);
        implConf = (loaded && loaded.conf) || {};
      } catch (e) {
        meta.log('CommandHub', `warn: Failed loading implConf ${implConfRel}, error=${e.message}`);
      }
    }

    const meta2 = { ...meta, implConf };
    return impl.init(meta2);
  }
};