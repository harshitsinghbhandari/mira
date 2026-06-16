# Slice 2: Store (transmission persistence sidecar)

Branch: `slice/store`
Date: 2026-06-16

## Goal

When a transmission happens, persist its transcoded audio to S3 and a metadata
record to DynamoDB, **without ever touching the live talking channel**. Delivery
stays instant; persistence is a fire-and-forget sidecar off the hot path.

## How decoupling is guaranteed

In `relay/server.js`, the `end` handler does, in order:

1. `transcode()` the buffered audio to fragmented MP4/AAC (unchanged from slice 1).
2. **Fan out** the mp4 + `end` to every peer in the channel (the live delivery).
3. **Only then** hand the transmission to the store with:

   ```js
   Promise.resolve()
     .then(() => persistStore.persist(tx))
     .catch((err) => log(`PERSIST ERROR (ignored, channel unaffected): ...`))
   ```

`Promise.resolve().then(...)` defers the write past the synchronous fan-out, and
it is **never awaited**. `.catch` swallows both synchronous throws and async
rejections. So a slow, stuck, or failing S3/DynamoDB call cannot backpressure,
delay, or break the talking channel. Worst case: the error is logged and the
audio still played for every listener.

Tests prove this directly (`relay/server.store.test.js`): live fan-out still
delivers all three messages (meta, mp4, end) when the writer hangs forever,
throws asynchronously, or throws synchronously.

## S3 key scheme

```
<channel>/<YYYY-MM-DD>/<transmissionId>.mp4
```

Groups recordings by channel then day: scannable prefixes, easy per-channel or
per-day lifecycle/retention rules.

## DynamoDB schema (minimal single table)

| Attribute        | Example                                  | Notes                              |
| ---------------- | ---------------------------------------- | ---------------------------------- |
| `pk`             | `CHANNEL#ch5`                            | Partition key — one channel        |
| `sk`             | `TX#1781947800000#<uuid>`                | Sort key — `TX#<epochMs>#<id>`, time-ordered |
| `transmissionId` | `<uuid>`                                 | `crypto.randomUUID()`              |
| `channel`        | `ch5`                                    |                                    |
| `timestamp`      | `2026-06-16T09:30:00.000Z`               | ISO 8601                           |
| `epochMs`        | `1781947800000`                          | epoch ms                           |
| `durationMs`     | `2500`                                   | wall-clock from `meta` to `end`    |
| `clientId`       | `c7`                                     | sender connection id               |
| `s3Bucket`       | `mira-transmissions`                     |                                    |
| `s3Key`          | `ch5/2026-06-16/<uuid>.mp4`              |                                    |
| `contentType`    | `audio/mp4`                              |                                    |
| `size`           | `4096`                                   | bytes                              |

Listing a channel's transmissions chronologically = query `pk = CHANNEL#<id>`,
sort by `sk`.

Write order is **S3 first, then DynamoDB**, so a record never points at a
missing object.

## Environment variables

See `relay/.env.example`. Persistence is opt-in:

- `MIRA_S3_BUCKET` + `MIRA_DDB_TABLE` — set both to enable real persistence.
- `MIRA_STORE=noop` — force the local stub even if the above are set.
- Unset bucket/table → no-op store (default): **no AWS calls, no budget spend,
  no credentials needed**. This is what dev and tests use.
- `AWS_REGION` (default `us-east-1`); credentials via the default AWS SDK
  provider chain. No secrets in the repo.

The AWS SDK is imported lazily — only when a real store is built and a write
actually happens — so the noop path never loads it.
