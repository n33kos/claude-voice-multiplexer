import { useEffect, useRef, useState } from "react";
import { useRelay } from "./hooks/useRelay";
import { useLiveKit } from "./hooks/useLiveKit";
import { useChime } from "./hooks/useChime";
import { useSettings } from "./hooks/useSettings";
import { SessionList } from "./components/SessionList/SessionList";
import { VoiceControls } from "./components/VoiceControls/VoiceControls";
import { Transcript } from "./components/Transcript/Transcript";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { Settings } from "./components/Settings/Settings";
import { ParticleNetwork } from "./components/ParticleNetwork/ParticleNetwork";
import { Header } from "./components/Header/Header";

export default function App() {
  const relay = useRelay();
  const livekit = useLiveKit();
  const { settings, updateSettings } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionsExpanded, setSessionsExpanded] = useState(
    !relay.connectedSessionId,
  );
  useChime(relay.agentStatus, settings.autoListen);

  // Auto-collapse session list when connected, expand when disconnected
  useEffect(() => {
    setSessionsExpanded((prev) => {
      const shouldExpand = !relay.connectedSessionId;
      return prev === shouldExpand ? prev : shouldExpand;
    });
  }, [relay.connectedSessionId]);

  // Track which room we've requested a token for to avoid re-fetching
  const pendingRoom = useRef<string | null>(null);
  const prevSessionId = useRef<string | null>(null);

  // Fetch LiveKit token for the connected session's room
  useEffect(() => {
    const sessionChanged = relay.connectedSessionId !== prevSessionId.current;
    prevSessionId.current = relay.connectedSessionId;

    if (!relay.connectedSessionId) {
      if (sessionChanged && livekit.token) {
        // Only reset if we actually had a token (disconnecting from a session)
        pendingRoom.current = null;
        livekit.resetToken();
      }
      return;
    }
    // Find the connected session's room name
    const session = relay.sessions.find(
      (s) => s.session_id === relay.connectedSessionId,
    );
    if (!session) return;

    const targetRoom = session.room_name;

    // Already connected or fetching for this room
    if (livekit.room === targetRoom || pendingRoom.current === targetRoom)
      return;

    // Switch rooms: reset old connection, fetch new token
    pendingRoom.current = targetRoom;
    livekit.resetToken();
    livekit.fetchToken(targetRoom);
  }, [
    relay.connectedSessionId,
    relay.sessions,
    livekit.room,
    livekit.token,
    livekit.fetchToken,
    livekit.resetToken,
  ]);

  return (
    <>
      <ParticleNetwork />
      <div
        className="relative h-dvh flex flex-col max-w-lg mx-auto px-4 py-4 select-none"
        style={{ zIndex: 1 }}
      >
        <Header onSettingsOpen={() => setSettingsOpen(true)} />

        {/* Session list — fixed */}
        <div className="shrink-0 mb-8">
          <SessionList
            sessions={relay.sessions}
            connectedSessionId={relay.connectedSessionId}
            connectedSessionName={relay.connectedSessionName}
            expanded={sessionsExpanded}
            onToggleExpanded={() => setSessionsExpanded((e) => !e)}
            onConnect={relay.connectSession}
            onDisconnect={relay.disconnectSession}
            onClearTranscript={relay.clearTranscript}
            onRemoveSession={relay.removeSession}
          />
        </div>

        {/* Voice controls — fixed */}
        {relay.connectedSessionId && livekit.token && livekit.url && (
          <div className="shrink-0 mb-8">
            <VoiceControls
              token={livekit.token}
              serverUrl={livekit.url}
              agentStatus={relay.agentStatus}
              autoListen={settings.autoListen}
              speakerMuted={settings.speakerMuted}
              showStatusPill={settings.showStatusPill}
              onAutoListenChange={(v) => updateSettings({ autoListen: v })}
              onSpeakerMutedChange={(v) => updateSettings({ speakerMuted: v })}
              onConnected={() => livekit.setConnected(true)}
              onDisconnected={() => livekit.setConnected(false)}
              onInterrupt={relay.interruptAgent}
            />
          </div>
        )}

        {/* Transcript — fills remaining space */}
        {relay.connectedSessionId && (
          <div className="flex-1 min-h-0 mt-3">
            <Transcript entries={relay.transcript} />
          </div>
        )}

        {/* Status bar — fixed at bottom */}
        <div className="shrink-0 mt-3 pt-3 border-t border-neutral-800">
          <StatusBar
            relayStatus={relay.status}
            livekitConnected={livekit.isConnected}
            claudeConnected={!!relay.connectedSessionId}
          />
        </div>

        {/* Settings panel */}
        <Settings
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          settings={settings}
          onUpdate={updateSettings}
        />
      </div>
    </>
  );
}
