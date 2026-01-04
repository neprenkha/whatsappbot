'use strict';

// FallbackGroupRouterV1.js
// Routes inbound fallback events to a target group.
// Priority:
// 1) WorkGroups active fallback group (if API available)
// 2) cfg.fallbackGroupId (optional hard override)
// 3) cfg.controlGroupId (always required)

module.exports.routeGroupId = function routeGroupId(meta, cfg, ctx) {
  const control = String((cfg && cfg.controlGroupId) || '').trim();
  const fallbackGroupId = String((cfg && cfg.fallbackGroupId) || '').trim();
  const svcName = String((cfg && cfg.workgroupsService) || 'workgroups').trim() || 'workgroups';

  // Guard: must always have a control group id configured (even if active fallback group is used).
  if (!control && !fallbackGroupId) return '';

  if (meta && typeof meta.getService === 'function') {
    const wg = meta.getService(svcName);

    try {
      // Newer API (if available)
      if (wg && typeof wg.pickFallbackGroup === 'function') {
        const gid = String(wg.pickFallbackGroup(ctx) || '').trim();
        if (gid) return gid;
      }

      // Current ONEBOT WorkGroupsV2 API
      if (wg && typeof wg.getActiveFallbackId === 'function') {
        const gid = String(wg.getActiveFallbackId() || '').trim();
        if (gid) return gid;
      }

      // Generic routing API (if available)
      if (wg && typeof wg.route === 'function') {
        const gid = String(wg.route('fallback', ctx) || '').trim();
        if (gid) return gid;
      }

      // Control group getter (if available)
      if (wg && typeof wg.getControlGroupId === 'function') {
        const gid = String(wg.getControlGroupId() || '').trim();
        if (gid) return gid;
      }
    } catch (_) {
      // ignore and fallback
    }
  }

  // Hard override
  if (fallbackGroupId) return fallbackGroupId;

  // Default
  return control;
};
