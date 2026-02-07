import type { Session } from '../hooks/useRelay'

interface Props {
  sessions: Session[]
  connectedSessionId: string | null
  onConnect: (sessionId: string) => void
  onDisconnect: () => void
}

export function SessionList({ sessions, connectedSessionId, onConnect, onDisconnect }: Props) {
  if (sessions.length === 0) {
    return (
      <div className="text-center text-neutral-500 py-8">
        <p className="text-sm">No Claude sessions in standby</p>
        <p className="text-xs mt-1 text-neutral-600">
          Use <code className="text-neutral-400">/voice-multiplexer:relay-standby</code> in a Claude session
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {sessions.map((session) => {
        const isConnected = session.session_id === connectedSessionId
        return (
          <button
            key={session.session_id}
            onClick={() => isConnected ? onDisconnect() : onConnect(session.session_id)}
            className={`
              w-full text-left px-4 py-3 rounded-xl transition-all
              ${isConnected
                ? 'bg-blue-500/20 border border-blue-500/40 text-blue-100'
                : 'bg-neutral-900 border border-neutral-800 text-neutral-300 active:bg-neutral-800'
              }
            `}
          >
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <div className="font-medium text-sm truncate">{session.name}</div>
                <div className="text-xs text-neutral-500 truncate">{session.cwd}</div>
              </div>
              {isConnected && (
                <div className="flex items-center gap-1.5 ml-3 shrink-0">
                  <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
                  <span className="text-xs text-blue-400">Connected</span>
                </div>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
