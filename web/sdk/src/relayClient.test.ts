/**
 * RelayClient features beyond what the web app's characterization tests
 * cover: explicit-token auth, remote URLs, speech events, audio frames,
 * session locking via options, and lifecycle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "./testing/fakeWebSocket";
import { encodeAudioFrame } from "./audioFrame";
import { RelayClient } from "./relayClient";

const WS = FakeWebSocket as unknown as typeof WebSocket;

function okFetch() {
  return vi.fn(async () => new Response(JSON.stringify({ metadata: [] }), { status: 200 }));
}

beforeEach(() => FakeWebSocket.reset());
afterEach(() => vi.useRealTimers());

describe("auth and URLs", () => {
  it("sends an explicit token as a subprotocol and as a Bearer header", async () => {
    const fetch = okFetch();
    const relay = new RelayClient({ url: "http://localhost:3100/", token: "tok", fetch, WebSocket: WS, watchVisibility: false });
    relay.start();
    const ws = FakeWebSocket.last();
    expect(ws.url).toBe("ws://localhost:3100/ws/client");
    expect(ws.protocols).toEqual(["vmux-token.tok"]);
    ws.serverOpen("vmux-token.tok");
    await relay.killSession("s1");
    expect(fetch).toHaveBeenCalledWith("http://localhost:3100/api/sessions/s1", {
      method: "DELETE",
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("can keep cookie auth for the WebSocket while using a token for REST", () => {
    const relay = new RelayClient({ url: "https://relay.example", token: () => "tok", wsAuth: "cookie", fetch: okFetch(), WebSocket: WS, watchVisibility: false });
    relay.start();
    expect(FakeWebSocket.last().url).toBe("wss://relay.example/ws/client");
    expect(FakeWebSocket.last().protocols).toEqual([]);
  });

  it("stops reconnecting on auth (4001) and origin (4003) rejections", () => {
    vi.useFakeTimers();
    for (const code of [4001, 4003]) {
      FakeWebSocket.reset();
      const relay = new RelayClient({ url: "http://localhost:3100", fetch: okFetch(), WebSocket: WS, watchVisibility: false });
      relay.start();
      FakeWebSocket.last().serverClose(code);
      vi.advanceTimersByTime(60_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
    }
  });

  it("stop() closes the socket without reconnecting", () => {
    vi.useFakeTimers();
    const relay = new RelayClient({ url: "http://localhost:3100", fetch: okFetch(), WebSocket: WS, watchVisibility: false });
    relay.start();
    FakeWebSocket.last().serverOpen();
    relay.stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(relay.getState().status).toBe("disconnected");
  });

  it("a stop/start cycle (React StrictMode) leaves exactly one live connection", () => {
    vi.useFakeTimers();
    const relay = new RelayClient({ url: "http://localhost:3100", fetch: okFetch(), WebSocket: WS, watchVisibility: false });
    relay.start();
    const first = FakeWebSocket.last();
    relay.stop();
    relay.start();
    const second = FakeWebSocket.last();
    second.serverOpen();
    first.serverClose(1006); // late close from the replaced socket
    first.serverSend({ type: "sessions", sessions: [] }); // and a stray message
    expect(relay.getState().status).toBe("connected");
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("drops commands while not connected instead of throwing", () => {
    const relay = new RelayClient({ url: "http://localhost:3100", fetch: okFetch(), WebSocket: WS, watchVisibility: false });
    relay.start();
    expect(relay.send({ type: "interrupt" })).toBe(false);
  });
});

describe("speech", () => {
  function connected(opts = {}) {
    const relay = new RelayClient({ url: "http://localhost:3100", fetch: okFetch(), WebSocket: WS, watchVisibility: false, ...opts });
    relay.start();
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    ws.serverSend({ type: "session_connected", session_id: "s1" });
    return { relay, ws };
  }

  it("tracks the current utterance and its words", () => {
    const { relay, ws } = connected();
    const events: string[] = [];
    relay.on("speech", (m) => events.push(m.type));
    ws.serverSend({ type: "speech_start", session_id: "s1", utterance_id: "u1", message_id: "m1", text: "Hi there.", sample_rate: 24000 });
    ws.serverSend({ type: "speech_chunk", session_id: "s1", utterance_id: "u1", seq: 0, offset_s: 0, duration_s: 1.2, words: [{ word: "Hi", start: 0, end: 0.3 }] });
    ws.serverSend({ type: "speech_chunk", session_id: "s1", utterance_id: "u1", seq: 1, offset_s: 1.2, duration_s: 0.8, words: [{ word: "there", start: 1.3, end: 1.6 }] });
    expect(relay.getState().speech.s1).toEqual({
      utteranceId: "u1",
      messageId: "m1",
      text: "Hi there.",
      words: [
        { word: "Hi", start: 0, end: 0.3 },
        { word: "there", start: 1.3, end: 1.6 },
      ],
      durationS: 2,
      ended: false,
      cancelled: false,
    });
    ws.serverSend({ type: "speech_end", session_id: "s1", utterance_id: "u1", cancelled: true, duration_s: 2 });
    expect(relay.getState().speech.s1).toMatchObject({ ended: true, cancelled: true });
    expect(events).toEqual(["speech_start", "speech_chunk", "speech_chunk", "speech_end"]);
  });

  it("ignores chunks for an utterance it didn't see start", () => {
    const { relay, ws } = connected();
    ws.serverSend({ type: "speech_chunk", session_id: "s1", utterance_id: "zz", seq: 0, offset_s: 0, duration_s: 1, words: [] });
    expect(relay.getState().speech.s1).toBeUndefined();
  });

  it("subscribes to audio on open (and again after reconnect) and decodes frames", () => {
    vi.useFakeTimers();
    const { relay, ws } = connected({ subscribeAudio: true });
    expect(ws.sentJson).toContainEqual({ type: "audio_subscribe", enabled: true });
    const frames: number[] = [];
    relay.on("audio", (f) => frames.push(f.samples.length));
    const header = { session_id: "s1", utterance_id: "u1", seq: 0, offset_samples: 0, sample_rate: 24000, channels: 1, format: "s16le" as const };
    ws.serverSendBinary(encodeAudioFrame(header, new Int16Array([0, 16384, -16384])));
    expect(frames).toEqual([3]);

    ws.serverClose();
    vi.advanceTimersByTime(1000);
    const ws2 = FakeWebSocket.last();
    ws2.serverOpen();
    expect(ws2.sentJson).toContainEqual({ type: "audio_subscribe", enabled: true });
  });
});

describe("locking via options", () => {
  it("refuses to connect to or leave anything but the locked session", () => {
    const relay = new RelayClient({ url: "http://localhost:3100", lockSessionId: "s1", fetch: okFetch(), WebSocket: WS, watchVisibility: false });
    relay.start();
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    relay.connectSession("s2");
    relay.disconnectSession();
    expect(ws.sentJson.filter((m) => m.type !== "pong")).toEqual([{ type: "connect_session", session_id: "s1" }]);
  });
});
