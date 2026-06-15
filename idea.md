# Mira: Voice-First Event Operations System

## Core Idea

Build Mira, a voice-first coordination system for live events, venues, campuses, conferences, festivals, hotels, warehouses, and emergency operations.

Today, many teams still coordinate through walkie-talkies, radio channels, phone calls, group chats, and manual notes. These tools are fast, but they lose context. Important details disappear into audio chatter, the wrong person may hear the issue, no one knows who accepted ownership, and there is no clean timeline of what happened.

Mira turns spoken field reports into structured operational work without slowing down the original communication.

Staff use a push-to-talk interface to send short voice reports to the relevant team as quickly as possible. AI processing runs in parallel after delivery: the system transcribes the message, extracts the issue, classifies the category, detects urgency, identifies location, identifies likely ownership, and logs the full timeline.

The result is a command-center layer over live operations: every spoken report becomes searchable, assignable, auditable, and actionable.

## Example

A staff member says:

> "Channel 5, food court, we need cleanup near stall B12. Someone spilled a drink and people are slipping."

The system:

- Delivers the voice report to the cleanup team immediately.
- Transcribes the voice note.
- Extracts location: `Food court, stall B12`.
- Detects category: `Cleanup / safety`.
- Detects urgency: `High`, because people are slipping.
- Creates an incident.
- Logs the original audio metadata, transcript, ownership inference, assignment, acknowledgement, and resolution timeline.
- Shows command staff the issue in a live operations feed.

## Why This Matters

Event coordination is still heavily dependent on real-time voice channels. That works for speed, but it breaks down at scale:

- Too much radio chatter.
- No durable transcript.
- No searchable operational memory.
- No automatic routing.
- No clear task ownership.
- No reliable post-event audit trail.
- Hard for managers to understand what happened, when, and who responded.

Mira keeps the speed of voice while adding the structure of a modern operations platform.

The one-line positioning:

> Mira gives operations teams the speed of a walkie-talkie and the memory of software.

## Core Design Principle

AI should not sit in the critical communication path.

Traditional event operations rely on walkie-talkies because voice is transmitted almost instantly. If Mira requires a message to be transcribed, analyzed, and routed before anyone receives it, the product risks becoming too slow for the field teams it is meant to help.

Mira should preserve near-instant communication first. Voice reports are delivered to the relevant team immediately, matching the responsiveness staff expect from radio channels. AI processing happens in parallel as an enhancement layer, not as a prerequisite for delivery.

After the message is received, Mira transcribes it, extracts key details, classifies the incident, identifies ownership, links related activity, and records the interaction in a structured timeline. This turns AI from a bottleneck into background operational intelligence.

## Target Users

- Large conferences and expos.
- Music festivals and sports venues.
- Hotels and hospitality operations.
- University campus operations.
- Warehouses and logistics teams.
- Security teams.
- Emergency drills and incident response teams.
- Facility management teams.

## User Roles

### Technical Manager

The Technical Manager configures Mira for an organization before an event goes live.

Responsibilities:

- Create the organization workspace.
- Define teams and departments.
- Create communication channels.
- Assign users to teams.
- Establish reporting hierarchies.
- Configure channel and routing preferences.
- Manage emergency settings.
- Control permissions and access levels.

This role is important because Mira should model the organization's real operational structure instead of forcing every event into a generic workflow.

### Field Staff

Field staff use Mira during live operations.

Their primary workflow should stay simple:

- Select a channel.
- Hold push-to-talk.
- Speak naturally.
- Hear or see team responses.
- Acknowledge assigned work when needed.

Field staff should not need to write detailed incident reports during the event.

### Team Leads

Team Leads manage ownership and escalation inside a team.

Responsibilities:

- Monitor their team channel.
- Accept or reassign incidents.
- Escalate urgent issues.
- Mark issues resolved.
- Review team workload.

### Command Staff

Command staff use Mira for situational awareness.

Responsibilities:

- Monitor all active channels and incidents.
- Track open issues by team, severity, and location.
- Trigger emergency broadcasts.
- Review timelines during and after the event.

## Organization Model

Organizations are divided into operational teams. Examples:

- Security
- Food & Beverage
- Hospitality
- Medical
- Operations
- Logistics
- Maintenance
- Volunteer Management
- Transportation

Each team should have:

- **Team name:** human-readable name, such as `Security`.
- **Team tag:** short voice-friendly identifier, such as `SEC`, `MED`, or `OPS`.
- **Team description:** responsibilities and operational scope.
- **Team members:** staff assigned to the team.
- **Team leads:** people responsible for ownership, escalation, and resolution.

