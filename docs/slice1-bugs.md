# Slice 1 Bug Log: Voice Transmission

Branch: `slice/voice-transmission`
Date: 2026-06-11

---

## Bug 1: `channels` Map at module scope

**Symptom:** Tests interfered with each other — state from one test leaked into the next.

**Root cause:** `const channels = new Map()` was at the top of `relay/server.js`, shared across all calls to `createRelay()`. Every test run shared the same channel registry.

**Fix:** Moved `channels` inside the `createRelay()` factory function so each server instance gets its own isolated map.

**Commit:** `aafb784`

---

## Bug 2: `end` sentinel sent before final audio chunk

**Symptom:** Receiver's `player.end()` was called before the last chunk arrived, so the final 250ms of audio was cut off on every message.

**Root cause:** `stop()` called `ws.send({ type: 'end' })` synchronously. But `MediaRecorder` fires one final `dataavailable` event *after* `stop()` is called, and that last chunk raced against the sentinel.

**Fix:** Moved the `end` send inside `recorder.onstop` callback, which fires only after the final `dataavailable` has been emitted.

**Commit:** `39ed8f2`

---

## Bug 3: Relay silently dropped `end` messages

**Symptom:** Receiver never triggered playback. Audio chunks arrived but the stream never closed.

**Root cause:** The relay's text-message handler only processed `join`. The `end` control message was parsed but fell through without being forwarded to channel peers.

**Fix:** Added `else if (msg.type === 'end')` branch that fans the text frame to all peers in the channel, same pattern as binary fan-out.

**Commit:** `4bf22d1`

---

## Bug 4: `MediaSource` crash on iOS Safari

**Symptom:** `ReferenceError: Can't find variable: MediaSource` on iPhone. `StreamingPlayer` constructor threw immediately, leaving `playerRef.current` null. Any subsequent binary chunk then crashed on `playerRef.current.append(buf)`.

**Root cause:** iOS Safari does not expose `MediaSource` for audio. The `StreamingPlayer` constructor called `new MediaSource()` unconditionally.

**Fix:** Replaced the entire MSE streaming path with buffer-then-play: chunks accumulate in a plain array; `end()` assembles them into a `Blob` and plays it. No `MediaSource` anywhere. Latency trade-off: audio plays after PTT release rather than while the sender is speaking — acceptable for walkie-talkie UX.

**Commit:** `c73a8e9`

---

## Bug 5: MIME type mismatch between sender (Safari) and receiver (Chrome)

**Symptom:** After fixing the `MediaSource` crash, audio blobs were constructed with `audio/webm;codecs=opus` type but the iPhone sender was encoding `audio/mp4`. The blob played silently or not at all.

**Root cause:** `PTTRecorder` only tried `audio/webm;codecs=opus` then fell back to `audio/webm`. Safari's `MediaRecorder` supports neither — it uses `audio/mp4`. The receiver had no way to know which format the sender chose.

**Fix:**
- Expanded MIME type probe chain: `webm/opus → mp4/aac → mp4 → webm`.
- Sender emits `{ type: 'meta', mimeType }` as the first WebSocket message before any audio chunks.
- Relay forwards `meta` the same way it forwards `end`.
- Receiver creates the player on `meta`, calls `player.setMimeType()` so the `Blob` is assembled with the correct type.

**Commits:** `c73a8e9`, `4bf22d1`

---

## Bug 6: Null ref crash after `await arrayBuffer()`

**Symptom:** `TypeError: null is not an object (evaluating 'playerRef.current.append')` — intermittent, at the line after the `await`.

**Root cause:** `onmessage` was `async`. When it hit `await event.data.arrayBuffer()`, it yielded to the event loop. During that gap, the `end` handler ran synchronously, set `playerRef.current = null`, and then the append resumed into null.

**Fix:** Capture `const player = playerRef.current` before the `await`. Use the local variable for the `append` call. The local holds the reference even if the ref is nulled mid-flight.

