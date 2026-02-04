"use strict";

// CV wrapper for Outbox.
// Hub requires module.exports.init(meta).
// OutboxV1 exports init(meta) as a function.

const init = require("./OutboxV1");

module.exports = { init };
