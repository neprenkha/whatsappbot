'use strict';

function text(value) {
  return String(value ?? '').trim();
}

function applyTemplate(template, vars) {
  let out = String(template || '');
  Object.keys(vars).forEach((name) => {
    out = out.split(`{${name}}`).join(String(vars[name] ?? ''));
  });
  return out;
}

module.exports = {
  init: async function init(meta, cfg) {
    const template = text(cfg.ticketCardTemplate);

    return {
      render: async function render(data) {
        return applyTemplate(template, {
          TICKETID: text(data.ticketId),
          CUSTOMER: text(data.customerChatId),
          NAME: text(data.customerName),
          STATUS: text(data.status),
          TIME: text(data.time),
          COUNT: String(data.messageCount || 0),
          LASTTEXT: text(data.lastText),
        });
      },
    };
  },
};