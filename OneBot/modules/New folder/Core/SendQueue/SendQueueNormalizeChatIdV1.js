'use strict';

function normalize(chatId) {
  if (!chatId) return '';
  if (typeof chatId === 'string') return chatId.trim();

  if (typeof chatId === 'object') {
    const c =
      chatId.chatId ||
      chatId.id ||
      chatId._serialized ||
      chatId.remoteJid ||
      '';
    return String(c || '').trim();
  }

  return String(chatId).trim();
}

module.exports = { normalize };
