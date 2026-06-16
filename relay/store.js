// Transmission persistence sidecar.
//
// This module assembles an S3 key + DynamoDB record for a finished transmission
// and writes them via injected `putObject` / `putItem` functions. It is called
// fire-and-forget from the relay AFTER the live fan-out has completed, so a slow
// or failing AWS call can never backpressure or break the talking channel.
//
// The AWS SDK is imported lazily (only when a real store is built from env), so
// tests and local dev that use the noop store never touch the SDK or credentials.

// S3 key scheme: channel/YYYY-MM-DD/transmissionId.mp4
// Groups recordings by channel then day, which keeps prefixes scannable and
// makes lifecycle/retention rules easy to express per channel or per day.
export function s3Key({ channel, transmissionId, timestamp }) {
  const date = new Date(timestamp).toISOString().slice(0, 10)
  return `${channel}/${date}/${transmissionId}.mp4`
}

// Minimal single-table DynamoDB item. Partition by channel, sort by time so a
// channel's transmissions read back chronologically (TX#<epochMs>#<id>).
export function buildRecord({
  channel,
  transmissionId,
  timestamp,
  duration,
  clientId,
  bucket,
  key,
  contentType,
  size,
}) {
  return {
    pk: `CHANNEL#${channel}`,
    sk: `TX#${timestamp}#${transmissionId}`,
    transmissionId,
    channel,
    timestamp: new Date(timestamp).toISOString(),
    epochMs: timestamp,
    durationMs: duration,
    clientId,
    s3Bucket: bucket,
    s3Key: key,
    contentType,
    size,
  }
}

// Real store. `putObject`/`putItem` are injected so the persistence logic is
// fully decoupled from (and testable without) the AWS SDK.
export function createStore({ bucket, putObject, putItem }) {
  return {
    kind: 'aws',
    async persist(tx) {
      const key = s3Key(tx)
      // Write the object first; the record points at it, so a dangling record
      // (object missing) is worse than a dangling object (record missing).
      await putObject({
        Bucket: bucket,
        Key: key,
        Body: tx.audio,
        ContentType: tx.contentType,
      })
      await putItem(buildRecord({ ...tx, bucket, key }))
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
//   MIRA_DDB_TABLE   target DynamoDB table for metadata records
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

  return createStore({ bucket: env.MIRA_S3_BUCKET, table, putObject, putItem })
}
