# Transmission Store — Fire-and-Forget Persistence Sidecar

How Mira durably records every transmission (audio to S3, metadata to
DynamoDB) **without ever sitting in the live voice path.**

The non-negotiable rule for this slice: the relay's fan-out to listeners must be
byte-for-byte unaffected and must never block, slow down, or fail because of
persistence. If persistence breaks, the talking channel keeps working and the
error is logged. Everything below exists to make that guarantee structural, not
aspirational.

## The system

```
Sender (PTT)        Relay (Node.js, relay/server.js)              Listeners
  meta      --ws-->  forward meta immediately            --ws-->  "Receiving..."
  binary    --ws-->  buffer whole utterance
  end       --ws-->  transcode (FFmpeg -> fragmented mp4)
                     ┌─────────────────────────────────────┐
                     │ 1. FAN OUT mp4 + end to every peer   │ --ws--> audio plays
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
                          ├─ putObject  -> S3   (audio/mp4 bytes)
                          └─ putItem    -> DynamoDB (metadata record)
```

The store hook lives **inside the relay**, not in the Next.js app, for one
reason: the transcoded mp4 only ever exists here, in the `end` handler, as the
`mp4` buffer produced by FFmpeg. That is the exact artifact we want to persist
and the exact bytes listeners receive. Persisting anywhere else would mean
re-shipping or re-transcoding the audio.

## Why the hot path is never blocked

The relevant code in `relay/server.js`'s `end` handler, in order:

```js
const mp4 = await transcode(captured, id)

// 1. LIVE DELIVERY — synchronous fan-out to every peer
for (const peer of peers) {
  if (peer !== ws && peer.readyState === WebSocket.OPEN) {
    peer.send(mp4, { binary: true })
    peer.send(JSON.stringify({ type: 'end' }))
  }
}

// 2. PERSISTENCE SIDECAR — off the hot path
const tx = { channel, transmissionId, clientId, timestamp, duration,
             contentType: 'audio/mp4', size: mp4.length, audio: mp4 }
Promise.resolve()
  .then(() => persistStore.persist(tx))
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
   chain means both an async rejection (`putObject` rejects) and a *synchronous*
   throw inside `persist` (e.g. a bad client constructed eagerly) are caught and
   logged. Nothing escapes to crash the connection or surface as an
   `unhandledRejection`. (The relay still has `process.on('unhandledRejection')`
   as a backstop, but the sidecar never relies on it.)

Worst case for a total persistence outage: a log line per transmission, and
every listener still heard the audio in full.

### What is measured

`relay/server.store.test.js` asserts this behavior directly rather than trusting
the reasoning. With an injected store whose `persist`:

- **hangs forever** (`() => new Promise(() => {})`) — listeners still receive all
  three frames (meta, mp4, end),
- **throws asynchronously** (`async () => { throw }`) — fan-out unaffected, `end`
  still delivered,
- **throws synchronously** (`() => { throw }`) — fan-out unaffected.

A fourth test asserts the writer receives correct metadata and that
`tx.audio` is byte-for-byte identical to the mp4 the listener received
(`Buffer.compare(tx.audio, deliveredMp4) === 0`).

## The store module (`relay/store.js`)

The module is pure logic plus injected I/O, so it is testable without the AWS
SDK and swappable for a no-op locally.

### Transmission object (`tx`)

Assembled by the relay and handed to `persist`:

| Field | Source | Notes |
|---|---|---|
| `channel` | `channelId` | which channel the utterance was sent to |
| `transmissionId` | `crypto.randomUUID()` | unique per transmission |
| `clientId` | relay connection id (`c7`) | the sender |
| `timestamp` | `Date.now()` at `end` | epoch ms |
| `duration` | `end` time − `meta` time | wall-clock ms of the utterance |
| `contentType` | `'audio/mp4'` | transcoding normalises every input to this |
| `size` | `mp4.length` | bytes |
| `audio` | the `mp4` buffer | persisted to S3; not stored in DynamoDB |

`duration` is a wall-clock proxy: `utteranceStart` is stamped when the relay
forwards `meta` (the moment the sender starts speaking) and subtracted at `end`.
It is not derived from decoding the audio container, which would add work to the
path; the wall-clock figure is accurate enough for operational timelines.

### S3 key scheme

```
<channel>/<YYYY-MM-DD>/<transmissionId>.mp4
e.g.  ch5/2026-06-16/3f2a…c1.mp4
```

`s3Key()` derives the date from the transmission timestamp. Grouping by channel
then UTC day keeps prefixes scannable (list one channel's audio for one day with
a single prefix) and makes lifecycle/retention policies expressible per channel
or per day — important as Mira grows into governed environments with retention
rules.

### DynamoDB schema (minimal single table)

`buildRecord()` produces one item:

| Attribute | Example | Role |
|---|---|---|
| `pk` | `CHANNEL#ch5` | partition key — one channel |
| `sk` | `TX#1781947800000#3f2a…c1` | sort key — `TX#<epochMs>#<id>` |
| `transmissionId` | `3f2a…c1` | |
| `channel` | `ch5` | |
| `timestamp` | `2026-06-16T09:30:00.000Z` | ISO 8601 |
| `epochMs` | `1781947800000` | numeric, mirrors the sort prefix |
| `durationMs` | `2500` | |
| `clientId` | `c7` | sender |
| `s3Bucket` | `mira-transmissions` | |
| `s3Key` | `ch5/2026-06-16/3f2a…c1.mp4` | pointer to the audio |
| `contentType` | `audio/mp4` | |
| `size` | `4096` | bytes |

