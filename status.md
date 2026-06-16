# Mira — Status

**Hackathon deadline:** June 29, 2026 (submission) / June 30 (judging starts)
**Days left:** 12

---

## What's live

| Layer | Status | Notes |
|---|---|---|
| WebSocket relay | Live | EC2 ap-south-1, Nginx TLS, FFmpeg WebM to MP4 transcode |
| PTT voice transmission | Live | Browser MediaRecorder to relay to receiver, sub-second |
| iOS Safari playback | Live | Persistent audio element, silent WAV unlock |
| Transmission store | Live | Every PTT persists to S3 + DynamoDB + SQS on the relay |
| Frontend | Live | `mira.theharshitsingh.com` on Vercel, GitHub auto-deploy |
| S3 audio storage | Live | `mira-transmissions-harshit`, ap-south-1, 15-day expiry |
| DynamoDB | Live | `mira-events` table, `pk=EVENT#`, `sk=TX#<endedAt>#<id>` |
| SQS | Live | `mira-transcription` queue, ready for STT worker |

## What's not built yet

| Feature | Priority | Notes |
|---|---|---|
| Event ID + join code | High | No access control yet, anyone can join |
| Role picker | High | Staff vs. command, needed for demo |
| Channel feed (command center) | High | Core of the demo loop |
| Groq Whisper transcription | High | SQS queue is ready, worker not built |
| Claude Haiku enrichment | High | Category, urgency, location, summary |
| Message card UI | High | Show transcript + AI badges after enrichment |
| Staff page with channel select | High | Full PTT flow with channel routing |
| Home / join screen | High | Entry point for the demo |
| Seed endpoint | Medium | Demo event + 5 channels in DynamoDB |
| Analytics / ops log | Low | Post-demo polish |
| Emergency broadcast | Low | Future feature |

## Infrastructure

| Resource | Value |
|---|---|
| EC2 instance | ap-south-1, t3.micro, Elastic IP stable |
| Relay URL | `wss://mira-relay.theharshitsingh.com` |
| Frontend | `https://mira.theharshitsingh.com` |
| S3 bucket | `mira-transmissions-harshit` |
| DynamoDB table | `mira-events` |
| SQS queue | `mira-transcription` |

**Stop EC2 when not working:** `mirastop` / `mirastart`

## Demo target

1. Open join screen, enter event ID + code
2. Pick role: field staff or command center
3. Staff holds PTT, speaks, releases
4. Voice appears instantly in command center
5. Transcript + AI classification (urgency, category, location) appear within seconds
6. Command center shows live feed across all channels

## Architecture one-liner (for submission)

DynamoDB because voice reports from many field staff hit simultaneously: single-digit millisecond writes, event-scoped partitioning (`EVENT#`), clean separation between the hot delivery path and background AI enrichment.
