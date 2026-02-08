import { useEffect, useState } from "react";
import { useRelay } from "./hooks/useRelay";
import { useLiveKit } from "./hooks/useLiveKit";
import { useChime } from "./hooks/useChime";
import { useSettings } from "./hooks/useSettings";
import { SessionList } from "./components/SessionList";
import { VoiceControls } from "./components/VoiceControls";
import { Transcript } from "./components/Transcript";
import { StatusBar } from "./components/StatusBar";
import { Settings } from "./components/Settings";

export default function App() {
  const relay = useRelay();
  const livekit = useLiveKit();
  const { settings, updateSettings } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionsExpanded, setSessionsExpanded] = useState(!relay.connectedSessionId);
  useChime(relay.agentStatus);

  // Auto-collapse session list when connected, expand when disconnected
  useEffect(() => {
    setSessionsExpanded(!relay.connectedSessionId);
  }, [relay.connectedSessionId]);

  // Fetch LiveKit token when a session is connected
  useEffect(() => {
    if (relay.connectedSessionId && !livekit.token) {
      livekit.fetchToken();
    }
  }, [relay.connectedSessionId, livekit.token, livekit.fetchToken]);

  return (
    <div className="h-dvh flex flex-col max-w-lg mx-auto px-4 py-4 select-none">
      {/* Header — fixed */}
      <div className="shrink-0 relative flex items-center justify-center mb-4">
        <h1 className="text-lg font-medium text-neutral-400 tracking-tight font-audiowide-regular header-gradient">
          Claude Voice Multiplexer
        </h1>
        <button
          onClick={() => setSettingsOpen(true)}
          className="absolute right-0 w-8 h-8 flex items-center justify-center rounded-full text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 transition-colors"
        >
          <svg
            className="w-6 h-6"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
            />
          </svg>
        </button>
      </div>

      {/* Session list — fixed */}
      <div className="shrink-0">
        <SessionList
          sessions={relay.sessions}
          connectedSessionId={relay.connectedSessionId}
          connectedSessionName={relay.connectedSessionName}
          expanded={sessionsExpanded}
          onToggleExpanded={() => setSessionsExpanded(e => !e)}
          onConnect={relay.connectSession}
          onDisconnect={relay.disconnectSession}
          onClearTranscript={relay.clearTranscript}
          onRemoveSession={relay.removeSession}
        />
      </div>

      {/* Voice controls — fixed */}
      {relay.connectedSessionId && livekit.token && livekit.url && (
        <div className="shrink-0 py-4">
          <VoiceControls
            token={livekit.token}
            serverUrl={livekit.url}
            agentStatus={relay.agentStatus}
            autoListen={settings.autoListen}
            speakerMuted={settings.speakerMuted}
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
  );
}
