import { useEffect, useRef } from "react";
import {
  LiveKitRoom,
  useTracks,
} from "@livekit/components-react";
import { Track } from "livekit-client";
import type { VoiceControlsProps } from "./VoiceControls.types";
import { MicControls } from "./components/MicControls/MicControls";
import styles from "./VoiceControls.module.scss";

const AGENT_IDENTITY_PREFIX = "relay-agent";

/**
 * Only renders audio from the relay agent participant, ignoring other
 * clients in the room. This prevents feedback when multiple devices
 * are connected to the same session nearby.
 */
function AgentAudioRenderer({ muted }: { muted: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const gainRef = useRef<GainNode | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const tracks = useTracks([Track.Source.Microphone]);

  const agentTrack = tracks.find(
    (t) =>
      !t.participant.isLocal &&
      t.participant.identity.startsWith(AGENT_IDENTITY_PREFIX),
  );

  useEffect(() => {
    const el = audioRef.current;
    const mediaTrack = agentTrack?.publication.track?.mediaStreamTrack;
    if (!el || !mediaTrack) {
      if (el) el.srcObject = null;
      return;
    }

    // Route audio through Web Audio API GainNode.
    // This changes the iOS audio category so hardware volume buttons work,
    // and gives us programmatic mute control via gain.
    const stream = new MediaStream([mediaTrack]);
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    source.connect(gain);
    gain.connect(ctx.destination);
    ctxRef.current = ctx;
    gainRef.current = gain;

    // Also attach to audio element to keep WebRTC session active on iOS
    el.srcObject = stream;
    el.muted = true; // Silence the element — audio plays through gain node

    if (ctx.state === "suspended") ctx.resume();

    return () => {
      source.disconnect();
      gain.disconnect();
      ctx.close();
      ctxRef.current = null;
      gainRef.current = null;
    };
  }, [agentTrack?.publication.track?.mediaStreamTrack]);

  // Mute by zeroing the gain node
  useEffect(() => {
    if (gainRef.current) {
      gainRef.current.gain.value = muted ? 0 : 1;
    }
    if (ctxRef.current?.state === "suspended") ctxRef.current.resume();
  }, [muted]);

  return <audio ref={audioRef} autoPlay />;
}

export function VoiceControls({
  token,
  serverUrl,
  agentStatus,
  autoListen,
  speakerMuted,
  showStatusPill,
  onAutoListenChange,
  onSpeakerMutedChange,
  onConnected,
  onDisconnected,
  onInterrupt,
}: VoiceControlsProps) {
  return (
    <div className={styles.Root}>
      <LiveKitRoom
        token={token}
        serverUrl={serverUrl}
        connect={true}
        audio={autoListen}
        video={false}
        onConnected={onConnected}
        onDisconnected={onDisconnected}
      >
        <AgentAudioRenderer muted={speakerMuted} />
        <MicControls
          agentStatus={agentStatus}
          autoListen={autoListen}
          speakerMuted={speakerMuted}
          showStatusPill={showStatusPill}
          onAutoListenChange={onAutoListenChange}
          onSpeakerMutedChange={onSpeakerMutedChange}
          onInterrupt={onInterrupt}
        />
      </LiveKitRoom>
    </div>
  );
}
