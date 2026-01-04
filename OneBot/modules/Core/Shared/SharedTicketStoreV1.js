'use strict';

/**
 * SharedTicketStoreV1
 * - Handles loading and saving ticket data to persistent storage.
 */

const fs = require('fs');
const path = require('path');

module.exports.load = async function load(meta, cfg, storeSpec) {
  const filePath = path.resolve(meta.baseDir, storeSpec);
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    meta.log('SharedTicketStoreV1', `Failed to load ticket store: ${error.message}`);
    return {}; // Return an empty document if loading fails
  }
};

module.exports.save = async function save(meta, cfg, storeSpec, doc) {
  const filePath = path.resolve(meta.baseDir, storeSpec);
  try {
    fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf8');
    meta.log('SharedTicketStoreV1', `Ticket store saved: ${filePath}`);
    return { ok: true };
  } catch (error) {
    meta.log('SharedTicketStoreV1', `Failed to save ticket store: ${error.message}`);
    return { ok: false, error };
  }
};