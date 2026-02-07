import { useEffect } from 'react'
import { useRelay } from './hooks/useRelay'
import { useLiveKit } from './hooks/useLiveKit'
import { SessionList } from './components/SessionList'
import { VoiceControls } from './components/VoiceControls'
import { Transcript } from './components/Transcript'
import { StatusBar } from './components/StatusBar'

export default function App() {
  const relay = useRelay()
  const livekit = useLiveKit()

  // Fetch LiveKit token when a session is connected
  useEffect(() => {
    if (relay.connectedSessionId && !livekit.token) {
      livekit.fetchToken()
    }
  }, [relay.connectedSessionId, livekit.token, livekit.fetchToken])

  return (
    <div className="h-full flex flex-col max-w-md mx-auto px-4 py-6 select-none">
      {/* Header */}
      <div className="text-center mb-4">
        <h1 className="text-lg font-medium text-neutral-400 tracking-tight">
          Claude Voice Multiplexer
        </h1>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col gap-4 overflow-hidden">
        {/* Session list */}
        <SessionList
          sessions={relay.sessions}
          connectedSessionId={relay.connectedSessionId}
          onConnect={relay.connectSession}
          onDisconnect={relay.disconnectSession}
        />

        {/* Voice controls (shown when connected to a session and have token) */}
        {relay.connectedSessionId && livekit.token && livekit.url && (
          <div className="flex justify-center py-2">
            <VoiceControls
              token={livekit.token}
              serverUrl={livekit.url}
              onConnected={() => livekit.setConnected(true)}
              onDisconnected={() => livekit.setConnected(false)}
            />
          </div>
        )}

        {/* Transcript */}
        {relay.connectedSessionId && (
          <Transcript entries={relay.transcript} />
        )}
      </div>

      {/* Status bar */}
      <div className="mt-4 pt-3 border-t border-neutral-800">
        <StatusBar
          relayStatus={relay.status}
          livekitConnected={livekit.isConnected}
          connectedSessionId={relay.connectedSessionId}
        />
      </div>
    </div>
  )
}
