export interface RecorderOptions {
  ws: WebSocket
  timeslice?: number  // ms per chunk, default 250
}

export class PTTRecorder {
  private recorder: MediaRecorder | null = null
  private ws: WebSocket
  private timeslice: number
  private cancelled = false

  constructor({ ws, timeslice = 250 }: RecorderOptions) {
    this.ws = ws
    this.timeslice = timeslice
  }

  async start(): Promise<void> {
    this.cancelled = false
    console.debug('[rec] start: requesting mic...')
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    console.debug('[rec] mic granted, ws.readyState=', this.ws.readyState)

    if (this.cancelled) {
      console.debug('[rec] cancelled during getUserMedia, stopping tracks')
      stream.getTracks().forEach((t) => t.stop())
      return
    }

    const mimeType =
      MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' :
      MediaRecorder.isTypeSupported('audio/mp4;codecs=aac') ? 'audio/mp4;codecs=aac' :
      MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' :
      MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' :
      ''

    this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {})
    console.debug(`[rec] MediaRecorder created, mimeType=${this.recorder.mimeType} (requested ${mimeType || 'default'})`)

    // Tell receivers which format to expect before the first chunk arrives
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'meta', mimeType: this.recorder.mimeType }))
      console.debug('[rec] sent meta')
    } else {
      console.warn('[rec] ws NOT open when sending meta, readyState=', this.ws.readyState)
    }

    let chunkN = 0
    this.recorder.ondataavailable = (e) => {
      chunkN++
      if (e.data.size > 0 && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(e.data)
        console.debug(`[rec] sent chunk #${chunkN} (${e.data.size}b)`)
      } else {
        console.warn(`[rec] DROPPED chunk #${chunkN}: size=${e.data.size} ws.readyState=${this.ws.readyState}`)
      }
    }

    this.recorder.start(this.timeslice)
    console.debug(`[rec] recording started, timeslice=${this.timeslice}ms`)
  }

  stop(): void {
    this.cancelled = true
    if (!this.recorder) {
      console.debug('[rec] stop() called but no active recorder')
      return
    }
    console.debug('[rec] stop: state=', this.recorder.state)
    this.recorder.onstop = () => {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'end' }))
        console.debug('[rec] onstop: sent end')
      } else {
        console.warn('[rec] onstop: ws NOT open, end NOT sent, readyState=', this.ws.readyState)
      }
    }
    this.recorder.stop()
    this.recorder.stream.getTracks().forEach((t) => t.stop())
    this.recorder = null
  }

  get isRecording(): boolean {
    return this.recorder?.state === 'recording'
  }
}
