# Transmission Store — Fire-and-Forget Persistence Sidecar

How Mira durably records every transmission (audio to S3, event-partitioned
metadata to DynamoDB, a transcription job to SQS) **without ever sitting in the
live voice path.**

The non-negotiable rule for this slice: the relay's fan-out to listeners must be
byte-for-byte unaffected and must never block, slow down, or fail because of
persistence. If persistence breaks, the talking channel keeps working and the
error is logged. Everything below exists to make that guarantee structural, not
aspirational.

Data model: the **event is the ownership boundary.** A User creates an Event; the
Event owns Members, Channels, Transmissions, and (later) AI-derived data. The
relay writes transmissions into that event's operational memory.

## The system

```
Sender (PTT)        Relay (Node.js, relay/server.js)              Listeners
  join {event,ch}    room = event::channel  (fan-out isolation)
  meta      --ws-->  forward meta immediately            --ws-->  "Receiving..."
  binary    --ws-->  buffer whole utterance
  end       --ws-->  transcode (FFmpeg -> fragmented mp4)
                     ┌─────────────────────────────────────┐
                     │ 1. FAN OUT mp4 + end to room peers   │ --ws--> audio plays
                     │    (the live delivery — synchronous) │
                     └─────────────────────────────────────┘
                                    │
                                    │ only after fan-out returns
                                    ▼
                     ┌─────────────────────────────────────┐
                     │ 2. hand transmission to store        │
                     │    Promise.resolve().then(persist)   │   (NOT awaited)
                     │    .catch(log)                       │
                     └─────────────────────────────────────┘
                                    │
                          store.persist(tx)  (relay/store.js)
                          ├─ putObject  -> S3        (audio/mp4 bytes)
                          ├─ putItem    -> DynamoDB   (TRANSMISSION record)
                          └─ enqueue    -> SQS        (transcription job)
                                                          │
                                                          ▼
                                                   STT worker (later slice)
```

The store hook lives **inside the relay**, not in the Next.js app, for one
reason: the transcoded mp4 only ever exists here, in the `end` handler, as the
`mp4` buffer produced by FFmpeg. That is the exact artifact we want to persist
and the exact bytes listeners receive. Persisting anywhere else would mean
re-shipping or re-transcoding the audio.

## Event-scoped fan-out

Fan-out rooms are keyed by `eventId::channelId`
(`roomKey(eventId, channelId)`), not by channel name alone, so two events that
reuse a channel name (both have "security") never cross-talk. The `join` message
carries an optional `eventId`; when absent it defaults to `default`, so existing
single-event clients keep working with zero change.

This is the only delivery-path change in the slice, and it is deliberately
minimal: an O(1) string concatenation for the room key, no new dependency, and
no persistence dependency. Delivery still works with all of AWS down. The
event-isolation guarantee is covered by a test (same channel name, two events,
no cross-talk).

## Why the hot path is never blocked

The relevant code in `relay/server.js`'s `end` handler, in order:

```js
const mp4 = await transcode(captured, id)

// 1. LIVE DELIVERY — synchronous fan-out to every peer in the room
for (const peer of peers) {
  if (peer !== ws && peer.readyState === WebSocket.OPEN) {
    peer.send(mp4, { binary: true })
    peer.send(JSON.stringify({ type: 'end' }))
  }
}

// 2. PERSISTENCE SIDECAR — off the hot path
const tx = { eventId, channelId, clientId, relayId, transmissionId,
             startedAt, endedAt, durationMs,
             contentType: 'audio/mp4', size: mp4.length, audio: mp4 }
Promise.resolve()
  .then(() => persistStore.persist(tx))   // S3 -> DynamoDB -> SQS
  .then(() => log(`persisted ${tx.transmissionId}`))
  .catch((err) => log(`PERSIST ERROR (ignored, channel unaffected): ${err.message}`))
```

Three properties make the decoupling structural:

1. **Order.** Every `peer.send` runs before `persist` is even referenced. The
   audio is already on the wire to listeners before the store is touched.

2. **`Promise.resolve().then(() => persist(tx))` — deferred and unawaited.**
   The handler does not `await` this chain. `Promise.resolve().then(...)`
   schedules `persist` as a microtask that runs *after* the current synchronous
   handler finishes. The `ws.on('message')` callback returns immediately; the
   event loop is free to process the next frame. A `persist` that takes 5
   seconds, or never resolves at all, changes nothing about delivery latency.

3. **`.catch` swallows every failure mode.** Wrapping the call in a promise
   chain means both an async rejection (`putObject`/`putItem`/`enqueue` rejects)
   and a *synchronous* throw inside `persist` are caught and logged. Nothing
   escapes to crash the connection or surface as an `unhandledRejection`. (The
   relay still has `process.on('unhandledRejection')` as a backstop, but the
   sidecar never relies on it.)

Worst case for a total persistence outage: a log line per transmission, and
every listener still heard the audio in full. The invariant: **voice delivery
must not depend on S3, DynamoDB, SQS, STT, or any LLM.**

