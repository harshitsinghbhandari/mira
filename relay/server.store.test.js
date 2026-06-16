import { describe, it, expect, afterEach } from 'vitest'
import WebSocket from 'ws'
import { createRelay } from './server.js'

function connect(port, { eventId, channelId } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', eventId, channelId }))
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

  it('hands the transmission to the writer with correct event-scoped metadata', async () => {
    const calls = []
    const store = { kind: 'test', persist: async (tx) => { calls.push(tx) } }
    await start(store)

    const sender = await connect(port, { eventId: 'event123', channelId: 'security' })
    const receiver = await connect(port, { eventId: 'event123', channelId: 'security' })
    const incoming = nextMessages(receiver, 3)
    await sendAudio(sender)
    const msgs = await incoming
    const deliveredMp4 = msgs.find((m) => m.isBinary).data

    await new Promise((r) => setTimeout(r, 50)) // let the fire-and-forget sidecar run

    expect(calls).toHaveLength(1)
    const tx = calls[0]
    expect(tx.eventId).toBe('event123')
    expect(tx.channelId).toBe('security')
    expect(typeof tx.clientId).toBe('string')
    expect(typeof tx.relayId).toBe('string')
    expect(typeof tx.transmissionId).toBe('string')
    expect(tx.transmissionId.length).toBeGreaterThan(0)
    expect(tx.contentType).toBe('audio/mp4')
    expect(tx.size).toBe(deliveredMp4.length)
    expect(Buffer.isBuffer(tx.audio)).toBe(true)
    // persisted bytes are byte-for-byte what listeners received
    expect(Buffer.compare(tx.audio, deliveredMp4)).toBe(0)
    expect(typeof tx.startedAt).toBe('number')
    expect(typeof tx.endedAt).toBe('number')
    expect(tx.endedAt).toBeGreaterThanOrEqual(tx.startedAt)
    expect(tx.durationMs).toBe(tx.endedAt - tx.startedAt)

    sender.close(); receiver.close()
  })

  it('defaults eventId when the sender does not send one', async () => {
    const calls = []
    const store = { kind: 'test', persist: async (tx) => { calls.push(tx) } }
    await start(store)

    const sender = await connect(port, { channelId: 'ch1' })
    const receiver = await connect(port, { channelId: 'ch1' })
    const incoming = nextMessages(receiver, 3)
    await sendAudio(sender)
    await incoming
    await new Promise((r) => setTimeout(r, 50))

    expect(calls).toHaveLength(1)
    expect(typeof calls[0].eventId).toBe('string')
    expect(calls[0].eventId.length).toBeGreaterThan(0)

    sender.close(); receiver.close()
  })

  it('does NOT block or break live fan-out when the writer hangs forever', async () => {
    const store = { kind: 'test', persist: () => deferred().promise }
    await start(store)

    const sender = await connect(port, { channelId: 'ch1' })
    const receiver = await connect(port, { channelId: 'ch1' })
    const incoming = nextMessages(receiver, 3)
    await sendAudio(sender)

    const msgs = await incoming
    expect(msgs).toHaveLength(3)
    expect(msgs.some((m) => m.isBinary)).toBe(true)

    sender.close(); receiver.close()
  })

  it('does NOT break live fan-out when the writer throws', async () => {
    const store = { kind: 'test', persist: async () => { throw new Error('s3 exploded') } }
    await start(store)

    const sender = await connect(port, { channelId: 'ch1' })
    const receiver = await connect(port, { channelId: 'ch1' })
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

    const sender = await connect(port, { channelId: 'ch1' })
    const receiver = await connect(port, { channelId: 'ch1' })
    const incoming = nextMessages(receiver, 3)
    await sendAudio(sender)

    const msgs = await incoming
    expect(msgs).toHaveLength(3)

    sender.close(); receiver.close()
  })

  it('isolates fan-out by event: same channel name, different events do not cross-talk', async () => {
    const store = { kind: 'test', persist: async () => {} }
    await start(store)

    const sender = await connect(port, { eventId: 'eventA', channelId: 'security' })
    const sameEvent = await connect(port, { eventId: 'eventA', channelId: 'security' })
    const otherEvent = await connect(port, { eventId: 'eventB', channelId: 'security' })

    let otherGot = false
    otherEvent.on('message', () => { otherGot = true })
    const incoming = nextMessages(sameEvent, 3)

    await sendAudio(sender)

    const msgs = await incoming
    expect(msgs).toHaveLength(3) // same-event peer hears it
    await new Promise((r) => setTimeout(r, 200))
    expect(otherGot).toBe(false) // other-event peer on the same channel name does not

    sender.close(); sameEvent.close(); otherEvent.close()
  })
})
