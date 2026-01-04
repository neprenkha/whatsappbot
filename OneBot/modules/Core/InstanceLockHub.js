"use strict";

/**
 * InstanceLockHub.js (FROZEN HUB LOADER)
 * - Hub stays in Modules/Core root.
 * - Loads active impl from hubConf (implFile + implConfig).
 */

const path = require("path");

module.exports.init = async function init(meta) {
  const hubConf = meta.hubConf || {};
  const enabledRaw = String(hubConf.enabled ?? "1").trim().toLowerCase();
  const enabled = !(enabledRaw === "0" || enabledRaw === "false" || enabledRaw === "off");

  if (!enabled) {
    return {
      onEvent: async () => {},
      onMessage: async () => {},
    };
  }

  const implFile = String(hubConf.implFile || "Modules/Core/InstanceLock/InstanceLockCV.js").trim();
  const implConfig = String(hubConf.implConfig || "modules/Core/Impl/InstanceLockCV.conf").trim();

  let impl;
  try {
    impl = require(path.join(meta.codeRoot, implFile));
  } catch (e) {
    meta.log(
      "loader",
      `module.error id=${meta.id} err=Require failed file=${implFile} msg=${e.message}`
    );
    throw e;
  }

  const cfg = implConfig ? meta.loadConfRel(implConfig) : { absPath: "", conf: {} };

  if (!impl || typeof impl.init !== "function") {
    throw new Error(`InstanceLock impl missing init(): ${implFile}`);
  }

  return impl.init({
    ...meta,
    implConf: (cfg && cfg.conf) || {},
    implConfPath: (cfg && cfg.absPath) || "",
  });
};
