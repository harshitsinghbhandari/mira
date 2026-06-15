'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { PTTRecorder } from '@/lib/audio/recorder'

interface PTTTransmitProps {
  wsUrl: string
  channelId: string
  senderName: string
}

export function PTTTransmit({ wsUrl, channelId, senderName }: PTTTransmitProps) {
  const wsRef = useRef<WebSocket | null>(null)
  const recorderRef = useRef<PTTRecorder | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [connected, setConnected] = useState(false)
  const [recording, setRecording] = useState(false)
  const [status, setStatus] = useState('Connecting...')

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let unmounted = false
    let attempt = 0
    const slog = (...a: unknown[]) => console.debug('[send]', ...a)

    function connect() {
      attempt++
      slog(`connect attempt #${attempt} -> ${wsUrl}`)
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        slog(`OPEN, joining #${channelId}`)
        ws.send(JSON.stringify({ type: 'join', channelId }))
        setConnected(true)
        setStatus(`Connected to #${channelId}`)
      }
      ws.onerror = () => slog('ERROR event (close will follow)')
      // Auto-reconnect so a relay restart doesn't permanently break the sender.
      ws.onclose = (e) => {
        slog(`CLOSE code=${e.code} reason="${e.reason}" wasClean=${e.wasClean} unmounted=${unmounted}`)
        setConnected(false)
        if (unmounted) return
        setStatus('Reconnecting...')
        reconnectTimer = setTimeout(connect, 1000)
      }
    }

    connect()

    return () => {
      slog('CLEANUP (effect unmount) — closing ws, cancelling reconnect')
      unmounted = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      recorderRef.current?.stop()
      recorderRef.current = null
      wsRef.current?.close()
    }
  }, [wsUrl, channelId])

  const startPTT = useCallback(async () => {
    console.debug('[send] startPTT, ws.readyState=', wsRef.current?.readyState, 'hasRecorder=', !!recorderRef.current)
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.warn('[send] startPTT aborted: ws not open')
      return
    }
    if (recorderRef.current) {
      console.warn('[send] startPTT aborted: recorder already active')
      return
    }
    const recorder = new PTTRecorder({ ws: wsRef.current })
    recorderRef.current = recorder
    try {
      await recorder.start()
      setRecording(true)
      setStatus('Recording...')
    } catch (err) {
      console.error('[send] recorder.start() failed:', (err as Error)?.message)
      recorderRef.current = null
      setStatus('Mic access denied')
    }
  }, [])

  const stopPTT = useCallback(() => {
    console.debug('[send] stopPTT, hasRecorder=', !!recorderRef.current)
    recorderRef.current?.stop()
    recorderRef.current = null
    setRecording(false)
    setStatus(`Connected to #${channelId}`)
  }, [channelId])

  // React registers touchstart/touchmove as passive, so preventDefault() in a
  // JSX onTouchStart handler is ignored (and warns). Attach natively as
  // non-passive instead — preventDefault here suppresses the synthesized ghost
  // mouse events so onMouseDown/onMouseUp don't double-fire PTT on touch.
  useEffect(() => {
    const btn = buttonRef.current
    if (!btn) return
    const onStart = (e: TouchEvent) => { e.preventDefault(); startPTT() }
    const onEnd = (e: TouchEvent) => { e.preventDefault(); stopPTT() }
    btn.addEventListener('touchstart', onStart, { passive: false })
    btn.addEventListener('touchend', onEnd, { passive: false })
    return () => {
      btn.removeEventListener('touchstart', onStart)
      btn.removeEventListener('touchend', onEnd)
    }
  }, [startPTT, stopPTT])

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-sm text-gray-400">{status}</p>
      <p className="text-xs text-gray-600">Sending as: {senderName}</p>
      <button
        ref={buttonRef}
        onMouseDown={startPTT}
        onMouseUp={stopPTT}
        disabled={!connected}
        className={[
          'select-none touch-none rounded-full w-32 h-32 font-bold text-sm transition-all duration-100',
          recording
            ? 'bg-red-600 scale-110 shadow-2xl shadow-red-500/50 text-white'
            : connected
            ? 'bg-blue-600 hover:bg-blue-700 text-white'
            : 'bg-gray-700 text-gray-500 cursor-not-allowed',
        ].join(' ')}
      >
        {recording ? '🔴 REC' : '🎙 Hold to Talk'}
      </button>
    </div>
  )
}
