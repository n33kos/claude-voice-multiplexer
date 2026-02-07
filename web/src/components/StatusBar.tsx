interface Props {
  relayStatus: 'disconnected' | 'connecting' | 'connected'
  livekitConnected: boolean
  connectedSessionId: string | null
}

export function StatusBar({ relayStatus, livekitConnected, connectedSessionId }: Props) {
  const statusColor = {
    disconnected: 'bg-red-500',
    connecting: 'bg-yellow-500',
    connected: 'bg-green-500',
  }[relayStatus]

  return (
    <div className="flex items-center justify-between text-xs text-neutral-500 px-1">
      <div className="flex items-center gap-1.5">
        <div className={`w-1.5 h-1.5 rounded-full ${statusColor}`} />
        <span>Relay {relayStatus}</span>
      </div>
      <div className="flex items-center gap-3">
        {livekitConnected && (
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
            <span>Audio</span>
          </div>
        )}
        {connectedSessionId && (
          <span className="text-blue-400">Session active</span>
        )}
      </div>
    </div>
  )
}
