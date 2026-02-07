import {
  LiveKitRoom,
  useRoomContext,
  useLocalParticipant,
  RoomAudioRenderer,
} from '@livekit/components-react'

interface Props {
  token: string
  serverUrl: string
  onConnected: () => void
  onDisconnected: () => void
}

function MicControls() {
  const room = useRoomContext()
  const { isMicrophoneEnabled } = useLocalParticipant()

  const toggleMic = async () => {
    await room.localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled)
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <button
        onClick={toggleMic}
        className={`
          w-16 h-16 rounded-full flex items-center justify-center transition-all
          ${isMicrophoneEnabled
            ? 'bg-red-500 shadow-lg shadow-red-500/30 active:bg-red-600'
            : 'bg-neutral-800 border border-neutral-700 active:bg-neutral-700'
          }
        `}
      >
        <svg
          className="w-6 h-6 text-white"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          {isMicrophoneEnabled ? (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z"
            />
          ) : (
            <>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z"
              />
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
            </>
          )}
        </svg>
      </button>
      <span className="text-xs text-neutral-500">
        {isMicrophoneEnabled ? 'Mic on — tap to mute' : 'Mic off — tap to unmute'}
      </span>
    </div>
  )
}

export function VoiceControls({ token, serverUrl, onConnected, onDisconnected }: Props) {
  return (
    <LiveKitRoom
      token={token}
      serverUrl={serverUrl}
      connect={true}
      audio={true}
      video={false}
      onConnected={onConnected}
      onDisconnected={onDisconnected}
    >
      <RoomAudioRenderer />
      <MicControls />
    </LiveKitRoom>
  )
}
