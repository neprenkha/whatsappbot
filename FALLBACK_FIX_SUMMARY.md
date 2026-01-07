# Fallback Session Close - Fix Summary

## Date
2026-01-08 (Session Close)

## Issues Fixed

### 1. Audio/Video Not Forwarded (DM -> Control Group)
**Problem**: When customer sent audio or video to bot, only ticket card appeared in control group. The actual media files were not forwarded.

**Root Cause**: The `hasMedia` property on message objects does not reliably detect audio/video/ptt types.

**Solution**: Created `hasMediaContent()` helper function that explicitly checks for:
- `msg.hasMedia` property (images, documents)
- `msg.type === 'audio'` or `'video'` or `'ptt'` (voice notes)

**Files Modified**:
- `FallbackCV.js` - Added `hasMediaContent()` helper
- `FallbackQuoteReplyV1.js` - Added `hasMediaContent()` helper
- `FallbackReplyMediaV1.js` - Added `hasMediaContent()` helper

### 2. Quote-Reply Not Resolving Tickets (Control Group -> DM)
**Problem**: When staff quoted a message in control group to reply, system logged:
- `[FallbackQuoteReplyV1] debug noTicket {"reason":"noMatch","type":"chat"}`
- `[FallbackQuoteReplyV1] debug noTicket {"reason":"noQuoted","type":"image"}`

Staff could not send replies to customers because ticket resolution failed.

**Root Cause**: 
- Quoted messages (especially forwarded media) don't contain ticket ID in text/caption
- System tried to extract ticket ID from quoted text, which was empty or had no ticket
- Sticky ticket system exists but only helps with rapid succession, not reliable for quote-reply

**Solution**: Implemented Message ID Mapping System
1. When ticket card is sent to control group, capture message ID
2. When media is forwarded to control group, capture message ID
3. Store mapping: `groupMessageId -> ticketId` in SharedMessageTicketMapV1
4. When staff quotes a message, extract quoted message ID
5. Look up ticket ID using `MessageTicketMap.get(msgId)`
6. If not found, fall back to text extraction, then sticky

**Files Created**:
- `SharedMessageTicketMapV1.js` - In-memory mapping with 24-hour auto-expiry

**Files Modified**:
- `FallbackCV.js` - Store message IDs after sending ticket card and forwarding media
- `FallbackQuoteReplyV1.js` - Look up message ID mapping before falling back to text extraction

### 3. Ticket Object Access Bug
**Problem**: Code was accessing `ticketData.ticket` as a string, but it's actually an object.

**Root Cause**: Misunderstanding of TicketCore API:
- `TicketCore.touch()` returns `{ ok: true, ticket: ticketObject }`
- `TicketCore.resolve()` returns `{ ok: true, ticket: ticketObject, payload }`
- Ticket ID is at `ticketObject.id`
- Customer chatId is at `ticketObject.chatId`

**Solution**: Fixed property access:
- `ticketData.ticket` → `ticketData.ticket.id`
- `res.chatId` → `res.ticket.chatId`

**Files Modified**:
- `FallbackCV.js` - Fixed ticket ID extraction
- `FallbackQuoteReplyV1.js` - Fixed chatId extraction

## How The Fix Works

### Forward Flow (DM -> Control Group)

```
Customer sends audio/video to bot
    ↓
hasMediaContent(raw) detects audio/video type
    ↓
Message added to buffer (bufferMs window)
    ↓
flushBuffer() creates/touches ticket
    ↓
Ticket card sent to control group
    ↓
Capture ticket card message ID → MessageTicketMap.set(cardMsgId, ticketId)
    ↓
For each media item:
    - Try downloadMedia() first (with logging)
    - Fallback to forward() if download fails
    - Capture forwarded message ID → MessageTicketMap.set(mediaMsgId, ticketId)
```

### Reply Flow (Control Group -> DM)

```
Staff quotes message in control group
    ↓
Extract quoted message ID
    ↓
Lookup: ticketId = MessageTicketMap.get(quotedMsgId)
    ↓
If not found, try extract ticket from quoted text
    ↓
If not found, try extract ticket from staff's message text
    ↓
If not found, use sticky ticket (if enabled and not expired)
    ↓
If still no ticket → log noTicket and return
    ↓
Resolve ticket: TicketCore.resolve(ticketId) → get customer chatId
    ↓
If media reply: FallbackReplyMediaV1.sendMedia()
    ↓
If text reply: textSender.fn() with ticket stripped
```

## Enhanced Logging

### Forward Media Logging
- `media.forward.attempt` - Shows type, hasDownload, hasForward
- `media.download.ok` - Shows type, size
- `media.download.null` - Download returned null
- `media.download.fail` - Download exception
- `media.forward.trying.forward` - Fallback to forward()
- `media.forward.sent` - Success with via: 'download' or 'forward'
- `media.forward.no.method` - No download or forward available

### Message ID Mapping Logging
- `msgmap.set` - Ticket card message ID stored
- `msgmap.set.media` - Media message ID stored (download path)
- `msgmap.set.media.fwd` - Media message ID stored (forward path)

