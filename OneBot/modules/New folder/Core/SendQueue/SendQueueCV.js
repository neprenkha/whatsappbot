'use strict';

// SendQueueCV.js (Core)
// Stable implementation for SendQueue. Loaded by SendQueueHub.js (freeze).
// Note: Supports both new structure (files in same folder) and legacy structure (SendQueueParts/).

function req(primary, fallback) {
  try { return require(primary); } catch (e) { return require(fallback); }
}

const Config = req('./SendQueueConfigV1', './SendQueueParts/SendQueueConfigV1');
const Store = req('./SendQueueStoreV1', './SendQueueParts/SendQueueStoreV1');
const Normalize = req('./SendQueueNormalizeChatIdV1', './SendQueueParts/SendQueueNormalizeChatIdV1');
const Transport = req('./SendQueueTransportAdapterV1', './SendQueueParts/SendQueueTransportAdapterV1');
const Pump = req('./SendQueuePumpV1', './SendQueueParts/SendQueuePumpV1');
const Service = req('./SendQueueServiceV1', './SendQueueParts/SendQueueServiceV1');

module.exports.init = async function init(meta) {
  const cfg = Config.read(meta);

  if (!cfg.enabled) {
    Config.log(meta, cfg, 'disabled enabled=0');
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  const store = Store.create(cfg.maxQueue);
  const tx = Transport.create(meta, cfg.transportService);
  const pump = Pump.create(meta, cfg, store, tx);

  const sendFn = Service.createSend(meta, cfg, store, pump, Normalize);

  if (typeof meta.registerService === 'function') {
    meta.registerService(cfg.serviceName, sendFn);
  }

  pump.start();

  Config.log(
    meta,
    cfg,
    `ready service=${cfg.serviceName} delayMs=${cfg.delayMs} maxQueue=${cfg.maxQueue} batchMax=${cfg.batchMax} dedupeMs=${cfg.dedupeMs || 0}`
  );

  return { onMessage: async () => {}, onEvent: async () => {} };
};
