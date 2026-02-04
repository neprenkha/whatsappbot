"use strict";

// CV wrapper for OutboundGateway.
// Hub requires module.exports.init(meta).
// OutboundGatewayV1 exports init(meta) as a function.

const init = require("./OutboundGatewayV1");

module.exports = { init };
