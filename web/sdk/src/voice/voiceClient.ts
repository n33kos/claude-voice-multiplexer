/**
 * VoiceClient: a session's LiveKit voice room — the user's mic in, Claude's
 * voice out — for UIs that talk to Claude.
 *
 *   import { VoiceClient } from "@vmux/client/voice";
 *   const voice = new VoiceClient(relay, { mode: "full" });
 *   await voice.join();                       // the relay's connected session
 *   voice.followTurn(turn);                   // mic follows the VoiceTurn machine
 *
 * Modes:
 *   - "full":   publishes the mic, plays Claude's voice.
 *   - "listen": joins without a mic and without playing; only exposes
 *               Claude's audio track and its loudness (agentLevel()).
 *
 * For word-accurate timing (lip sync), prefer SpeechPlayer: it plays the
 * relay's audio itself so every word's moment is known.  A "full" UI that
 * uses SpeechPlayer for output can join here with `playAgentAudio: false`
 * to keep only the mic.
 *
 * Separate entry point because it depends on `livekit-client` (a peer
 * dependency of @vmux/client).
 */
import { Room, RoomEvent, Track, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication } from "livekit-client";
import { Emitter } from "../emitter";
import type { RelayClient } from "../relayClient";
import type { VoiceTurn } from "../voiceTurn";

export type VoiceMode = "full" | "listen";

export interface VoiceClientOptions {
  mode?: VoiceMode;
  /** Play Claude's voice from the room (default: true in "full", always false in "listen"). */
  playAgentAudio?: boolean;
  /** AudioContext for playback/analysis (default: a new one). */
  context?: AudioContext;
  /** The relay's TTS participant identity prefix. */
  agentIdentityPrefix?: string;
  /** LiveKit Room factory (tests). */
  createRoom?: () => Room;
}

export interface VoiceClientEvents extends Record<string, unknown> {
  connected: { room: string };
  disconnected: void;
  /** Claude's audio track appeared or went away. */
  agentTrack: MediaStreamTrack | null;
  micEnabled: boolean;
}

export class VoiceClient extends Emitter<VoiceClientEvents> {
  readonly mode: VoiceMode;
  readonly context: AudioContext;
  /** Loudness of Claude's voice as received from the room. */
  readonly agentAnalyser: AnalyserNode;
  private relay: RelayClient;
  private opts: VoiceClientOptions;
  private room: Room | null = null;
  private roomName: string | null = null;
  private agentSource: MediaStreamAudioSourceNode | null = null;
  private outputGain: GainNode;
  private turnOff: (() => void) | null = null;
  private levelBuf: Float32Array<ArrayBuffer>;

  constructor(relay: RelayClient, opts: VoiceClientOptions = {}) {
    super();
    this.relay = relay;
    this.opts = opts;
    this.mode = opts.mode ?? "full";
    this.context = opts.context ?? new AudioContext();
    this.agentAnalyser = this.context.createAnalyser();
    this.agentAnalyser.fftSize = 512;
    this.outputGain = this.context.createGain();
    this.outputGain.gain.value = this.playsAgentAudio ? 1 : 0;
    this.agentAnalyser.connect(this.outputGain);
    this.outputGain.connect(this.context.destination);
    this.levelBuf = new Float32Array(this.agentAnalyser.fftSize);
  }

  get playsAgentAudio(): boolean {
    return this.mode === "full" && (this.opts.playAgentAudio ?? true);
  }

  get connectedRoom(): string | null {
    return this.roomName;
  }

