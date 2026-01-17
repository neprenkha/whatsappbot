'use strict';

const path = require('path');
const fs = require('fs');

module.exports = {
  async init(meta) {
    const hubConf = meta.hubConf || {};
    const implRel = hubConf.implFile || '';
    const implConfRel = hubConf.implConfig || '';
    if (!implRel) {
      meta.log('FallbackHub', 'disabled: missing implFile in hub .conf');
      return { enabled: false };
    }

    // Resolve implementation file path
    const implAbs = path.isAbsolute(implRel) ? implRel : path.join(meta.codeRoot, implRel);
    
    // Validate file existence
    if (!fs.existsSync(implAbs)) {
      meta.log('FallbackHub', `disabled: implementation file not found, path=${implAbs}`);
      return { enabled: false };
    }
    
    let impl;
    try {
      impl = require(implAbs);
      meta.log('FallbackHub', `info: loaded implementation file=${implAbs}`);
    } catch (e) {
      meta.log('FallbackHub', `disabled: require failed ${e.message || e}, file=${implAbs}`);
      meta.log('FallbackHub', `error stack: ${e.stack}`);
      return { enabled: false };
    }

    if (!impl || typeof impl.init !== 'function') {
      meta.log('FallbackHub', `disabled: impl.init() not found, file=${implAbs}`);
      meta.log('FallbackHub', `debug: implType=${typeof impl}, hasInit=${!!(impl && impl.init)}, initType=${impl && impl.init ? typeof impl.init : 'undefined'}`);
      return { enabled: false };
    }

    // Load configuration
    let implConfig = {};
    if (implConfRel) {
      try {
        const loaded = meta.loadConfRel(implConfRel);
        implConfig = (loaded && loaded.conf) || {};
        meta.log('FallbackHub', `info: loaded implConfig file=${implConfRel}`);
      } catch (e) {
        meta.log('FallbackHub', `warn: failed loading implConfig, file=${implConfRel}, error=${e.message}`);
      }
    }

    const metaWithConfig = { ...meta, hubConf, implConf: implConfig };
    
    try {
      const result = await impl.init(metaWithConfig);
      meta.log('FallbackHub', `info: impl.init() completed successfully`);
      return result;
    } catch (e) {
      meta.log('FallbackHub', `error: impl.init() threw exception: ${e.message || e}`);
      meta.log('FallbackHub', `error stack: ${e.stack}`);
      return { enabled: false };
    }
  }
};