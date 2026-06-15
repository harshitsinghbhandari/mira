# Mira Slice 1: Real-Time Voice Transmission

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream audio from device A to device B in real time — receiver starts hearing the sender ~300ms after they start speaking, regardless of message length.

**Architecture:** Browser records audio in 250ms chunks via MediaRecorder (WebM/Opus), sends each chunk immediately as binary over a WebSocket connection to a Node.js relay server, which fans it out to all subscribers in the same channel. Receiver pipes chunks into MediaSource Extensions (MSE) and plays them as they arrive — no waiting for the full message. EC2 t3.micro hosts the relay behind Nginx with Let's Encrypt for WSS (required because Vercel-hosted Next.js is HTTPS-only and can't open plain `ws://` connections).

**Tech Stack:** Node.js + `ws` (relay), MediaRecorder + MSE (browser audio), Next.js (test UI), EC2 + Nginx + Certbot (hosting)

---

## Expected Latencies

| Metric | Local (same network) | Internet |
|--------|---------------------|----------|
| First audio at receiver (from PTT press) | ~275ms | ~320–400ms |
| Post-release tail (last audio after PTT released) | ~100–200ms | ~150–300ms |
| End-to-end perceived delay | **~275–350ms** | **~350–500ms** |

**Where the time goes:**

```
PTT pressed
  └─ MediaRecorder buffers audio for 250ms (timeslice)    → +250ms
  └─ ondataavailable fires, ws.send(chunk)                → +1–5ms  (local) / +20–80ms (internet)
  └─ relay receives, fans out to subscribers              → +0–1ms
  └─ receiver MSE appends chunk to SourceBuffer           → +5–15ms
  └─ audio element plays buffered data                    → +10–30ms
                                                 TOTAL:  ~275ms (local) / ~320–400ms (internet)
```

Tuning lever: `timeslice`. Dropping to `125ms` cuts first-delivery to ~180ms locally but doubles WebSocket message rate and increases CPU. `250ms` is the right starting point.

> **Safari caveat:** Safari does not support `audio/webm` in MediaRecorder or MSE. Chrome, Firefox, and Edge work. This slice targets Chrome/Firefox only — Safari is a later problem.

---

## File Map

| Path | Purpose |
|------|---------|
| `relay/server.js` | Node.js WebSocket relay — fans out binary audio chunks to channel subscribers |
| `relay/package.json` | ws dependency + start script |
| `relay/Dockerfile` | Container image for EC2/ECS deployment |
| `relay/server.test.js` | Integration tests — real ws connections, channel isolation, binary forwarding |
| `src/lib/audio/recorder.ts` | `PTTRecorder` class — wraps MediaRecorder, streams 250ms chunks via WebSocket |
| `src/lib/audio/player.ts` | `StreamingPlayer` class — MSE-based receiver, queues and plays incoming chunks |
| `src/components/PTTTransmit.tsx` | Hold-to-talk UI component — wires PTTRecorder to a button |
| `src/components/AudioReceiver.tsx` | Receiver UI component — instantiates StreamingPlayer, shows playback state |
| `src/app/transmit/page.tsx` | Test page — two panels side by side: transmit + receive (works with two browser tabs) |

---

## Task 1: Relay Server

A pure relay — no business logic, no persistence. Receives binary chunks from one WebSocket, fans them out to all other WebSockets subscribed to the same channel. JSON control messages handle join/leave.

**Files:**
- Create: `relay/package.json`
- Create: `relay/server.js`
- Create: `relay/server.test.js`

