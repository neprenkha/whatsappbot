ONEBOT WHATSAPP BOT - BUILD INTENT + MODULE CONTRACTS (README FOR CODEX)
ASCII ONLY. THIS DOCUMENT IS THE SOURCE OF TRUTH FOR WHAT THIS BUILD IS TRYING TO BE.

0) SOURCE PRECEDENCE AND REJECTED PATTERN RULE
This README is the current build contract.

When old PDFs, old AI answers, current README, live test, and latest user correction conflict:
- latest user correction wins
- latest live-tested behavior wins
- current README wins over old AI suggestions
- repo active pointer scan wins over guessed file paths
- old AI mistakes must not be treated as approved features

Old session PDFs, uploaded TXT trackers/specs, fullrules, and latest live test notes are historical evidence.
They must be used to collect the user's intended features, latest corrections, and rejected mistakes.

Rejected patterns must not be reintroduced:
- V1/V2/V3/V* runtime/reference usage
- hardcoded IDs/text/prefix/timezone/template paths
- customer auto-ack in main fallback inbox flow
- exposing ticket id to customer
- old fallback layout:
  Ticket <ticket> from <chatId> (<chatId>) count=<n>
- using Tips.conf as fallback card layout without active config pointer
- double control-group message for one inbound burst
- manual/human messages blocked by AUTO policy
- random/unbound group responses
- summary-only/diff-only/truncated Codex output marked as copyable

1) PURPOSE (WHAT THIS BOT IS)
ONEBOT is a WhatsApp operations bot for handling customer messages, internal staff workflow, ticketing, and controlled outbound automation.

ONEBOT must:
- Receive inbound customer messages (DM) and ensure they are not missed.
- Create or reuse an open ticket for customer DM conversations.
- Route customer conversations into the configured internal control/work group workflow.
- Post a clear internal inbox card/message for staff to review and reply.
- Enable staff to reply manually from the internal group back to the customer with auditability.
- Support customer text, image, document, audio, voice/ptt, video, and captions in the fallback workflow.
- Separate customer inbox traffic from status/broadcast/system noise and internal chatter.
- Use the single outbound pipeline so messages are queued, paced, retried, and never silently dropped.

The main customer inbox flow must not auto-reply to the customer.
For normal customer DM fallback:
- Customer must not receive immediate acknowledgement.
- Customer must not receive ticket id.
- Customer must not receive bot/system text unless an explicitly approved AUTO workflow sends it.

Automations are allowed only as separate AUTO workflows, such as scheduled followups, promos, birthday wishes, payment reminders, and approved reminders.
All AUTO sends must be:
- clearly marked as AUTO,
- sent through the global outbound pipeline,
- rate-limited,
- blocked while the customer is actively chatting when active-chat policy applies,
- audited,
- never allowed to block or limit manual staff replies.

Manual staff replies are human actions and must never be blocked by AUTO rate limits, quiet windows, active-chat blocks, or schedule policy.

2) LOCKED RULES (NON-NEGOTIABLE)
R1. ASCII ONLY
- All code, config, and templates must be ASCII only.
- No emoji, smart quotes, ellipsis, bullets, non-ASCII symbols.

R2. ZERO HARDCODE
- No hardcoded groupId/chatId/phone numbers in JS.
- No hardcoded user-facing text in JS (must come from templates/config).
- No hardcoded template paths (must come from config).
- No hardcoded command prefix in logic (prefix is single-source in GlobalCV.conf).

R3. CANONICAL KEYNAMES ONLY
- Scan current repo .conf files first.
- Reuse the existing same-function keyname already used in the repo.
- If no same-function key exists in repo .conf, use keyname.conf.txt as a reference/library.
- If the key is still missing after repo scan and keyname.conf.txt lookup, propose the new key and STOP.
- Do not silently add new keynames.
- Do not create alias keys for the same concept.
- Do not duplicate keys.
- Do not rename existing keys silently.
- One canonical key per concept.

R4. CONFIG STANDARD (LOCKED)
- ASCII only
- Comment-only header
- Append-only (do not rename keys, do not reorder, do not duplicate keys)
- One canonical key per concept

R5. FOUNDATION IS FROZEN
Do NOT edit these unless explicitly required:
- Start.cmd
- OneBot/Kernel.js
- OneBot/Connector.js
- Any *Hub.js loader files

