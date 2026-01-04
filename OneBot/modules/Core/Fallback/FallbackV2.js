// FallbackV2.js (ticket + quote-reply bridge)
// - Forward customer DM -> active fallback group (WorkGroups active.fallback if set)
// - Reuse ONE ticket per customer within reuseWindowSec
// - Reply from group by QUOTE (right-click reply) sends back to customer
// - Uses template file (NO hardcoded layout)

const fs = require('fs');
const path = require('path');

function toInt(v, d) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : d;
}
function toStr(v, d='') {
  const s = (v === undefined || v === null) ? '' : String(v);
  return s.trim() ? s.trim() : d;
}
function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}
function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}
function isGroupId(x) {
  return toStr(x).endsWith('@g.us');
}
function isCusId(x) {
  return toStr(x).endsWith('@c.us');
}
function nowIso() {
  return new Date().toISOString();
}

function pickSend(meta) {
  const prefer = toStr(meta.implConf?.sendPrefer, 'outsend,sendout,send').split(',').map(s => s.trim()).filter(Boolean);
  for (const n of prefer) {
    if (typeof meta.services[n] === 'function') return meta.services[n];
  }
  if (typeof meta.services.send === 'function') return meta.services.send;
  return async (chatId, content, options) => meta.services.transport.sendDirect(chatId, content, options);
}

// ticket: YYMMT####### (matches your logs like 2512T7053887)
function makeTicketId() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const rand = String(Math.floor(Math.random() * 10000000)).padStart(7, '0');
  return `${yy}${mm}T${rand}`;
}

function extractTicket(text) {
  const s = toStr(text, '');
  const m = s.match(/\b\d{4}T\d{7}\b/);
  return m ? m[0] : '';
}

function resolvePath(meta, p, kind) {
  const raw = toStr(p, '');
  if (!raw) return '';
  if (path.isAbsolute(raw)) return raw;

  const dataDir = meta.paths?.dataDir || process.cwd();
  const configDir = meta.paths?.configDir || ''; // may exist in your kernel
  const cands = [];

  if (configDir) {
    cands.push(path.join(configDir, raw));
    cands.push(path.join(configDir, 'ui', raw));
  }
  cands.push(path.join(dataDir, raw));
  cands.push(path.join(process.cwd(), raw));

  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  // fallback
  if (kind === 'data') return path.join(dataDir, raw);
  return path.join(process.cwd(), raw);
}

// TEMPLATE format:
// [NEW]
// ... {{TICKET}} {{FROM_PHONE}} {{TEXT}} ...
// [UPDATE]
// ...
// [ACK]
// ...
function loadTemplates(file) {
  const out = {};
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    let cur = '';
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*\[(NEW|UPDATE|ACK)\]\s*$/i);
      if (m) {
        cur = m[1].toUpperCase();
        out[cur] = '';
        continue;
      }
      if (!cur) continue;
      out[cur] += line + '\n';
    }
  } catch (_) {}
  return out;
}

function applyTokens(tpl, vars) {
  let s = tpl || '';
  for (const k of Object.keys(vars)) {
    const v = (vars[k] === undefined || vars[k] === null) ? '' : String(vars[k]);
    s = s.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
  }
  return s.trim();
}

