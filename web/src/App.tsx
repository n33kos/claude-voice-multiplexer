import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useRelay } from "./hooks/useRelay";
import { useLiveKit } from "./hooks/useLiveKit";
import {
  useChime,
  playNotificationChime,
  playDisconnectChime,
} from "./hooks/useChime";
import { useSettings } from "./hooks/useSettings";
import { useTheme } from "./hooks/useTheme";
import { useAuth } from "./hooks/useAuth";
import { SessionList } from "./components/SessionList/SessionList";
import { Transcript } from "./components/Transcript/Transcript";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { Settings } from "./components/Settings/Settings";
import { ParticleNetwork } from "./components/ParticleNetwork/ParticleNetwork";
import { Header } from "./components/Header/Header";
import { PairScreen } from "./components/PairScreen/PairScreen";
import styles from "./App.module.scss";

// Lazy-load VoiceControls (pulls in heavy livekit-client bundle)
const VoiceControls = lazy(() =>
  import("./components/VoiceControls/VoiceControls").then((m) => ({
    default: m.VoiceControls,
  })),
);

export default function App() {
  const auth = useAuth();
  const relay = useRelay(auth.authenticated);
  const livekit = useLiveKit();
  const { settings, updateSettings } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const particleAnalyserRef = useRef<AnalyserNode | null>(null);
  const [sessionsExpanded, setSessionsExpanded] = useState(
    !relay.connectedSessionId,
  );
  useChime(relay.agentStatus, settings.autoListen);
  useTheme(settings.theme);

  // Play notification chime when a new online session appears
  const prevOnlineIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    const currentIds = new Set(
      relay.sessions
        .filter((s) => s.online && s.session_id)
        .map((s) => s.session_id!),
    );
    const isNew = [...currentIds].some((id) => !prevOnlineIds.current.has(id));
    const isGone = [...prevOnlineIds.current].some((id) => !currentIds.has(id));
    // Only chime if we had sessions before (skip initial load)
    if (prevOnlineIds.current.size > 0) {
      if (isNew) playNotificationChime();
      if (isGone) playDisconnectChime();
    }
    prevOnlineIds.current = currentIds;
  }, [relay.sessions]);

  // Disable auto-listen when server signals noise-only transcription
  const prevSeq = useRef(0);
  useEffect(() => {
    if (relay.disableAutoListenSeq > prevSeq.current && settings.autoListen) {
      updateSettings({ autoListen: false });
    }
    prevSeq.current = relay.disableAutoListenSeq;
  }, [relay.disableAutoListenSeq, settings.autoListen, updateSettings]);

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

  // Show nothing while checking auth status
  if (!auth.checked) return null;

  // Auth gate: show pairing screen if auth is enabled and not authenticated
  if (auth.authEnabled && !auth.authenticated) {
    return (
      <>
        <ParticleNetwork />
        <PairScreen onPair={auth.pairDevice} />
      </>
    );
  }

  return (
    <>
      <ParticleNetwork
        sessionId={relay.connectedSessionId}
        hueOverride={relay.sessions.find(s => s.session_id === relay.connectedSessionId)?.hue_override}
        analyserRef={particleAnalyserRef}
        audioReactive={settings.audioReactiveParticles}
      />
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
          onRenameSession={relay.renameSession}
          onRecolorSession={relay.recolorSession}
        />

        {relay.connectedSessionId && (
          <Transcript
            entries={relay.transcript}
            cwd={
              relay.sessions.find(
                (s) => s.session_id === relay.connectedSessionId,
              )?.cwd
            }
            sessionId={relay.connectedSessionId}
            hueOverride={
              relay.sessions.find(
                (s) => s.session_id === relay.connectedSessionId,
              )?.hue_override
            }
            onSendText={relay.sendTextMessage}
          />
        )}

        {relay.connectedSessionId && livekit.token && livekit.url && (
          <Suspense fallback={null}>
            <VoiceControls
              token={livekit.token}
              serverUrl={livekit.url}
              sessionId={relay.connectedSessionId}
              hueOverride={relay.sessions.find(s => s.session_id === relay.connectedSessionId)?.hue_override}
              agentStatus={relay.agentStatus}
              autoListen={settings.autoListen}
              speakerMuted={settings.speakerMuted}
              showStatusPill={settings.showStatusPill}
              onAutoListenChange={(v) => updateSettings({ autoListen: v })}
              onSpeakerMutedChange={(v) => updateSettings({ speakerMuted: v })}
              onConnected={() => livekit.setConnected(true)}
              onDisconnected={() => livekit.setConnected(false)}
              onInterrupt={relay.interruptAgent}
              particleAnalyserRef={particleAnalyserRef}
            />
          </Suspense>
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
          authEnabled={auth.authEnabled}
          devices={auth.devices}
          connectedClients={
            relay.sessions.find(
              (s) => s.session_id === relay.connectedSessionId,
            )?.connected_clients
          }
          onGenerateCode={auth.generateCode}
          onRevokeDevice={auth.revokeDevice}
        />
      </div>
    </>
  );
}