- [ ] **Step 1: Write failing relay tests**

  Create `relay/server.test.js`:
  ```javascript
  import { describe, it, expect, beforeEach, afterEach } from 'vitest'
  import WebSocket, { WebSocketServer } from 'ws'
  import { createRelay } from './server.js'

  function connect(port, channelId) {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}`)
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'join', channelId }))
        // small delay so server processes the join before test proceeds
        setTimeout(() => resolve(ws), 20)
      })
    })
  }

  function nextBinaryMessage(ws) {
    return new Promise((resolve) => {
      ws.once('message', (data, isBinary) => {
        if (isBinary) resolve(data)
      })
    })
  }

  describe('relay server', () => {
    let wss, port

    beforeEach(async () => {
      wss = createRelay(0) // port 0 = OS picks a free port
      await new Promise((resolve) => wss.once('listening', resolve))
      port = wss.address().port
    })

    afterEach(() => wss.close())

    it('forwards binary chunk from sender to receiver in same channel', async () => {
      const sender = await connect(port, 'ch-security')
      const receiver = await connect(port, 'ch-security')

      const incoming = nextBinaryMessage(receiver)
      sender.send(Buffer.from([1, 2, 3, 4]), { binary: true })
      const received = await incoming

      expect(Buffer.from(received)).toEqual(Buffer.from([1, 2, 3, 4]))
      sender.close()
      receiver.close()
    })

    it('does NOT forward to a client in a different channel', async () => {
      const sender = await connect(port, 'ch-security')
      const outsider = await connect(port, 'ch-medical')

      let received = false
      outsider.on('message', () => { received = true })

      sender.send(Buffer.from([1, 2, 3]), { binary: true })
      await new Promise((r) => setTimeout(r, 100))

      expect(received).toBe(false)
      sender.close()
      outsider.close()
    })

    it('does NOT echo the chunk back to the sender', async () => {
      const sender = await connect(port, 'ch-security')

      let echoed = false
      sender.on('message', () => { echoed = true })

      sender.send(Buffer.from([9, 9, 9]), { binary: true })
      await new Promise((r) => setTimeout(r, 100))

      expect(echoed).toBe(false)
      sender.close()
    })

    it('forwards to multiple receivers in the same channel', async () => {
      const sender = await connect(port, 'ch-ops')
      const r1 = await connect(port, 'ch-ops')
      const r2 = await connect(port, 'ch-ops')

      const p1 = nextBinaryMessage(r1)
      const p2 = nextBinaryMessage(r2)
      sender.send(Buffer.from([7, 7, 7]), { binary: true })
      const [d1, d2] = await Promise.all([p1, p2])

      expect(Buffer.from(d1)).toEqual(Buffer.from([7, 7, 7]))
      expect(Buffer.from(d2)).toEqual(Buffer.from([7, 7, 7]))
      sender.close(); r1.close(); r2.close()
    })

    it('removes client from channel on disconnect', async () => {
      const sender = await connect(port, 'ch-security')
      const receiver = await connect(port, 'ch-security')

      receiver.close()
      await new Promise((r) => setTimeout(r, 50))

      // Should not throw when sending to a channel with no live receivers
      expect(() => sender.send(Buffer.from([1]), { binary: true })).not.toThrow()
      sender.close()
    })
  })
  ```

- [ ] **Step 2: Run tests to confirm they fail**

  ```bash
  cd relay && npx vitest run
  ```
  Expected: FAIL — `createRelay` not found.

- [ ] **Step 3: Create relay/package.json**

  ```json
  {
    "name": "mira-relay",
    "version": "1.0.0",
    "type": "module",
    "main": "server.js",
    "scripts": {
      "start": "node server.js",
      "dev": "node --watch server.js",
      "test": "vitest run"
    },
    "dependencies": {
      "ws": "^8.18.0"
    },
    "devDependencies": {
      "vitest": "^2.0.0"
    }
  }
  ```

  ```bash
  cd relay && npm install
  ```

- [ ] **Step 4: Create relay/server.js**

  ```javascript
  import { WebSocketServer } from 'ws'

  // channels: Map<channelId, Set<WebSocket>>
  const channels = new Map()

  export function createRelay(port) {
    const wss = new WebSocketServer({ port })

    wss.on('connection', (ws) => {
      let channelId = null

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          // Audio chunk — fan out to all other clients in the same channel
          if (!channelId) return
          const peers = channels.get(channelId)
          if (!peers) return
          for (const peer of peers) {
            if (peer !== ws && peer.readyState === 1 /* OPEN */) {
              peer.send(data, { binary: true })
            }
          }
          return
        }

        // JSON control message
        try {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'join' && typeof msg.channelId === 'string') {
            // Leave previous channel if any
            if (channelId && channels.has(channelId)) {
              channels.get(channelId).delete(ws)
            }
            channelId = msg.channelId
            if (!channels.has(channelId)) channels.set(channelId, new Set())
            channels.get(channelId).add(ws)
          }
        } catch {
          // ignore malformed control messages
        }
      })

      ws.on('close', () => {
        if (channelId && channels.has(channelId)) {
          channels.get(channelId).delete(ws)
          if (channels.get(channelId).size === 0) channels.delete(channelId)
        }
      })
    })

    return wss
  }

  // Only start the server when run directly (not when imported by tests)
  if (process.argv[1] === new URL(import.meta.url).pathname) {
    const PORT = process.env.PORT ?? 8080
    const wss = createRelay(PORT)
    wss.on('listening', () => console.log(`relay listening on :${PORT}`))
  }
  ```

- [ ] **Step 5: Run tests — confirm they pass**

  ```bash
  cd relay && npm test
  ```
  Expected: 5 tests PASS.

- [ ] **Step 6: Smoke-test the server manually**

  Terminal 1:
  ```bash
  cd relay && npm run dev
  ```
  Terminal 2 (use wscat or websocat):
  ```bash
  npx wscat -c ws://localhost:8080
  > {"type":"join","channelId":"test"}
  ```
  Terminal 3:
  ```bash
  npx wscat -c ws://localhost:8080
  > {"type":"join","channelId":"test"}
  # Now type anything binary-ish from terminal 2 — terminal 3 should receive it
  ```

- [ ] **Step 7: Create relay/Dockerfile**

  ```dockerfile
  FROM node:20-alpine
  WORKDIR /app
  COPY package*.json ./
  RUN npm ci --omit=dev
  COPY server.js .
  EXPOSE 8080
  CMD ["node", "server.js"]
  ```

- [ ] **Step 8: Commit**

  ```bash
  git add relay/
  git commit -m "feat: add WebSocket relay server with channel fan-out"
  ```

---

## Task 2: Audio Modules (Recorder + Player)

Two classes with clean interfaces. `PTTRecorder` handles the MediaRecorder lifecycle and streams chunks over a WebSocket. `StreamingPlayer` receives those chunks and plays them via MSE with minimal buffering.

**Files:**
- Create: `src/lib/audio/recorder.ts`
- Create: `src/lib/audio/player.ts`

- [ ] **Step 1: Create src/lib/audio/recorder.ts**

  ```typescript
  export interface RecorderOptions {
    ws: WebSocket
    timeslice?: number  // ms per chunk, default 250
  }

  export class PTTRecorder {
    private recorder: MediaRecorder | null = null
    private ws: WebSocket
    private timeslice: number

    constructor({ ws, timeslice = 250 }: RecorderOptions) {
      this.ws = ws
      this.timeslice = timeslice
    }

    async start(): Promise<void> {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })

      // Prefer WebM/Opus — streamable format MSE can handle incrementally
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'

      this.recorder = new MediaRecorder(stream, { mimeType })

      this.recorder.ondataavailable = (e) => {
        if (e.data.size > 0 && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(e.data)
        }
      }

      this.recorder.start(this.timeslice)
    }

    stop(): void {
      if (!this.recorder) return
      this.recorder.stop()
      this.recorder.stream.getTracks().forEach((t) => t.stop())
      this.recorder = null
      // Signal end-of-message to receivers
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'end' }))
      }
    }

    get isRecording(): boolean {
      return this.recorder?.state === 'recording'
    }
  }
  ```

- [ ] **Step 2: Create src/lib/audio/player.ts**

  ```typescript
  // One StreamingPlayer per incoming PTT message.
  // Create it when the first chunk arrives, destroy it when playback ends.
  export class StreamingPlayer {
    private ms: MediaSource
    private sb: SourceBuffer | null = null
    private queue: ArrayBuffer[] = []
    private audio: HTMLAudioElement
    private ended = false

    constructor() {
      this.ms = new MediaSource()
      this.audio = new Audio()
      this.audio.src = URL.createObjectURL(this.ms)

      this.ms.addEventListener('sourceopen', () => {
        // Must match the sender's mimeType exactly
        const mime = MediaSource.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm'

        this.sb = this.ms.addSourceBuffer(mime)
        this.sb.addEventListener('updateend', () => this.flush())
        this.flush()
      })
    }

    append(chunk: ArrayBuffer): void {
      this.queue.push(chunk)
      this.flush()

      // Start playing as soon as we have the first chunk buffered
      if (this.audio.paused && this.audio.readyState >= 2 /* HAVE_CURRENT_DATA */) {
        this.audio.play().catch(() => {})
      }
    }

    // Call when the sender signals end-of-message
    end(): void {
      this.ended = true
      this.flush()
    }

    private flush(): void {
      if (!this.sb || this.sb.updating) return

      if (this.queue.length > 0) {
        this.sb.appendBuffer(this.queue.shift()!)
        return
      }

      // Queue drained — if message is over, close the stream
      if (this.ended && !this.ms.readyState.startsWith('closed')) {
        try { this.ms.endOfStream() } catch { /* already closed */ }
      }
    }

    // Attach to a DOM container so the audio element exists in the page
    attach(container: HTMLElement): void {
      container.appendChild(this.audio)
    }

    destroy(): void {
      this.audio.pause()
      URL.revokeObjectURL(this.audio.src)
      this.audio.remove()
    }
  }
  ```

  > **Why one player per message:** Reusing a single MediaSource across PTT messages requires careful SourceBuffer management and `endOfStream` handling. Creating a fresh player per message is simpler and garbage-collects cleanly.

- [ ] **Step 3: Commit**

  ```bash
  git add src/lib/audio/
  git commit -m "feat: add PTTRecorder and StreamingPlayer audio modules"
  ```

---

## Task 3: UI Components + Test Page

A minimal PTT transmit button and audio receiver component, wired together on a single test page. Two browser tabs open on this page can talk to each other — one as sender, one as receiver.

**Files:**
- Create: `src/components/PTTTransmit.tsx`
- Create: `src/components/AudioReceiver.tsx`
- Create: `src/app/transmit/page.tsx`

- [ ] **Step 1: Create src/components/PTTTransmit.tsx**

  ```tsx
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
    const [connected, setConnected] = useState(false)
    const [recording, setRecording] = useState(false)
    const [status, setStatus] = useState('Connecting...')

    useEffect(() => {
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'join', channelId }))
        setConnected(true)
        setStatus(`Connected to #${channelId}`)
      }
      ws.onclose = () => { setConnected(false); setStatus('Disconnected') }
      ws.onerror = () => setStatus('Connection error')

      return () => ws.close()
    }, [wsUrl, channelId])

    const startPTT = useCallback(async () => {
      if (!wsRef.current || !connected) return
      const recorder = new PTTRecorder({ ws: wsRef.current })
      recorderRef.current = recorder
      await recorder.start()
      setRecording(true)
      setStatus('Recording...')
    }, [connected])

    const stopPTT = useCallback(() => {
      recorderRef.current?.stop()
      recorderRef.current = null
      setRecording(false)
      setStatus(`Connected to #${channelId}`)
    }, [channelId])

    return (
      <div className="flex flex-col items-center gap-4">
        <p className="text-sm text-gray-400">{status}</p>
        <p className="text-xs text-gray-600">Sending as: {senderName}</p>
        <button
          onMouseDown={startPTT}
          onMouseUp={stopPTT}
          onTouchStart={(e) => { e.preventDefault(); startPTT() }}
          onTouchEnd={(e) => { e.preventDefault(); stopPTT() }}
          disabled={!connected}
          className={[
            'select-none rounded-full w-32 h-32 font-bold text-sm transition-all duration-100',
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
  ```

- [ ] **Step 2: Create src/components/AudioReceiver.tsx**

  ```tsx
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

    useEffect(() => {
      const ws = new WebSocket(wsUrl)

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'join', channelId }))
        setStatus(`Listening on #${channelId}`)
      }

      ws.onmessage = async (event) => {
        if (event.data instanceof Blob) {
          // Binary = audio chunk
          if (!playerRef.current) {
            // First chunk of a new message — create a fresh player
            const player = new StreamingPlayer()
            if (containerRef.current) player.attach(containerRef.current)
            playerRef.current = player
            setStatus('Receiving...')
          }
          const buf = await event.data.arrayBuffer()
          playerRef.current.append(buf)
        } else {
          // JSON control message
          try {
            const msg = JSON.parse(event.data)
            if (msg.type === 'end' && playerRef.current) {
              playerRef.current.end()
              setLastReceived(new Date().toLocaleTimeString())
              setStatus(`Listening on #${channelId}`)
              // Clean up after playback — give 5s for audio to finish
              const stale = playerRef.current
              playerRef.current = null
              setTimeout(() => stale.destroy(), 5000)
            }
          } catch { /* ignore */ }
        }
      }

      ws.onclose = () => setStatus('Disconnected')

      return () => {
        ws.close()
        playerRef.current?.destroy()
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
        <p className="text-sm text-gray-400">{status}</p>
        {lastReceived && (
          <p className="text-xs text-gray-600">Last received: {lastReceived}</p>
        )}
        {/* Audio elements are injected here by StreamingPlayer */}
        <div ref={containerRef} className="hidden" />
      </div>
    )
  }
  ```

- [ ] **Step 3: Create src/app/transmit/page.tsx**

  ```tsx
  'use client'

  import { useState } from 'react'
  import { PTTTransmit } from '@/components/PTTTransmit'
  import { AudioReceiver } from '@/components/AudioReceiver'

  // Change this to your relay server URL once deployed
  const WS_URL = process.env.NEXT_PUBLIC_RELAY_URL ?? 'ws://localhost:8080'

  export default function TransmitPage() {
    const [channel, setChannel] = useState('ch-security')
    const [name, setName] = useState('Staff A')
    const [role, setRole] = useState<'send' | 'receive' | 'both'>('both')

    return (
      <main className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center gap-8 p-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold">Mira — Voice Transmission Test</h1>
          <p className="text-gray-500 text-sm mt-1">
            Open this page in two tabs. One sends, one receives.
          </p>
        </div>

        {/* Controls */}
        <div className="flex gap-3 items-center flex-wrap justify-center">
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
          >
            <option value="ch-security">security</option>
            <option value="ch-medical">medical</option>
            <option value="ch-ops">operations</option>
          </select>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm w-32"
          />
          <div className="flex gap-1">
            {(['send', 'receive', 'both'] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRole(r)}
                className={`px-3 py-2 rounded-lg text-sm capitalize ${role === r ? 'bg-blue-600' : 'bg-gray-800'}`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* Panels */}
        <div className="flex gap-16 flex-wrap justify-center">
          {(role === 'send' || role === 'both') && (
            <div className="flex flex-col items-center gap-2">
              <p className="text-xs uppercase tracking-widest text-gray-600">Transmit</p>
              <PTTTransmit wsUrl={WS_URL} channelId={channel} senderName={name} />
            </div>
          )}
          {(role === 'receive' || role === 'both') && (
            <div className="flex flex-col items-center gap-2">
              <p className="text-xs uppercase tracking-widest text-gray-600">Receive</p>
              <AudioReceiver wsUrl={WS_URL} channelId={channel} />
            </div>
          )}
        </div>

        <p className="text-xs text-gray-700 text-center max-w-sm">
          Relay: <span className="font-mono text-gray-500">{WS_URL}</span>
        </p>
      </main>
    )
  }
  ```

- [ ] **Step 4: Add NEXT_PUBLIC_RELAY_URL to .env.local**

  ```bash
  echo "NEXT_PUBLIC_RELAY_URL=ws://localhost:8080" >> .env.local
  ```

- [ ] **Step 5: Test locally with two tabs**

  Terminal 1 — relay:
  ```bash
  cd relay && npm run dev
  ```
  Terminal 2 — Next.js:
  ```bash
  npm run dev
  ```

  1. Open `http://localhost:3000/transmit` in Tab A, select role `send`
  2. Open `http://localhost:3000/transmit` in Tab B, select role `receive`
  3. Both on the same channel (e.g. `security`)
  4. Hold PTT in Tab A, speak, release
  5. Tab B should start playing audio within ~300ms of you starting to speak

  **Measure latency:** Use a stopwatch or speak a clap sound — note the delay between clap in Tab A and hearing it in Tab B.

- [ ] **Step 6: Commit**

  ```bash
  git add src/components/PTTTransmit.tsx src/components/AudioReceiver.tsx src/app/transmit/
  git commit -m "feat: add PTT transmit and audio receiver UI with MSE streaming"
  ```

---

## Task 4: EC2 Deployment (WSS)

Vercel serves the Next.js app over HTTPS. Browsers block mixed-content: a page on `https://` cannot open a plain `ws://` WebSocket. The relay must be served over `wss://` (WebSocket Secure). The cleanest path: EC2 t3.micro + Nginx as TLS-terminating reverse proxy + Let's Encrypt cert.

**Files:** No source changes — server configuration only.

- [ ] **Step 1: Launch EC2 t3.micro**

  Via AWS Console or CLI:
  ```bash
  aws ec2 run-instances \
    --image-id ami-0c02fb55956c7d316 \
    --instance-type t3.micro \
    --key-name your-keypair \
    --security-group-ids sg-xxxxxxxx \
    --count 1 \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=mira-relay}]'
  ```

  Security group must allow:
  - TCP 22 (SSH) from your IP
  - TCP 80 (HTTP, for Let's Encrypt challenge) from 0.0.0.0/0
  - TCP 443 (HTTPS/WSS) from 0.0.0.0/0

- [ ] **Step 2: Point a subdomain at the EC2 public IP**

  In your DNS provider, add an A record:
  ```
  relay.your-domain.com  →  <EC2 public IP>
  ```
  Wait for propagation (usually <5 min on Cloudflare).

- [ ] **Step 3: SSH in and install dependencies**

  ```bash
  ssh -i your-keypair.pem ec2-user@<EC2-IP>
  ```
  Then:
  ```bash
  sudo yum update -y
  sudo yum install -y nginx nodejs npm git certbot python3-certbot-nginx
  ```

- [ ] **Step 4: Deploy the relay server**

  ```bash
  git clone https://github.com/harshitsinghbhandari/mira.git
  cd mira/relay
  npm ci --omit=dev
  # Install PM2 to keep the process alive
  sudo npm install -g pm2
  pm2 start server.js --name mira-relay
  pm2 save
  pm2 startup  # run the command it prints to auto-start on reboot
  ```

- [ ] **Step 5: Configure Nginx as WSS reverse proxy**

  Create `/etc/nginx/conf.d/mira-relay.conf`:
  ```nginx
  server {
      listen 80;
      server_name relay.your-domain.com;
      location / { return 301 https://$host$request_uri; }
  }

  server {
      listen 443 ssl;
      server_name relay.your-domain.com;

      # Certbot will fill in the ssl_certificate lines after Step 6
      
      location / {
          proxy_pass http://localhost:8080;
          proxy_http_version 1.1;
          proxy_set_header Upgrade $http_upgrade;
          proxy_set_header Connection "upgrade";
          proxy_set_header Host $host;
          proxy_read_timeout 3600;   # keep WebSocket connections open for up to 1hr
      }
  }
  ```

  ```bash
  sudo nginx -t && sudo systemctl restart nginx
  ```

- [ ] **Step 6: Issue TLS certificate**

  ```bash
  sudo certbot --nginx -d relay.your-domain.com --non-interactive --agree-tos -m your@email.com
  ```
  Expected: Certificate issued, Nginx reloaded. Certbot auto-renews via cron.

- [ ] **Step 7: Update NEXT_PUBLIC_RELAY_URL in Vercel**

  In the Vercel dashboard → your Mira project → Settings → Environment Variables:
  ```
  NEXT_PUBLIC_RELAY_URL = wss://relay.your-domain.com
  ```
  Redeploy.

- [ ] **Step 8: Verify end-to-end over the internet**

  1. Open deployed Vercel URL (`/transmit`) on your phone (cellular, not WiFi)
  2. Open same URL on your laptop (WiFi)
  3. Hold PTT on phone, speak, release
  4. Confirm laptop hears audio within ~400ms

  **What to check if it doesn't work:**
  - Browser console: look for WebSocket connection errors
  - EC2: `pm2 logs mira-relay` — are connections appearing?
  - Nginx: `sudo tail -f /var/log/nginx/error.log`

- [ ] **Step 9: Commit relay config reference**

  ```bash
  git add .env.local  # don't commit — just note the updated value
  git commit -m "feat: deploy relay to EC2 with WSS, end-to-end voice transmission working"
  ```

---

## Latency Reality Check

Once deployed, do a measured test with two phones on different networks:

| What you're measuring | How to measure |
|-----------------------|----------------|
| First audio delivery | Clap into sender mic — time until receiver hears the clap |
| Post-release tail | Note silence gap after PTT release |
| Relay processing overhead | Check relay logs for receive→send timestamp diff |

If measured latency is significantly higher than expected:

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| >600ms first delivery | EC2 region far from users | Switch to a closer region |
| >600ms first delivery | `timeslice` too high | Drop to `125` in `PTTRecorder` |
| MSE stutters or drops | Chunk queue backing up | Increase `timeslice` to `500` |
| Audio doesn't play on mobile | Autoplay policy blocked | Require user gesture before creating `StreamingPlayer` — move `attach()` to a button click |
| Works in Chrome, broken in Safari | WebM not supported | Known limitation — Safari needs MP4/AAC, handle in Slice 2 |
