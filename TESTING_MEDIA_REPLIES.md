# Testing Media Reply Functionality

## Overview
This document provides instructions for testing and simulating media reply functionality in the WhatsApp bot, specifically for the fallback components.

## Prerequisites
- Bot must be connected to WhatsApp
- Access to the control group (configured in bot settings)
- At least one active customer ticket

## Test Scenarios

### 1. Single Media Reply (Image/Document)

**Steps:**
1. In the control group, quote/reply to a message containing a ticket ID
2. Attach an image or document
3. Optionally add a caption with additional text
4. Send the message

**Expected Behavior:**
- Media should be downloaded and sent to the customer
- Sticky ticket should be set for the sender
- Log should show: `replyMedia {..., ok: true, type: "image", sticky: 0, mode: "send"}`

**Debug Logging:**
```
[FallbackReplyMediaV1] debug pickSendFn trying services: outsend,sendout,send
[FallbackReplyMediaV1] debug pickSendFn selected service: outsend
[FallbackReplyMediaV1] debug sendMedia: type=image to=<customerChatId>
[FallbackReplyMediaV1] debug sendMedia: attempting downloadMedia type=image
[FallbackReplyMediaV1] debug sendMedia: downloadMedia success type=image
[FallbackReplyMediaV1] debug sendMedia: attempting send with sendFn type=image
[FallbackReplyMediaV1] info sendMedia: send success type=image
[FallbackQuoteReplyV1] debug sticky SET ticket=<ticketId> sender=<staffId> exp=<timestamp>
[FallbackQuoteReplyV1] info replyMedia {"ticket":"<ticketId>","ok":true,"type":"image","sticky":0,"mode":"send"}
```

### 2. Album/Burst Media (Multiple Images)

**Steps:**
1. In the control group, quote a message with a ticket ID
2. Attach the first image and send
3. Within 3 seconds (default sticky window), send additional images WITHOUT quoting
4. Send 2-3 more images in quick succession

**Expected Behavior:**
- First image: creates sticky ticket (sticky: 0)
- Subsequent images: reuse sticky ticket (sticky: 1)
- All images delivered to the same customer
- Sticky ticket expiration extended with each new media

**Debug Logging:**
```
# First image
[FallbackQuoteReplyV1] debug sticky SET ticket=<ticketId> sender=<staffId> exp=<timestamp>
[FallbackQuoteReplyV1] info replyMedia {"ticket":"<ticketId>","ok":true,"type":"image","sticky":0}

# Second image (no quote)
[FallbackQuoteReplyV1] debug sticky USE ticket=<ticketId> sender=<staffId> exp=<newTimestamp>
[FallbackQuoteReplyV1] info replyMedia {"ticket":"<ticketId>","ok":true,"type":"image","sticky":1}

# Third image (no quote)
[FallbackQuoteReplyV1] debug sticky USE ticket=<ticketId> sender=<staffId> exp=<newerTimestamp>
[FallbackQuoteReplyV1] info replyMedia {"ticket":"<ticketId>","ok":true,"type":"image","sticky":1}
```

### 3. Audio/Video Reply

**Steps:**
1. Quote a message with a ticket ID in the control group
2. Attach an audio or video file
3. Send the message

**Expected Behavior:**
- For audio/video, forward method is preferred (more reliable)
- Caption is stripped for audio messages
- Fallback to download+send if forward fails
- Log should show the attempt sequence

**Debug Logging:**
```
[FallbackReplyMediaV1] debug sendMedia: type=audio to=<customerChatId>
[FallbackReplyMediaV1] debug sendMedia: attempting forward for AV type=audio
[FallbackReplyMediaV1] info sendMedia: forward success type=audio
[FallbackQuoteReplyV1] info replyMedia {"ticket":"<ticketId>","ok":true,"type":"audio","sticky":0,"mode":"forward"}
```

### 4. Failed Media Processing

**Test Cases:**

#### a. No Send Service Available
- Simulate by temporarily disabling send services
- Expected log: `[FallbackReplyMediaV1] error pickSendFn: No outbound send service available`

#### b. Download Failure
- Use corrupted or inaccessible media
- Expected log sequence:
```
[FallbackReplyMediaV1] warn sendMedia: downloadMedia failed type=image err=<error>
[FallbackReplyMediaV1] warn sendMedia: media is null after download, attempting forward
[FallbackReplyMediaV1] info sendMedia: forward after download fail success type=image
```

