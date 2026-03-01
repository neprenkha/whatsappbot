'use strict';

// SharedPhoneV1.js
// Basic normalizer for WhatsApp numbers like 60123456789

module.exports = {
  normPhone
};

function normPhone(v) {
  if (!v) return '';
  let s = String(v).trim();
  // remove + and spaces
  s = s.replace(/[^0-9]/g, '');
  if (s.startsWith('0')) s = '6' + s; // assume Malaysia default
  if (!s.startsWith('6')) s = '6' + s;
  return s;
}
