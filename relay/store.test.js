import { describe, it, expect, vi } from 'vitest'
import {
  s3Key,
  buildRecord,
  createStore,
  createNoopStore,
  createStoreFromEnv,
} from './store.js'

const STARTED = Date.UTC(2026, 5, 16, 9, 29, 57, 500) // 2026-06-16T09:29:57.500Z
const ENDED = Date.UTC(2026, 5, 16, 9, 30, 0, 0) //     2026-06-16T09:30:00.000Z

const sampleTx = (over = {}) => ({
  eventId: 'event123',
  channelId: 'security',
  clientId: 'c7',
  relayId: 'relay-a',
  transmissionId: 'tx-abc',
  startedAt: STARTED,
  endedAt: ENDED,
  durationMs: ENDED - STARTED,
  contentType: 'audio/mp4',
  size: 8,
  audio: Buffer.from('mp4bytes'),
  ...over,
})

const KEY = 'event123/security/2026-06-16/tx-abc.mp4'

describe('s3Key', () => {
  it('is event/channel/date/transmissionId.mp4, dated by endedAt', () => {
    expect(s3Key(sampleTx())).toBe(KEY)
  })

  it('throws a descriptive error when endedAt is missing or invalid', () => {
    expect(() => s3Key({ ...sampleTx(), endedAt: undefined })).toThrow(/endedAt/)
    expect(() => s3Key({ ...sampleTx(), endedAt: null })).toThrow(/endedAt/)
    expect(() => s3Key({ ...sampleTx(), endedAt: 'nope' })).toThrow(/endedAt/)
    expect(() => s3Key({ ...sampleTx(), endedAt: NaN })).toThrow(/endedAt/)
  })
})

describe('buildRecord', () => {
  it('is an event-partitioned TRANSMISSION item carrying all metadata', () => {
    const rec = buildRecord({ ...sampleTx(), bucket: 'mira-transmissions', key: KEY })
    expect(rec).toEqual({
      pk: 'EVENT#event123',
      sk: `TX#${ENDED}#tx-abc`,
      entityType: 'TRANSMISSION',
      schemaVersion: 1,
      eventId: 'event123',
      channelId: 'security',
      clientId: 'c7',
      relayId: 'relay-a',
      transmissionId: 'tx-abc',
      startedAt: STARTED,
      endedAt: ENDED,
      durationMs: ENDED - STARTED,
      s3Bucket: 'mira-transmissions',
      s3Key: KEY,
      contentType: 'audio/mp4',
      size: 8,
    })
  })

  it('never stores audio bytes', () => {
    const rec = buildRecord({ ...sampleTx(), bucket: 'b', key: 'k' })
    expect(rec.audio).toBeUndefined()
  })
})

describe('createStore', () => {
  it('writes S3, then DynamoDB, then enqueues a transcription job (in order)', async () => {
    const putObject = vi.fn().mockResolvedValue({})
    const putItem = vi.fn().mockResolvedValue({})
    const enqueue = vi.fn().mockResolvedValue({})
    const store = createStore({ bucket: 'mira-transmissions', putObject, putItem, enqueue })

    const tx = sampleTx()
    await store.persist(tx)

    expect(putObject).toHaveBeenCalledWith({
      Bucket: 'mira-transmissions',
      Key: KEY,
      Body: tx.audio,
      ContentType: 'audio/mp4',
    })
    expect(putItem).toHaveBeenCalledWith(
      expect.objectContaining({
        pk: 'EVENT#event123',
        sk: `TX#${ENDED}#tx-abc`,
        entityType: 'TRANSMISSION',
        s3Key: KEY,
      }),
    )
    // SQS job carries exactly what an STT worker needs — no DynamoDB polling.
    expect(enqueue).toHaveBeenCalledWith({
      eventId: 'event123',
      transmissionId: 'tx-abc',
      bucket: 'mira-transmissions',
      key: KEY,
    })

    const order = [putObject, putItem, enqueue].map((f) => f.mock.invocationCallOrder[0])
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('does not write DynamoDB or enqueue if the S3 put fails', async () => {
    const putObject = vi.fn().mockRejectedValue(new Error('s3 down'))
    const putItem = vi.fn()
    const enqueue = vi.fn()
    const store = createStore({ bucket: 'b', putObject, putItem, enqueue })

    await expect(store.persist(sampleTx())).rejects.toThrow('s3 down')
    expect(putItem).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('does not enqueue if the DynamoDB write fails', async () => {
    const putObject = vi.fn().mockResolvedValue({})
    const putItem = vi.fn().mockRejectedValue(new Error('ddb down'))
    const enqueue = vi.fn()
    const store = createStore({ bucket: 'b', putObject, putItem, enqueue })

    await expect(store.persist(sampleTx())).rejects.toThrow('ddb down')
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('treats enqueue as optional (defaults to a noop)', async () => {
    const putObject = vi.fn().mockResolvedValue({})
    const putItem = vi.fn().mockResolvedValue({})
    const store = createStore({ bucket: 'b', putObject, putItem })
    await expect(store.persist(sampleTx())).resolves.toBeDefined()
  })
})

describe('createStoreFromEnv', () => {
  it('returns a noop store when MIRA_STORE=noop, even with AWS config present', () => {
    const store = createStoreFromEnv({
      MIRA_STORE: 'noop',
      MIRA_S3_BUCKET: 'mira-transmissions',
      MIRA_DDB_TABLE: 'mira',
    })
    expect(store.kind).toBe('noop')
  })

  it('returns a noop store when no bucket/table is configured (local dev)', () => {
    expect(createStoreFromEnv({}).kind).toBe('noop')
    expect(createStoreFromEnv({ MIRA_S3_BUCKET: 'only-bucket' }).kind).toBe('noop')
  })

  it('returns an aws store when bucket and table are configured', () => {
    const store = createStoreFromEnv({
      MIRA_S3_BUCKET: 'mira-transmissions',
      MIRA_DDB_TABLE: 'mira',
      AWS_REGION: 'us-east-1',
    })
    expect(store.kind).toBe('aws')
  })
})

describe('createNoopStore', () => {
  it('resolves without doing any work', async () => {
    const store = createNoopStore()
    expect(store.kind).toBe('noop')
    await expect(store.persist(sampleTx())).resolves.toBeUndefined()
  })
})
