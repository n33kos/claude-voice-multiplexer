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
import { TerminalOverlay } from "./components/TerminalOverlay/TerminalOverlay";
import styles from "./App.module.scss";

// Lazy-load VoiceControls (pulls in heavy livekit-client bundle)
const VoiceControls = lazy(() =>
  import("./components/VoiceControls/VoiceControls").then((m) => ({
    default: m.VoiceControls,
  })),
);

function InsecureContextBanner() {
  const origin = window.location.origin;
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard?.writeText(origin).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div
      style={{
        width: "100%",
        background: "rgba(255, 180, 0, 0.12)",
        border: "1px solid rgba(255, 180, 0, 0.3)",
        borderRadius: "8px",
        padding: "0.75rem 1rem",
        fontSize: "0.8rem",
        color: "rgba(255, 220, 100, 0.9)",
        lineHeight: "1.5",
        userSelect: "text",
      }}
    >
      <strong style={{ display: "block", marginBottom: "0.25rem" }}>
        ⚠ Microphone unavailable over HTTP
      </strong>
      Browsers block mic access on non-HTTPS connections. To enable:
      <ol style={{ margin: "0.4rem 0 0.4rem 1.2rem", padding: 0 }}>
        <li>
          Open{" "}
          <code style={{ userSelect: "all" }}>
            chrome://flags/#unsafely-treat-insecure-origin-as-secure
          </code>{" "}
          in Chrome
        </li>
        <li>
          Add this URL to the allowlist:&nbsp;
          <code style={{ userSelect: "all" }}>{origin}</code>
          {navigator.clipboard && (
            <button
              onClick={copy}
              style={{
                marginLeft: "0.4rem",
                background: "rgba(255,180,0,0.15)",
                border: "1px solid rgba(255,180,0,0.3)",
                borderRadius: "4px",
                color: "inherit",
                cursor: "pointer",
                fontSize: "0.75rem",
                padding: "0 0.4rem",
              }}
            >
              {copied ? "✓" : "copy"}
            </button>
          )}
        </li>
        <li>Relaunch Chrome and reload this page</li>
      </ol>
    </div>
  );
}

export default function App() {
  const auth = useAuth();
  const relay = useRelay(auth.authenticated);
  const livekit = useLiveKit();
  const { settings, updateSettings } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
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
        hueOverride={
          relay.sessions.find((s) => s.session_id === relay.connectedSessionId)
            ?.hue_override
        }
        analyserRef={particleAnalyserRef}
        audioReactive={settings.audioReactiveParticles}
      />
      <div className={styles.Layout}>
        <Header
          onSettingsOpen={() => setSettingsOpen(true)}
          onTerminalOpen={() => setTerminalOpen(true)}
          showTerminalButton={!!relay.connectedSessionId}
        />

        <SessionList
          sessions={relay.sessions}
          connectedSessionId={relay.connectedSessionId}
          connectedSessionName={relay.connectedSessionName}
          expanded={sessionsExpanded}
          onToggleExpanded={() => setSessionsExpanded((e) => !e)}
          onConnect={relay.connectSession}
          onDisconnect={relay.disconnectSession}
          onClearTranscript={relay.clearTranscript}
          onReconnectSession={relay.reconnectSession}
          onRemoveSession={relay.removeSession}
          onRenameSession={relay.renameSession}
          onRecolorSession={relay.recolorSession}
          onSpawnSession={relay.spawnSession}
          onKillSession={relay.killSession}
          onRestartSession={relay.restartSession}
          onHardInterrupt={relay.hardInterruptSession}
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
            onCaptureTerminal={() => setTerminalOpen(true)}
          />
        )}

        <TerminalOverlay
          open={terminalOpen}
          onClose={() => setTerminalOpen(false)}
          onSendKeys={relay.sendTerminalKeys}
          onSendSpecialKey={relay.sendTerminalSpecialKey}
          onStartStream={relay.startTerminalStream}
          onStopStream={relay.stopTerminalStream}
          onSetTerminalDataCallback={relay.setTerminalDataCallback}
        />

        {relay.connectedSessionId && !navigator.mediaDevices && (
          <InsecureContextBanner />
        )}

        {relay.connectedSessionId &&
          livekit.token &&
          livekit.url &&
          navigator.mediaDevices && (
            <Suspense fallback={null}>
              <VoiceControls
                token={livekit.token}
                serverUrl={livekit.url}
                sessionId={relay.connectedSessionId}
                hueOverride={
                  relay.sessions.find(
                    (s) => s.session_id === relay.connectedSessionId,
                  )?.hue_override
                }
                agentStatus={relay.agentStatus}
                autoListen={settings.autoListen}
                speakerMuted={settings.speakerMuted}
                showStatusPill={settings.showStatusPill}
                onAutoListenChange={(v) => updateSettings({ autoListen: v })}
                onSpeakerMutedChange={(v) =>
                  updateSettings({ speakerMuted: v })
                }
                onConnected={() => livekit.setConnected(true)}
                onDisconnected={() => livekit.setConnected(false)}
                onInterrupt={() => {
                  relay.interruptAgent();
                  relay.hardInterruptSession(relay.connectedSessionId!);
                }}
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
