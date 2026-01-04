// SendPolicyV1.js
// Enforces outbound sending policies by wrapping/guarding ctx.services.sendout/outsend/send.
//
// HubConf keys (SendPolicy.conf):
// enabled=1
// defaultProfile=normal
// profilesJson=SendPolicyProfiles.json         (relative to confRoot/SendPolicy by default unless absolute)
//
// This module is designed to be SAFE if files are missing: if enabled=0 or profiles missing, it will not block anything.

const fs = require('fs');
const path = require('path');

function toBool(v, defVal = false) {
  if (v === true || v === false) return v;
  if (v === undefined || v === null) return defVal;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on', 'enable', 'enabled'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off', 'disable', 'disabled'].includes(s)) return false;
  return defVal;
}

function safeTag(meta, tag, msg) {
  try {
    if (meta && typeof meta.log === 'function') return meta.log(tag, msg);
  } catch (_) {}
  try { console.log(`[${tag}] ${msg}`); } catch (_) {}
}

function safeReadJson(absPath) {
  try {
    if (!absPath) return null;
    if (!fs.existsSync(absPath)) return null;
    const txt = fs.readFileSync(absPath, 'utf-8');
    return JSON.parse(txt);
  } catch (_) {
    return null;
  }
}

module.exports = {
  init: (meta) => {
    const cfg = (meta && meta.hubConf) ? meta.hubConf : {};
    const enabled = toBool(cfg.enabled, false);

    if (!enabled) {
      safeTag(meta, 'SendPolicyV1', 'disabled: enabled=0');
      return { onMessage: async () => {}, onEvent: async () => {} };
    }

    const confRoot = (meta && typeof meta.confRoot === 'string') ? meta.confRoot : '';
    const defaultProfile = String(cfg.defaultProfile || 'normal');

    // profilesJson path resolution:
    // - If absolute, use as-is
    // - Else default: <confRoot>/SendPolicy/<profilesJson>
    const relProfiles = String(cfg.profilesJson || 'SendPolicyProfiles.json');
    const profilesAbs = path.isAbsolute(relProfiles)
      ? relProfiles
      : path.join(confRoot, 'SendPolicy', relProfiles);

    const profiles = safeReadJson(profilesAbs) || { profiles: {} };
    const profileNames = Object.keys(profiles.profiles || {});

    safeTag(meta, 'SendPolicyV1', `ready enabled=1 defaultProfile=${defaultProfile} profiles=${profileNames.length} file=${profilesAbs}`);

    // This core is a placeholder guard layer for later expansion.
    // For now, it only exposes a helper service "sendpolicy.getProfile" so other modules can read it.
    if (meta && typeof meta.registerService === 'function') {
      meta.registerService('sendpolicy.getProfile', (name) => {
        const n = String(name || defaultProfile);
        return (profiles.profiles && profiles.profiles[n]) ? profiles.profiles[n] : null;
      });
    }

    return {
      onMessage: async () => {},
      onEvent: async () => {},
    };
  },
};
