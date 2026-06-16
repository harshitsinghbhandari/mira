import { WebSocketServer, WebSocket } from 'ws'
import { spawn } from 'child_process'
import { randomUUID } from 'node:crypto'
import { createStoreFromEnv } from './store.js'

const log = (...a) => console.log(`[relay ${new Date().toISOString().slice(11, 23)}]`, ...a)

let connSeq = 0  // label each connection for traceable logs

// Transcode any audio format to fragmented MP4/AAC via FFmpeg.
// Fragmented MP4 (frag_keyframe+empty_moov) plays from a Blob URL on all browsers.
function transcode(chunks, tag) {
  return new Promise((resolve, reject) => {
    const inputBytes = chunks.reduce((n, c) => n + c.length, 0)
    log(`${tag} transcode start: ${chunks.length} chunks, ${inputBytes}b in`)
    const ff = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov',
      '-loglevel', 'error',
      'pipe:1',
    ])
    const out = []
    let stderr = ''
    ff.stdout.on('data', (d) => out.push(d))
    ff.stdout.on('end', () => {
      const buf = Buffer.concat(out)
      log(`${tag} transcode done: ${buf.length}b out${stderr ? ` (stderr: ${stderr.trim()})` : ''}`)
      resolve(buf)
    })
    ff.stderr.on('data', (d) => { stderr += d.toString() })
    ff.on('error', (err) => { log(`${tag} ffmpeg spawn error: ${err.message}`); reject(err) })
    ff.on('close', (code) => { if (code !== 0) log(`${tag} ffmpeg exited code ${code}`) })
    // Guard the pipe: if ffmpeg dies early, writing emits EPIPE on stdin. An
    // unhandled stream 'error' would crash the whole relay process.
    ff.stdin.on('error', (err) => log(`${tag} ffmpeg stdin error (ignored): ${err.code || err.message}`))
    for (const chunk of chunks) ff.stdin.write(chunk)
    ff.stdin.end()
  })
}

// Fan-out is scoped by the event (the ownership boundary), so two events that
// reuse a channel name never cross-talk. The room key combines both.
const roomKey = (eventId, channelId) => `${eventId}::${channelId}`

