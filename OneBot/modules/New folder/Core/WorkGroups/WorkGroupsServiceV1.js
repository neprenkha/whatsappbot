'use strict';

function createServiceV1(meta, cfg, store) {
  let state = store.load();
  if (!state || !Array.isArray(state.groups)) state = { groups: [] };

  function normName(name) {
    return String(name || '').trim().toLowerCase();
  }

  function listGroups() {
    return state.groups.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  function setGroup(name, chatId) {
    const n = normName(name);
    if (!n) return { ok: false, err: 'Missing group name' };
    if (!chatId) return { ok: false, err: 'Missing chatId' };

    const existing = state.groups.find(g => normName(g.name) === n);
    if (existing) {
      existing.chatId = chatId;
      existing.name = String(name).trim();
    } else {
      state.groups.push({ name: String(name).trim(), chatId });
    }
    store.save(state);
    return { ok: true };
  }

  function delGroup(name) {
    const n = normName(name);
    const before = state.groups.length;
    state.groups = state.groups.filter(g => normName(g.name) !== n);
    if (state.groups.length === before) return { ok: false, err: 'Not found' };
    store.save(state);
    return { ok: true };
  }

  function getGroupForChatId(chatId) {
    return state.groups.find(g => String(g.chatId) === String(chatId)) || null;
  }

  return { listGroups, setGroup, delGroup, getGroupForChatId };
}

module.exports = { createServiceV1 };
