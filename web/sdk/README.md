# @vmux/client

Build your own UI on the Claude Voice Multiplexer relay: see a session's
sessions, transcript and agent status, know exactly which word Claude is
saying and how loud, talk back by text or voice, and lock it all to one
session.  The vmux web app is built on this SDK; anything it can do, your UI
can do.

Framework-free TypeScript.  `livekit-client` is an optional peer dependency,
needed only for `@vmux/client/voice`.

> Lives in `web/sdk` (not a top-level package) because the daemon's
> auto-updater builds `web/` on its own.  Copy the folder into your project,
> or import `web/sdk/src` via a path alias as the web app does.

## Quick start

```ts
import { RelayClient, SpeechPlayer, pairDevice } from "@vmux/client";

// 1. Pair once with a code from the vmux web app (Settings → Authorized Devices → Pair New Device)
//    or /voice-multiplexer:auth-code.  Ask for the least you need.
const { token } = await pairDevice({
  url: "http://localhost:3100",
  code: "123456",
  deviceName: "Calcifer",
  scope: "listen",
});

// 2. Connect, locked to one session.
const relay = new RelayClient({
  url: "http://localhost:3100",
  token,
  lockSessionId: "abc123def456",   // sha256(project dir)[:12]
  subscribeAudio: true,             // receive TTS audio for SpeechPlayer
});
relay.start();

// 3. Play Claude's voice with word-accurate timing.
const player = new SpeechPlayer(relay);
button.onclick = () => player.resume();   // browsers need a user gesture

requestAnimationFrame(function tick() {
  const { word, level } = player.frame();  // current word + loudness 0..1
  mouth.style.height = `${level * 100}%`;
  caption.textContent = word?.word ?? "";
  requestAnimationFrame(tick);
});
```

## Origins

A page on any origin (another port, a sandboxed `null` frame) can use the
relay **with a token**: the WebSocket carries it as a `vmux-token.<jwt>`
subprotocol, REST as `Authorization: Bearer` (CORS is answered for these),
and LiveKit as its room JWT.  Cookies from other origins are ignored, so
nothing rides on the browser's own login.

Only cookie-based use from another origin (embedding the vmux web app
itself, say) needs an allowlist entry in
`~/.claude/voice-multiplexer/voice-multiplexer.env`:

```
VMUX_ALLOWED_ORIGINS=http://localhost:5173
```

Non-browser clients (no `Origin` header) just need a token.

## Without a bundler

The relay serves the SDK as one classic script:

```html
<script src="http://localhost:3100/sdk/vmux-client.js"></script>
<script>
  const { RelayClient, SpeechPlayer } = window.VmuxClient;
</script>
```

(`@vmux/client/voice` isn't in it; bundle that yourself if you need the mic.)

## Scopes

| scope     | can |
|-----------|-----|
| `listen`  | sessions, transcript, agent status, speech events + audio, voice room without a mic |
| `speak`   | + send text, use the mic, stop Claude speaking, answer question cards |
| `control` | + permission prompts, terminal, spawn/kill/restart, model/effort, settings, pairing |

Every relay endpoint and WebSocket message is checked.  Devices paired
before scopes existed (and the web app) have `control`.

## RelayClient

One connection to the relay: reconnects with backoff, rejoins its session,
and keeps a state snapshot.

```ts
relay.getState();          // RelayState: status, liveSessions, connectedSessionId,
                           // transcripts, agentStatus, speech, taskLists, prLists, …
relay.subscribe(onChange); // React: useSyncExternalStore(relay.subscribe, relay.getState)
relay.on("message", m => …);   // every relay message, after it's applied
relay.on("speech", m => …);    // speech_start / speech_chunk / speech_end

relay.connectSession(id);  relay.disconnectSession();
relay.sendText("run the tests");            // speak
relay.interrupt();                          // speak: stop Claude talking
relay.answerQuestion(sid, i, label, ts, isFinal);
relay.answerPermission(sid, "allow");       // control
relay.request("/api/sessions");             // any REST endpoint, authenticated
```

`lockSessionId` makes the client join that session whenever it's online and
ignore every attempt to switch away (including voice "switch to …").

**Transcript entries** are upserted: streamed assistant messages arrive as
several deltas sharing a `message_id`, and the client grows one entry per
message (`appendTranscriptEntry`).

## Speech

For each utterance the relay sends:

| event | fields |
|-------|--------|
| `speech_start` | `utterance_id`, `message_id` (the transcript entry being spoken), `text` (as spoken), `sample_rate` |
| `speech_chunk` | `seq`, `offset_s`, `duration_s`, `words: [{word, start, end}]` (seconds from utterance start) |
| `speech_end`   | `cancelled`, `duration_s` (sent immediately on cancel) |

`relay.getState().speech[sessionId]` keeps the current utterance with all
words so far.

With `subscribeAudio`, the PCM arrives as binary frames (`VMXA` header + JSON
+ 16-bit mono PCM, see `audioFrame.ts`).  **SpeechPlayer** schedules them on
one Web Audio timeline per utterance:

- `on("word", w)` fires as each word is heard; `frame()` gives the current
  word, time into the utterance and loudness, for animation loops.
- `on("start" | "end")` per utterance; a cancelled utterance stops at once.
- `muted: true` keeps timing and loudness running silently (listen-only).
  If another client plays the audio through LiveKit, set `leadInS` to its
  delay: measured locally at 65–103ms (median 83) with
  `examples/sync-probe`, more over a network.
- Words carry `phonemes` (misaki/IPA, e.g. `həlˈO`) when the relay's
  phonemizer is running, for mouth shapes per sound.
- `analyser` is an `AnalyserNode` on the speech, for visualizers.

## Voice (`@vmux/client/voice`)

The session's LiveKit room, for talking by voice:

```ts
import { VoiceClient } from "@vmux/client/voice";
import { VoiceTurn } from "@vmux/client";

const voice = new VoiceClient(relay, { mode: "full", playAgentAudio: false }); // SpeechPlayer plays
await voice.join();
const turn = new VoiceTurn("active");   // mic posture: "active" | "wake" | "muted"
relay.subscribe(() => {
  const s = relay.getState();
  const userTurns = (s.transcripts[s.connectedSessionId ?? ""] ?? []).filter(e => e.speaker === "user").length;
  turn.update(s.agentStatus.state, userTurns);
});
voice.followTurn(turn);                 // mic on during your turn, off during Claude's
```

`mode: "listen"` joins without a mic or playback (needs only `listen`
scope).  `VoiceTurn`/`deriveVoiceState` is the same turn machine the web
app uses: talk-over, wake-word arming, auto-listen.

Several full clients in one room all play Claude's voice; that's allowed.

## Testing

`src/testing/` has a `FakeWebSocket` (play the relay's side) and a
`FakeAudioContext` for unit tests.  Run everything with
`./scripts/test.sh` from the repo root.
