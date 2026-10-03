import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoomEvent, Track, type Room } from "livekit-client";
import { RelayClient } from "../relayClient";
import { VoiceTurn } from "../voiceTurn";
import { FakeAudioContext } from "../testing/fakeAudioContext";
import { FakeWebSocket } from "../testing/fakeWebSocket";
import { VoiceClient } from "./voiceClient";

class FakeMediaStream {
  tracks: unknown[];
  constructor(tracks: unknown[]) {
    this.tracks = tracks;
  }
}

class FakeRoom {
  handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  remoteParticipants = new Map<string, { identity: string; audioTrackPublications: Map<string, unknown> }>();
  connectedWith: [string, string] | null = null;
  disconnected = false;
  localParticipant = { setMicrophoneEnabled: vi.fn(async (enabled: boolean) => void enabled) };
  on(ev: string, fn: (...a: unknown[]) => void) {
    (this.handlers.get(ev) ?? this.handlers.set(ev, new Set()).get(ev)!).add(fn);
    return this;
  }
  off(ev: string, fn: (...a: unknown[]) => void) {
    this.handlers.get(ev)?.delete(fn);
    return this;
  }
  fire(ev: string, ...args: unknown[]) {
    for (const fn of this.handlers.get(ev) ?? []) fn(...args);
  }
  async connect(url: string, token: string) {
    this.connectedWith = [url, token];
  }
  async disconnect() {
    this.disconnected = true;
  }
}

function ctxWithStreams() {
  const ctx = new FakeAudioContext() as FakeAudioContext & { createMediaStreamSource: (s: unknown) => unknown };
  ctx.createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  return ctx;
}

function setup(opts: Partial<ConstructorParameters<typeof VoiceClient>[1]> = {}) {
  const fetch = vi.fn(async (url: string) =>
    url.startsWith("http://localhost:3100/api/token")
      ? new Response(JSON.stringify({ token: "lk", url: "ws://localhost:3100/livekit", room: "vmux_s1", identity: "c" }))
      : new Response("{}"),
  );
  const relay = new RelayClient({ url: "http://localhost:3100", token: "t", fetch, WebSocket: FakeWebSocket as unknown as typeof WebSocket, watchVisibility: false });
  relay.start();
  const ws = FakeWebSocket.last();
  ws.serverOpen("vmux-token.t");
  ws.serverSend({ type: "sessions", sessions: [{ session_id: "s1", name: "p", cwd: "/p", dir_name: "p", room_name: "vmux_s1", connected_clients: [], created_at: 0, last_heartbeat: 0 }] });
  ws.serverSend({ type: "session_connected", session_id: "s1" });
  const room = new FakeRoom();
  const ctx = ctxWithStreams();
  const voice = new VoiceClient(relay, { context: ctx as unknown as AudioContext, createRoom: () => room as unknown as Room, ...opts });
  return { relay, fetch, room, ctx, voice };
}

const agentTrack = { kind: Track.Kind.Audio, mediaStreamTrack: { id: "agent-audio" } };
const agent = { identity: "relay-agent-vmux_s1" };

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal("MediaStream", FakeMediaStream);
});

describe("VoiceClient", () => {
  it("joins the connected session's room with a relay-issued token", async () => {
    const { voice, room, fetch } = setup();
    await voice.join();
    expect(fetch).toHaveBeenCalledWith("http://localhost:3100/api/token?room=vmux_s1", { headers: { Authorization: "Bearer t" } });
    expect(room.connectedWith).toEqual(["ws://localhost:3100/livekit", "lk"]);
    expect(voice.connectedRoom).toBe("vmux_s1");
  });

  it("routes only the relay agent's audio into the analyser", async () => {
    const { voice, room, ctx } = setup();
    const seen: unknown[] = [];
    voice.on("agentTrack", (t) => seen.push(t));
    await voice.join();
    room.fire(RoomEvent.TrackSubscribed, { kind: Track.Kind.Audio, mediaStreamTrack: { id: "other" } }, {}, { identity: "client-abc" });
    room.fire(RoomEvent.TrackSubscribed, agentTrack, {}, agent);
    expect(seen).toEqual([{ id: "agent-audio" }]);
    expect(ctx.createMediaStreamSource).toHaveBeenCalledTimes(1);
    room.fire(RoomEvent.TrackUnsubscribed, agentTrack, {}, agent);
    expect(seen).toEqual([{ id: "agent-audio" }, null]);
  });

  it("listen mode never plays audio and has no mic", async () => {
    const { voice } = setup({ mode: "listen" });
    expect(voice.playsAgentAudio).toBe(false);
    await voice.join();
    await expect(voice.setMicEnabled(true)).rejects.toThrow(/no mic/);
  });

  it("full mode can still leave playback to SpeechPlayer", () => {
    const { voice } = setup({ mode: "full", playAgentAudio: false });
    expect(voice.playsAgentAudio).toBe(false);
  });

  it("follows the voice turn machine for the mic", async () => {
    const { voice, room } = setup();
    await voice.join();
    const turn = new VoiceTurn("active");
    voice.followTurn(turn);
    turn.update("idle", 0);
    turn.update("speaking", 1);
    await Promise.resolve();
    expect(room.localParticipant.setMicrophoneEnabled.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });

  it("leaves cleanly and can rejoin", async () => {
    const { voice, room } = setup();
    await voice.join();
    await voice.leave();
    expect(room.disconnected).toBe(true);
    expect(voice.connectedRoom).toBeNull();
  });
});