**Access pattern this serves:** "list a channel's transmissions, newest or
oldest first." Query `pk = CHANNEL#<id>`; the `TX#<epochMs>#…` sort key returns
them in chronological order, forward or reverse. The partition key isolates each
channel's write/read load. This is a deliberately minimal single-table design
sized to the slice; the broader vision (incidents, status events, audit log)
will layer additional item types onto the same table or add GSIs as those
access patterns are defined.

### Write ordering: S3 first, then DynamoDB

```js
await putObject({ Bucket, Key, Body: tx.audio, ContentType: tx.contentType })
await putItem(buildRecord({ ...tx, bucket, key }))
```

The object is written before the record that points at it. The failure
asymmetry is intentional:

- S3 succeeds, DynamoDB fails → an **orphan object** (audio with no record).
  Harmless: it is unreferenced and ages out under lifecycle rules. Logged.
- DynamoDB succeeds, S3 fails → a **dangling record** (metadata pointing at a
  missing object). A reader following `s3Key` would 404.

The first is strictly better, so S3 goes first. If `putObject` rejects, the
record write is skipped entirely (`createStore`'s `persist` throws before
reaching `putItem`) — proven by `store.test.js`.

### Dependency injection and lazy SDK loading

`createStore({ bucket, putObject, putItem })` takes the two write operations as
functions. This is what makes the logic unit-testable with spies and keeps the
AWS SDK out of the test path entirely.

`createStoreFromEnv()` builds the real operations and only there does it
`await import('@aws-sdk/client-s3')` etc. — **lazily, on first write.** The SDK
is never loaded when running the no-op store (dev/tests), so it costs nothing
there.

### Store selection

```
createStoreFromEnv(env):
  MIRA_STORE === 'noop'         -> noop store   (force local stub)
  no MIRA_S3_BUCKET / DDB_TABLE -> noop store   (default — dev/tests)
  both set                      -> aws store
```

The **no-op store** accepts a transmission and does nothing. It is the default,
so the relay runs with zero AWS config, zero credentials, and zero spend out of
the box. Persistence is strictly opt-in.

## Configuration

All via environment variables (documented in `relay/.env.example`); no secrets
in the repo.

| Var | Purpose |
|---|---|
| `MIRA_S3_BUCKET` | target bucket for audio; required to enable persistence |
| `MIRA_DDB_TABLE` | target table for metadata; required to enable persistence |
| `MIRA_STORE=noop` | force the local stub even if bucket/table are set |
| `AWS_REGION` | region (default `us-east-1`) |
| AWS credentials | resolved by the default AWS SDK provider chain (env, shared config, or EC2 instance role) |

## Cost posture

- Default no-op store means dev and CI never call AWS, protecting the budgeted
  AWS spend and its alerts.
- One `PutObject` + one `PutItem` per transmission — proportional to actual
  traffic, no polling or background sweeps.
- The S3 key layout supports cheap per-day/per-channel lifecycle expiry so audio
  does not accumulate cost indefinitely.

## Failure modes

| Failure | Effect on live audio | Effect on persistence |
|---|---|---|
| `persist` slow / hung | none (unawaited microtask) | that write stalls; logged |
| `putObject` throws | none | record skipped; logged; no orphan |
| `putItem` throws | none | orphan object remains; logged |
| Wrong/missing AWS creds | none | writes fail; logged each transmission |
| `MIRA_STORE=noop` / unset | none | nothing persisted (by design) |

## Where this fits the vision

This slice is the persistence layer beneath the delivery layer (Slice 1). It
turns each ephemeral transmission into a durable record + audio object, which is
the input the background enrichment pipeline (transcription, classification,
incident creation) will later consume — entirely off the delivery path, exactly
as the store sidecar is. The principle is the same at every layer: **voice is
delivered first; everything else catches up behind it, and never the reverse.**

See also: `docs/slice2-store.md` (slice summary), `architecture/ec2-relay-ops.md`
(how the relay is deployed).
