'use client'

import { useEffect, useRef, useState } from 'react'
import { StreamingPlayer } from '@/lib/audio/player'

interface AudioReceiverProps {
  wsUrl: string
  channelId: string
}

export function AudioReceiver({ wsUrl, channelId }: AudioReceiverProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<StreamingPlayer | null>(null)
  const [status, setStatus] = useState('Connecting...')
  const [lastReceived, setLastReceived] = useState<string | null>(null)
  // iOS blocks audio.play() that isn't driven by a user gesture. We gate
  // playback behind one tap, which unlocks a single persistent <audio> element.
  const [audioReady, setAudioReady] = useState(false)

  // Tap handler — MUST stay a direct user gesture so unlock()'s play() is allowed.
  const enableAudio = async () => {
    if (!playerRef.current) {
      const player = new StreamingPlayer()
      if (containerRef.current) player.attach(containerRef.current)
      playerRef.current = player
    }
    const ok = await playerRef.current.unlock()
    setAudioReady(ok)
  }

  // Destroy the player only on real unmount.
  useEffect(() => () => { playerRef.current?.destroy(); playerRef.current = null }, [])

  useEffect(() => {
    let ws: WebSocket
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let unmounted = false

    // Track in-flight arrayBuffer() calls so end() waits for all chunks
    let pendingChunks = 0
    let pendingEnd = false

    const rlog = (...a: unknown[]) => console.debug('[recv]', ...a)
    let attempt = 0

    function flushEnd() {
      const player = playerRef.current
      if (!player) { rlog('flushEnd: no player (audio not enabled yet?)'); return }
      rlog('flushEnd -> player.end()')
      player.end()
      setLastReceived(new Date().toLocaleTimeString())
      setStatus(`Listening on #${channelId}`)
    }

    function connect() {
      attempt++
      rlog(`connect attempt #${attempt} -> ${wsUrl}`)
      ws = new WebSocket(wsUrl)

      ws.onopen = () => {
        rlog(`OPEN, joining #${channelId}`)
        ws.send(JSON.stringify({ type: 'join', channelId }))
        setStatus(`Listening on #${channelId}`)
      }

      ws.onmessage = async (event) => {
        if (event.data instanceof Blob) {
          rlog(`<- BINARY ${event.data.size}b (pendingChunks before=${pendingChunks})`)
          const player = playerRef.current
          if (!player) { rlog('binary dropped: audio not enabled'); return }
          pendingChunks++
          const buf = await event.data.arrayBuffer()
          player.append(buf)
          pendingChunks--
          rlog(`decoded chunk, pendingChunks now=${pendingChunks}, pendingEnd=${pendingEnd}`)
          // If end arrived while we were decoding, fire it now that the queue is clear
          if (pendingEnd && pendingChunks === 0) {
            pendingEnd = false
            flushEnd()
          }
        } else {
          try {
            const msg = JSON.parse(event.data as string)
            rlog('<- control', JSON.stringify(msg))
            if (msg.type === 'meta') {
              // Reuse the one unlocked element; just start a fresh utterance.
              const player = playerRef.current
              if (player) {
                player.reset()
                player.setMimeType(msg.mimeType)
                setStatus('Receiving...')
              }
            } else if (msg.type === 'end') {
              if (pendingChunks > 0) {
                rlog(`end deferred: ${pendingChunks} chunks still decoding`)
                pendingEnd = true
              } else {
                flushEnd()
              }
            }
          } catch (err) {
            rlog('non-JSON frame ignored', (err as Error)?.message)
          }
        }
      }

      // Auto-reconnect: the relay (or network) dropping should not leave us
      // permanently dead. Retry after 1s unless the component unmounted.
      ws.onclose = (e) => {
        rlog(`CLOSE code=${e.code} reason="${e.reason}" wasClean=${e.wasClean} unmounted=${unmounted}`)
        if (unmounted) return
        setStatus('Reconnecting...')
        reconnectTimer = setTimeout(connect, 1000)
      }
      ws.onerror = () => { rlog('ERROR event (close will follow)') }
    }

    connect()

    return () => {
      rlog('CLEANUP (effect unmount) — closing ws, cancelling reconnect')
      unmounted = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws.close()
    }
  }, [wsUrl, channelId])

  return (
    <div className="flex flex-col items-center gap-4">
      <div className={[
        'w-32 h-32 rounded-full flex items-center justify-center text-4xl border-4 transition-all',
        status === 'Receiving...'
          ? 'border-green-500 bg-green-950/30 animate-pulse'
          : 'border-gray-700 bg-gray-900/30',
      ].join(' ')}>
        📻
      </div>
      {!audioReady ? (
        <button
          onClick={enableAudio}
          className="rounded-full bg-blue-600 hover:bg-blue-700 text-white font-bold px-6 py-3"
        >
          🔊 Tap to enable audio
        </button>
      ) : (
        <p className="text-sm text-gray-400">{status}</p>
      )}
      {lastReceived && (
        <p className="text-xs text-gray-600">Last received: {lastReceived}</p>
      )}
      <div ref={containerRef} className="hidden" />
    </div>
  )
}
