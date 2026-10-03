/**
 * SpeechPlayer: plays Claude's TTS from relay audio frames with Web Audio,
 * so the exact moment every sample (and so every word) is heard is known.
 *
 *   const relay = new RelayClient({ url, token, subscribeAudio: true });
 *   const player = new SpeechPlayer(relay);
 *   await player.resume();                      // after a user gesture
 *   player.on("word", ({ word }) => …);        // fired as each word is heard
 *   requestAnimationFrame(function tick() {     // or poll per frame:
 *     const { word, level } = player.frame();   // current word + loudness 0..1
 *     requestAnimationFrame(tick);
 *   });
 *
 * Muted, it still schedules silently and keeps word timing and loudness
 * running, which is "listen-only" mode: animate alongside another client
 * that's playing the audio.  When that client plays through LiveKit (the
 * vmux web app), its WebRTC jitter buffer delays the sound by roughly
 * 100–500ms; raise `leadInS` to line up.  For exact sync, let SpeechPlayer
 * play the audio itself.
 *
 * Audio subscription: pass `subscribeAudio: true` to RelayClient (or call
 * relay.setAudioSubscribed(true)).
 */
import type { AudioFrame } from "./audioFrame";
import { Emitter } from "./emitter";
import type { SpeechMessage, SpokenWord } from "./protocol";
import type { RelayClient } from "./relayClient";

export interface SpeechPlayerOptions {
  /** Use an existing AudioContext (default: a new one). */
  context?: AudioContext;
  /** Where audible output goes (default: context.destination). */
  destination?: AudioNode;
  /** Start muted (listen-only). */
  muted?: boolean;
  /** Delay before the first frame of an utterance plays, to absorb jitter (s). Default 0.08. */
  leadInS?: number;
  /** Only play this session's speech (default: the relay's connected session). */
  sessionId?: () => string | null;
}

export interface SpokenWordEvent extends SpokenWord {
  index: number;
  utteranceId: string;
  messageId: string | null;
}

export interface SpeechFrame {
  /** Utterance currently audible, if any. */
  utteranceId: string | null;
  /** Seconds into that utterance. */
  t: number | null;
  word: SpokenWordEvent | null;
  /** Loudness of the audible speech, 0..1. */
  level: number;
}

export interface SpeechPlayerEvents extends Record<string, unknown> {
  /** First audio of an utterance starts playing. */
  start: { utteranceId: string; messageId: string | null; text: string };
  word: SpokenWordEvent;
  /** Playback finished (or was cancelled). */
  end: { utteranceId: string; cancelled: boolean };
}

interface Utterance {
  id: string;
  messageId: string | null;
  text: string;
  sessionId: string;
  /** Context time at which sample 0 of the utterance plays. */
  t0: number | null;
  words: SpokenWordEvent[];
  sources: AudioBufferSourceNode[];
  timers: ReturnType<typeof setTimeout>[];
  /** Context time when the last scheduled sample finishes. */
  endsAt: number;
  serverEnded: boolean;
  done: boolean;
}

export class SpeechPlayer extends Emitter<SpeechPlayerEvents> {
  readonly context: AudioContext;
  /** Speech loudness analyser (pre-mute), for visualizers. */
  readonly analyser: AnalyserNode;
  private gain: GainNode;
  private utterances = new Map<string, Utterance>();
  private opts: SpeechPlayerOptions;
  private relay: RelayClient;
  private offs: Array<() => void> = [];
  private levelBuf: Float32Array<ArrayBuffer>;

  constructor(relay: RelayClient, opts: SpeechPlayerOptions = {}) {
    super();
    this.relay = relay;
    this.opts = opts;
    this.context = opts.context ?? new AudioContext();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 512;
    this.gain = this.context.createGain();
    this.gain.gain.value = opts.muted ? 0 : 1;
    this.analyser.connect(this.gain);
    this.gain.connect(opts.destination ?? this.context.destination);
    this.levelBuf = new Float32Array(this.analyser.fftSize);
    this.offs.push(
      relay.on("speech", (m) => this.onSpeech(m)),
      relay.on("audio", (f) => this.onAudio(f)),
    );
  }

  /** Browsers start audio suspended until a user gesture; call from one. */
  resume(): Promise<void> {
    return this.context.resume();
  }

  setMuted(muted: boolean): void {
    this.gain.gain.value = muted ? 0 : 1;
  }

  /** Stop everything now (e.g. the user talks over Claude). */
  stopAll(): void {
    for (const u of this.utterances.values()) this.finish(u, true);
  }

  dispose(): void {
    this.stopAll();
    for (const off of this.offs) off();
    this.offs = [];
    this.analyser.disconnect();
    this.gain.disconnect();
  }