### What is measured

`relay/server.store.test.js` asserts this behavior directly rather than trusting
the reasoning. With an injected store whose `persist`:

- **hangs forever** (`() => new Promise(() => {})`) — listeners still receive all
  three frames (meta, mp4, end),
- **throws asynchronously** (`async () => { throw }`) — fan-out unaffected, `end`
  still delivered,
- **throws synchronously** (`() => { throw }`) — fan-out unaffected.

Further tests assert the writer receives correct event-scoped metadata, that
`tx.audio` is byte-for-byte identical to the mp4 the listener received
(`Buffer.compare(tx.audio, deliveredMp4) === 0`), and that fan-out is isolated by
event.

## The store module (`relay/store.js`)

The module is pure logic plus injected I/O, so it is testable without the AWS
SDK and swappable for a no-op locally.

### Transmission object (`tx`)

Assembled by the relay and handed to `persist`:

| Field | Source | Notes |
|---|---|---|
| `eventId` | `join` message (default `default`) | the ownership boundary |
| `channelId` | `join` message | which channel the utterance went to |
| `clientId` | relay connection id (`c7`) | the sender |
| `relayId` | `MIRA_RELAY_ID` env (default `relay-local`) | which relay handled it |
| `transmissionId` | `crypto.randomUUID()` | unique per transmission |
| `startedAt` | `meta` time (`utteranceStart`) | epoch ms, sender began speaking |
| `endedAt` | `Date.now()` at `end` | epoch ms |
| `durationMs` | `endedAt − startedAt` | wall-clock ms of the utterance |
| `contentType` | `'audio/mp4'` | transcoding normalises every input to this |
| `size` | `mp4.length` | bytes |
| `audio` | the `mp4` buffer | persisted to S3; never stored in DynamoDB |

`durationMs` is a wall-clock proxy: `startedAt` is stamped when the relay
forwards `meta` (the moment the sender starts speaking) and subtracted at `end`.
It is not derived from decoding the audio container, which would add work to the
path; the wall-clock figure is accurate enough for operational timelines.

### S3 key scheme

```
<eventId>/<channelId>/<YYYY-MM-DD>/<transmissionId>.mp4
e.g.  event123/security/2026-06-16/3f2a…c1.mp4
```

`s3Key()` derives the date from `endedAt`. Partitioning by the ownership
boundary (event) then channel then UTC day keeps prefixes scannable and makes
lifecycle/retention policies expressible per event, channel, or day — important
as Mira grows into governed environments with retention rules.

### DynamoDB schema (event operational memory, single table)

The table is partitioned by event and holds the whole operational memory of an
event; a transmission is one entity type among many planned:

```
PK                  SK
-----------------------------------------------
EVENT#event123      META
EVENT#event123      MEMBER#user456
EVENT#event123      CHANNEL#security
EVENT#event123      TX#1781947800000#3f2a…c1
EVENT#event123      INCIDENT#<ts>#<id>        (future)
EVENT#event123      SUMMARY#<ts>              (future)
```

This slice writes only the **TRANSMISSION** item via `buildRecord()`
(members/channels/incidents are created by the app/setup surfaces, not the
relay):

| Attribute | Example | Role |
|---|---|---|
| `pk` | `EVENT#event123` | partition key — one event |
| `sk` | `TX#1781947800000#3f2a…c1` | sort key — `TX#<endedAt>#<id>` |
| `entityType` | `TRANSMISSION` | discriminator within the table |
| `schemaVersion` | `1` | for forward migration |
| `eventId` | `event123` | |
| `channelId` | `security` | |
| `clientId` | `c7` | sender |
| `relayId` | `relay-a` | which relay handled it |
| `transmissionId` | `3f2a…c1` | |
| `startedAt` | `1781947797500` | epoch ms |
| `endedAt` | `1781947800000` | epoch ms (mirrors the sort prefix) |
| `durationMs` | `2500` | |
| `s3Bucket` | `mira-transmissions` | |
| `s3Key` | `event123/security/2026-06-16/3f2a…c1.mp4` | pointer to the audio |
| `contentType` | `audio/mp4` | |
| `size` | `4096` | bytes |

**Primary access pattern:** "show everything in an event, in time order." Query
`pk = EVENT#<id>`; the `TX#<endedAt>#…` sort key returns transmissions
chronologically, forward or reverse, interleaved with other entity types as the
model grows. The event partition isolates each tenant's read/write load.

**Future GSIs (only when proven):** operator history
(`GSI1PK = CLIENT#<clientId>`) and channel replay
(`GSI2PK = CHANNEL#<channelId>`). Channel is never the primary partition key.

Write order is **S3 first, then DynamoDB, then SQS** (see below).

### STT pipeline boundary (SQS) — `relay/queue.js`

After S3 + DynamoDB succeed, `persist` enqueues a transcription job:

```json
{ "eventId": "...", "transmissionId": "...", "bucket": "...", "key": "..." }
```

