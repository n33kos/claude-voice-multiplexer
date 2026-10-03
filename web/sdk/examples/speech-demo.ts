/**
 * Minimal SDK consumer: follow one session and animate a face to Claude's
 * speech with word-accurate timing.
 *
 *   cd web && npm run dev
 *   open http://localhost:5173/sdk/examples/speech-demo.html#session=<id>&token=<token>
 *
 * The Vite dev server proxies /api and /ws to the relay, so the page is
 * same-origin.  Get a token with pairDevice() (scope "listen" is enough).
 */
import { RelayClient, SpeechPlayer } from "@vmux/client";

const params = new URLSearchParams(location.hash.slice(1));
const sessionId = params.get("session");
const token = params.get("token");

const $ = (id: string) => document.getElementById(id)!;
const face = $("face");
const wordEl = $("word");
const caption = $("caption");
const status = $("status");

const relay = new RelayClient({ token, lockSessionId: sessionId, subscribeAudio: true });
const player = new SpeechPlayer(relay);
relay.start();

$("start").addEventListener("click", () => void player.resume());

relay.subscribe(() => {
  const s = relay.getState();
  status.textContent = `${s.status} · session ${s.connectedSessionId ?? "—"} · ${s.agentStatus.state}`;
});

// Lay out the utterance as words; highlight as each is heard.
// (Words arrive with speech_chunk, just before that chunk's audio.)
let spans: HTMLSpanElement[] = [];
relay.on("speech", (m) => {
  if (m.type === "speech_start") {
    caption.textContent = "";
    spans = [];
    return;
  }
  if (m.type !== "speech_chunk") return;
  for (const w of m.words) {
    if (!/\w/.test(w.word)) continue; // punctuation tokens
    const span = document.createElement("span");
    span.textContent = w.word + " ";
    caption.appendChild(span);
    spans.push(span);
  }
});

let spokenIndex = -1;
player.on("word", (w) => {
  if (!/\w/.test(w.word)) return;
  spokenIndex++;
  spans.forEach((s, i) => s.classList.toggle("said", i < spokenIndex));
  spans[spokenIndex - 1]?.classList.remove("now");
  spans[spokenIndex]?.classList.add("now");
  wordEl.textContent = w.word;
});
player.on("end", () => {
  spokenIndex = -1;
  wordEl.textContent = "";
  spans.forEach((s) => s.classList.add("said"));
});

requestAnimationFrame(function tick() {
  face.style.setProperty("--level", String(player.frame().level));
  requestAnimationFrame(tick);
});

// Handy for poking at the SDK from devtools.
(window as unknown as Record<string, unknown>).vmuxDemo = { relay, player };