#### c. Send Failure
- Simulate network issues or invalid chatId
- Expected log:
```
[FallbackReplyMediaV1] error sendMedia: send failed type=image err=<error>
[FallbackQuoteReplyV1] error replyMedia FAILED ticket=<ticketId> reason=sendFailed
[FallbackQuoteReplyV1] info replyMedia {"ticket":"<ticketId>","ok":false,"type":"image","sticky":0,"reason":"sendFailed","error":"<error>"}
```

### 5. Text Reply (Baseline Test)

**Steps:**
1. Quote a message with a ticket ID
2. Type a text message (no media)
3. Send

**Expected Behavior:**
- Text sent via configured send service
- Ticket stripped from customer-facing message
- Success logged with service name

**Debug Logging:**
```
[FallbackReplyTextV1] debug trying service: outsend
[FallbackReplyTextV1] info sendOk {"to":"<customerChatId>","via":"outsend"}
[FallbackQuoteReplyV1] info replyText {"ticket":"<ticketId>","ok":true,"type":"chat","sticky":0,"via":"outsend"}
```

### 6. Control Group Routing

**Test Cases:**

#### a. Valid Quote Reply
- Quote message with ticket → should route to customer

#### b. Invalid/Missing Ticket
- Quote message without ticket → should NOT route
- Expected log: `[FallbackQuoteReplyV1] info noTicket {"reason":"noTicketInQuote",...}`

#### c. Expired Sticky Ticket
- Wait > 3 seconds after last sticky media
- Send media without quote → should NOT route
- Expected log: `[FallbackQuoteReplyV1] info noTicket {"reason":"noTicket",...,"stickyExpired":true}`

## Configuration Options

### Enable Debug Logging
In bot configuration, set:
```json
{
  "debugLog": 1,
  "traceLog": 1
}
```

### Adjust Sticky Ticket Window
```json
{
  "replyStickyMs": 5000,  // 5 seconds (default: 3000)
  "replyStickyEnabled": 1
}
```

### Configure Send Service Preference
```json
{
  "sendPrefer": "outsend,sendout,send,transport"
}
```

## Troubleshooting

### Issue: "No outbound send service"
- Check that at least one send service is registered
- Verify `meta.getService('outsend')` or similar returns a function
- Check logs: `[FallbackReplyMediaV1] error pickSendFn: No outbound send service available`

### Issue: Media not forwarding
- Check that `rawMsg.downloadMedia()` function exists
- Verify `rawMsg.forward()` is available as fallback
- Look for: `[FallbackReplyMediaV1] error sendMedia: no download or forward available`

### Issue: Sticky ticket not working for albums
- Verify `replyStickyEnabled: 1` in config
- Check time between images < `replyStickyMs`
- Look for: `[FallbackQuoteReplyV1] debug sticky USE ticket=...`

### Issue: Wrong ticket resolved
- Check ticket format matches: `\d{6}T\d{10}` pattern
- Verify ticket exists in ticket store
- Check: `[FallbackQuoteReplyV1] info ticketNotResolved`

## Monitoring

### Key Log Patterns to Monitor

**Success:**
- `replyMedia {"ticket":"...","ok":true,...}`
- `replyText {"ticket":"...","ok":true,...}`
- `sticky SET/USE ticket=...`

**Warnings:**
- `sendMedia: downloadMedia failed`
- `sendMedia: forward failed`
- `noTicket`

**Errors:**
- `replyMedia FAILED`
- `No outbound send service available`
- `allFailed after trying`

## Simulation Scripts

### Manual Test Checklist
- [ ] Single image reply with ticket
- [ ] Multiple images (album) with sticky ticket
- [ ] Audio file reply
- [ ] Video file reply
- [ ] Document reply
- [ ] Text reply (baseline)
- [ ] Quote reply to non-ticket message (should not route)
- [ ] Media without quote after sticky expires (should not route)
- [ ] Verify logs show detailed debugging info
- [ ] Verify ok:true/false status in logs
- [ ] Verify sticky ticket updates in logs

## Notes

- All code paths now return `{ok: true/false, ...}` for proper tracking
- Enhanced logging includes error details and processing mode
- Sticky tickets automatically extend for album/burst scenarios
- Audio/video prefer forward method for reliability
- All failures are logged with reason and error details
