ONEBOT WHATSAPP BOT - BUILD INTENT + MODULE CONTRACTS (README FOR CODEX)
ASCII ONLY. THIS DOCUMENT IS THE SOURCE OF TRUTH FOR WHAT THIS BUILD IS TRYING TO BE.

1) PURPOSE (WHAT THIS BOT IS)
ONEBOT is a WhatsApp automation system that:
- Receives inbound customer messages (DM) and ensures they are not missed.
- Routes customer conversations into an internal control group workflow with ticketing.
- Enables staff to reply manually from the internal group back to the customer, with auditability.
- Separates "customer inbox" from other traffic (status/broadcast/system noise and internal chatter).
- Uses a strict outbound pipeline so messages are queued, paced, and never silently dropped.

The current build policy prefers "no auto-reply to customer" for the main inbox flow.
Automations (scheduled followups, promos, birthday wishes, payment reminders) are allowed, but must be:
- clearly treated as AUTO,
- rate-limited,
- blocked while the customer is actively chatting (to avoid rude interruptions),
- NEVER block or limit staff manual replies.

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
- Use ONLY keynames listed in keyname.conf.txt.
- Never invent new names for existing concepts (avoid enable/on drift, debug/trace drift, etc).
- One key per concept.

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
- Each module has ONE active implementation (CV).
- Legacy V1/V2/V3 files may exist ONLY as reference during rebuild.
- Active runtime must not require/import V1/V2/V* from CV modules.

R7. OUTBOUND MUST USE SINGLE GLOBAL PIPELINE
- No sendDirect bypass.
- Must queue (SendQueue -> Outbox -> OutboundGateway -> Connector) and never silently drop.
- Rate limit must queue and delay, not drop.
- Manual staff messages must not be blocked.

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
GlobalCV.conf is the single-source for shared settings used by many modules, for example:
- controlGroupId
- prefix (command prefix)
- sendPrefer (preferred outbound sender services)

Modules should reference global config using:
globalConfRel=modules/Core/Impl/GlobalCV.conf

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

AccessRoles
- Gate commands/actions by role (staff/admin).

Help
- Help text for commands; text must be template-driven.

PingDiag
- Diagnostics for staff/admin.

Scheduler
- Runs scheduled jobs (AUTO messages):
  - must pass options.isAuto=1
  - must pass options.lastInboundAtMs (from MessageJournal) if available
  - scheduled sends must respect active-chat block

WorkGroups
- Map tags/workflows to internal group chat(s).
- Provide guard rails for wrong-group handling.

Fallback (4x4 locked)
- Router (firewall): decide forward/reply path and routing.
- Text handlers: plain text flows.
- Media handlers: picture/document album handling.
- AV handlers: audio/video/ptt handling.
- Ticketing: strict ticket format YYMMT + 7 digits, card template from OneData/config/ui/Fallback/ticketcard.txt.
- No auto-reply to customer in main flow unless explicitly enabled by policy.

BootAnnounce
- Startup announcements (template-driven).

SystemControl
- Ops controls for restart/status; must be template-driven and ASCII.

Library
- Shared helper registry (technical helpers only, no business logic).

9) FALLBACK FEATURE TARGETS (AGREED SPEC - SUMMARY)
Must support:
- Never miss customer DM.
- Ticket card posted to control group with key info (customer phone/chatId, ticketId, snippet).
- Staff reply from group to customer via quote reply or command mapping.
- Clear states: New/Open/Pending/Closed (as designed).
- Quick picks (!1/!2/!3 style) if enabled by spec (must use global prefix).
- WClient/PIC mapping (multi-number / ownership).
- Anti-miss reminders/escalation (AUTO only, respects active-chat block).
- Audit view (journal summary per ticket).
- Status/broadcast never pollute inbox.

If an item is not implemented yet, it must be listed in the rebuild tracker as PENDING.

10) HOW CODEX MUST WORK (PROCESS)
- Always scan repo first (never guess).
- Follow active pointer chain: <Module>.conf -> <Module>Hub.conf -> implFile + implConfig.
- Use V1/V2/V3 only as reference to port behavior into CV; do not import them.
- Do changes in small batches (usually 2 files: 1 JS + 1 CONF).
- Output full file bodies only, ASCII only.
- Never add new keynames; use keyname.conf.txt.
- Never hardcode IDs/text/prefix; use GlobalCV.conf and templates.

README ADDITIONS (PASTE INTO ONEBOT_Build_Readme_For_Codex.txt)
ASCII ONLY. COPY/PASTE THESE SECTIONS INTO THE README.

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
- Any "stray/legacy" conf entries (V1/V2/V3) must be disabled or removed from active inventory.

----------------------------------------------------------------
B) REBUILD STATUS (DONE / PENDING)
----------------------------------------------------------------
The rebuild is done in a strict sequence. Update this table as work progresses.
This prevents repeating work and prevents adding features on an unstable base.

STATUS RULES
- DONE means: CV-only, no V1/V2 imports, canonical keynames, no hardcode, ASCII-only, passes runtime.
- PENDING means: still not rebuilt OR still violates rules OR still depends on V1/V2.

DONE (FILL IN)
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
- (add other active modules here)

PENDING (NOTES)
- List the exact missing rule(s): "imports V1", "hardcoded prefix", "alias keys", "conf drift", "missing init(meta)", etc.
- List the next batch target: "2 files (CV.js + CV.conf)".

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

