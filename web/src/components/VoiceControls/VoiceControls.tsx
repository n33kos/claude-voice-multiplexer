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
    el.srcObject = new MediaStream([mediaTrack]);
  }, [agentTrack?.publication.track?.mediaStreamTrack]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = muted;
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
