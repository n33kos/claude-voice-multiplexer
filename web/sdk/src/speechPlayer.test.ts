import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAudioFrame } from "./audioFrame";
import { RelayClient } from "./relayClient";
import { SpeechPlayer } from "./speechPlayer";
import { FakeAudioContext } from "./testing/fakeAudioContext";
import { FakeWebSocket } from "./testing/fakeWebSocket";

const SR = 24000;

function setup(playerOpts = {}) {
  const relay = new RelayClient({
    url: "http://localhost:3100",
    fetch: vi.fn(async () => new Response("{}")),
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    watchVisibility: false,
    subscribeAudio: true,
  });
  relay.start();
  const ws = FakeWebSocket.last();
  ws.serverOpen();
  ws.serverSend({ type: "session_connected", session_id: "s1" });
  const ctx = new FakeAudioContext();
  const player = new SpeechPlayer(relay, { context: ctx as unknown as AudioContext, ...playerOpts });
  return { relay, ws, ctx, player };
}

function frame(utteranceId: string, offsetSamples: number, samples: number, sessionId = "s1") {
  return encodeAudioFrame(
    { session_id: sessionId, utterance_id: utteranceId, seq: 0, offset_samples: offsetSamples, sample_rate: SR, channels: 1, format: "s16le" },
    new Int16Array(samples),
  );
}

const start = (id = "u1", sessionId = "s1") => ({
  type: "speech_start", session_id: sessionId, utterance_id: id, message_id: "m1", text: "Hello there.", sample_rate: SR,
});

beforeEach(() => {
  FakeWebSocket.reset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("SpeechPlayer", () => {
  it("schedules frames on one timeline anchored at the first frame plus lead-in", () => {
    const { ws, ctx, player } = setup({ leadInS: 0.1 });
    const starts: string[] = [];
    player.on("start", (e) => starts.push(e.utteranceId));
    ctx.currentTime = 5;
    ws.serverSend(start());
    ws.serverSendBinary(frame("u1", 0, SR)); // 1s
    ctx.currentTime = 5.5;
    ws.serverSendBinary(frame("u1", SR, SR / 2)); // next 0.5s
    expect(ctx.sources.map((s) => s.startedAt)).toEqual([5.1, 6.1]);
    expect(starts).toEqual(["u1"]);
  });

  it("emits words when they're heard and reports the current word", () => {
    const { ws, ctx, player } = setup({ leadInS: 0.1 });
    const heard: string[] = [];
    player.on("word", (w) => heard.push(w.word));
    ws.serverSend(start());
    ws.serverSend({
      type: "speech_chunk", session_id: "s1", utterance_id: "u1", seq: 0, offset_s: 0, duration_s: 1,
      words: [{ word: "Hello", start: 0.0, end: 0.4 }, { word: "there", start: 0.5, end: 0.9 }],
    });
    ws.serverSendBinary(frame("u1", 0, SR));
    expect(heard).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(heard).toEqual(["Hello"]);
    vi.advanceTimersByTime(500);
    expect(heard).toEqual(["Hello", "there"]);

    ctx.currentTime = 0.1 + 0.6; // 0.6s into the utterance
    const f = player.frame();
    expect(f.utteranceId).toBe("u1");
    expect(f.t).toBeCloseTo(0.6);
    expect(f.word?.word).toBe("there");
    expect(f.word?.messageId).toBe("m1");
  });

  it("reports loudness only while speech is audible", () => {
    const { ws, ctx, player } = setup({ leadInS: 0 });
    ctx.analysers[0].amplitude = 0.1;
    expect(player.frame().level).toBe(0);
    ws.serverSend(start());
    ws.serverSendBinary(frame("u1", 0, SR));
    ctx.currentTime = 0.5;
    expect(player.frame().level).toBeCloseTo(0.4);
  });

  it("stops scheduled audio immediately on a cancelled end", () => {
    const { ws, ctx, player } = setup();
    const ends: Array<[string, boolean]> = [];
    player.on("end", (e) => ends.push([e.utteranceId, e.cancelled]));
    ws.serverSend(start());
    ws.serverSendBinary(frame("u1", 0, SR * 3));
    ws.serverSend({ type: "speech_end", session_id: "s1", utterance_id: "u1", cancelled: true, duration_s: 3 });
    expect(ctx.sources[0].stopped).toBe(true);
    expect(ends).toEqual([["u1", true]]);
    expect(player.frame().utteranceId).toBeNull();
  });

  it("ends normally once the last scheduled sample has played", () => {
    const { ws, ctx, player } = setup({ leadInS: 0 });
    const ends: Array<[string, boolean]> = [];
    player.on("end", (e) => ends.push([e.utteranceId, e.cancelled]));
    ws.serverSend(start());
    ws.serverSendBinary(frame("u1", 0, SR * 2));
    ws.serverSend({ type: "speech_end", session_id: "s1", utterance_id: "u1", cancelled: false, duration_s: 2 });
    vi.advanceTimersByTime(1900);
    expect(ends).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(ends).toEqual([["u1", false]]);
    expect(ctx.sources[0].stopped).toBe(false);
  });

  it("re-anchors after a stall so words stay with the audio", () => {
    const { ws, ctx } = setup({ leadInS: 0 });
    ws.serverSend(start());
    ws.serverSendBinary(frame("u1", 0, SR)); // t0 = 0, plays 0..1
    ctx.currentTime = 3; // next frame (offset 1s) arrives 2s late
    ws.serverSendBinary(frame("u1", SR, SR));
    expect(ctx.sources[1].startedAt).toBeCloseTo(3.02);
  });

  it("only plays the connected session's speech", () => {
    const { ws, ctx } = setup();
    ws.serverSend(start("u9", "other"));
    ws.serverSendBinary(frame("u9", 0, SR, "other"));
    expect(ctx.sources).toHaveLength(0);
  });

  it("mutes output without stopping analysis (listen-only)", () => {
    const { player, ctx } = setup({ muted: true });
    void ctx;
    // gain is the node between analyser and destination
    const gain = (player as unknown as { gain: { gain: { value: number } } }).gain;
    expect(gain.gain.value).toBe(0);
    player.setMuted(false);
    expect(gain.gain.value).toBe(1);
  });
});
