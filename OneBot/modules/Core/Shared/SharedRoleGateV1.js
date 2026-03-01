'use strict';

// SharedRoleGateV1
// Purpose: central role/permission check helper (no listeners).
// Tries multiple service names to avoid config mismatch.

function pickAccessService(meta, preferredName) {
  const tryNames = [];
  if (preferredName) tryNames.push(String(preferredName));
  tryNames.push('accessroles', 'accessRoles', 'access', 'roles');

  for (const n of tryNames) {
    const svc = meta.getService(n);
    if (svc) return svc;
  }
  return null;
}

function normalizeRole(role) {
  const r = String(role || '').trim().toLowerCase();
  return r;
}

function isAllowed(meta, accessServiceName, senderId, requiredRole) {
  const req = normalizeRole(requiredRole);
  if (!req) return true;

  const access = pickAccessService(meta, accessServiceName);
  if (!access) return true; // fail-open (avoid breaking control group if roles misconfigured)

  try {
    if (typeof access.hasAtLeast === 'function') {
      return !!access.hasAtLeast(senderId, req);
    }
    if (typeof access.hasRole === 'function') {
      return !!access.hasRole(senderId, req);
    }
  } catch (_) {}
  return true;
}

module.exports = {
  isAllowed,
  pickAccessService,
};
