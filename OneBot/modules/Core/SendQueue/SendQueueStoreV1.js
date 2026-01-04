'use strict';

function create(maxQueue) {
  const q = [];

  function size() {
    return q.length;
  }

  function enqueue(item) {
    if (q.length >= maxQueue) return { ok: false, reason: 'queue.full' };
    q.push(item);
    return { ok: true, size: q.length };
  }

  function peek() {
    return q.length ? q[0] : null;
  }

  function shift() {
    return q.shift();
  }

  return { size, enqueue, peek, shift };
}

module.exports = { create };