STT workers consume this queue explicitly. They do **not** poll DynamoDB, and we
do **not** use DynamoDB Streams at this stage — the queue is explicit,
debuggable, and easy to retry. The worker is a later slice; this slice only
establishes the interface, defaulting to a no-op queue locally. The job carries
exactly what a worker needs (the S3 location + ids), so it never reads back
through the database to start work.

### Write ordering: S3 → DynamoDB → SQS

```js
await putObject({ Bucket, Key, Body: tx.audio, ContentType: tx.contentType })
const record = buildRecord({ ...tx, bucket, key })
await putItem(record)
await enqueue({ eventId, transmissionId, bucket, key })
```

Each step gates the next; a failure short-circuits the rest (and is caught by
the sidecar's `.catch`). The failure asymmetry is intentional:

- S3 ok, DynamoDB fails → an **orphan object** (audio, no record, no STT job).
  Harmless: unreferenced, ages out under lifecycle rules. Logged.
- DynamoDB ok, S3 fails → would be a **dangling record/job** pointing at a
  missing object. Avoided by writing S3 first: if `putObject` rejects, neither
  the record nor the job is written.
- STT enqueued for a transmission with no metadata record → avoided by enqueuing
  only after `putItem` succeeds, so a transcript never attaches to a missing
  parent.

All three orderings are proven by `store.test.js`.

### Dependency injection and lazy SDK loading

`createStore({ bucket, putObject, putItem, enqueue })` takes the three write
operations as functions. This is what makes the logic unit-testable with spies
and keeps the AWS SDK out of the test path entirely. `enqueue` defaults to a
no-op, so persistence can run without the STT pipeline wired up.

`createStoreFromEnv()` builds the real operations and only there does it
`await import('@aws-sdk/client-s3')` / `client-dynamodb` / `lib-dynamodb`, and
`createQueueFromEnv()` lazily imports `@aws-sdk/client-sqs` — **all on first
write.** The SDK is never loaded when running the no-op store/queue (dev/tests),
so it costs nothing there.

### Store / queue selection

```
createStoreFromEnv(env):
  MIRA_STORE === 'noop'         -> noop store   (force local stub)
  no MIRA_S3_BUCKET / DDB_TABLE -> noop store   (default — dev/tests)
  both set                      -> aws store (enqueue from createQueueFromEnv)

createQueueFromEnv(env):
  MIRA_STORE === 'noop'         -> noop queue
  no MIRA_SQS_QUEUE_URL         -> noop queue   (STT pipeline optional)
  set                           -> sqs queue
```

The **no-op store/queue** accept a transmission/job and do nothing. They are the
default, so the relay runs with zero AWS config, zero credentials, and zero
spend out of the box. Persistence and STT enqueue are each strictly opt-in.

## Configuration

All via environment variables (documented in `relay/.env.example`); no secrets
in the repo.

| Var | Purpose |
|---|---|
| `MIRA_S3_BUCKET` | target bucket for audio; required to enable persistence |
| `MIRA_DDB_TABLE` | target table (event operational memory); required to enable persistence |
| `MIRA_SQS_QUEUE_URL` | target queue for transcription jobs; optional (unset = no STT enqueue) |
| `MIRA_RELAY_ID` | recorded as `relayId` on each transmission (default `relay-local`) |
| `MIRA_STORE=noop` | force the local stub (store + queue) even if config is set |
| `AWS_REGION` | region (default `us-east-1`) |
| AWS credentials | resolved by the default AWS SDK provider chain (env, shared config, or EC2 instance role) |

## Cost posture

- Default no-op store/queue means dev and CI never call AWS, protecting the
  budgeted AWS spend and its alerts.
- One `PutObject` + one `PutItem` (+ optional one `SendMessage`) per
  transmission — proportional to actual traffic, no polling or background sweeps.
- The S3 key layout supports cheap per-event/-channel/-day lifecycle expiry so
  audio does not accumulate cost indefinitely.

## Failure modes

| Failure | Effect on live audio | Effect on persistence |
|---|---|---|
| `persist` slow / hung | none (unawaited microtask) | that write stalls; logged |
| `putObject` throws | none | record + job skipped; logged; no orphan |
| `putItem` throws | none | orphan object remains; job skipped; logged |
| `enqueue` throws | none | object + record persisted; no STT job; logged |
| Wrong/missing AWS creds | none | writes fail; logged each transmission |
| `MIRA_STORE=noop` / unset | none | nothing persisted (by design) |

## Where this fits the vision

This slice is the persistence layer beneath the delivery layer (Slice 1). It
turns each ephemeral transmission into a durable, event-owned record + audio
object, and hands a job to the STT pipeline — all entirely off the delivery
path. That durable transmission + event-memory foundation is the substrate the
background enrichment pipeline (transcription, classification, incident
creation) will build on next. The principle is the same at every layer: **voice
is delivered first; everything else catches up behind it, and never the
reverse.**

See also: `docs/slice2-store.md` (slice summary), `architecture/ec2-relay-ops.md`
(how the relay is deployed).
