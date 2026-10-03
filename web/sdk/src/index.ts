/**
 * @vmux/client — build a UI on the Claude Voice Multiplexer relay.
 *
 * - RelayClient: sessions, transcript, agent status, speech events, commands
 * - SpeechPlayer: play relay TTS audio with exact word timing (Web Audio)
 * - VoiceClient: the session's LiveKit voice room (mic + Claude's voice)
 * - deriveVoiceState / VoiceTurn: the shared turn + mic state machine
 *
 * See README.md.
 */
export * from "./protocol";
export * from "./relayState";
export * from "./transcript";
export { RelayClient, pairDevice } from "./relayClient";
export type { DeviceScope, PairResult, RelayClientEvents, RelayClientOptions } from "./relayClient";
export { decodeAudioFrame, encodeAudioFrame } from "./audioFrame";
export type { AudioFrame, AudioFrameHeader } from "./audioFrame";
export { Emitter } from "./emitter";
export { SpeechPlayer } from "./speechPlayer";
export type { SpeechFrame, SpeechPlayerEvents, SpeechPlayerOptions, SpokenWordEvent } from "./speechPlayer";
export { deriveVoiceState, VoiceTurn } from "./voiceTurn";
export type { DerivedVoiceState, MicMode, VoicePhase, VoiceTurnState } from "./voiceTurn";
