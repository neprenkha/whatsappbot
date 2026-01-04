'use strict';

function readConfigV1(conf) {
  const cfg = conf || {};
  return {
    enabled: String(cfg.enabled ?? '1') !== '0',

    // Command module prefix is "!" globally, so config is WITHOUT "!"
    cmdGroup: String(cfg.cmdGroup || 'group').trim(),
    cmdGroupList: String(cfg.cmdGroupList || 'group list').trim(),
    cmdGroupAdd: String(cfg.cmdGroupAdd || 'group add').trim(),
    cmdGroupSet: String(cfg.cmdGroupSet || 'group set').trim(),
    cmdGroupDel: String(cfg.cmdGroupDel || 'group del').trim(),
    cmdGroupWho: String(cfg.cmdGroupWho || 'group who').trim(),

    requiredRole: String(cfg.requiredRole || 'staff').trim(),

    // jsonstore | file | none
    store: String(cfg.store || 'jsonstore').trim(),
    storeNs: String(cfg.storeNs || 'core').trim(),
    storeKey: String(cfg.storeKey || 'WorkGroups/state.json').trim(),
    storeFile: String(cfg.storeFile || '').trim(),
  };
}

module.exports = { readConfigV1 };
