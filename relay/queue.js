// Transcription job queue (STT pipeline boundary).
//
// After a transmission is persisted (audio in S3, metadata in DynamoDB), the
// relay enqueues a small job so a downstream STT worker can pick it up. Workers
// consume the queue explicitly — they do NOT poll DynamoDB and we do NOT use
// DynamoDB Streams at this stage (explicit, debuggable, easy to retry).
//
// Like the store, the queue is only ever called from the fire-and-forget
// sidecar, never on the voice path, and defaults to a no-op locally so dev and
// tests need no SQS and spend no budget. The AWS SDK is imported lazily.

export function createNoopQueue() {
  return {
    kind: 'noop',
    async enqueue() {
      // intentionally does nothing
    },
  }
}

// `sendMessage` is injected (the SQS SendMessage operation), so the enqueue
// logic is testable without the AWS SDK.
export function createSqsQueue({ queueUrl, sendMessage }) {
  return {
    kind: 'sqs',
    async enqueue(job) {
      await sendMessage({ QueueUrl: queueUrl, MessageBody: JSON.stringify(job) })
    },
  }
}

// Build a queue from environment variables:
//
//   MIRA_SQS_QUEUE_URL  target SQS queue for transcription jobs (opt-in)
//   MIRA_STORE=noop     forces the no-op queue too
//   AWS_REGION          region (default us-east-1)
//
// Without a queue URL (or with MIRA_STORE=noop) it returns the no-op queue, so
// persistence can run without the STT pipeline wired up.
export function createQueueFromEnv(env = process.env) {
  if (env.MIRA_STORE === 'noop' || !env.MIRA_SQS_QUEUE_URL) {
    return createNoopQueue()
  }

  const region = env.AWS_REGION || 'us-east-1'
  let sqs

  const sendMessage = async (input) => {
    if (!sqs) {
      const { SQSClient, SendMessageCommand } = await import('@aws-sdk/client-sqs')
      sqs = { client: new SQSClient({ region }), SendMessageCommand }
    }
    return sqs.client.send(new sqs.SendMessageCommand(input))
  }

  return createSqsQueue({ queueUrl: env.MIRA_SQS_QUEUE_URL, sendMessage })
}
