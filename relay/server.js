import { WebSocketServer, WebSocket } from 'ws'
import { spawn } from 'child_process'

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

export function createRelay(port) {
  const channels = new Map()
  const wss = new WebSocketServer({ port })

  wss.on('connection', (ws, req) => {
    const id = `c${++connSeq}`
    let channelId = null
    let binCount = 0
    let binBytes = 0
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
          if (channelId && channels.has(channelId)) channels.get(channelId).delete(ws)
          channelId = msg.channelId
          if (!channels.has(channelId)) channels.set(channelId, new Set())
          channels.get(channelId).add(ws)
          log(`${id} JOINED #${channelId} (channel now has ${channels.get(channelId).size} peers)`)

        } else if (msg.type === 'meta') {
          // Forward immediately so receivers show "Receiving..." while sender speaks
          if (!channelId) { log(`${id} meta dropped: not joined`); return }
          const peers = channels.get(channelId)
          if (!peers) { log(`${id} meta dropped: no channel`); return }
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

        } else if (msg.type === 'end') {
          if (!channelId || chunks.length === 0) {
            log(`${id} end ignored: channelId=${channelId} chunks=${chunks.length}`)
            chunks.length = 0
            return
          }
          const peers = channels.get(channelId)
          if (!peers) { log(`${id} end dropped: no channel`); chunks.length = 0; return }

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
      if (channelId && channels.has(channelId)) {
        channels.get(channelId).delete(ws)
        if (channels.get(channelId).size === 0) channels.delete(channelId)
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
