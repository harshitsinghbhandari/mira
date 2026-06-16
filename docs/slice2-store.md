# Slice 2: Store (transmission persistence sidecar)

Branch: `slice/store`
Date: 2026-06-16

## Goal

When a transmission happens, persist its transcoded audio to S3, a metadata
record to DynamoDB, and a transcription job to SQS, **without ever touching the
live talking channel**. Delivery stays instant; persistence is a fire-and-forget
sidecar off the hot path.

The data model is multi-tenant and **event-centric**: a User creates an Event;
the Event owns Members, Channels, Transmissions, and (later) AI-derived data.
**The event is the ownership boundary.**

## How decoupling is guaranteed

In `relay/server.js`, the `end` handler does, in order:

1. `transcode()` the buffered audio to fragmented MP4/AAC (unchanged from slice 1).
2. **Fan out** the mp4 + `end` to every peer in the room (the live delivery).
3. **Only then** hand the transmission to the store:

   ```js
   Promise.resolve()
     .then(() => persistStore.persist(tx))   // S3 -> DynamoDB -> SQS
     .catch((err) => log(`PERSIST ERROR (ignored, channel unaffected): ...`))
   ```

`Promise.resolve().then(...)` defers the write past the synchronous fan-out, and
it is **never awaited**. `.catch` swallows both synchronous throws and async
rejections. So a slow, stuck, or failing S3/DynamoDB/SQS call cannot
backpressure, delay, or break the talking channel. Worst case: the error is
logged and the audio still played for every listener.

Tests prove this directly (`relay/server.store.test.js`): live fan-out still
delivers all three messages (meta, mp4, end) when the writer hangs forever,
throws asynchronously, or throws synchronously.

### The invariant

Voice delivery MUST NOT depend on S3, DynamoDB, SQS, STT, or any LLM. The relay
keeps delivering audio even if every persistence and AI component is down.

## Event-scoped fan-out

Fan-out rooms are keyed by `eventId::channelId`, not by channel name alone, so
two events that reuse a channel name (e.g. both have "security") never
cross-talk. The `join` message accepts an optional `eventId`; when absent it
defaults to `default`, so existing single-event clients are unaffected. This is
an O(1) in-memory routing change with no new dependency and no persistence
dependency — delivery still works with all of AWS down.

## S3 key scheme

```
<eventId>/<channelId>/<YYYY-MM-DD>/<transmissionId>.mp4
```

Partitioned by the ownership boundary (event), then channel, then UTC day:
scannable prefixes and easy per-event/-channel/-day lifecycle/retention rules.
Audio bytes are stored only in S3, never in DynamoDB.

## DynamoDB schema (event operational memory, single table)

The table holds an event's whole operational memory, partitioned by event. A
transmission is one entity type among many planned:

```
PK                  SK
-----------------------------------------------
EVENT#event123      META
EVENT#event123      MEMBER#user456
EVENT#event123      CHANNEL#security
EVENT#event123      TX#1781947800000#tx123
EVENT#event123      INCIDENT#<ts>#<id>      (future)
EVENT#event123      SUMMARY#<ts>            (future)
```

This slice writes only the **TRANSMISSION** item (members/channels/incidents are
created by the app/setup surfaces, not the relay):

| Attribute        | Example                                   | Notes                              |
| ---------------- | ----------------------------------------- | ---------------------------------- |
| `pk`             | `EVENT#event123`                          | Partition key — one event          |
| `sk`             | `TX#1781947800000#tx123`                  | `TX#<endedAt>#<id>`, time-ordered  |
| `entityType`     | `TRANSMISSION`                            | discriminator within the table     |
| `schemaVersion`  | `1`                                       | for forward migration              |
| `eventId`        | `event123`                                |                                    |
| `channelId`      | `security`                                |                                    |
| `clientId`       | `c7`                                      | sender connection id               |
| `relayId`        | `relay-a`                                 | which relay handled it (env)       |
| `transmissionId` | `tx123`                                   | `crypto.randomUUID()`              |
| `startedAt`      | `1781947797500`                           | epoch ms (sender began speaking)   |
| `endedAt`        | `1781947800000`                           | epoch ms (transmission ended)      |
| `durationMs`     | `2500`                                    | `endedAt - startedAt`              |
| `s3Bucket`       | `mira-transmissions`                      |                                    |
| `s3Key`          | `event123/security/2026-06-16/tx123.mp4`  |                                    |
| `contentType`    | `audio/mp4`                               |                                    |
| `size`           | `4096`                                    | bytes                              |

**Primary access pattern:** "show everything in an event, in time order" =
query `pk = EVENT#<id>`, sort by `sk`. Channel/operator history are future GSIs
(`GSI2PK = CHANNEL#<id>`, `GSI1PK = CLIENT#<id>`), added only when those access
patterns are proven; channel is never the primary partition key.

Write order is **S3 first, then DynamoDB, then SQS**, so a record never points
at a missing object and an STT job never references missing metadata.

## STT pipeline boundary (SQS)

After S3 + DynamoDB succeed, the store enqueues a transcription job:

```json
{ "eventId": "...", "transmissionId": "...", "bucket": "...", "key": "..." }
```

STT workers consume this queue explicitly. They do **not** poll DynamoDB, and we
do **not** use DynamoDB Streams at this stage (the queue is explicit,
debuggable, and easy to retry). The STT worker itself is a later slice — this
slice only establishes the interface, defaulting to a no-op queue locally.

## Environment variables

See `relay/.env.example`. Persistence is opt-in:

- `MIRA_S3_BUCKET` + `MIRA_DDB_TABLE` — set both to enable real persistence.
- `MIRA_SQS_QUEUE_URL` — optional; unset = no STT enqueue.
- `MIRA_RELAY_ID` — recorded as `relayId` (default `relay-local`).
- `MIRA_STORE=noop` — force the local stub (store + queue) even if the above are set.
- Unset bucket/table → no-op store (default): **no AWS calls, no budget spend,
  no credentials needed**. This is what dev and tests use.
- `AWS_REGION` (default `us-east-1`); credentials via the default AWS SDK
  provider chain. No secrets in the repo.

The AWS SDK (S3, DynamoDB, SQS clients) is imported lazily — only when a real
store/queue is built and a write actually happens — so the noop path never
loads it.
