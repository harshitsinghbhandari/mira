import { describe, it, expect, vi } from 'vitest'
import { createNoopQueue, createSqsQueue, createQueueFromEnv } from './queue.js'

describe('createSqsQueue', () => {
  it('sends the transcription job as a JSON message to the queue url', async () => {
    const sendMessage = vi.fn().mockResolvedValue({})
    const q = createSqsQueue({ queueUrl: 'https://sqs/q', sendMessage })

    const job = { eventId: 'e', transmissionId: 't', bucket: 'b', key: 'k' }
    await q.enqueue(job)

    expect(sendMessage).toHaveBeenCalledWith({
      QueueUrl: 'https://sqs/q',
      MessageBody: JSON.stringify(job),
    })
  })
})

describe('createQueueFromEnv', () => {
  it('returns a noop queue when no queue url is configured', () => {
    expect(createQueueFromEnv({}).kind).toBe('noop')
  })

  it('returns a noop queue when MIRA_STORE=noop, even with a queue url', () => {
    expect(createQueueFromEnv({ MIRA_STORE: 'noop', MIRA_SQS_QUEUE_URL: 'u' }).kind).toBe('noop')
  })

  it('returns an sqs queue when a queue url is configured', () => {
    expect(createQueueFromEnv({ MIRA_SQS_QUEUE_URL: 'https://sqs/q' }).kind).toBe('sqs')
  })
})

describe('createNoopQueue', () => {
  it('resolves without doing any work', async () => {
    const q = createNoopQueue()
    expect(q.kind).toBe('noop')
    await expect(q.enqueue({ eventId: 'e' })).resolves.toBeUndefined()
  })
})
