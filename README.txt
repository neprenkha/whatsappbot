# ONEBOT WhatsApp Bot - Rebuild README (CV-only)
# Purpose: Single source of truth for rules, contracts, features, and rebuild workflow.
# Standard: ASCII-only. No emoji. No smart quotes. No ellipsis.

## 0) Definitions
- CV = Current Version. Runtime behavior must be CV only.
- V1/V2/V3 files are for future upgrades only. During rebuild, do NOT add new versions.
- Foundation = Start.cmd + OneBot/Kernel.js + OneBot/Connector.js + any *Hub.js logic (frozen).

## 1) Non-negotiable Rules (LOCKED)
1. Foundation freeze:
   - DO NOT edit: Start.cmd, OneBot/Kernel.js, OneBot/Connector.js, any *Hub.js logic.
2. ASCII-only:
   - All JS/CONF/templates/log strings must be ASCII-only.
3. Zero hardcode:
   - No hardcoded IDs (groupId/chatId/phone).
   - No hardcoded staff/customer texts.
   - No hardcoded command prefix/command names.
   - No hardcoded template paths.
   - All IDs/settings come from config/global/store. All texts come from templates/store.
4. Canonical keynames only:
   - Use only canonical keys from the key contract.
   - Never use alias/legacy keys for the same concept.
5. CONF standard:
   - key=value only, no duplicate keys, booleans 1/0, append-only edits.
   - Every Impl/*CV.conf MUST include:
     moduleLog, bugLog, detailLog, traceLog
6. Outbound single pipeline:
   - All outbound must go through SendQueue -> Outbox -> OutboundGateway.
   - RateLimit must never block manual staff/fallback messages. RateLimit applies to autobot only.
7. Output contract for changes:
   - Max 5 files per batch.
   - 1 module = 2 files rule:
     If you touch a module, output BOTH:
       (1) OneBot/modules/Core/<Module>/<Module>CV.js
       (2) OneData/bots/ONEBOT/config/modules/Core/Impl/<Module>CV.conf
   - Each file must be printed as full body (copy/paste).
   - Each file must have a Path header line outside the code block.

## 2) Global Shared Settings (Single Source of Truth)
Shared settings MUST NOT be duplicated across module configs.
They live only in:
- OneData/bots/ONEBOT/config/modules/Core/Impl/GlobalCV.conf

All module Impl CV configs MUST reference global via:
- globalConfRel=modules/Core/Impl/GlobalCV.conf

Shared settings that belong in GlobalCV.conf:
- controlGroupId
- sendPrefer (default service preference list)
- base directory rel defaults (e.g. logBaseDirRel, jsonStoreBaseDirRel)
- other shared values repeated in 2+ module conf files

Timezone rule (single source):
- Only TimeZone module reads the timeZone value.
- All other modules consume the "timezone" service (no timeZone=... duplication).

## 3) Canonical Keyname Contract (No Aliases)
Do not create or read multiple keys for the same concept.
Examples of forbidden alias patterns:
- groupId / targetGroupId / fallbackGroupId / fallbackGroupChatId -> controlGroupId (canonical)
- tz / timezone (as alias) -> timeZone (only TimeZone module reads the value)
- debug / debugLog / traceEnabled -> moduleLog/bugLog/detailLog/traceLog (and other canonical toggles)
- storeSpec / ticketStore -> canonical store key (e.g. ticketStoreSpec if defined)
- bufferMs / msgBuffer / albumWindowMs -> canonical buffer keys (msgBufferMax, burstMs, etc.)
If unsure: STOP and propose, do not invent new keys.

## 4) Rebuild Sequence (Do not skip)
Rebuild in dependency order to prevent regression:

0) Foundation (freeze, read-only)
1) Log, TimeZone
2) JsonStore
3) Outbound pipeline:
   - OutboundGateway
   - Outbox
   - SendQueue
   - RateLimit (autobot-only)
4) Inbound pipeline:
   - InboundFilter
   - InboundDedupe
   - MessageJournal
5) Command plane:
   - Command
   - AccessRoles
   - Help
   - PingDiag
   - SystemControl
   - Scheduler
   - StatusFeed
6) WorkGroups
7) Fallback (last):
   - Must follow modular 4x4 architecture (Receive/Reply x Router/Text/Media/AV)

## 5) Scheduler (Mandatory Features)
Scheduler is a generalized automation engine:
- follow-up tasks (payment/quote/sitevisit)
- birthday wishes
- festive wishes
- promotions/campaigns

All schedules MUST be created from group commands (wizard).
No manual file edits to add schedules.
Scheduler stores jobs/templates as data in store.

Politeness rule (mandatory):
- If customer is active (recent inbound/outbound), Scheduler must NOT send payment reminder to customer.
- Default for payment follow-up: staff task to group, not auto DM to customer.
- Suppress/defer when customer active; configurable windows and defer duration.

## 6) Help (Mandatory Features)
Help is the user/staff README inside the bot:
- Dynamic, generated from command registry
- Role-aware (AccessRoles)
- No hardcoded command prefix or command names inside help text
- Supports:
  help
  help <command/topic>
  help search <keyword>

## 7) Fallback (Mandatory Features)
Fallback must stay modular 4x4:
- ReceiveRouter / ReceiveText / ReceiveMedia / ReceiveAv
- ReplyRouter / ReplyText / ReplyMedia / ReplyAv
Router is a firewall. No cross-call between handlers.
Ticketing format must follow agreed spec. Do not change format unless explicitly decided.

## 8) Deployment Safety Rules
- Never deploy mixed output that contains old and new versions of the same file.
- Always deploy module pairs together (CV.js + CV.conf).
- Never deploy a conf change for a module without its matching CV.js rebuild.
- If output contains duplicate file bodies or conflicting variants, treat as NOT deployable.

## 9) What to Archive (User Controlled)
After CV implementations are real and stable:
- Archive legacy V1/V2 wrappers and unused conf variants.
Do not add new folders; archive is user operation.