// Buffer chunks per utterance, then play the assembled blob on a SINGLE
// persistent <audio> element. Works on Safari (no MediaSource needed) and
// matches PTT "release to hear" UX.
//
// iOS autoplay: Safari only allows audio.play() that is driven by a user
// gesture, OR on an element already "blessed" by a prior gesture-initiated
// play. Incoming WebSocket audio has no gesture in its call stack, so the
// element MUST be unlocked once (see unlock()) and then REUSED for every
// utterance — a fresh Audio() per utterance is locked again and silently fails.

// Tiny valid silent WAV — played inside a tap to bless the element.
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='

export class StreamingPlayer {
  private chunks: ArrayBuffer[] = []
  private audio: HTMLAudioElement
  private mimeType = 'audio/mp4'
  private currentUrl: string | null = null
  unlocked = false

  constructor() {
    this.audio = new Audio()
    // Surface the media element's own lifecycle — invaluable for iOS playback bugs
    for (const ev of ['play', 'playing', 'pause', 'ended', 'stalled', 'waiting', 'error', 'canplay']) {
      this.audio.addEventListener(ev, () => {
        const mediaErr = this.audio.error
        console.debug(`[player] <audio> ${ev}` + (mediaErr ? ` code=${mediaErr.code} ${mediaErr.message}` : ''))
      })
    }
  }

  // MUST be called synchronously inside a user gesture (tap/click). Plays a
  // silent clip to satisfy iOS so later programmatic play() calls are allowed.
  async unlock(): Promise<boolean> {
    this.audio.src = SILENT_WAV
    try {
      await this.audio.play()
      this.audio.pause()
      this.audio.currentTime = 0
    } catch (err) {
      // NotAllowedError means the gesture didn't count — genuine failure.
      // Any other rejection (e.g. the dummy clip's format) still consumed the
      // gesture, so the element is blessed for later programmatic play().
      const name = (err as Error)?.name
      if (name === 'NotAllowedError') {
        console.error('[player] unlock failed (NotAllowedError) — not a real gesture?')
        return false
      }
      console.debug(`[player] unlock: silent clip errored (${name}) but gesture consumed — treating as unlocked`)
    }
    this.unlocked = true
    console.debug('[player] unlocked via user gesture')
    return true
  }

  setMimeType(mimeType: string): void {
    console.debug(`[player] setMimeType(${mimeType})`)
    this.mimeType = mimeType
  }

  // Begin a new utterance — drop any leftover chunks from a previous one.
  reset(): void {
    this.chunks = []
  }

  append(chunk: ArrayBuffer): void {
    this.chunks.push(chunk)
    console.debug(`[player] append chunk (${chunk.byteLength}b, ${this.chunks.length} total)`)
  }

  end(): void {
    if (this.chunks.length === 0) {
      console.warn('[player] end() called with 0 chunks — nothing to play')
      return
    }
    const blob = new Blob(this.chunks, { type: this.mimeType })
    this.chunks = []  // ready for the next utterance immediately
    if (this.currentUrl) URL.revokeObjectURL(this.currentUrl)
    this.currentUrl = URL.createObjectURL(blob)
    this.audio.src = this.currentUrl
    console.debug(`[player] play() blob=${blob.size}b type=${this.mimeType} unlocked=${this.unlocked}`)
    this.audio.play().then(
      () => console.debug('[player] play() started OK'),
      (err) => console.error(`[player] play() REJECTED: ${err?.name}: ${err?.message}`),
    )
  }

  attach(container: HTMLElement): void {
    container.appendChild(this.audio)
    console.debug('[player] attached audio element')
  }

  destroy(): void {
    console.debug(`[player] destroy (had ${this.chunks.length} chunks, paused=${this.audio.paused})`)
    this.audio.pause()
    if (this.currentUrl) { URL.revokeObjectURL(this.currentUrl); this.currentUrl = null }
    this.audio.src = ''
    this.audio.remove()
    this.chunks = []
  }
}
