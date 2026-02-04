'use strict';

/**
 * AccessRolesV1.js
 * - Provides basic role access functionality for users and groups.
 */

function createRoleService(meta, options = {}) {
  const roles = options.roles || {};
  const logTag = 'AccessRolesV1';

  return {
    getRole(userId) {
      const role = roles[userId] || 'guest';
      meta.log(logTag, `getRole: userId=${userId} -> role=${role}`);
      return role;
    },

    hasAtLeast(userId, minRole) {
      const roleRank = { guest: 0, staff: 1, admin: 2, controller: 3 };
      const userRole = this.getRole(userId);
      const access = (roleRank[userRole] || 0) >= (roleRank[minRole] || 0);
      meta.log(logTag, `hasAtLeast: userId=${userId} requires=${minRole}, access=${access}`);
      return access;
    },
  };
}

module.exports = {
  init: (meta, options) => {
    const logTag = 'AccessRolesV1';
    const service = createRoleService(meta, options);

    // Register as a service
    meta.registerService('access', service);
    meta.log(logTag, 'Access role service initialized.');

    return { onMessage: async () => {}, onEvent: async () => {} };
  },
};