R6. CV-ONLY RUNTIME
- Each active module has ONE active implementation: CV.
- Active runtime must not require, import, load, or depend on V1/V2/V3/V* implementation files.
- The current build is expected to have no V1/V2/V3/V* runtime implementation files.
- If any V1/V2/V3/V* script is found during repo scan, treat it as stray legacy residue.
- Do not import it.
- Do not reference it.
- Do not port behavior from it.
- Do not use it to justify changes.
- Report the exact file path and STOP unless the user explicitly approves cleanup.
- Current repo active pointer chain is the source of truth:
  <Module>.conf -> <Module>Hub.conf -> implFile + implConfig
- Any active pointer to V1/V2/V3/V* is a critical runtime violation and must be reported before fixes.

R7. OUTBOUND MUST USE SINGLE GLOBAL PIPELINE
- No sendDirect bypass.
- Must queue (SendQueue -> Outbox -> OutboundGateway -> Connector) and never silently drop.
- Rate limit must queue and delay, not drop.
- Manual staff messages must not be blocked.
- Human/manual messages must not be blocked by time, day, night, quiet window, active-chat rule, AUTO schedule rule, or AUTO rate policy.
- Human/manual messages include staff replies, admin replies, owner actions, and manually selected media/files.
- Manual bulk media/files may queue briefly only for real transport collision, but must not be dropped or collapsed.
- Only AUTO/scheduled messages may be policy-limited.

R8. FALLBACK ARCHITECTURE IS LOCKED (4x4)
No cross-calls between handlers. Router is the firewall.
- Forward x (Router / Text / Media / AV)
- Reply   x (Router / Text / Media / AV)

3) REPO LAYOUT (CONCEPTUAL)
- OneBot/ : code
- OneData/bots/ONEBOT/config/ : configuration and templates
- OneData/bots/ONEBOT/config/modules/Core/ : module entries and hub pointers
- OneData/bots/ONEBOT/config/modules/Core/Impl/ : per-module implementation config (CV)
- OneData/bots/ONEBOT/config/ui/ : user-facing templates (ASCII only)
- OneData/bots/ONEBOT/data/ : persistent stores (JsonStore/Module state)
- OneData/bots/ONEBOT/logs/ : logs

4) MODULE STANDARD (HOW A MODULE IS WIRED)
Standard files (paths and names must remain consistent):
1) OneBot/modules/Core/<Module>Hub.js                       (FROZEN LOADER)
2) OneBot/modules/Core/<Module>/<Module>CV.js              (ACTIVE IMPLEMENTATION)
3) OneData/bots/ONEBOT/config/modules/Core/<Module>.conf    (ENTRY CONF)
4) OneData/bots/ONEBOT/config/modules/Core/<Module>Hub.conf (POINTER CONF: implFile + implConfig)
5) OneData/bots/ONEBOT/config/modules/Core/Impl/<Module>CV.conf (IMPL CONF)

The ONLY thing that makes a module "active" is the <Module>.conf entry enabled=1 and valid pointers.

5) GLOBAL SINGLE-SOURCE SETTINGS
GlobalCV.conf is the single-source for shared runtime settings used by multiple modules.

Shared settings include, but are not limited to:
- controlGroupId
- prefix
- sendPrefer
- timeZone
- locale
- hour12
- global module log master flags, if implemented

Modules should reference global config using:
globalConfRel=modules/Core/Impl/GlobalCV.conf

Runtime values must come from .conf/template/data only.
JS must not hardcode runtime values such as:
- group ids
- chat ids
- phone numbers
- command prefix
- timezone
- locale
- customer/staff-facing text
- template paths
- runtime defaults

If a required global config value is missing or invalid, the affected module must log a bug and disable safely. It must not invent fallback runtime values inside JS.

For timezone:
- TimeZoneCV reads timeZone, locale, and hour12 from GlobalCV.conf.
- TimeZoneCV provides the canonical service name: timezone.
- Other modules should use the timezone service when available, or read GlobalCV.conf through configured globalConfRel when that module contract requires it.
- JS must not hardcode timezone or locale values.

