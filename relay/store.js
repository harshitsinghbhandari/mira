// Transmission persistence sidecar.
//
// Assembles an S3 key + an event-partitioned DynamoDB record for a finished
// transmission, writes them via injected `putObject` / `putItem` functions, then
// enqueues a transcription job via an injected `enqueue`. It is called
// fire-and-forget from the relay AFTER the live fan-out has completed, so a slow
// or failing AWS call can never backpressure or break the talking channel.
//
// Data model: the event is the ownership boundary. DynamoDB is a single table of
// event operational memory (PK = EVENT#<eventId>); a transmission is one entity
// type within it. See docs/slice2-store.md and the architecture doc.
//
// The AWS SDK is imported lazily (only when a real store is built from env), so
// tests and local dev that use the noop store never touch the SDK or credentials.

import { createQueueFromEnv } from './queue.js'

// S3 key scheme: <eventId>/<channelId>/<YYYY-MM-DD>/<transmissionId>.mp4
// Partitioned by the ownership boundary (event) then channel then UTC day, which
// keeps prefixes scannable and makes per-event/-channel/-day retention easy.
export function s3Key({ eventId, channelId, transmissionId, endedAt }) {
  // endedAt is the date partition; guard it so a contract slip yields a clear
  // error instead of a cryptic "Invalid time value" RangeError. (Any throw here
  // is already caught by the relay's fire-and-forget .catch, never the channel.)
  if (!Number.isFinite(endedAt)) {
    throw new Error(`s3Key requires a valid endedAt timestamp (epoch ms), got: ${endedAt}`)
  }
  const date = new Date(endedAt).toISOString().slice(0, 10)
  return `${eventId}/${channelId}/${date}/${transmissionId}.mp4`
}

// One DynamoDB item: an EVENT#-partitioned TRANSMISSION entity, sorted by end
// time so an event's transmissions read back chronologically. Audio bytes are
// NEVER stored here — only the S3 pointer.
export function buildRecord({
  eventId,
  channelId,
  clientId,
  relayId,
  transmissionId,
  startedAt,
  endedAt,
  durationMs,
  bucket,
  key,
  contentType,
  size,
}) {
  return {
    pk: `EVENT#${eventId}`,
    sk: `TX#${endedAt}#${transmissionId}`,
    entityType: 'TRANSMISSION',
    schemaVersion: 1,
    eventId,
    channelId,
    clientId,
    relayId,
    transmissionId,
    startedAt,
    endedAt,
    durationMs,
    s3Bucket: bucket,
    s3Key: key,
    contentType,
    size,
  }
}

// Real store. `putObject`/`putItem`/`enqueue` are injected so the persistence
// pipeline is fully decoupled from (and testable without) the AWS SDK.
export function createStore({ bucket, putObject, putItem, enqueue = async () => {} }) {
  return {
    kind: 'aws',
    async persist(tx) {
      const key = s3Key(tx)
      // 1. S3 first: the record and the STT job both point at this object, so a
      //    dangling pointer (object missing) is worse than an orphan object.
      await putObject({
        Bucket: bucket,
        Key: key,
        Body: tx.audio,
        ContentType: tx.contentType,
      })
      // 2. DynamoDB metadata record.
      const record = buildRecord({ ...tx, bucket, key })
      await putItem(record)
      // 3. Hand off to the STT pipeline (workers consume the queue, not the DB).
      await enqueue({
        eventId: tx.eventId,
        transmissionId: tx.transmissionId,
        bucket,
        key,
      })
      return record
    },
  }
}

// Local/dev/test store: accepts a transmission and does nothing. Keeps the relay
// runnable with zero AWS config and zero budget spend.
export function createNoopStore() {
  return {
    kind: 'noop',
    async persist() {
      // intentionally does nothing
    },
  }
}

// Build a store from environment variables.
//
//   MIRA_STORE       set to "noop" to force the local stub (overrides AWS config)
//   MIRA_S3_BUCKET   target S3 bucket for transcoded audio
//   MIRA_DDB_TABLE   target DynamoDB table for event operational memory
//   MIRA_SQS_QUEUE_URL  target SQS queue for transcription jobs (optional)
//   AWS_REGION       AWS region (default us-east-1)
//   AWS credentials  resolved by the default AWS SDK provider chain (never hardcoded)
//
// Without a bucket + table (or with MIRA_STORE=noop) it returns the noop store,
// so dev and tests run without live AWS and without burning the AWS budget.
export function createStoreFromEnv(env = process.env) {
  if (env.MIRA_STORE === 'noop' || !env.MIRA_S3_BUCKET || !env.MIRA_DDB_TABLE) {
    return createNoopStore()
  }

  const region = env.AWS_REGION || 'us-east-1'
  const table = env.MIRA_DDB_TABLE
  let s3
  let ddb

  const putObject = async (input) => {
    if (!s3) {
      const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3')
      s3 = { client: new S3Client({ region }), PutObjectCommand }
    }
    return s3.client.send(new s3.PutObjectCommand(input))
  }

  const putItem = async (item) => {
    if (!ddb) {
      const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb')
      const { DynamoDBDocumentClient, PutCommand } = await import('@aws-sdk/lib-dynamodb')
      ddb = {
        client: DynamoDBDocumentClient.from(new DynamoDBClient({ region })),
        PutCommand,
      }
    }
    return ddb.client.send(new ddb.PutCommand({ TableName: table, Item: item }))
  }

  const queue = createQueueFromEnv(env)

  return createStore({
    bucket: env.MIRA_S3_BUCKET,
    putObject,
    putItem,
    enqueue: (job) => queue.enqueue(job),
  })
}
