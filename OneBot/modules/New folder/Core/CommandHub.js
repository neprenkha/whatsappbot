'use strict';

/**
 * CommandHub (Core - Freeze)
 * Loads implementation file + conf from its hub .conf
 */

const path = require('path');

module.exports = {
  async init(meta) {
    const id = meta.id || 'Command';
    const hubConf = meta.hubConf || {};
    const implFile = hubConf.implFile;
    const implConfRel = hubConf.implConfig;

    if (!implFile) {
      meta.log('CommandHub', `disabled: missing implFile in ${meta.hubConfPath}`);
      return { id, enabled: false };
    }

    let impl;
    try {
      const abs = path.join(meta.codeRoot, implFile);
      impl = require(abs);
    } catch (e) {
      meta.log('CommandHub', `disabled: require failed: ${e.message} file=${implFile}`);
      return { id, enabled: false };
    }

    if (!impl || typeof impl.init !== 'function') {
      meta.log('CommandHub', `disabled: impl missing init() file=${implFile}`);
      return { id, enabled: false };
    }

    let implConf = {};
    let implConfPath = '';
    if (implConfRel) {
      try {
        const loaded = meta.loadConfRel(implConfRel);
        implConf = (loaded && loaded.conf) ? loaded.conf : {};
        implConfPath = (loaded && loaded.absPath) ? loaded.absPath : '';
      } catch (e) {
        meta.log('CommandHub', `warn: implConfig load failed: ${e.message} rel=${implConfRel}`);
      }
    }

    const meta2 = {
      ...meta,
      implConf,
      implConfPath,
    };

    try {
      return await impl.init(meta2);
    } catch (e) {
      meta.log('CommandHub', `disabled: init failed: ${e.message}`);
      return { id, enabled: false };
    }
  }
};
