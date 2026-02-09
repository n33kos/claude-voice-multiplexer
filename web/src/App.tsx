import { useEffect, useRef, useState } from "react";
import { useRelay } from "./hooks/useRelay";
import { useLiveKit } from "./hooks/useLiveKit";
import { useChime } from "./hooks/useChime";
import { useSettings } from "./hooks/useSettings";
import { useTheme } from "./hooks/useTheme";
import { SessionList } from "./components/SessionList/SessionList";
import { VoiceControls } from "./components/VoiceControls/VoiceControls";
import { Transcript } from "./components/Transcript/Transcript";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { Settings } from "./components/Settings/Settings";
import { ParticleNetwork } from "./components/ParticleNetwork/ParticleNetwork";
import { Header } from "./components/Header/Header";
import styles from "./App.module.scss";

export default function App() {
  const relay = useRelay();
  const livekit = useLiveKit();
  const { settings, updateSettings } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionsExpanded, setSessionsExpanded] = useState(
    !relay.connectedSessionId,
  );
  useChime(relay.agentStatus, settings.autoListen);
  useTheme(settings.theme);

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
        pendingRoom.current = null;
        livekit.resetToken();
      }
      return;
    }
    const session = relay.sessions.find(
      (s) => s.session_id === relay.connectedSessionId,
    );
    if (!session) return;

    const targetRoom = session.room_name;

    if (livekit.room === targetRoom || pendingRoom.current === targetRoom)
      return;

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
      <div className={styles.Layout}>
        <Header onSettingsOpen={() => setSettingsOpen(true)} />

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

        {relay.connectedSessionId && livekit.token && livekit.url && (
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
        )}

        {relay.connectedSessionId && (
          <Transcript entries={relay.transcript} />
        )}

        <StatusBar
          relayStatus={relay.status}
          livekitConnected={livekit.isConnected}
          claudeConnected={!!relay.connectedSessionId}
        />

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
