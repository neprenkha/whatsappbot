'use strict';

/**
 * FallbackForwarderV1
 * - Forwards messages from customers to the control group with deduplication.
 * - Handles media, text, documents and ensures no duplicate tickets are generated.
 */

const SharedTicketCore = require('../Shared/SharedTicketCoreV1');
const SharedSafeSend = require('../Shared/SharedSafeSendV1');
const SharedQuoteUtil = require('../Shared/SharedQuoteUtilV1');
const SharedConf = require('../Shared/SharedConfV1');
const SharedTipsEngine = require('../Shared/SharedTipsEngineV1');

const path = require('path');
const fs = require('fs');

// Paths to configs
const TIPS_PATH = path.resolve(__dirname, '../conf/Tips.conf');
const CONTACTS_PATH = path.resolve(__dirname, '../data/Contact.csv');

const dedupStore = new Map();

function deduplicate(chatId, messageId) {
  const key = `${chatId}:${messageId}`;
  if (dedupStore.has(key)) return true; // Duplicate detected
  dedupStore.set(key, true);
  setTimeout(() => dedupStore.delete(key), 30000); // Auto-clean deduplications after 30 seconds
  return false;
}

/**
 * saveContactNumber
 * - Saves a customer's phone number into contact.csv
 */
function saveContactNumber(customerName, phone) {
  try {
    const contactEntry = `${customerName},${phone}\n`;
    fs.appendFileSync(CONTACTS_PATH, contactEntry, 'utf8');
  } catch (e) {
    console.error('Failed to save contact:', e.message);
  }
}

/**
 * forwardMessage
 * - Main function for forwarding customer messages to the control group.
 */
async function forwardMessage(meta, ctx) {
  const config = meta.implConf || {};
  const controlGroupId = config.controlGroupId || '';

  if (!controlGroupId) {
    meta.log('FallbackForwarderV1', 'Missing control group configuration.');
    return { ok: false, reason: 'control.group.missing' };
  }

  const msg = ctx.message;
  const chatId = msg.chatId;
  const messageId = msg.id;

  if (deduplicate(chatId, messageId)) {
    meta.log('FallbackForwarderV1', 'Duplicate message skipped.');
    return { ok: false, reason: 'duplicate.message' };
  }

  const customerName = ctx.sender.name || 'Unknown';
  const phone = ctx.sender.phone || '';
  const quotedText = await SharedQuoteUtil.buildQuotePreview(msg);

  // Save contact number if template and permission exist
  if (config.autoSaveContacts) {
    saveContactNumber(customerName, phone);
  }

  const ticketInfo = await SharedTicketCore.touch(
    meta,
    config,
    'fallback',
    chatId,
    { fromName: customerName, fromPhone: phone, text: msg.text || '' }
  );

  if (!ticketInfo) {
    meta.log('FallbackForwarderV1', 'Ticket generation failed.');
    return { ok: false, reason: 'ticket.error' };
  }

  let messageToSend = `
    Ticket: ${ticketInfo.ticket}
    Customer: ${customerName}
    Phone: ${phone}
    ChatId: ${chatId}
    
    ${quotedText || msg.text || '[No Text]'}

    Tips: ${SharedTipsEngine.getTips(SharedTipsEngine.loadTipsMap(TIPS_PATH), 'fallback')}
  `;

  // Hide ticket number for non-text messages
  if (msg.hasMedia || msg.hasFile || msg.hasDocument) {
    messageToSend = messageToSend.replace(/Ticket:.+\n/, '');
  }

  const result = await SharedSafeSend.safeSend(meta, SharedSafeSend.pickSend(meta), controlGroupId, messageToSend.trim());
  if (!result.ok) {
    meta.log('FallbackForwarderV1', `Failed to forward message: ${result.error || 'unknown error'}`);
    return result;
  }

  meta.log('FallbackForwarderV1', `Message forwarded successfully for ticket ${ticketInfo.ticket}`);
  return result;
}

module.exports = {
  forwardMessage,
};