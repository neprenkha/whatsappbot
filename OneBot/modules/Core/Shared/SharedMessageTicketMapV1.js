'use strict';

/*
  SharedMessageTicketMapV1.js
  - In-memory mapping of group message IDs to ticket IDs
  - Used to resolve tickets from quoted messages in control group
  - Auto-expires old entries to prevent memory bloat
*/

// Map: messageId -> { ticketId, timestamp }
const messageMap = new Map();
let setCounter = 0; // Track total sets regardless of deletions

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function cleanupOld(ttlMs = DEFAULT_TTL_MS) {
  const now = Date.now();
  const cutoff = now - ttlMs;
  
  for (const [msgId, entry] of messageMap.entries()) {
    if (entry.timestamp < cutoff) {
      messageMap.delete(msgId);
    }
  }
}

function extractMessageId(msgObj) {
  if (!msgObj) return '';
  
  // Direct id property
  if (msgObj.id && typeof msgObj.id === 'string') {
    return String(msgObj.id).trim();
  }
  
  // Nested in _data.id._serialized (whatsapp-web.js format)
  if (msgObj._data && msgObj._data.id) {
    if (msgObj._data.id._serialized) {
      return String(msgObj._data.id._serialized).trim();
    }
    if (typeof msgObj._data.id === 'string') {
      return String(msgObj._data.id).trim();
    }
  }
  
  return '';
}

function set(messageId, ticketId) {
  if (!messageId || !ticketId) return;
  
  const id = String(messageId).trim();
  const ticket = String(ticketId).trim();
  
  if (!id || !ticket) return;
  
  messageMap.set(id, {
    ticketId: ticket,
    timestamp: Date.now()
  });
  
  // Cleanup old entries periodically (every 100th set)
  setCounter++;
  if (setCounter % 100 === 0) {
    cleanupOld();
  }
}

function setFromResult(resultObj, ticketId) {
  if (!resultObj || !ticketId) return;
  
  const msgId = extractMessageId(resultObj);
  if (msgId) {
    set(msgId, ticketId);
    return msgId;
  }
  
  return '';
}

function get(messageId) {
  if (!messageId) return null;
  
  const id = String(messageId).trim();
  const entry = messageMap.get(id);
  
  if (!entry) return null;
  
  // Check if expired
  const age = Date.now() - entry.timestamp;
  if (age > DEFAULT_TTL_MS) {
    messageMap.delete(id);
    return null;
  }
  
  return entry.ticketId || null;
}

function clear() {
  messageMap.clear();
  setCounter = 0; // Reset counter for consistent cleanup behavior
}

function size() {
  return messageMap.size;
}

module.exports = {
  set,
  setFromResult,
  get,
  clear,
  size,
  cleanupOld,
  extractMessageId
};