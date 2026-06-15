# Voice Transmission: Why iOS Safari Played No Audio

This is the story of one bug: **laptop (Chrome) speaks, phone (iOS Safari) shows
"Receiving..." but no sound plays.** It took several attempts, each fixing a real
problem, before we found the actual root cause. The system works flawlessly now.

## The system

Push-to-talk voice relay for a live event ops platform:

```
Laptop (Chrome)            Relay (Node.js)              Phone (iOS Safari)
  PTTRecorder    --ws-->   buffers chunks      --ws-->   AudioReceiver
  MediaRecorder            transcodes to mp4              StreamingPlayer
  250ms chunks             fans out to peers              buffer-then-play
```

- Sender records audio, streams 250ms binary chunks over a WebSocket.
- Relay buffers a whole utterance, transcodes it with FFmpeg, fans the result
  out to every other client in the channel.
- Receiver buffers the chunks and plays the assembled blob on release ("release
  to hear" walkie-talkie UX).

Key files: `relay/server.js`, `src/lib/audio/recorder.ts`,
`src/lib/audio/player.ts`, `src/components/AudioReceiver.tsx`,
`src/components/PTTTransmit.tsx`.

## The attempts

Each of these was a genuine bug found and fixed along the way. None of them was
the final root cause of the silence, but all were real and had to be fixed for
the system to work.

### Attempt 1 — Transcode to MP4 for Safari (`741c190`)

**Theory:** Chrome records `audio/webm;codecs=opus`. iOS Safari cannot play
`audio/webm` at all, ever. That was a true incompatibility.

**Fix:** The relay now runs FFmpeg on each utterance
(`webm/opus -> fragmented mp4/aac`) and tells receivers to expect `audio/mp4`.
Fragmented MP4 (`frag_keyframe+empty_moov`) plays from a Blob URL on every
browser.

**Result:** Necessary, but audio was still silent. The format was now correct
and the bytes arrived intact, yet nothing played.

### Attempt 2 — Auto-reconnect after relay drop (`a0f9468`, Bug 8)

**Symptom:** Worked once, then went permanently silent after the relay was
stopped and restarted.

**Root cause:** Neither client had reconnection logic. The WebSocket was created
once in a `useEffect` and `onclose` only set a status string. A relay restart
closed both sockets and the effect never re-ran (deps never change), so the
clients sat orphaned until a hard reload.

**Fix:** Wrapped socket creation in a `connect()` function on both clients;
`onclose` reconnects after a 1s backoff, guarded by an `unmounted` flag.

**Result:** Recovery after restart worked, but transmissions still went silent
after a couple of plays. The symptom shifted from "1 then dead" to "2 then dead"
— a strong hint the real cause was elsewhere.

### Attempt 3 — Non-passive touch listeners (`3c3c025`, Bug 9)

**Symptom:** Console spam: `Unable to preventDefault inside passive event
listener invocation`.

**Root cause:** React registers `touchstart`/`touchmove` as passive listeners,
so `e.preventDefault()` in the JSX `onTouchStart` handler was a no-op.

**Fix:** Attach `touchstart`/`touchend` natively via a ref with
`{ passive: false }`; add `touch-none` to the button.

**Result:** Cleaned up the warning and prevented ghost-click double-firing on
touch. Still not the silence.

### The red herring that cost the most time

Throughout, the console showed:

```
WebSocket connection to 'ws://192.168.88.7:8080/' failed:
  WebSocket is closed before the connection is established.
```

It *looked* like a connection bug. It was not. Its stack trace ran through
`commitHookEffectListUnmount -> doubleInvokeEffectsOnFiber ->
recursivelyTraverseAndDoubleInvokeEffectsInDEV` — that is **React StrictMode's
dev-only double-mount**: it opens a socket, immediately closes it while still
connecting (hence the warning), then opens the real one. It prints once on every
page load in development and disappears in production. It had nothing to do with
the missing audio. Chasing it repeatedly was the biggest time sink.

## How we actually found it: verbose logging at every boundary

After three plausible-but-wrong fixes, we stopped guessing and instrumented the
entire pipeline instead — tagged logs at each boundary:

- `[relay …]` — relay: connections, joins, every chunk, transcode in/out sizes,
  fan-out counts (plus a crash-hardened FFmpeg stdin pipe and process-level
  `uncaughtException` handlers so a crash could never again look like a silent
  stop).
- `[rec]` — recorder: chosen MIME type, every chunk sent, the `end` send.
- `[send]` / `[recv]` — both components' WebSocket lifecycle and message flow.
- `[player]` — blob size, MIME type, and crucially the `<audio>` element's own
  events plus the result of `play()`.

The decisive change was in `StreamingPlayer.end()`. It had been swallowing the
playback error:

```ts
this.audio.play().catch(() => {})   // silent failure — the bug hid here
```

We replaced it with a logged promise. The very next test produced the answer:

```
[relay 20:00:13.787] c12 control msg: {"type":"meta","mimeType":"audio/webm;codecs=opus"}
[relay 20:00:13.790] c12 forwarded meta to 1/1 peers
[relay 20:00:14.100] c12 binary chunk #1 (3060b, buffered total 3060b)
...
[relay 20:00:15.256] c12 transcode start: 5 chunks, 21477b in
[relay 20:00:15.374] c12 transcode done: 19179b out
[relay 20:00:15.374] c12 forwarded 19179b mp4 + end to 1/1 peers

[player] play() REJECTED: NotAllowedError: The request is not allowed by the
  user agent or the platform in the current context, possibly because the user
  denied permission.
```

The relay was perfect. Every byte arrived. The single point of failure was one
`play()` call on the phone.

## The actual root cause: iOS autoplay policy + per-element unlock

iOS Safari only allows `audio.play()` that is either (a) driven directly by a
user gesture, or (b) called on an element already "blessed" by a prior
gesture-initiated play. Audio arriving over a WebSocket has no user gesture in
its call stack, so iOS rejected `play()` with `NotAllowedError`.

This also explained the "works N times, then stops" pattern: iOS grants a short
user-activation window after a tap, and `play()` succeeds inside it; once the
window expires, it is blocked.

The second, subtler half of the bug: the receiver created a **brand-new
`StreamingPlayer` (new `Audio()`) on every `meta` message**. iOS unlock is
**per element**. So even when an element got blessed, the next utterance built a
fresh, locked one — which is why no amount of activation lasted.

## What finally worked (Bug 10)

Two changes, both mandatory on iOS:

1. **One persistent, unlocked `<audio>` element.** `StreamingPlayer` now keeps a
   single element for its lifetime. `end()` swaps the element's `src` to the new
   blob and replays; a new `reset()` clears the chunk buffer to begin the next
   utterance on the *same* element. No more new `Audio()` per message.

2. **A one-time user gesture to unlock playback.** The receiver shows a
   **"🔊 Tap to enable audio"** button. The tap calls `player.unlock()`, which
   plays a tiny silent clip *inside the gesture* to bless the element. Only
   `NotAllowedError` counts as a real failure there — a format quirk in the dummy
   clip still consumes the gesture, so the element is considered unlocked.

After the tap, every incoming utterance plays on the same blessed element:

```
[player] unlocked via user gesture
[player] play() blob=19179b type=audio/mp4 unlocked=true
[player] <audio> play
[player] play() started OK
```

## Lessons

- **A silent `.catch(() => {})` will cost you hours.** The bug lived behind it
  the whole time. Surface errors before debugging.
- **Read the stack trace before trusting the message.** "WebSocket closed before
  established" pointed at the network; the stack pointed at React StrictMode. The
  stack was right.
- **In a multi-component pipeline, instrument the boundaries instead of
  guessing.** Three reasonable fixes missed because we hadn't yet seen where the
  data actually died. One round of boundary logging found it immediately.
- **iOS audio has two rules, not one:** playback needs a user gesture, AND the
  unlock is per element — so the unlocked element must be reused, never
  recreated per utterance.

## Related history

| Commit | What |
|--------|------|
| `741c190` | Relay transcodes webm -> mp4 for Safari |
| `a0f9468` | Auto-reconnect WebSocket clients after relay drop (Bug 8) |
| `3c3c025` | Non-passive PTT touch listeners (Bug 9) |
| _(this fix)_ | Persistent unlocked `<audio>` element + tap-to-enable gate (Bug 10) |

See `docs/slice1-bugs.md` for the full per-bug log.