**Commit:** `63d791e`

---

## Bug 7: Intermittent silence / missing audio (the main flakiness)

**Symptom:** Audio sometimes transmitted fine, sometimes completely silent, with no error. Especially frequent on short PTT presses.

**Root cause:** `event.data.arrayBuffer()` is async (Blob-to-ArrayBuffer conversion). Multiple chunks could be in-flight simultaneously. If the `end` message arrived while any chunk was still being decoded, `player.end()` ran with a partial (or empty) chunk list. The blob was assembled from whatever was in `this.chunks` at that instant — missing the tail of the audio.

**Fix:** Added `pendingChunks` counter (incremented before `await`, decremented after). When `end` arrives and `pendingChunks > 0`, set `pendingEnd = true` instead of calling `flushEnd()`. The last resolving chunk checks `pendingEnd` and fires `flushEnd()` itself, guaranteeing all audio is in the blob before playback starts.

**Commit:** `d3e4dbd`

---

## Bug 8: No reconnect after relay restart (permanent silence)

**Symptom:** Audio worked the first time. After stopping and restarting the relay, transmission went permanently silent with no recovery. Console showed only the (unrelated) "WebSocket closed before connection established" warning, which made it look like a connection bug.

**Root cause:** Neither client had reconnection logic. The WebSocket was created once inside `useEffect` and `onclose` only set a status string. Restarting the relay closes both sockets, but the effect's deps (`[wsUrl, channelId]`) never change, so it never re-runs and the socket is never reopened. The clients sit orphaned until a hard page reload.

The StrictMode console warning was a red herring (see Non-bugs below) and misdirected the investigation.

**Evidence that ruled out other layers:**
- Relay isolation test: a fresh relay handled 3 back-to-back transmissions cleanly (meta → binary → end each time), no crash, both clients stayed connected. Rules out an FFmpeg/EPIPE relay crash on repeat transmissions.
- Confirmed `.env.local` pointed at the live local relay (not the stopped EC2 box) and ffmpeg was installed.

**Fix:** Wrapped socket creation in a `connect()` function in both `AudioReceiver.tsx` and `PTTTransmit.tsx`. `onclose` now schedules `connect()` after a 1s backoff, guarded by an `unmounted` flag so the cleanup function does not trigger a reconnect. The sender keeps `wsRef.current` pointed at the live socket across reconnects. Status shows "Reconnecting..." during the gap.

**Verification:** Protocol-level test reproducing the exact flow (transmit → kill relay → restart → transmit) recovers automatically within the backoff window, where the old code stayed silent.

**Commit:** `a0f9468`

---

## Bug 9: `preventDefault` ignored in passive touch listeners

**Symptom:** Console spammed `Unable to preventDefault inside passive event listener invocation` from the PTT button's touch handlers on every touch.

**Root cause:** React's event system registers `touchstart`/`touchmove` as **passive** listeners on the root container (a scroll-performance default). Inside a passive listener `preventDefault()` is a no-op, so the JSX `onTouchStart={(e) => { e.preventDefault(); ... }}` handlers warned. The `preventDefault()` was there to suppress the synthesized ghost mouse events so `onMouseDown`/`onMouseUp` would not double-fire PTT on touch devices.

**Fix:** Attach `touchstart`/`touchend` natively via a button ref in a `useEffect` with `{ passive: false }`, where `preventDefault()` actually works. Removed the JSX `onTouchStart`/`onTouchEnd`, added `touch-none` to disable scroll/zoom gestures on the button. Kept `onMouseDown`/`onMouseUp` for desktop.

**Commit:** `3c3c025`

---

## Non-bugs (dev environment noise)

**"WebSocket closed before connection established"** — React StrictMode in development runs every `useEffect` twice (mount, unmount, remount). The first WebSocket is closed immediately by the cleanup; the second is the real connection. This warning appears every page load in dev and disappears in production.