6) LOGGING POLICY
Each Impl/*CV.conf must include these toggles:
- moduleLog
- bugLog
- detailLog
- traceLog

Even if a future "global log override" exists, these toggles still exist per-module for stability.

7) PIPELINE OVERVIEW (THE BUILD ORDER AND DATA FLOW)
7A. OUTBOUND PIPELINE (MUST BE STABLE FIRST)
SendQueue:
- Accept send requests.
- Dedupe by chatId + payload + options subset.
- Never drop on transient errors; retry via timer.
Outbox:
- Persist queue to JsonStore.
- Retry with backoff/waitMs.
- No silent loss; move max-attempt failures to a dead list with error info.
OutboundGateway:
- Choose sender service (prefer list from GlobalCV.conf).
- Apply RateLimit checks for AUTO messages.
- Finalize payload and call transport.
RateLimit:
- AUTO-only enforcement.
- Manual/staff bypass always allowed.
- Active-chat block for AUTO sends using idleMs and lastInboundAtMs.
Connector:
- The actual WhatsApp transport.

7B. INBOUND PIPELINE
InboundFilter:
- Drop status@broadcast and system/empty noise (config controlled).
InboundDedupe:
- Prevent duplicate inbound processing without dropping burst media.
MessageJournal:
- Record inbound/outbound events for audit and for active-chat last inbound timing.
StatusFeed:
- Segregate status/broadcast to ops feed (not customer inbox).
WorkGroups:
- Tag -> group routing (internal workflow).
Fallback (LAST):
- Customer DM -> ticket -> internal control group card -> staff reply mapping.
Manual/fromMe inbound handling:
- Messages from the bot's own WhatsApp account must not create customer fallback tickets.
- Manual messages sent by a human using the bot phone are manual outbound actions, not AUTO.
- If a fromMe/manual message is linked to a ticket, journal it as manual outbound or staff action.
- If it is not linked to a ticket, ignore it or journal it as non-ticket manual activity according to config.
- Do not treat fromMe/manual messages as customer inbound.
- Do not let AUTO policy block manual/fromMe human activity.

7C. SHARED FALLBACK/INBOUND HELPERS
Shared helpers are allowed only to remove repeated logic and prevent handler drift.
They must stay technical and must not contain business hardcode.

Required helper concepts:
- Normalize Envelope
  - Normalize raw WhatsApp message into stable fields:
    chatId, rawChatId, senderId, fromMe, isGroup, messageId, body, caption, media kind, timestamp, push/display name.
  - Must not guess customer phone from @lid unless a verified mapping exists.

- Ticket Resolve
  - Resolve or create the correct active ticket for a customer chat.
  - Must prevent duplicate tickets for the same customer burst/window.
  - Must preserve one active open ticket per customer chat thread unless closed.

- Album Collector / Burst Collector
  - Collect short-window inbound text/media bursts into one fallback card.
  - Must not drop media-only messages.
  - Must not create one card per attachment.
  - One inbound burst = one control-group card/text message.

- Send Plan / Send Strategy
  - Build send decisions before sending.
  - Manual staff reply must be marked manual/bypass.
  - AUTO sends must be marked AUTO and go through RateLimit.
  - No sendDirect bypass.

Helper rule:
- Helpers may be used by Forward/Reply Text/Media/AV handlers.
- Helpers must not call each other in a way that breaks the locked Fallback 4x4 architecture.
- Router remains the firewall.

8) MODULE ROLES (WHAT EACH MODULE IS FOR)
NOTE: Names below are conceptual. The actual module list is defined by Core/*.conf entries.

InstanceLock
- Ensure single instance runs; prevents double-start.

Log
- Central log writer with timezone-correct timestamps.

TimeZone
- Provides canonical timezone service name: 'timezone'.

JsonStore
- Persistent key/value or json file store used by Outbox, Ticketing, Journal, etc.

SendQueue
- In-memory queue; dedupe; pacing; retries; hands off to Outbox.

Outbox
- Persistent outbound queue (JsonStore); handles retries/backoff; dead-letter.

OutboundGateway
- Outbound orchestrator; chooses sender; enforces RateLimit for AUTO; calls connector.

RateLimit
- Enforce limits ONLY for AUTO messages:
  - daily/burst/gap/windows (if configured)
  - active-chat block (idleMs)
- Never block manual staff replies.

InboundFilter
- Filter inbound noise: status/broadcast, system empty, fromMe (optional).

InboundDedupe
- Inbound duplicate suppression:
  - Must not drop album burst media with empty text.
  - Dedupe key can include message id when available.

MessageJournal
- Record message events (dir=in/out, msgId, ticketId if known).
- Should support last inbound time per chatId for RateLimit active-chat block.

StatusFeed
- Route status/broadcast away from inbox; ops-only feed.

Command
- Parse commands using global prefix from GlobalCV.conf.
- UnknownText must not hardcode prefix; keep neutral.
- Staff commands must map configured command text/aliases to configured feature intents, such as check_unreplied_ticket.
- Command words/aliases must come from .conf/data, not JS.
- The bot must resolve command scope from the current bound workgroup and ticket route, not by guessing from command text.
- Random/unbound groups must stay silent for all staff operational commands.
- Customer DM must not run staff operational commands.
- Customer DM must not receive staff command help, no-access text, pending/unreplied output, or internal operational output.

AccessRoles
- Gate commands/actions by configured role.
- Common roles may include:
  - owner
  - admin
  - manager
  - sales
  - staff
  - viewer
- Role names and permission rules must come from config/data.
- JS must not hardcode staff phone numbers, owner phone numbers, or role membership.
- Manual staff reply permissions must be checked through AccessRoles or the approved staff/workgroup contract.

Help
- Help text for commands; text must be template-driven.

PingDiag
- Diagnostics for staff/admin.

Scheduler
- Runs scheduled jobs and timed checks.
- Scheduled customer-facing sends are AUTO messages.
- Scheduled/AUTO sends must pass:
  - options.isAuto=1
  - options.lastInboundAtMs from MessageJournal when available
- Scheduled/AUTO sends must respect RateLimit and active-chat block.
- Scheduler must never block manual staff replies.

AntiMiss / Pending Ticket Reminder
- Runs configured checks for open tickets with latest customer inbound not yet answered by staff.
- Reminder target is the ticket's current bound workgroup, not the customer.
- Reminder timing, repeat gap, max attempts, reminder window, and escalation timing must come from config.
- Escalation target must come from configured role/group.
- Reminder cycle must stop or reset when staff replies to the customer ticket.
- Do not send anti-miss reminder to the customer.
- Do not expose ticket id to the customer.
- Anti-miss is AUTO and must be audited.

OutboundAutomation / Broadcast / Followup / Reminder
- Own approved automated outbound campaigns and scheduled followups.
- May include:
  - broadcast
  - promo
  - scheduled followup
  - birthday wish
  - payment reminder
  - approved reminder
- All sends from this workflow are AUTO.
- AUTO sends must use the global outbound pipeline.
- AUTO sends must respect RateLimit and active-chat block.
- AUTO sends must never block manual staff replies.
- Audience, schedule, template, and send text must come from config/data/templates.
- No broadcast/promo/payment text may be hardcoded in JS.
- No mass auto-reply to strangers.

WorkGroups
- Map business workflow tags to internal WhatsApp group chat(s).
- Workgroups are business functions, not one module = one group.
- Common workflow groups may include:
  - ops
  - sales
  - account
  - admin
  - installation
  - opsFeed
- Ops is the default inbox/control group for new/unassigned customer DM.
- Ops Feed is for status/broadcast feed only and must not receive customer inbox messages.
- A single WhatsApp group may serve more than one function if configured.
- WorkGroups must resolve groupChatId by configured key only.
- No group id may be hardcoded in JS.
- Random/unbound groups must stay silent.
- Bound/control/work groups may show short wrong-route tips when a staff command is used in the wrong configured workgroup.

Fallback (4x4 locked)
- Router (firewall): decide forward/reply path and routing.
- Text handlers: plain text forwarding and staff text replies.
- Media handlers: image/document forwarding and staff media replies.
- AV handlers: audio/video/ptt forwarding and staff AV replies.
- Ticketing: strict ticket format YYMMT + 7 digits.

Customer inbound:
- Customer DM creates or reuses one open ticket.
- Customer DM is forwarded to the configured control/work group.
- Customer must not receive immediate auto acknowledgement in the main inbox flow.
- Customer must not receive ticket id in the main inbox flow.
- Status/broadcast/system noise must not enter fallback inbox.

Fallback card:
- Fallback card/text must come from configured template/renderer, not JS hardcoded layout.
- Template path must come from config or repo scan.
- Current known sequence template path is:
  OneData/bots/ONEBOT/config/ui/ticketsquence.txt
- Do not assume this path exists unless repo scan proves it:
  OneData/bots/ONEBOT/config/ui/Fallback/ticketsquence.txt
- Do not use Tips.conf as fallback card layout unless active config explicitly points to it.
- One inbound burst must send exactly one control-group text/card message.
- Media attachments may be forwarded after that one card/message.
- Do not send both ticket card and consolidated text separately.
- Reject old fallback layout:
  Ticket <ticket> from <chatId> (<chatId>) count=<n>

Fallback card must support these data fields when available:
- ticket id
- current route/workgroup
- ticket status
- WClient/Account code
- client type
- account/company/family display name
- PIC name
- PIC phone
- PIC WhatsApp id / raw chat id
- customer display/push/contact name
- clean customer phone when resolvable
- raw chat id for audit
- configured local time
- inbound text/list
- attachment count/types
- short action instructions/tips from template/config

Staff reply:
- Staff can reply from group by quote reply or configured command mapping.
- Staff text/media/audio/video/ptt replies must route back to the original customer ticket.
- Staff manual replies must bypass AUTO rate limits and active-chat blocks.
- Random/unbound groups must stay silent.
- Bound/control/work groups may show short wrong-route tips only when relevant.

BootAnnounce
- Startup announcements (template-driven).

SystemControl
- Ops controls for restart/status; must be template-driven and ASCII.

Library
- Catalog/search service for reusable business content.
- May store or search:
  - price text
  - product info
  - standard replies
  - templates
  - images
  - documents
  - tags
  - notes
- Staff should be able to search broadly by keyword/name/tag.
- Library search should support broad token matching where appropriate.
- Library must not directly send customer-facing content to a customer outside ticket workflow.
- Sending Library content to a customer must go through fallback ticket reply service or approved outbound workflow.
- This preserves ticket context and audit.
- Library may provide content to staff first, then staff sends via quote/command/manual approval.
- Library must remain data/template driven.
- Library must not hardcode customer-facing text in JS.

ContactBook / ClientBook / Account / PIC / Context
- Own customer account, PIC, and context data.
- This logic must not be buried inside Fallback if a dedicated service exists.

Latest contact model rule:
- The latest model is Account / PIC / Context / Ticket.
- Do not downgrade this to old CSV-only or Google-Contacts-only contact capture.
- Earlier WClient/CSV/contact-capture notes are historical intent only unless current config/spec explicitly enables that storage.
- Unknown customer/contact must stay Unassigned until staff links or creates the correct Account/PIC/Context.
- Do not silently create a wrong permanent customer record from guessed data.

Canonical concepts:
- ACCOUNT
  - Internal stable code such as ACC0001.
  - Represents a company, family, customer entity, vendor, contractor, owner, or other business entity.
  - One Account may have many PICs.
- PIC
  - A person/contact that messages the bot.
  - Stores display name, phone, chatId, WhatsApp id, tags, notes, and linked accountCode.
  - One PIC should link to one Account unless staff relinks it.
- CONTEXT
  - Internal stable code such as CTX0001.
  - Represents a specific job, inquiry, order, booking, support case, renovation, fabrication order, delivery, or other work context.
  - One Account may have many Contexts.
- TICKET
  - Ticket links to accountCode, picId, contextCode, and workgroupKey when available.
  - TicketId must never be exposed to the customer.

Resolution:
- On inbound DM, normalize chatId/phone.
- Look up PIC by chatId or phone.
- If PIC exists, resolve linked Account and optional Context.
- If not found, mark as Unassigned and show raw identifier in fallback card.
- For @lid, do not pretend it is a phone number unless a verified mapping exists.
- If no phone mapping exists, use raw @lid as fallback identifier.

Commands are config/template driven and must be handled by the owner module, not hardcoded:
- acc new
- acc link
- acc show
- acc list
- acc setname
- pic setname
- pic link
- pic list
- ctx new
- ctx link
- ctx list
- ctx close
- save
- save ctx=<CTX> cat=<category>

Professional document naming:
- Customer-facing quotations/invoices must use the real customer/company/person display name.
- Internal codes such as ACC/CTX may appear only as a reference line.
- Do not make customer-facing documents look like internal database records.

Filing/media saving:
- If Account and Context exist, save media under Account + Context folder structure.
- If Context is missing, save temporarily to Account inbox and prompt staff to assign/create Context.
- If Account is missing, deny save and ask staff to assign Account first.

Fallback integration:
- Fallback consumes ContactBook/ClientBook data for card display and ticket linking.
- Fallback must not become the owner of Account/PIC/Context data if dedicated service exists.
- If ContactBook/ClientBook is not implemented yet, list it as PENDING in the rebuild tracker.

9) FALLBACK FEATURE TARGETS (AGREED SPEC - SUMMARY)
Must support:

Customer DM intake:
- Never miss customer DM.
- Customer text/media/voice/video/document/caption must create or reuse one open ticket.
- Customer must not receive immediate auto acknowledgement in the main inbox flow.
- Customer must not receive ticket id in the main inbox flow.
- Status/broadcast/system noise must not pollute the customer inbox.

Fallback group card:
- Ticket card/text must be posted to the configured control/work group.
- One inbound burst must send exactly one control-group text/card message.
- Media attachments may be forwarded after that one card/message.
- Bot must not send both ticket card and consolidated text separately.
- Reject old fallback layout:
  Ticket <ticket> from <chatId> (<chatId>) count=<n>
- Fallback card/text must use configured template/renderer, not JS hardcoded layout.
- Current known sequence template path is:
  OneData/bots/ONEBOT/config/ui/ticketsquence.txt
- Template path must come from config or repo scan.
- Do not use Tips.conf as fallback card layout unless active config explicitly points to it.

Fallback card fields:
- ticket id
- customer phone when resolvable
- customer display/saved/push/contact name when available
- raw chat id for audit
- configured timezone time
- inbound text/list
- attachment count/types
- reply instruction/tips from template/config only

Customer identity:
- For @c.us and @s.whatsapp.net, display clean phone when available.
- For @lid, do not pretend it is a phone number.
- If @lid cannot be mapped to phone, show raw @lid as fallback identifier and raw chat id.
- If saved/display/push/contact name exists, show it.
- Raw chat id must remain available for audit.

Staff reply:
- Staff can reply from group to customer by quote reply or configured command mapping.
- Staff text/media/audio/video/ptt replies must route back to the original customer ticket.
- Manual staff replies must pass manual/bypass options so they are never blocked by AUTO policy.
- Random/unbound groups must stay silent.
- No no-access message and no help text should be sent to random/unbound groups.

Ticket and workflow:
- Strict ticket format YYMMT + 7 digits.
- Clear states: New/Open/Pending/Closed, as designed.
- Quick picks such as !1/!2/!3 are allowed if enabled by spec and must use global prefix.
- WClient/PIC/Account/Context mapping must be supported when implemented.
- Anti-miss reminders/escalation are allowed as AUTO only and must respect active-chat block.
- Audit view or journal summary per ticket must be supported.
- Status/broadcast must never pollute inbox.
- Ticket operational commands must be configurable and staff-group only.
- Ticket actions may include route/move, assign, close, reopen, show, and audit, if enabled by config.
- Ticket actions must respect AccessRoles and WorkGroups.
- Ticket action text must come from template/config, not hardcoded JS.
- Customer must never receive internal ticket command output.

Quick reply suggestions and teaching:
- Quick reply suggestions belong to the inbox card, not Tips.conf.
- Staff may choose configured quick replies such as !1, !2, !3 if enabled.
- Quick reply commands must use the global prefix.
- If no suitable suggestion exists, staff may manually reply by quote.
- Teaching/improving templates must be stored in the proper data/template store, not hardcoded in JS and not mixed into Tips.conf.
- Tips must stay short and only show relevant actions for the current card.

Anti-miss / pending ticket check:
- Anti-miss exists to prevent customer messages from being missed or left unanswered.
- Reminder applies only to open tickets with latest customer inbound not yet answered by staff.
- Reminder target is the ticket's current bound workgroup, not the customer.
- Reminder timing must be configurable, for example 1 hour, 6 hours, or other configured interval.
- Manual check command must be configurable from .conf/data, not hardcoded in JS.
- The feature intent is:
  check_unreplied_ticket
- The command text/alias may be configured per workflow, for example:
  pending ticket
  unreplied
  pending payment
  followup
- Command must use the global prefix from GlobalCV.conf.
- In a bound workgroup, the command checks tickets for that workgroup/context only.
- Example:
  sales group command may show sales unreplied tickets.
  account/payment group command may show pending payment tickets.
  HR group command may show HR-bound pending tickets only if that workflow is configured.
- Admin/manager/owner may check all workgroups if access allows.
- Random/unbound groups must stay silent.
- Customer DM must never receive pending/unreplied/reminder output.
- The bot must resolve ticket route/workgroup from ticket data and WorkGroups config, not by guessing from command text.
- Do not assume pending payment belongs to sales unless the ticket is routed to sales.
- Command output and reminder text must come from template/config, not hardcoded JS.
- The same configured intent may have different aliases per workgroup.
- Example: sales may use pending ticket, account may use pending payment, but both must resolve through configured intent and current bound workgroup scope.

Audit/journal:
- Every key event should be traceable:
  - ticket created
  - ticket reused
  - inbound received
  - media received
  - ticket routed/moved
  - staff reply sent
  - media reply sent
  - ticket closed
  - reminder/escalation sent
  - quick reply/teach action
  - reminder scheduled
  - reminder skipped because ticket already replied
  - reminder sent to staff group
  - reminder retry scheduled
  - escalation sent to staff/admin group
  - reminder cycle stopped after staff reply
  - staff responder/action history
  - ticket assignment changed
  - ticket owner/staff changed
  - ticket route/workgroup changed

- Audit must preserve enough staff responder history for teamwork and later reporting.
- Do not implement commission/payment calculation unless a separate approved module/spec exists.

- Audit view should support:
  - list tickets
  - show last activity time
  - show current group/tag
  - show last replied by
  - show account/pic/context link when available

Ban-risk minimization:
- No mass auto-reply to strangers.
- No repeated link spam in bursts.
- All outgoing messages should be paced through the outbound pipeline.
- Customer-facing messages should be purposeful and human-like.
- Manual staff replies remain allowed and must not be policy-blocked.

If an item is not implemented yet, it must be listed in the rebuild tracker as PENDING.

10) HOW CODEX MUST WORK (PROCESS)
- Always scan repo first. Never guess file paths.
- Follow active pointer chain:
  <Module>.conf -> <Module>Hub.conf -> implFile + implConfig
- Treat the current repo/live mirror as source of truth before editing.
- Do not use V1/V2/V3/V* files as reference for normal fixes.
- If any V1/V2/V3/V* script is found during repo scan, treat it as stray legacy residue.
- Report the exact path and STOP unless the user explicitly approves cleanup.
- If active runtime points to V1/V2/V3/V*, report it as a critical runtime violation.
- Use small batches.
- For normal fixes, use focused batches such as 1 JS + 1 CONF when needed.
- For large files, output one full file only.
- Do not rewrite large runtime files if a smaller config/template/renderer fix solves the issue.
- Do not output malformed, minified, flat, or unreadable JS.
- Output must be full raw file bodies only when deploy/copy is expected.
- No snippets.
- No diff.
- No patch.
- No zip unless explicitly requested by user.
- No split output unless explicitly requested by user.
- If output limit prevents a complete full file, report:
  READY_TO_COPY | NO
  REASON | output_limit
- Summary-only, diff-only, truncated, malformed, or partial output is not deployable.
- Never claim READY_TO_COPY if the full raw file is not complete and directly copyable.
- When Codex outputs a file more than once, only the last complete version is valid.
- Ignore earlier partial blocks, older variants, mixed dumps, or malformed outputs.
- Deploy by exact path header only.
- Never deploy floating snippets.
- ChatGPT must mark BOLEH COPY / DEPLOY only when all are true:
  - output is full raw file body
  - output is complete from first line to final line
  - output is not truncated
  - output is not summary-only
  - output is not diff-only
  - output is not zip unless user explicitly requested zip
  - JS passes node --check when applicable
  - no runtime hardcode is introduced
  - no template/user-facing text is hardcoded in JS
  - no unrelated files are changed
  - manual staff replies remain bypass/manual
  - customer ticket id is not exposed to customer
- If Codex output is summary/testing/commit/PR only, reject and request strict full raw file output.
- If Codex output is truncated, reject with REASON | output_limit.
- If Codex output is malformed/minified/unindented JS, reject.
- If Codex changes unrelated files, reject and force batch strict scope.
- If Codex says the prompt scope blocks the real fix, accept the STOP report and widen only the exact necessary file scope.
- Never add new keynames silently.
- Scan repo .conf first, reuse existing same-function keys, then use keyname.conf.txt as reference/library.
- Never hardcode IDs/text/prefix/timezone/locale/template paths/runtime defaults in JS.
- Runtime values must come from GlobalCV.conf, module .conf, templates, or data stores.
- Customer/staff-facing text must come from templates/config.
- If a prompt scope prevents the real fix, stop with READY_TO_COPY | NO and state the exact file that must be edited.
- Use one task/prompt per round.
- After a copyable repair batch, wait for fresh live logs or user test result before writing the next repair prompt.
- If a fix fails, scan the related connected chain to find the root cause instead of repeatedly editing the same guessed file.
- Do not ask Codex to find live logs in the repo unless logs were actually copied into the repo; live logs are normally uploaded separately by the user.
- For README or documentation changes, do not regenerate the whole file unless explicitly requested.
- Replace only the requested full section/block.
- Do not delete unrelated existing content.
- If a section must be replaced, output the full replacement section, not a partial patch.
- When preparing a Codex task, use CodexDefaultMsgTask.txt as the master header unchanged.
- ChatGPT should write only the TASK section under the existing master header.
- Do not rewrite or redesign the master header unless the user explicitly asks.
- Codex outputs files for review/copy; do not assume Codex has deployed to the live server.
- The user copies full accepted files to the live server manually.

----------------------------------------------------------------
A) ACTIVE MODULE INVENTORY (SOURCE OF TRUTH)
----------------------------------------------------------------
This build treats the module inventory as the source of truth.
A module is ACTIVE ONLY if:
- OneData/bots/ONEBOT/config/modules/Core/<Module>.conf has enabled=1, AND
- OneData/bots/ONEBOT/config/modules/Core/<Module>Hub.conf exists, AND
- <Module>Hub.conf points to existing implFile + implConfig.

DO NOT count modules by "Hub.js exists". Hub.js without an entry conf is NOT a module.

ACTIVE MODULE LIST (FILL THIS IN FROM REPO SCAN)
Format (one line per module):
- <ModuleId> | enabled=1 | entryConf=<Module>.conf | hubConf=<Module>Hub.conf | implFile=<path> | implConfig=<path> | service=<primary service name> | depends=<key services>

Example:
- Outbox | enabled=1 | entryConf=Outbox.conf | hubConf=OutboxHub.conf | implFile=Modules/Core/Outbox/OutboxCV.js | implConfig=modules/Core/Impl/OutboxCV.conf | service=outbox | depends=jsonstore, outboundgateway

IMPORTANT:
- If a module is not listed here, it is treated as NOT PART OF THIS BUILD, even if code files exist.
- The current build is expected to have no V1/V2/V3/V* runtime implementation files.
- If any V1/V2/V3/V* script or active pointer is found during repo scan, report the exact path and STOP.
- Do not import it.
- Do not reference it.
- Do not port behavior from it.
- Do not use it to justify changes.
- Only clean up or remove it when the user explicitly approves cleanup.

----------------------------------------------------------------
B) REBUILD STATUS (DONE / PENDING)
----------------------------------------------------------------
The rebuild is done in a strict sequence. Update this table as work progresses.
This prevents repeating work and prevents adding features on an unstable base.

STATUS RULES
- DONE means: CV-only, active pointer chain verified, no V1/V2/V3/V* runtime dependency, canonical keynames, no hardcode, ASCII-only, passes runtime, passes live behavior, and passes module acceptance tests.
- PENDING means: still not rebuilt OR still violates rules OR active pointer chain is not verified OR any V1/V2/V3/V* residue was found and not approved for cleanup OR still fails live/acceptance behavior.
- A module can compile and still remain PENDING if live behavior is wrong.

DONE (FILL IN FROM REPO SCAN AND LIVE TEST)
- OutboundGateway: DONE/PENDING
- Outbox: DONE/PENDING
- SendQueue: DONE/PENDING
- RateLimit: DONE/PENDING
- InboundFilter: DONE/PENDING
- InboundDedupe: DONE/PENDING
- MessageJournal: DONE/PENDING
- StatusFeed: DONE/PENDING
- Command: DONE/PENDING
- AccessRoles: DONE/PENDING
- Help: DONE/PENDING
- Scheduler: DONE/PENDING
- WorkGroups: DONE/PENDING
- Fallback (4x4): DONE/PENDING
- ContactBook / ClientBook: DONE/PENDING
- Library / Catalog: DONE/PENDING
- (add other active modules here)

PENDING (NOTES)
For each PENDING module, list:
- exact failed behavior,
- exact missing rule,
- exact script/conf/template involved,
- exact live log evidence if available,
- next small batch target.

Examples:
- Fallback: PENDING - duplicate control group text card + consolidated text.
- Fallback: PENDING - old layout Ticket <ticket> from <chatId> (<chatId>) count=<n> still active.
- Fallback: PENDING - active template pointer does not match current sequence template.
- ContactBook: PENDING - Account/PIC/Context mapping not implemented or not wired to fallback card.
- Library: PENDING - search/catalog not wired through ticket reply service.

----------------------------------------------------------------
C) GLOBAL LOG MASTER CAP (OPTIONAL, RECOMMENDED)
----------------------------------------------------------------
Goal: allow turning logs on/off from ONE place, without removing per-module toggles.

RULE:
effectiveLogFlag = (GlobalCV.conf flag) AND (Module Impl CV.conf flag)

Required per-module keys (still required in every Impl/*CV.conf):
- moduleLog
- bugLog
- detailLog
- traceLog

Global master keys (in GlobalCV.conf):
- moduleLog
- bugLog
- detailLog
- traceLog

Behavior:
- If global.moduleLog=0, then module moduleLog is effectively OFF for all modules.
- If global.moduleLog=1, then each module controls its own moduleLog as usual.
Same for bugLog/detailLog/traceLog.

Why keep per-module toggles:
- When debugging, you can enable traceLog only for one noisy module instead of flooding logs.

----------------------------------------------------------------
D) AUTO SCHEDULE FLAGS (REQUIRED FOR POLITE AUTOMATION)
----------------------------------------------------------------
Scheduled/automated messages MUST pass these options into the outbound pipeline:
- options.isAuto=1
- options.lastInboundAtMs=<timestamp of last inbound from this chat, if available>

This enables RateLimit policy:
- RateLimit applies to AUTO only.
- Active chat block (idleMs) only works when lastInboundAtMs is provided.

Manual/staff replies MUST pass:
- options.manualReply=1
(or options.bypassRateLimit=1)
so they are never blocked.

END 
