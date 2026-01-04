'use strict';

// SharedIdentityV1
// Normalization helpers for phone + lid ids.

function extractDigits(input) {
  if (input === undefined || input === null) return '';
  const s = String(input);
  const m = s.match(/\d+/g);
  return m ? m.join('') : '';
}

function normalizePhone(input) {
  const d = extractDigits(input);
  if (!d) return '';
  // Malaysia-friendly normalization:
  // - "+6012..." -> "6012..."
  // - "012..."   -> "60" + "12..."
  if (d.startsWith('60')) return d;
  if (d.startsWith('0') && d.length >= 9) return '60' + d.slice(1);
  return d;
}

function normalizeLid(input) {
  if (input === undefined || input === null) return '';
  const raw = String(input).trim();

  if (!raw) return '';

  const low = raw.toLowerCase();

  // "lid:123"
  if (low.startsWith('lid:')) {
    const d = extractDigits(low.slice(4));
    return d ? ('lid:' + d) : '';
  }

  // "123@lid"
  if (low.endsWith('@lid')) {
    const d = extractDigits(low.slice(0, -4));
    return d ? ('lid:' + d) : '';
  }

  // "LID:123"
  if (low.startsWith('lid')) {
    const d = extractDigits(low);
    return d ? ('lid:' + d) : '';
  }

  // digits only -> treat as lid if it looks like lid-length
  const d = extractDigits(low);
  if (d && d.length >= 10) return 'lid:' + d;

  return '';
}

function normalizeSender(senderId) {
  // senderId might be:
  // - "60123456789"
  // - "lid:123..."
  // - "123...@lid"
  const lid = normalizeLid(senderId);
  if (lid) return { senderId: lid, lid, phone: '' };

  const phone = normalizePhone(senderId);
  if (phone) return { senderId: phone, lid: '', phone };

  const s = (senderId === undefined || senderId === null) ? '' : String(senderId).trim();
  return { senderId: s, lid: '', phone: '' };
}

function maskPhone(phone) {
  const p = normalizePhone(phone);
  if (!p) return '';
  if (p.length <= 6) return p;
  return p.slice(0, 3) + '****' + p.slice(-3);
}

module.exports = {
  extractDigits,
  normalizePhone,
  normalizeLid,
  normalizeSender,
  maskPhone
};