### Ticket Resolution Logging
- `ticket.from.msgmap` - Ticket found via message ID mapping
- `ticket.from.quoted.text` - Ticket extracted from quoted text
- `ticket.from.direct.text` - Ticket extracted from staff message text
- `sticky.use` - Using sticky ticket
- `noTicket` - No ticket found, with detailed reason

## Configuration

No configuration changes required. The fix uses existing config:

```ini
# Already in FallbackCV.conf
ticketType=fallback
ticketStoreSpec=jsonstore:Fallback/tickets
storeSpec=jsonstore:Fallback/tickets

controlGroupId=120363402608825006@g.us

sendPrefer=outsend,sendout,send
replySendPrefer=sendout,outsend,send

allowStickyReply=1
stickyTtlSec=900

debugLog=1
traceLog=1
```

## Testing Checklist

### Forward (DM -> Control Group)
- [ ] Text only - Should create ticket card
- [ ] Image x4 album - Should create one ticket, forward all 4 images
- [ ] Document x3 - Should create one ticket, forward all 3 documents
- [ ] Audio file - Should create ticket card AND forward audio
- [ ] Video file - Should create ticket card AND forward video
- [ ] Mixed (text + 2 images + 1 video) - Should create one ticket with all media

### Reply (Control Group -> DM)
- [ ] Quote ticket card + text - Should send text to customer
- [ ] Quote ticket card + attach image - Should send image to customer
- [ ] Quote forwarded image + text - Should send text to customer
- [ ] Quote forwarded audio + text - Should send text to customer
- [ ] Quote forwarded video + text - Should send text to customer
- [ ] Send image without quote (within 5s of first reply) - Should use sticky ticket
- [ ] Send text after 15 minutes - Should fail with noTicket (sticky expired)

### Log Verification
- [ ] Audio forward shows: `media.forward.attempt type:audio`
- [ ] Audio forward shows: `media.forward.sent via:download` or `via:forward`
- [ ] Ticket card shows: `msgmap.set msgId:... ticket:...`
- [ ] Media forward shows: `msgmap.set.media` or `msgmap.set.media.fwd`
- [ ] Quote reply shows: `ticket.from.msgmap` (first priority)
- [ ] No more `noTicket reason:noMatch` for valid quote-replies
- [ ] No more `send.skip.missingChatId` warnings

## Rollback Plan

If issues occur, rollback is simple:

```bash
cd /home/runner/work/whatsappbot/whatsappbot
git revert HEAD~3..HEAD
git push origin copilot/track-fallback-handover
```

This will revert the 3 commits:
1. Add message ID mapping and enhanced media detection for fallback system
2. Fix ticket object access in FallbackCV and FallbackQuoteReplyV1
3. Add enhanced media detection to FallbackQuoteReplyV1 and FallbackReplyMediaV1

## Known Limitations

1. **Message ID Mapping is In-Memory Only**
   - Mapping is lost on bot restart
   - Auto-expires after 24 hours
   - Solution: Staff should quote messages within 24 hours, or re-send ticket card if needed

2. **Large Video Files**
   - Very large videos (>100MB) might timeout on download
   - System will fallback to forward(), which should work
   - Log will show: `media.download.fail` then `media.forward.sent via:forward`

3. **Sticky Ticket Window**
   - Default 900 seconds (15 minutes)
   - Staff must send multiple media within this window to use same ticket
   - Configure with `stickyTtlSec` in FallbackCV.conf

## Success Criteria

✅ All fixes implemented:
- Enhanced media detection for audio/video/ptt
- Message ID mapping for quote-reply
- Fixed ticket object property access
- Comprehensive logging for debugging

✅ Code quality:
- All JavaScript syntax validated
- Minimal changes (surgical fixes)
- No breaking changes to existing functionality
- Backward compatible with existing configs

✅ Non-negotiable rules followed:
- No changes to foundation files (Kernel.js, Connector.js, Start.cmd)
- No changes to Hub files (FallbackHub.js)
- Naming conventions maintained
- ASCII-safe code
- Configurable via .conf files

## Next Steps

1. Deploy to staging/test environment
2. Run manual test suite (see Testing Checklist above)
3. Monitor logs for new patterns (msgmap.set, ticket.from.msgmap)
4. Verify audio/video forwarding works
5. Verify quote-reply works for all media types
6. If successful, deploy to production
7. Monitor production logs for 24-48 hours

## Support

If issues arise:
- Check logs with `debugLog=1` and `traceLog=1`
- Look for new log patterns (msgmap, ticket.from, media.forward)
- Verify MessageTicketMap size doesn't grow unbounded (auto-cleanup every 100 entries)
- Consider increasing `stickyTtlSec` if staff need longer window for media bursts

## References

- Problem Statement: ONEBOT FALLBACK HANDOVER TRACKER (Session Close)
- Modified Files: 4 files (3 modified, 1 created)
- Lines Changed: +237, -20
- Commits: 3