This structure supports fast channel-based communication while still giving Mira enough data to create useful logs, incidents, and analytics.

## Communication Model

Mira should use channel-based communication as the default model.

Instead of requiring AI to determine every recipient, organizations define channels ahead of time:

- Security Channel
- Medical Channel
- Operations Channel
- Food & Beverage Channel
- Logistics Channel
- Maintenance Channel

A staff member can select a channel or speak the channel name:

> "Security. Crowd gathering near Gate 4."

The message is delivered immediately to the Security channel. AI can later suggest that the report should also involve Operations or Medical, but it should not delay the initial delivery.

This keeps routing simple, fast, and understandable for field teams.

## Voice Interface

### Push-To-Talk Mode

The MVP should use push-to-talk voice messages.

Staff hold a button, speak, and release. Mira immediately sends the audio report to the selected team channel, then runs transcription and enrichment in the background.

Example:

> "Medical assistance needed near Stage B."

### Future Hands-Free Mode

Hands-free operation may be useful later for staff who cannot easily use a phone or tablet during active work.

Possible wake-word syntax:

> "Mira, Security. Suspicious bag near Gate 2."

This should be treated as future expansion, not MVP scope.

## Real-Time Delivery Layer

The real-time delivery layer is the most critical product component.

Requirements:

- Near-instant transmission.
- Minimal latency.
- High reliability.
- Clear delivery status.
- Resilience under poor network conditions.
- No dependency on AI completion before delivery.

If the voice layer feels slower than a walkie-talkie, the product will fail with real operations teams.

## Operational Memory

Traditional radios create communication but no memory. Mira creates memory.

Every voice report contributes to a searchable operational timeline:

- What happened?
- When did it happen?
- Who reported it?
- Which channel received it?
- Who acknowledged it?
- Who owned it?
- When was it resolved?

Example timeline:

- `14:02` Security reports overcrowding near Gate 4.
- `14:04` Operations dispatches additional staff.
- `14:07` Issue resolved.
- `14:10` Gate traffic returns to normal.

This gives teams post-event visibility that radio systems cannot provide.

## Geolocation

Users may optionally share location data with Mira.

Benefits:

- Precise incident mapping.
- Faster response coordination.
- Better situational awareness.
- Post-event heatmap analysis.

Location data should be configurable and privacy-aware. Some organizations may require it for safety; others may only allow location sharing during active events or for specific roles.

## Privacy And AI Governance

Operational environments may include sensitive information:

- Medical situations.
- Staff details.
- Security incidents.
- Personally identifiable information.
- Private venue or customer information.

Mira should make it clear what data is captured, what is stored, and what is sent to AI systems.

Future controls:

- Channel exclusions from AI processing.
- Data retention policies.
- Transcript redaction.
- Role-based access control.
- Enterprise privacy settings.
- Export and deletion workflows.

This is especially important if Mira expands into campuses, hospitals, security, or emergency operations.

## Emergency Broadcast System

Command staff need a way to communicate with everyone instantly.

Mira should include an emergency broadcast flow for authorized users.

Examples:

- Security threat.
- Fire.
- Evacuation.
- Medical emergency.
- Severe weather.

Emergency activation should:

- Send push notifications to all staff.
- Trigger an audible alert.
- Display an emergency banner.
- Log the broadcast automatically.
- Require confirmation to prevent accidental activation.

This is likely not part of the first vertical slice, but it is a strong future feature and helps position Mira as serious operations software.

## Hackathon Track Fit

Best fit:

- **Track 2: Monetizable B2B App**
- **Track 3: Million-scale Global App**
- **Track 4: Open Innovation**

The strongest positioning is probably **Monetizable B2B App**, because the buyer is clear: operations teams running venues, conferences, hotels, campuses, and large facilities.

It can also make a strong case for the million-scale track if the demo emphasizes high-volume event ingestion and scalable routing architecture.

## MVP

The MVP should avoid risky live streaming and focus on a reliable push-to-talk workflow.

### Core Workflow

1. Staff member records a short voice report.
2. App immediately delivers the audio report to the selected team channel.
3. App stores the report metadata and initial delivery event.
4. AI processes the report in parallel and extracts structured fields:
   - category
   - urgency
   - location
   - summary
   - likely owner
   - confidence score
