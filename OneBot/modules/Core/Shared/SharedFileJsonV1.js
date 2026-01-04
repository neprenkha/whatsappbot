'use strict';

const fs = require('fs');
const path = require('path');

function ensureDirForFile(filePath) {
  if (!filePath) throw new Error('ensureDirForFile: filePath is empty');
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonFile(filePath, fallback = null) {
  if (!filePath) return fallback;
  try {
    const txt = fs.readFileSync(filePath, 'utf8');
    if (!txt.trim()) return fallback;
    return JSON.parse(txt);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return fallback;
    throw e;
  }
}

function atomicWriteJson(filePath, obj) {
  if (!filePath) throw new Error('atomicWriteJson: filePath is empty');
  ensureDirForFile(filePath);

  const tmpPath = filePath + '.tmp';
  const data = JSON.stringify(obj, null, 2);

  fs.writeFileSync(tmpPath, data, 'utf8');
  // On Windows, rename over existing can fail; unlink first for safety.
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {}
  fs.renameSync(tmpPath, filePath);
}

module.exports = {
  ensureDirForFile,
  readJsonFile,
  atomicWriteJson
};
