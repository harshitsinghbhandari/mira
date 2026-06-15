# Mira

Mira is a voice-first operations system for live events, venues, campuses, and field teams.

The idea is simple: keep the speed of walkie-talkies, but make every transmission structured, searchable, and auditable.

Staff submit short push-to-talk voice reports that are delivered immediately to the relevant team. AI runs in parallel after delivery, transcribing the report, extracting the operational intent, classifying urgency, identifying ownership, and logging the full response timeline.

## Concept

Event coordination still depends on radio channels, group chats, phone calls, and manual notes. These tools are fast, but they lose context:

- Important details disappear into audio chatter.
- The right team may not hear the issue.
- Ownership is unclear.
- There is no reliable timeline of what happened.
- Post-event review depends on memory and scattered notes.

Mira turns spoken field reports into operational memory.

## Design Principle

AI should not sit in the critical communication path. Mira preserves near-instant voice communication first, then adds transcription, classification, ownership, search, and auditability in the background.

## Core Workflow

1. A staff member records a short voice report.
2. Mira delivers the audio report to the relevant team channel immediately.
3. AI transcribes the audio and extracts category, urgency, location, summary, and likely owner in parallel.
4. The report becomes a structured incident or timeline entry.
5. A responder acknowledges, reassigns, or resolves the issue.
6. Command staff see the full incident timeline and audit log.

## Hackathon Direction

Mira is being explored for the H0 hackathon as a full-stack app using Vercel and an AWS database.

Strong track fit:

- Monetizable B2B App
- Million-scale Global App
- Open Innovation

The initial MVP focuses on push-to-talk reporting, low-latency team delivery, background AI enrichment, incident status, team queues, and a searchable operations log.

## Repository Status

This repository currently contains the product idea and early project scaffolding. See [idea.md](./idea.md) for the full concept brief.
