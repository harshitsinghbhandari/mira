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

// Collect the next N messages (binary or text) from a socket
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

// Send a minimal valid WebM/Opus file so FFmpeg can actually transcode it
async function sendAudio(sender, channelId) {
  // Minimal 1-second WebM/Opus blob produced by a real browser
  // We use a tiny sine wave encoded with ffmpeg: ffmpeg -f lavfi -i sine=d=0.1 -c:a libopus out.webm
  // For tests, just send the actual WebM bytes so FFmpeg succeeds
  sender.send(JSON.stringify({ type: 'meta', mimeType: 'audio/webm;codecs=opus' }))
  // Generate a real tiny WebM with ffmpeg via child_process in the test
  const { execSync } = await import('child_process')
  const webm = execSync(
    'ffmpeg -f lavfi -i "sine=frequency=440:duration=0.2" -c:a libopus -f webm pipe:1 2>/dev/null'
  )
  sender.send(webm, { binary: true })
  sender.send(JSON.stringify({ type: 'end' }))
}

describe('relay server', () => {
  let wss, port

  beforeEach(async () => {
    wss = createRelay(0)
    await new Promise((resolve) => wss.once('listening', resolve))
    port = wss.address().port
  })

  afterEach(() => wss.close())

  it('forwards transcoded mp4 to receiver after end', async () => {
    const sender = await connect(port, 'ch1')
    const receiver = await connect(port, 'ch1')

    const incoming = nextMessages(receiver, 3)  // meta, binary(mp4), end
    await sendAudio(sender, 'ch1')

    const msgs = await incoming
    const [metaMsg, binaryMsg, endMsg] = msgs

    expect(metaMsg.isBinary).toBe(false)
    expect(JSON.parse(metaMsg.data.toString())).toEqual({ type: 'meta', mimeType: 'audio/mp4' })

    expect(binaryMsg.isBinary).toBe(true)
    expect(binaryMsg.data.length).toBeGreaterThan(0)

    expect(endMsg.isBinary).toBe(false)
    expect(JSON.parse(endMsg.data.toString())).toEqual({ type: 'end' })

    sender.close()
    receiver.close()
  })

  it('does NOT forward to a client in a different channel', async () => {
    const sender = await connect(port, 'ch1')
    const outsider = await connect(port, 'ch2')

    let gotMessage = false
    outsider.on('message', () => { gotMessage = true })

    await sendAudio(sender, 'ch1')
    await new Promise((r) => setTimeout(r, 2000))  // wait for transcode
    expect(gotMessage).toBe(false)

    sender.close()
    outsider.close()
  })

  it('does NOT echo audio back to sender', async () => {
    const sender = await connect(port, 'ch1')

    let gotMessage = false
    sender.on('message', () => { gotMessage = true })

    await sendAudio(sender, 'ch1')
    await new Promise((r) => setTimeout(r, 2000))
    expect(gotMessage).toBe(false)

    sender.close()
  })

  it('forwards mp4 to multiple receivers', async () => {
    const sender = await connect(port, 'ch1')
    const r1 = await connect(port, 'ch1')
    const r2 = await connect(port, 'ch1')

    const p1 = nextMessages(r1, 3)
    const p2 = nextMessages(r2, 3)
    await sendAudio(sender, 'ch1')

    const [msgs1, msgs2] = await Promise.all([p1, p2])
    expect(msgs1[1].isBinary).toBe(true)
    expect(msgs2[1].isBinary).toBe(true)

    sender.close(); r1.close(); r2.close()
  })

  it('removes client from channel on disconnect', async () => {
    const sender = await connect(port, 'ch1')
    const receiver = await connect(port, 'ch1')

    receiver.close()
    await new Promise((r) => setTimeout(r, 50))

    // Should not throw — channel still exists with sender in it
    expect(() => sender.send(JSON.stringify({ type: 'end' }))).not.toThrow()
    sender.close()
    await new Promise((r) => setTimeout(r, 50))
    expect(wss.clients.size).toBe(0)
  })
})