5. System creates or updates the related incident.
6. Team member acknowledges, reassigns, or resolves it.
7. Command center sees status changes in a timeline.
8. Every action is logged.

### Core Screens

- Staff push-to-talk report screen.
- Channel selection and live channel feed.
- Live command center feed.
- Team queues: security, medical, cleanup, logistics, AV, vendor ops.
- Incident detail page with transcript, ownership suggestion, assignment, and timeline.
- Searchable operations log.
- Basic analytics: open incidents, median response time, high-risk areas, team load.
- Technical Manager setup screen for teams and channels.

## AI Features

The AI should be used as an operational intelligence layer, not as a gimmick and not as a delivery blocker.

Possible AI tasks:

- Speech-to-text transcription.
- Extract location, category, urgency, and action requested.
- Summarize messy radio-style reports.
- Identify likely ownership after delivery.
- Suggest rerouting if the original channel looks wrong.
- Detect duplicates or related reports.
- Suggest escalation when urgency is high.
- Generate post-event incident summaries.

## Database Story

The database architecture is important for the hackathon.

The system needs to store:

- organizations
- events
- teams
- channels
- users
- voice report metadata
- immediate delivery events
- transcripts
- AI extraction results
- ownership and rerouting suggestions
- incidents
- team assignments
- acknowledgements
- status changes
- audit events
- emergency broadcasts

### DynamoDB Option

DynamoDB is a strong fit if the story emphasizes high-volume event ingestion.

Potential entities:

- `REPORT`
- `INCIDENT`
- `CHANNEL`
- `TEAM_QUEUE`
- `AUDIT_EVENT`
- `USER`
- `VENUE`

Useful access patterns:

- Get all open incidents for an event.
- Get all reports delivered to a team.
- Get all messages delivered to a channel.
- Get timeline for an incident.
- Get recent high-urgency reports.
- Search reports by event and time window.
- Track acknowledgement and resolution status.

Why DynamoDB fits:

- High write volume from many staff members.
- Low-latency team queues.
- Event-driven audit logs.
- Scales well for large live events.
- Clear separation between immediate voice delivery events and background AI enrichment events.

### Aurora PostgreSQL Option

Aurora PostgreSQL is a strong fit if the story emphasizes relational operations and analytics.

Potential tables:

- `events`
- `venues`
- `teams`
- `channels`
- `users`
- `voice_reports`
- `channel_messages`
- `incidents`
- `incident_assignments`
- `incident_status_events`
- `routing_decisions`
- `audit_log`
- `emergency_broadcasts`

Why Aurora PostgreSQL fits:

- Clear relational model.
- Easier analytics and reporting.
- Strong fit for operations dashboards.
- Good for proving thoughtful schema design.

### Recommended Choice

Use **DynamoDB** if the submission story is about massive real-time operational ingestion.

Use **Aurora PostgreSQL** if the submission story is about clean business operations, relational workflows, and analytics.

For the hackathon, DynamoDB may create a stronger scale story, while Aurora PostgreSQL may make development faster and easier to explain.

## Architecture

Expected architecture:

- v0-generated Next.js frontend deployed on Vercel.
- Push-to-talk voice capture in the browser.
- API route or server action receives audio/report data and records immediate delivery.
- Team channel receives the voice report with minimal delay.
- Transcription service converts audio to text in parallel.
- AI enrichment service extracts structured fields and likely ownership.
- AWS database stores reports, incidents, assignments, and audit events.
- Command center UI reads live incident state.
- Team queues update immediately from delivery events, then become richer as AI enrichment completes.

## v0 And AWS Fit

The hackathon stack should be visible in the product architecture, not just mentioned in the submission.

### v0 / Vercel

Use v0 to generate and iterate on the core interface:

- Staff push-to-talk screen.
- Channel feed.
- Command center.
- Incident timeline.
- Team queue views.
- Technical Manager setup flow.

The app should be a Next.js project deployed on Vercel from the GitHub repository.

### AWS Database

Use an AWS database as the real backend for operational data.

The strongest fit is likely DynamoDB if Mira emphasizes high-volume live event ingestion and low-latency channel events. Aurora PostgreSQL remains an option if the product leans harder into relational analytics and admin workflows.

For the hackathon, the architecture should clearly show:

> v0-built Next.js app on Vercel -> API/server actions -> AWS database -> live command center and team queues.

The submission should include a screenshot proving the AWS database integration through Vercel/v0 storage configuration.

## Demo Story

The demo should be simple and memorable.

