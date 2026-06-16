import { describe, it, expect, vi } from 'vitest'
import {
  s3Key,
  buildRecord,
  createStore,
  createNoopStore,
  createStoreFromEnv,
} from './store.js'

const TS = Date.UTC(2026, 5, 16, 9, 30, 0) // 2026-06-16T09:30:00.000Z

describe('s3Key', () => {
  it('uses a channel/date/transmissionId.mp4 scheme', () => {
    const key = s3Key({ channel: 'ch5', transmissionId: 'abc-123', timestamp: TS })
    expect(key).toBe('ch5/2026-06-16/abc-123.mp4')
  })
})

describe('buildRecord', () => {
  it('produces a single-table item carrying all metadata', () => {
    const rec = buildRecord({
      channel: 'ch5',
      transmissionId: 'abc-123',
      timestamp: TS,
      duration: 2500,
      clientId: 'c7',
      bucket: 'mira-audio',
      key: 'ch5/2026-06-16/abc-123.mp4',
      contentType: 'audio/mp4',
      size: 4096,
    })
    expect(rec).toEqual({
      pk: 'CHANNEL#ch5',
      sk: `TX#${TS}#abc-123`,
      transmissionId: 'abc-123',
      channel: 'ch5',
      timestamp: '2026-06-16T09:30:00.000Z',
      epochMs: TS,
      durationMs: 2500,
      clientId: 'c7',
      s3Bucket: 'mira-audio',
      s3Key: 'ch5/2026-06-16/abc-123.mp4',
      contentType: 'audio/mp4',
      size: 4096,
    })
  })
})

describe('createStore (aws)', () => {
  it('puts audio to S3 then writes the metadata record to DynamoDB', async () => {
    const putObject = vi.fn().mockResolvedValue({})
    const putItem = vi.fn().mockResolvedValue({})
    const store = createStore({ bucket: 'mira-audio', table: 'mira', putObject, putItem })

    const audio = Buffer.from('mp4bytes')
    await store.persist({
      channel: 'ch5',
      transmissionId: 'abc-123',
      timestamp: TS,
      duration: 2500,
      clientId: 'c7',
      contentType: 'audio/mp4',
      size: audio.length,
      audio,
    })

    expect(putObject).toHaveBeenCalledWith({
      Bucket: 'mira-audio',
      Key: 'ch5/2026-06-16/abc-123.mp4',
      Body: audio,
      ContentType: 'audio/mp4',
    })
    expect(putItem).toHaveBeenCalledWith(
      expect.objectContaining({
        pk: 'CHANNEL#ch5',
        sk: `TX#${TS}#abc-123`,
        s3Bucket: 'mira-audio',
        s3Key: 'ch5/2026-06-16/abc-123.mp4',
        contentType: 'audio/mp4',
        size: 8,
        durationMs: 2500,
        clientId: 'c7',
      }),
    )
    // S3 object must exist before the record that points at it
    expect(putObject.mock.invocationCallOrder[0]).toBeLessThan(
      putItem.mock.invocationCallOrder[0],
    )
  })

  it('does not write a DynamoDB record if the S3 put fails', async () => {
    const putObject = vi.fn().mockRejectedValue(new Error('s3 down'))
    const putItem = vi.fn().mockResolvedValue({})
    const store = createStore({ bucket: 'mira-audio', table: 'mira', putObject, putItem })

    await expect(
      store.persist({
        channel: 'ch5',
        transmissionId: 'abc-123',
        timestamp: TS,
        duration: 10,
        clientId: 'c7',
        contentType: 'audio/mp4',
        size: 4,
        audio: Buffer.from('a'),
      }),
    ).rejects.toThrow('s3 down')
    expect(putItem).not.toHaveBeenCalled()
  })
})

describe('createStoreFromEnv', () => {
  it('returns a noop store when MIRA_STORE=noop, even if AWS config is present', () => {
    const store = createStoreFromEnv({
      MIRA_STORE: 'noop',
      MIRA_S3_BUCKET: 'mira-audio',
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
      MIRA_S3_BUCKET: 'mira-audio',
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
    await expect(store.persist({ channel: 'anything' })).resolves.toBeUndefined()
  })
})
