import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import WebSocket from 'ws'
import { createRelay } from './server.js'

function connect(port, channelId) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', channelId }))
      setTimeout(() => resolve(ws), 20)
    })
  })
}

function nextMessages(ws, count, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const msgs = []
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${count} messages`)), timeoutMs)
    ws.on('message', (data, isBinary) => {
      msgs.push({ data, isBinary })
      if (msgs.length === count) { clearTimeout(timer); resolve(msgs) }
    })
  })
}

async function sendAudio(sender) {
  sender.send(JSON.stringify({ type: 'meta', mimeType: 'audio/webm;codecs=opus' }))
  const { execSync } = await import('child_process')
  const webm = execSync(
    'ffmpeg -f lavfi -i "sine=frequency=440:duration=0.2" -c:a libopus -f webm pipe:1 2>/dev/null'
  )
  sender.send(webm, { binary: true })
  sender.send(JSON.stringify({ type: 'end' }))
}

// Deferred promise we resolve manually in tests
function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

describe('store sidecar', () => {
  let wss, port

  afterEach(() => wss && wss.close())

  async function start(store) {
    wss = createRelay(0, { store })
    await new Promise((resolve) => wss.once('listening', resolve))
    port = wss.address().port
  }

  it('hands the transmission to the writer with correct metadata', async () => {
    const calls = []
    const store = { kind: 'test', persist: async (tx) => { calls.push(tx) } }
    await start(store)

    const sender = await connect(port, 'ch1')
    const receiver = await connect(port, 'ch1')
    const incoming = nextMessages(receiver, 3)
    await sendAudio(sender)
    const msgs = await incoming
    const deliveredMp4 = msgs.find((m) => m.isBinary).data

    // give the fire-and-forget sidecar a tick to run
    await new Promise((r) => setTimeout(r, 50))

    expect(calls).toHaveLength(1)
    const tx = calls[0]
    expect(tx.channel).toBe('ch1')
    expect(typeof tx.transmissionId).toBe('string')
    expect(tx.transmissionId.length).toBeGreaterThan(0)
    expect(typeof tx.clientId).toBe('string')
    expect(tx.contentType).toBe('audio/mp4')
    expect(tx.size).toBe(deliveredMp4.length)
    expect(Buffer.isBuffer(tx.audio)).toBe(true)
    // persisted bytes are byte-for-byte what listeners received
    expect(Buffer.compare(tx.audio, deliveredMp4)).toBe(0)
    expect(typeof tx.timestamp).toBe('number')
    expect(typeof tx.duration).toBe('number')

    sender.close(); receiver.close()
  })

  it('does NOT block or break live fan-out when the writer hangs forever', async () => {
    // persist never resolves — simulates a slow/stuck S3 or DynamoDB call
    const store = { kind: 'test', persist: () => deferred().promise }
    await start(store)

    const sender = await connect(port, 'ch1')
    const receiver = await connect(port, 'ch1')
    const incoming = nextMessages(receiver, 3)
    await sendAudio(sender)

    // fan-out (meta, binary mp4, end) must still arrive despite the stuck writer
    const msgs = await incoming
    expect(msgs).toHaveLength(3)
    expect(msgs.some((m) => m.isBinary)).toBe(true)

    sender.close(); receiver.close()
  })

  it('does NOT break live fan-out when the writer throws', async () => {
    const store = { kind: 'test', persist: async () => { throw new Error('s3 exploded') } }
    await start(store)

    const sender = await connect(port, 'ch1')
    const receiver = await connect(port, 'ch1')
    const incoming = nextMessages(receiver, 3)
    await sendAudio(sender)

    const msgs = await incoming
    expect(msgs).toHaveLength(3)
    const endMsg = msgs.find((m) => !m.isBinary && JSON.parse(m.data.toString()).type === 'end')
    expect(endMsg).toBeTruthy()

    sender.close(); receiver.close()
  })

  it('does NOT break live fan-out when the writer throws synchronously', async () => {
    const store = { kind: 'test', persist: () => { throw new Error('sync boom') } }
    await start(store)

    const sender = await connect(port, 'ch1')
    const receiver = await connect(port, 'ch1')
    const incoming = nextMessages(receiver, 3)
    await sendAudio(sender)

    const msgs = await incoming
    expect(msgs).toHaveLength(3)

    sender.close(); receiver.close()
  })
})
