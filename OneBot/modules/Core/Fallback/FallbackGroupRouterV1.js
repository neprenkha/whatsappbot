/*
FallbackGroupRouterV1

Router for fallback group.
- Primary target is controlGroupId from config
- Optional dynamic override via WorkGroups service (active group)

ASCII only.
*/

'use strict';

function routeGroupId(meta, cfg, sampleCtx) {
  const controlGroupId = (cfg.controlGroupId ? String(cfg.controlGroupId) : '').trim();
  if (controlGroupId) {
    // If WorkGroups is available and provides an active group, prefer it.
    try {
      const wg = meta && meta.services && meta.services.workgroups;
      if (wg && typeof wg.getActiveControlGroupId === 'function') {
        const active = String(wg.getActiveControlGroupId(sampleCtx) || '').trim();
        if (active) return active;
      }
    } catch (e) {
      // ignore and fallback to controlGroupId
    }
    return controlGroupId;
  }

  // Last resort: try WorkGroups only
  try {
    const wg = meta && meta.services && meta.services.workgroups;
    if (wg && typeof wg.getActiveControlGroupId === 'function') {
      const active = String(wg.getActiveControlGroupId(sampleCtx) || '').trim();
      if (active) return active;
    }
  } catch (e) {
    // ignore
  }

  return '';
}

module.exports = {
  routeGroupId
};