  /** What's audible right now — call once per animation frame. */
  frame(): SpeechFrame {
    const now = this.context.currentTime;
    const u = this.audible(now);
    const t = u && u.t0 != null ? now - u.t0 : null;
    let word: SpokenWordEvent | null = null;
    if (u && t != null) {
      for (const w of u.words) {
        if (t >= w.start && t < w.end) {
          word = w;
          break;
        }
      }
    }
    return { utteranceId: u?.id ?? null, t, word, level: u ? this.level() : 0 };
  }

  /** RMS loudness of the speech signal, scaled to roughly 0..1. */
  level(): number {
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let sum = 0;
    for (let i = 0; i < this.levelBuf.length; i++) sum += this.levelBuf[i] * this.levelBuf[i];
    return Math.min(1, Math.sqrt(sum / this.levelBuf.length) * 4);
  }

  // --- internals ---------------------------------------------------------------------

  private wantSession(sessionId: string): boolean {
    const want = this.opts.sessionId ? this.opts.sessionId() : this.relay.getState().connectedSessionId;
    return !want || want === sessionId;
  }

  private audible(now: number): Utterance | null {
    for (const u of this.utterances.values()) {
      if (!u.done && u.t0 != null && now >= u.t0 && now < u.endsAt) return u;
    }
    return null;
  }

  private onSpeech(m: SpeechMessage) {
    if (!this.wantSession(m.session_id)) return;
    if (m.type === "speech_start") {
      this.utterances.set(m.utterance_id, {
        id: m.utterance_id,
        messageId: m.message_id,
        text: m.text,
        sessionId: m.session_id,
        t0: null,
        words: [],
        sources: [],
        timers: [],
        endsAt: 0,
        serverEnded: false,
        done: false,
      });
      return;
    }
    const u = this.utterances.get(m.utterance_id);
    if (!u || u.done) return;
    if (m.type === "speech_chunk") {
      for (const w of m.words) {
        const ev: SpokenWordEvent = { ...w, index: u.words.length, utteranceId: u.id, messageId: u.messageId };
        u.words.push(ev);
        this.scheduleWord(u, ev);
      }
    } else if (m.type === "speech_end") {
      u.serverEnded = true;
      if (m.cancelled) this.finish(u, true);
      else this.scheduleFinish(u);
    }
  }

  private onAudio(frame: AudioFrame) {
    const h = frame.header;
    if (!this.wantSession(h.session_id)) return;
    const u = this.utterances.get(h.utterance_id);
    if (!u || u.done || frame.samples.length === 0) return;

    const ctx = this.context;
    const now = ctx.currentTime;
    const offsetS = h.offset_samples / h.sample_rate;
    if (u.t0 == null) {
      u.t0 = now + (this.opts.leadInS ?? 0.08) - offsetS;
      this.emit("start", { utteranceId: u.id, messageId: u.messageId, text: u.text });
      for (const w of u.words) this.scheduleWord(u, w);
    } else if (u.t0 + offsetS < now) {
      // Fell behind (network stall): shift the timeline so audio and words stay together.
      u.t0 = now + 0.02 - offsetS;
    }

    const buffer = ctx.createBuffer(1, frame.samples.length, h.sample_rate);
    buffer.getChannelData(0).set(frame.samples);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.analyser);
    const at = u.t0 + offsetS;
    src.start(at);
    u.sources.push(src);
    u.endsAt = Math.max(u.endsAt, at + buffer.duration);
    if (u.serverEnded) this.scheduleFinish(u);
  }

  private scheduleWord(u: Utterance, w: SpokenWordEvent) {
    if (u.t0 == null) return; // scheduled once audio anchors the timeline
    const delayMs = (u.t0 + w.start - this.context.currentTime) * 1000;
    if (delayMs < -50) return; // already past
    u.timers.push(setTimeout(() => !u.done && this.emit("word", w), Math.max(0, delayMs)));
  }

  private finishTimer: Map<string, ReturnType<typeof setTimeout>> = new Map();

  private scheduleFinish(u: Utterance) {
    clearTimeout(this.finishTimer.get(u.id));
    const delayMs = Math.max(0, (u.endsAt - this.context.currentTime) * 1000);
    this.finishTimer.set(u.id, setTimeout(() => this.finish(u, false), delayMs));
  }

  private finish(u: Utterance, cancelled: boolean) {
    if (u.done) return;
    u.done = true;
    clearTimeout(this.finishTimer.get(u.id));
    this.finishTimer.delete(u.id);
    for (const t of u.timers) clearTimeout(t);
    if (cancelled) {
      for (const s of u.sources) {
        try {
          s.stop();
        } catch {
          // not started yet / already stopped
        }
      }
    }
    this.utterances.delete(u.id);
    this.emit("end", { utteranceId: u.id, cancelled });
  }
}
