import {
  LiveKitRoom,
  RoomAudioRenderer,
} from "@livekit/components-react";
import type { VoiceControlsProps } from "./VoiceControls.types";
import { MicControls } from "./components/MicControls/MicControls";

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
    <LiveKitRoom
      token={token}
      serverUrl={serverUrl}
      connect={true}
      audio={autoListen}
      video={false}
      onConnected={onConnected}
      onDisconnected={onDisconnected}
    >
      <RoomAudioRenderer muted={speakerMuted} />
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
  );
}