export function createRelay(port, { store } = {}) {
  const rooms = new Map()  // roomKey -> Set<ws>
  // Persistence sidecar. Defaults to env config (noop unless a bucket+table are
  // set), but is injectable for tests. It is ONLY ever called fire-and-forget,
  // off the live fan-out path — see the 'end' handler below.
  const persistStore = store ?? createStoreFromEnv()
  const relayId = process.env.MIRA_RELAY_ID || 'relay-local'
  const wss = new WebSocketServer({ port })

  wss.on('connection', (ws, req) => {
    const id = `c${++connSeq}`
    let eventId = 'default'  // overridden by the join message; default keeps single-event clients working
    let channelId = null
    let room = null  // current fan-out room key (event::channel)
    let binCount = 0
    let binBytes = 0
    let utteranceStart = null  // set on 'meta'; start time of the current transmission
    const chunks = []  // binary chunks buffered from this sender

    log(`${id} CONNECTED from ${req?.socket?.remoteAddress ?? '?'} (total clients: ${wss.clients.size})`)

    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        chunks.push(data)  // buffer — forwarded after transcoding on 'end'
        binCount++
        binBytes += data.length
        log(`${id} binary chunk #${binCount} (${data.length}b, buffered total ${binBytes}b)`)
        return
      }

      try {
        const msg = JSON.parse(data.toString())
        log(`${id} control msg: ${JSON.stringify(msg)}`)

        if (msg.type === 'join' && typeof msg.channelId === 'string') {
          if (room && rooms.has(room)) rooms.get(room).delete(ws)
          if (typeof msg.eventId === 'string') eventId = msg.eventId  // optional; defaults to 'default'
          channelId = msg.channelId
          room = roomKey(eventId, channelId)
          if (!rooms.has(room)) rooms.set(room, new Set())
          rooms.get(room).add(ws)
          log(`${id} JOINED ${eventId}#${channelId} (room now has ${rooms.get(room).size} peers)`)

        } else if (msg.type === 'meta') {
          // Forward immediately so receivers show "Receiving..." while sender speaks
          if (!room) { log(`${id} meta dropped: not joined`); return }
          const peers = rooms.get(room)
          if (!peers) { log(`${id} meta dropped: no room`); return }
          let sent = 0
          for (const peer of peers) {
            if (peer !== ws && peer.readyState === WebSocket.OPEN) {
              // Always tell receivers to expect mp4 — transcoding normalises the format
              peer.send(JSON.stringify({ type: 'meta', mimeType: 'audio/mp4' }))
              sent++
            }
          }
          log(`${id} forwarded meta to ${sent}/${peers.size - 1} peers`)
          binCount = 0; binBytes = 0  // reset counters for the new utterance
          utteranceStart = Date.now()  // start of this transmission, for duration

        } else if (msg.type === 'end') {
          if (!room || chunks.length === 0) {
            log(`${id} end ignored: room=${room} chunks=${chunks.length}`)
            chunks.length = 0
            return
          }
          const peers = rooms.get(room)
          if (!peers) { log(`${id} end dropped: no room`); chunks.length = 0; return }

          const captured = chunks.splice(0)  // drain buffer before async gap
          try {
            const mp4 = await transcode(captured, id)
            let sent = 0
            for (const peer of peers) {
              if (peer !== ws && peer.readyState === WebSocket.OPEN) {
                peer.send(mp4, { binary: true })
                peer.send(JSON.stringify({ type: 'end' }))
                sent++
              }
            }
            log(`${id} forwarded ${mp4.length}b mp4 + end to ${sent}/${peers.size - 1} peers`)

            // --- Persistence sidecar (off the hot path) ---------------------
            // Live fan-out above is already done. Hand the transmission to the
            // writer WITHOUT awaiting it: Promise.resolve().then(...) defers it
            // past this synchronous handler and .catch swallows any error (sync
            // throw or rejection). A slow or failing S3/DynamoDB write therefore
            // cannot backpressure, delay, or break the talking channel.
            const endedAt = Date.now()
            const tx = {
              eventId,
              channelId,
              clientId: id,
              relayId,
              transmissionId: randomUUID(),
              startedAt: utteranceStart ?? endedAt,
              endedAt,
              durationMs: utteranceStart ? endedAt - utteranceStart : 0,
              contentType: 'audio/mp4',
              size: mp4.length,
              audio: mp4,
            }
            Promise.resolve()
              .then(() => persistStore.persist(tx))
              .then(() => log(`${id} persisted transmission ${tx.transmissionId} (${tx.size}b)`))
              .catch((err) => log(`${id} PERSIST ERROR (ignored, channel unaffected): ${err.message}`))
          } catch (err) {
            log(`${id} TRANSCODE ERROR: ${err.message}`)
          }
        }
      } catch (err) {
        log(`${id} non-JSON / malformed control frame ignored: ${err.message}`)
      }
    })

    ws.on('error', (err) => log(`${id} ws error: ${err.message}`))

    ws.on('close', (code, reason) => {
      chunks.length = 0
      if (room && rooms.has(room)) {
        rooms.get(room).delete(ws)
        if (rooms.get(room).size === 0) rooms.delete(room)
      }
      log(`${id} CLOSED (code ${code}${reason?.length ? `, ${reason}` : ''}) — clients left: ${wss.clients.size}`)
    })
  })

  return wss
}

// A crash anywhere must be visible, not silent. node --watch will NOT auto-restart
// on crash, so an unlogged throw looks exactly like "the relay just stopped".
process.on('uncaughtException', (e) => log(`!!! UNCAUGHT EXCEPTION: ${e.stack || e.message}`))
process.on('unhandledRejection', (e) => log(`!!! UNHANDLED REJECTION: ${e?.stack || e?.message || e}`))

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const PORT = process.env.PORT ?? 8080
  const wss = createRelay(PORT)
  wss.on('listening', () => log(`relay listening on :${PORT}`))
}
