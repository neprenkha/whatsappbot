"use strict";

const fs = require("fs");
const path = require("path");

// Ticket format (LOCKED): YYMM + Prefix + 7 digits
// Example: 2601T0000001

function str(v, d) {
  if (v === undefined || v === null) return d;
  const s = String(v);
  return s.length ? s : d;
}

function int(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

function pad(num, width) {
  let s = String(num);
  while (s.length < width) s = "0" + s;
  return s;
}

function yymm(now) {
  const y = now.getFullYear() % 100;
  const m = now.getMonth() + 1;
  return pad(y, 2) + pad(m, 2);
}

function ensureDir(dirPath) {
  if (!dirPath) return;
  if (fs.existsSync(dirPath)) return;
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonSafe(filePath, defVal) {
  try {
    if (!fs.existsSync(filePath)) return defVal;
    const txt = fs.readFileSync(filePath, "utf8");
    if (!txt) return defVal;
    const obj = JSON.parse(txt);
    return obj && typeof obj === "object" ? obj : defVal;
  } catch (e) {
    return defVal;
  }
}

function writeJsonSafe(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

function seqFilePath(meta, cfg) {
  // Keep this data-driven.
  // Default under bot dataRoot if not configured.
  const botName = str(meta && meta.botName, "ONEBOT");
  const rel = str(cfg.ticketSequenceFile, "bots/" + botName + "/data/Fallback/ticket-seq.json");
  return path.isAbsolute(rel) ? rel : path.join(meta.dataRoot || "", rel);
}

function nextTicketId(meta, cfg, now) {
  const prefix = str(cfg.ticketPrefix, "T");
  const digits = int(cfg.ticketSeqDigits, 7);
  const filePath = seqFilePath(meta, cfg);
  const state = readJsonSafe(filePath, {});

  const p = yymm(now) + prefix;
  const cur = int(state[p], 0) + 1;
  state[p] = cur;
  writeJsonSafe(filePath, state);

  return p + pad(cur, digits);
}

module.exports = {
  // Keep signature stable: (meta, cfg, now)
  next(meta, cfg, now) {
    const t = now instanceof Date ? now : new Date();
    return nextTicketId(meta, cfg || {}, t);
  },
};