module.exports = function init(meta) {
  const tag = 'FallbackV2';

  const enabled = toInt(meta.implConf?.enabled, 1) === 1;
  const controlGroupId = toStr(meta.implConf?.controlGroupId, '');
  const reuseWindowSec = toInt(meta.implConf?.reuseWindowSec, 21600);
  const allowReplyInGroups = toInt(meta.implConf?.allowReplyInGroups, 1) === 1;
  const replyAck = toInt(meta.implConf?.replyAck, 1) === 1;

  const dataDir = meta.paths?.dataDir || process.cwd();
  const stateRel = toStr(meta.implConf?.stateFile, 'Fallback/state.json');
  const stateFile = resolvePath(meta, stateRel, 'data');

  const templateRel = toStr(meta.implConf?.templateFile, 'ticketsquence.txt');
  const templateFile = resolvePath(meta, templateRel, 'config');

  let templates = loadTemplates(templateFile);
  if (!templates.NEW) templates.NEW = '';
  if (!templates.UPDATE) templates.UPDATE = '';
  if (!templates.ACK) templates.ACK = '';

  let state = readJson(stateFile, {
    byCustomer: {}, // chatId -> { ticket, lastAt, phone, name, label }
    tickets: {}     // ticket -> { customerChatId, createdAt, lastAt, seq }
  });

  function save() { writeJson(stateFile, state); }

  function getActiveFallbackGroupId() {
    const wg = meta.services.workgroups;
    if (wg && typeof wg.getActiveFallbackId === 'function') {
      const gid = toStr(wg.getActiveFallbackId(), '');
      if (isGroupId(gid)) return gid;
    }
    return isGroupId(controlGroupId) ? controlGroupId : '';
  }

  function isAllowedWorkGroup(chatId) {
    if (!isGroupId(chatId)) return false;
    const wg = meta.services.workgroups;
    if (wg && typeof wg.isAllowedGroup === 'function') {
      return !!wg.isAllowedGroup(chatId);
    }
    // fallback: only the active fallback group
    return chatId === getActiveFallbackGroupId();
  }

  function upsertTicketForCustomer(customerChatId, phone, name) {
    const now = Date.now();
    const rec = state.byCustomer[customerChatId];

    if (rec && rec.ticket && rec.lastAt && (now - rec.lastAt) <= (reuseWindowSec * 1000)) {
      rec.lastAt = now;
      rec.phone = phone || rec.phone || '';
      rec.name = name || rec.name || '';
      state.byCustomer[customerChatId] = rec;

      const t = state.tickets[rec.ticket];
      if (t) {
        t.lastAt = now;
        t.seq = toInt(t.seq, 0);
        t.seq += 1;
        state.tickets[rec.ticket] = t;
      }
      save();
      return { ticket: rec.ticket, isNew: false, seq: state.tickets[rec.ticket]?.seq || 1 };
    }

    let ticket = makeTicketId();
    while (state.tickets[ticket]) ticket = makeTicketId();

    state.byCustomer[customerChatId] = {
      ticket,
      lastAt: now,
      phone: phone || '',
      name: name || '',
      label: ''
    };
    state.tickets[ticket] = {
      customerChatId,
      createdAt: now,
      lastAt: now,
      seq: 1
    };
    save();
    return { ticket, isNew: true, seq: 1 };
  }

  const send = pickSend(meta);

  async function sendToGroup(groupId, text) {
    if (!groupId) return false;
    return send(groupId, text, {});
  }

  async function sendToCustomer(customerChatId, content, options) {
    return send(customerChatId, content, options || {});
  }

  async function downloadMediaIfAny(msg) {
    try {
      if (!msg) return null;
      // Check for any media type: hasMedia (image/video/audio), hasDocument, or type property
      const hasAnyMedia = msg.hasMedia || msg.hasDocument || 
                         (msg.type && ['image', 'video', 'audio', 'document', 'ptt', 'sticker'].includes(msg.type));
      if (!hasAnyMedia) return null;
      if (typeof msg.downloadMedia !== 'function') return null;
      return await msg.downloadMedia();
    } catch (e) {
      // Log download error for debugging
      if (meta && meta.log) {
        meta.log(tag, `downloadMedia error: ${e && e.message ? e.message : e}`);
      }
      return null;
    }
  }

  function buildVars(ctx, ticket, mode, seq, extra) {
    const phone = toStr(ctx.sender?.phone, '');
    const name = toStr(ctx.sender?.name, '');
    const chatId = toStr(ctx.chatId, '');
    const time = nowIso();

    return {
      MODE: mode,
      TICKET: ticket,
      SEQ: seq,
      FROM_PHONE: phone,
      FROM_NAME: name,
      FROM_CHATID: chatId,
      TIME: time,
      TEXT: toStr(ctx.text, ''),
      LABEL: toStr(extra?.label, ''),
      ATTACH_COUNT: toStr(extra?.attachCount, '0'),
      ATTACH_TYPES: toStr(extra?.attachTypes, '')
    };
  }

  function defaultCard(vars, isNew) {
    const title = isNew ? '🟠 NEW INBOUND' : '🟡 UPDATE';
    const tips = [
      'Tips:',
      '- Reply (quote) this message in group to send back to customer (no need type !)',
      `- Or: !r ${vars.TICKET} your text`
    ].join('\n');

    return [
      title,
      `🎫 Ticket: ${vars.TICKET}`,
      `👤 From: ${vars.FROM_NAME || '-'} (${vars.FROM_PHONE || '-'})`,
      `🆔 ChatId: ${vars.FROM_CHATID}`,
      `🕒 Time: ${vars.TIME}`,
      vars.TEXT ? `📝 Text:\n${vars.TEXT}` : '📝 Text: (none)',
      vars.ATTACH_COUNT !== '0' ? `📎 Attachments: ${vars.ATTACH_COUNT} ${vars.ATTACH_TYPES ? '(' + vars.ATTACH_TYPES + ')' : ''}` : '',
      '',
      tips
    ].filter(Boolean).join('\n');
  }

  async function handleInboundCustomer(ctx) {
    if (!enabled) return;
    if (ctx.message && ctx.message.fromMe) return;
    if (ctx.isGroup) return;
    if (!isCusId(ctx.chatId)) return;

    const ticketInfo = upsertTicketForCustomer(
      ctx.chatId,
      toStr(ctx.sender?.phone, ''),
      toStr(ctx.sender?.name, '')
    );

    const groupId = getActiveFallbackGroupId();
    if (!groupId) return;

    const msg = ctx.message;

    // Enhanced media detection and type identification
    const media = await downloadMediaIfAny(msg);
    const attachTypes = [];
    let attachCount = 0;

    if (media) {
      attachCount += 1;
      // Determine media type from message
      let mediaType = 'media';
      if (msg && msg.type) {
        mediaType = msg.type; // image, video, audio, document, ptt, sticker
      } else if (msg && msg.hasDocument) {
        mediaType = 'document';
      } else if (media.mimetype) {
        // Fallback: detect from mimetype
        if (media.mimetype.startsWith('image/')) mediaType = 'image';
        else if (media.mimetype.startsWith('video/')) mediaType = 'video';
        else if (media.mimetype.startsWith('audio/')) mediaType = 'audio';
        else mediaType = 'document';
      }
      attachTypes.push(mediaType);
    }

    const vars = buildVars(ctx, ticketInfo.ticket, ticketInfo.isNew ? 'NEW' : 'UPDATE', ticketInfo.seq, {
      attachCount,
      attachTypes: attachTypes.join(',')
    });

    let card = '';
    if (ticketInfo.isNew && templates.NEW) {
      card = applyTokens(templates.NEW, vars);
    } else if (!ticketInfo.isNew && templates.UPDATE) {
      card = applyTokens(templates.UPDATE, vars);
    }

    if (!card) card = defaultCard(vars, ticketInfo.isNew);

    await sendToGroup(groupId, card);

    // forward media as separate message under same ticket
    if (media) {
      const caption = `📎 Ticket ${ticketInfo.ticket} (seq ${ticketInfo.seq}) [${attachTypes[0] || 'media'}]`;
      await send(groupId, media, { caption });
    }
  }

  async function replyAckToGroup(groupId, ticket, ok, note) {
    if (!replyAck) return;
    const tpl = templates.ACK || '';
    const base = tpl.trim()
      ? applyTokens(tpl, { TICKET: ticket, STATUS: ok ? 'SENT' : 'FAILED', NOTE: note || '' })
      : `${ok ? '✅ Sent' : '❌ Failed'} (Ticket ${ticket})${note ? '\n' + note : ''}\n\nTips:\n- Reply (quote) fallback card\n- !r <ticket> <text>`;

    await sendToGroup(groupId, base);
  }

  async function handleGroupReply(ctx) {
    if (!enabled) return;
    if (!allowReplyInGroups) return;
    if (!ctx.isGroup) return;
    if (ctx.message && ctx.message.fromMe) return;

    if (!isAllowedWorkGroup(ctx.chatId)) return;

    const msg = ctx.message;
    const text = toStr(ctx.text, '');

    // command fallback: !r <ticket> <text>
    if (text.toLowerCase().startsWith('!r ')) {
      const parts = text.trim().split(/\s+/);
      const ticket = toStr(parts[1], '');
      const body = text.split(/\s+/).slice(2).join(' ').trim();
      if (!ticket || !state.tickets[ticket] || !body) {
        return replyAckToGroup(ctx.chatId, ticket || '-', false, 'Usage: !r <ticket> <text>');
      }
      const customerChatId = state.tickets[ticket].customerChatId;
      try {
        await sendToCustomer(customerChatId, body, {});
        return replyAckToGroup(ctx.chatId, ticket, true, '');
      } catch (e) {
        return replyAckToGroup(ctx.chatId, ticket, false, e && e.message ? e.message : String(e));
      }
    }

    // quote-reply (right click reply) -> detect ticket from quoted message text
    let quotedText = '';
    try {
      if (msg && msg.hasQuotedMsg && typeof msg.getQuotedMessage === 'function') {
        const q = await msg.getQuotedMessage();
        quotedText = q && typeof q.body === 'string' ? q.body : '';
      }
    } catch (_) {}

    const ticketFromQuote = extractTicket(quotedText);
    if (!ticketFromQuote) return;

    const t = state.tickets[ticketFromQuote];
    if (!t || !t.customerChatId) {
      return replyAckToGroup(ctx.chatId, ticketFromQuote, false, 'Ticket not found');
    }

    const customerChatId = t.customerChatId;

    try {
      const media = await downloadMediaIfAny(msg);
      if (media) {
        const cap = text ? text : '';
        // Enhanced: log media type being sent
        let mediaType = 'media';
        if (msg && msg.type) mediaType = msg.type;
        else if (msg && msg.hasDocument) mediaType = 'document';
        meta.log && meta.log(tag, `sending ${mediaType} to customer ticket=${ticketFromQuote} chatId=${customerChatId}`);
        await sendToCustomer(customerChatId, media, cap ? { caption: cap } : {});
      } else if (text) {
        await sendToCustomer(customerChatId, text, {});
      } else {
        return replyAckToGroup(ctx.chatId, ticketFromQuote, false, 'No content (text/media) to send');
      }

      return replyAckToGroup(ctx.chatId, ticketFromQuote, true, '');
    } catch (e) {
      return replyAckToGroup(ctx.chatId, ticketFromQuote, false, e && e.message ? e.message : String(e));
    }
  }

  meta.log(tag, `ready enabled=${enabled ? 1 : 0} controlGroupId=${controlGroupId} template=${toStr(meta.implConf?.templateFile, 'ticketsquence.txt')}`);

  return {
    onMessage: async (ctx) => {
      // Expect ctx fields from your kernel: chatId, isGroup, sender{phone,name}, text, message(raw)
      try {
        if (ctx.isGroup) return handleGroupReply(ctx);
        return handleInboundCustomer(ctx);
      } catch (e) {
        meta.log(tag, `onMessage error: ${e && e.message ? e.message : e}`);
      }
    },
    onEvent: async () => {}
  };
};