  /** Join the voice room of `sessionId` (default: the relay's connected session). */
  async join(sessionId?: string): Promise<void> {
    const sid = sessionId ?? this.relay.getState().connectedSessionId;
    if (!sid) throw new Error("VoiceClient.join: no session (connect the RelayClient to one first)");
    const listed = this.relay.getState().liveSessions.find((s) => s.session_id === sid);
    const roomName = listed?.room_name ?? `vmux_${sid}`;
    if (this.room && this.roomName === roomName) return;
    await this.leave();

    const { token, url } = await this.relay.fetchVoiceToken(roomName);
    const room = this.opts.createRoom ? this.opts.createRoom() : new Room();
    this.room = room;
    this.roomName = roomName;
    room.on(RoomEvent.TrackSubscribed, this.onTrackSubscribed);
    room.on(RoomEvent.TrackUnsubscribed, this.onTrackUnsubscribed);
    room.on(RoomEvent.Disconnected, this.onDisconnected);
    await room.connect(url, token, { autoSubscribe: true });
    // Tracks already in the room when we joined.
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.audioTrackPublications.values()) {
        if (pub.track) this.onTrackSubscribed(pub.track as RemoteTrack, pub as RemoteTrackPublication, p);
      }
    }
    this.emit("connected", { room: roomName });
  }

  async leave(): Promise<void> {
    const room = this.room;
    if (!room) return;
    this.room = null;
    this.roomName = null;
    this.setAgentTrack(null);
    room.off(RoomEvent.TrackSubscribed, this.onTrackSubscribed);
    room.off(RoomEvent.TrackUnsubscribed, this.onTrackUnsubscribed);
    room.off(RoomEvent.Disconnected, this.onDisconnected);
    await room.disconnect();
    this.emit("disconnected", undefined);
  }

  /** Turn the published mic on/off ("full" mode only). */
  async setMicEnabled(enabled: boolean): Promise<void> {
    if (this.mode !== "full") throw new Error(`VoiceClient: no mic in "${this.mode}" mode`);
    if (!this.room) return;
    await this.room.localParticipant.setMicrophoneEnabled(enabled);
    this.emit("micEnabled", enabled);
  }

  /** Keep the mic in step with a VoiceTurn (micShouldBeLive). Returns an unsubscribe. */
  followTurn(turn: VoiceTurn): () => void {
    this.turnOff?.();
    const apply = () => {
      if (this.room) void this.setMicEnabled(turn.state.micShouldBeLive);
    };
    const off = turn.on("change", apply);
    apply();
    this.turnOff = off;
    return off;
  }

  setSpeakerMuted(muted: boolean): void {
    this.outputGain.gain.value = muted || !this.playsAgentAudio ? 0 : 1;
  }

  /** Loudness of Claude's received voice, roughly 0..1. */
  agentLevel(): number {
    this.agentAnalyser.getFloatTimeDomainData(this.levelBuf);
    let sum = 0;
    for (let i = 0; i < this.levelBuf.length; i++) sum += this.levelBuf[i] * this.levelBuf[i];
    return Math.min(1, Math.sqrt(sum / this.levelBuf.length) * 4);
  }

  // --- internals ----------------------------------------------------------------------

  private isAgent(p: RemoteParticipant): boolean {
    return p.identity.startsWith(this.opts.agentIdentityPrefix ?? "relay-agent");
  }

  private onTrackSubscribed = (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
    if (track.kind !== Track.Kind.Audio || !this.isAgent(participant)) return;
    this.setAgentTrack(track.mediaStreamTrack);
  };

  private onTrackUnsubscribed = (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
    if (track.kind !== Track.Kind.Audio || !this.isAgent(participant)) return;
    this.setAgentTrack(null);
  };

  private onDisconnected = () => {
    this.room = null;
    this.roomName = null;
    this.setAgentTrack(null);
    this.emit("disconnected", undefined);
  };

  private sinkElement: HTMLAudioElement | null = null;

  private setAgentTrack(track: MediaStreamTrack | null) {
    this.agentSource?.disconnect();
    this.agentSource = null;
    if (this.sinkElement) this.sinkElement.srcObject = null;
    if (track) {
      // Audio plays through Web Audio (analyser → gain → output), so "listen"
      // mode and speaker mute are just gain 0.  Chrome only feeds a remote
      // WebRTC stream into Web Audio while it's also attached to a media
      // element, so attach it to a muted one (as the web app does).
      const stream = new MediaStream([track]);
      if (typeof Audio !== "undefined") {
        this.sinkElement ??= new Audio();
        this.sinkElement.muted = true;
        this.sinkElement.srcObject = stream;
        void this.sinkElement.play?.()?.catch?.(() => {});
      }
      this.agentSource = this.context.createMediaStreamSource(stream);
      this.agentSource.connect(this.agentAnalyser);
      if (this.context.state === "suspended") void this.context.resume();
    }
    this.emit("agentTrack", track);
  }
}
