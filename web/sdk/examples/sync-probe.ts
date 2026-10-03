/**
 * Dev tool: how far behind the relay's direct audio (SpeechPlayer) does
 * LiveKit playback run?  Both streams are analysed in one page and their
 * speech onsets compared on performance.now().  Use the result to set a
 * listen-only UI's lead-in (e.g. Calcifer's feedDelay).
 *
 *   npm run dev -- --port 5199
 *   open http://localhost:5199/sdk/examples/sync-probe.html#session=<id>&token=<listen token>
 */
import { RelayClient, SpeechPlayer } from "@vmux/client";
import { VoiceClient } from "@vmux/client/voice";

const params = new URLSearchParams(location.hash.slice(1));
const out = document.getElementById("out")!;
const relay = new RelayClient({ token: params.get("token"), lockSessionId: params.get("session"), subscribeAudio: true });
const ctx = new AudioContext();
const player = new SpeechPlayer(relay, { context: ctx, muted: true, leadInS: 0 });
const voice = new VoiceClient(relay, { mode: "listen", context: ctx });
relay.start();
void ctx.resume();

const THRESH = 0.03;
const results: number[] = [];
let wsOnset: number | null = null;
let lkOnset: number | null = null;
let armed = false;

relay.on("speech", (m) => {
  if (m.type === "speech_start") {
    armed = true;
    wsOnset = lkOnset = null;
  }
});
relay.on("message", (m) => {
  if (m.type === "session_connected" && !voice.connectedRoom) void voice.join();
});

function poll() {
  if (armed) {
    const now = performance.now();
    if (wsOnset === null && player.level() > THRESH) wsOnset = now;
    if (lkOnset === null && voice.agentLevel() > THRESH) lkOnset = now;
    if (wsOnset !== null && lkOnset !== null) {
      results.push(lkOnset - wsOnset);
      armed = false;
      const sorted = [...results].sort((a, b) => a - b);
      out.textContent = `LiveKit lags direct audio by (ms): ${results.map((r) => r.toFixed(0)).join(", ")}\nmedian ${sorted[Math.floor(sorted.length / 2)].toFixed(0)}`;
      (window as unknown as Record<string, unknown>).syncResults = results;
    }
  }
  setTimeout(poll, 2);
}
poll();
