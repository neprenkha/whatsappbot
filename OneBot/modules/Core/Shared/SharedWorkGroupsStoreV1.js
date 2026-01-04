'use strict';

/**
 * SharedWorkGroupsStoreV1
 * - Handles storage, retrieval, and deletion of Work Groups.
 */

const groups = new Map(); // In-memory store for simplicity. Replace with proper persistent storage in production.

module.exports.add = async function add(name, chatId) {
  if (groups.has(name)) {
    return { ok: false, reason: 'group.exists' };
  }
  groups.set(name, { name, chatId });
  return { ok: true };
};

module.exports.list = async function list() {
  return Array.from(groups.values());
};

module.exports.del = async function del(name) {
  if (!groups.has(name)) {
    return { ok: false, reason: 'group.not.found' };
  }
  groups.delete(name);
  return { ok: true };
};