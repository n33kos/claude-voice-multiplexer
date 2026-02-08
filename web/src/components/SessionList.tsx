import { useEffect, useRef, useState } from 'react'
import type { DisplaySession } from '../hooks/useRelay'
import { initAudio } from '../hooks/useChime'

interface Props {
  sessions: DisplaySession[]
  connectedSessionId: string | null
  connectedSessionName: string | null
  expanded: boolean
  onToggleExpanded: () => void
  onConnect: (sessionId: string) => void
  onDisconnect: () => void
  onClearTranscript: (sessionName: string) => void
  onRemoveSession: (sessionName: string) => void
}

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() / 1000) - ts)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function SessionMenu({
  session,
  onClearTranscript,
  onRemoveSession,
}: {
  session: DisplaySession
  onClearTranscript: (sessionName: string) => void
  onRemoveSession: (sessionName: string) => void
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        className="w-7 h-7 flex items-center justify-center rounded-full text-neutral-500 hover:text-neutral-300 hover:bg-neutral-700/50 transition-colors"
      >
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
          <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-44 bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl z-20 overflow-hidden">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onClearTranscript(session.session_name)
              setOpen(false)
            }}
            className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
          >
            Clear transcripts
          </button>
          {!session.online && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onRemoveSession(session.session_name)
                setOpen(false)
              }}
              className="w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-neutral-700 transition-colors"
            >
              Delete session
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`w-4 h-4 text-neutral-500 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
    </svg>
  )
}

export function SessionList({
  sessions,
  connectedSessionId,
  connectedSessionName,
  expanded,
  onToggleExpanded,
  onConnect,
  onDisconnect,
  onClearTranscript,
  onRemoveSession,
}: Props) {
  // No sessions at all
  if (sessions.length === 0) {
    return (
      <div className="text-center text-neutral-500 py-8">
        <p className="text-sm">No Claude sessions</p>
        <p className="text-xs mt-1 text-neutral-600">
          Use <code className="text-neutral-400">/voice-multiplexer:relay-standby</code> in a Claude session
        </p>
      </div>
    )
  }

  const connectedSession = sessions.find(
    s => s.session_id === connectedSessionId && !!connectedSessionId
  )

  return (
    <div>
      {/* Collapsed header bar */}
      <button
        onClick={onToggleExpanded}
        className="w-full flex items-center justify-between px-4 py-2.5 rounded-xl bg-neutral-900 border border-neutral-800 transition-all active:bg-neutral-800"
      >
        <div className="flex items-center gap-2 min-w-0">
          {connectedSession ? (
            <>
              <div className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
              <span className="text-sm text-neutral-200 truncate">{connectedSessionName || connectedSession.session_name}</span>
            </>
          ) : (
            <span className="text-sm text-neutral-500">Select a session</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {sessions.length > 1 && (
            <span className="text-[10px] text-neutral-600">{sessions.length} sessions</span>
          )}
          <ChevronIcon expanded={expanded} />
        </div>
      </button>

      {/* Expanded session list */}
      {expanded && (
        <div className="mt-2 flex flex-col gap-1.5">
          {sessions.map((session) => {
            const isConnected = session.session_id === connectedSessionId && !!connectedSessionId
            const canConnect = session.online && !!session.session_id
            return (
              <div
                key={session.session_name}
                onClick={() => {
                  if (!canConnect) return
                  initAudio()
                  if (isConnected) {
                    onDisconnect()
                  } else {
                    onConnect(session.session_id!)
                    onToggleExpanded()
                  }
                }}
                className={`
                  w-full text-left px-4 py-2.5 rounded-xl transition-all
                  ${canConnect
                    ? 'bg-neutral-900 border border-neutral-800 text-neutral-300 active:bg-neutral-800 cursor-pointer'
                    : 'bg-neutral-900/50 border border-neutral-800/50 text-neutral-500'
                  }
                `}
              >
                <div className="flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {isConnected && (
                        <div className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                      )}
                      <span className={`font-medium text-sm truncate ${!session.online ? 'text-neutral-500' : ''}`}>
                        {session.session_name}
                      </span>
                      {!session.online && (
                        <span className="text-[10px] text-neutral-600 bg-neutral-800 px-1.5 py-0.5 rounded">
                          offline
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-neutral-600 truncate mt-0.5 ml-3.5">
                      {session.dir_name}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 ml-3 shrink-0">
                    <span className="text-[10px] text-neutral-600">{timeAgo(session.last_seen)}</span>
                    <SessionMenu
                      session={session}
                      onClearTranscript={onClearTranscript}
                      onRemoveSession={onRemoveSession}
                    />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
