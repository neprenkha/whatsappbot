"use strict";

const fs = require("fs");
const path = require("path");

function toBool(v, def = false) {
  if (v === undefined || v === null) return def;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return def;
}

function ensureDirSync(p) {
  if (!p) return;
  if (fs.existsSync(p)) return;
  fs.mkdirSync(p, { recursive: true });
}

function isPidAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

module.exports.init = async function init(meta) {
  const conf = meta.implConf || meta.moduleConf || {};

  const enabled = toBool(conf.enabled, true);
  if (!enabled) {
    meta.log("InstanceLockCV", "disabled");
    return { onEvent: async () => {}, onMessage: async () => {} };
  }

  const lockFileRel = String(conf.lockFileRel || "data/InstanceLock/instance.lock");
  const exitCode = Number(conf.exitCode ?? 100);

  const lockAbs = path.join(meta.dataRoot, lockFileRel);
  ensureDirSync(path.dirname(lockAbs));

  if (fs.existsSync(lockAbs)) {
    try {
      const raw = fs.readFileSync(lockAbs, "utf-8");
      const prevPid = parseInt(String(raw).trim(), 10);

      if (isPidAlive(prevPid)) {
        meta.log("InstanceLockCV", `lock exists pid=${prevPid} file=${lockAbs} -> exitCode=${exitCode}`);
        process.exit(exitCode);
      }
    } catch {
      // ignore, will overwrite lock
    }
  }

  fs.writeFileSync(lockAbs, String(process.pid), "utf-8");
  meta.log("InstanceLockCV", `lock acquired pid=${process.pid} file=${lockAbs}`);

  const cleanup = () => {
    try {
      if (fs.existsSync(lockAbs)) {
        const raw = fs.readFileSync(lockAbs, "utf-8");
        const pidInFile = parseInt(String(raw).trim(), 10);
        if (pidInFile === process.pid) fs.unlinkSync(lockAbs);
      }
    } catch {
      // ignore
    }
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  return { onEvent: async () => {}, onMessage: async () => {} };
};
