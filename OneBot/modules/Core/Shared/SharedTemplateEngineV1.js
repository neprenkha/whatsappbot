'use strict';

const fs = require('fs');

function loadText(filePath) {
  if (!filePath) return '';
  try { return fs.readFileSync(String(filePath), 'utf8'); } catch (_) { return ''; }
}

function render(templateText, vars) {
  const t = String(templateText || '');
  const v = vars || {};
  return t.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const val = v[key];
    return (val === undefined || val === null) ? '' : String(val);
  });
}

module.exports = { loadText, render };