1. Show the command center before any incidents.
2. Record a voice report as field staff.
3. Show the voice report appear immediately in the team channel.
4. Show the transcript and AI extraction appear shortly after as background enrichment.
5. Show AI identifying category, urgency, location, and likely owner.
6. A team member acknowledges it.
7. Show the incident timeline and audit log.
8. Simulate several more reports coming in.
9. Show command staff using search or analytics to understand what happened.

The key demo line:

> "Mira keeps the speed of walkie-talkies, while AI turns every transmission into structured operational memory in the background."

## Judging Angle

### Technical Implementation

- Low-latency voice delivery.
- Background transcription and AI classification.
- Thoughtful database schema or access patterns.
- Status workflow and audit log.
- Real deployment on Vercel with AWS database integration.

### Design

- Premium command-center interface.
- Clear team queues and incident states.
- Fast push-to-talk flow for field staff.
- Operator UI built for scanning and action.

### Impact

- Solves a real operational problem.
- Applies to many live-event and facility-management settings.
- Converts chaotic communication into measurable response workflows.

### Originality

- Not another generic dashboard.
- Reimagines walkie-talkie operations as immediate voice communication with AI-enriched operational memory.
- Combines voice, AI, event operations, and scalable database infrastructure.

## Product Name

The product is named **Mira**.

Mira is short, memorable, and works well for a system that listens, understands, and routes operational signals during live events.

## Submission Assets Needed

- Working deployed Vercel app.
- AWS database connected through required integration.
- Architecture diagram.
- Screenshot proving AWS database usage in Vercel/v0 storage configuration.
- Demo video under 3 minutes.
- Text description explaining the app, database choice, and architecture.
- Optional public build article for bonus points.

## Open Product Questions

These questions should be answered before or during implementation.

### Communication And Latency

- What level of latency is acceptable for the MVP: sub-second, 1-2 seconds, or "fast enough for demo"?
- Should MVP audio be live-streamed, or is async push-to-talk voice message delivery enough?
- Should staff receive audio playback only, transcript only, or both?
- Do team channels behave more like walkie-talkie rooms, Slack channels, or incident queues?
- How should Mira show that a message was delivered, heard, acknowledged, or missed?

### Channel And Routing Model

- Are users required to choose a channel before speaking?
- Can users speak the channel name inside the message?
- What happens when AI thinks the selected channel is wrong?
- Should AI automatically notify another team, or only suggest rerouting to a team lead?
- Can one message belong to multiple teams or incidents?

### Incident Creation

- Does every voice report become an incident?
- Should low-importance chatter remain as a channel message without creating an incident?
- What confidence threshold should create an incident automatically?
- Who can merge duplicate reports?
- Who can close or reopen incidents?

### Roles And Permissions

- What are the minimum roles for MVP: Technical Manager, Command Staff, Team Lead, Field Staff?
- Can Field Staff see all channels or only assigned channels?
- Can Team Leads edit AI-generated classification and priority?
- Who can trigger emergency broadcasts?
- Who can access post-event logs and analytics?

### AI Governance

- Which channels should be excluded from AI processing?
- Should sensitive transcripts be redacted before storage?
- How long should audio files and transcripts be retained?
- Should organizations be able to disable AI enrichment per event?
- How should Mira explain AI confidence and uncertainty to operators?

### Location And Privacy

- Is geolocation required, optional, or disabled by default?
- Should location be attached at message time, incident time, or only when users opt in?
- How precise should location be for privacy-sensitive deployments?
- Should location history be visible to managers after the event?

### Database And Scale

- Should the first implementation use DynamoDB for event ingestion or Aurora PostgreSQL for relational workflows?
- What are the core access patterns that must be fast for the demo?
- How will the app model event timelines, channel messages, incidents, and audit events?
- Should audio files be stored separately from metadata?
- What needs to be included in the architecture diagram to make the AWS database choice obvious?

### Demo Scope

- Which event scenario should the demo use: festival, conference, stadium, campus, or warehouse?
- How many teams should exist in the demo?
- Should the demo include emergency broadcast?
- Should the demo simulate many incoming reports to prove scale?
- What is the single strongest story for the 3-minute video?

## Next Step

Pick the database and build the first vertical slice:

1. Configure an event with teams and channels.
2. Record or simulate voice input.
3. Deliver the voice report immediately to the selected team channel.
4. Store report metadata, delivery event, transcript, AI enrichment, incident, and audit events.
5. Display the channel feed, command center, and incident timeline.

Once that works end-to-end, expand the interface and demo polish.
