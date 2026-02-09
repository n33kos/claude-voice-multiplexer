import { initAudio } from "../../hooks/useChime";
import type { SessionListProps } from "./SessionList.types";
import { timeAgo } from "./SessionList.utils";
import { SessionMenu } from "./components/SessionMenu/SessionMenu";
import { ChevronIcon } from "./components/ChevronIcon/ChevronIcon";

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
}: SessionListProps) {
  // No sessions at all
  if (sessions.length === 0) {
    return (
      <div
        data-component="SessionList"
        className="text-center text-neutral-500"
      >
        <p className="text-sm">No Claude sessions</p>
        <p className="text-xs mt-1 text-neutral-600">
          Use{" "}
          <code className="text-neutral-400">
            /voice-multiplexer:relay-standby
          </code>{" "}
          in a Claude session
        </p>
      </div>
    );
  }

  const connectedSession = sessions.find(
    (s) => s.session_id === connectedSessionId && !!connectedSessionId,
  );

  return (
    <div data-component="SessionList">
      {/* Collapsed header bar */}
      <button
        onClick={onToggleExpanded}
        className="w-full flex items-center justify-between px-4 py-2.5 rounded-xl bg-neutral-900 border border-neutral-800 transition-all active:bg-neutral-800"
      >
        <div className="flex items-center gap-2 min-w-0">
          {connectedSession ? (
            <>
              <div className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
              <span className="text-sm text-neutral-200 truncate">
                {connectedSessionName || connectedSession.session_name}
              </span>
            </>
          ) : (
            <span className="text-sm text-neutral-500">Select a session</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {sessions.length > 1 && (
            <span className="text-[10px] text-neutral-600">
              {sessions.length} sessions
            </span>
          )}
          <ChevronIcon expanded={expanded} />
        </div>
      </button>

      {/* Expanded session list */}
      {expanded && (
        <div className="mt-2 flex flex-col gap-1.5">
          {sessions.map((session) => {
            const isConnected =
              session.session_id === connectedSessionId && !!connectedSessionId;
            const canConnect = session.online && !!session.session_id;
            return (
              <div
                key={session.session_name}
                onClick={() => {
                  if (!canConnect) return;
                  initAudio();
                  if (isConnected) {
                    onDisconnect();
                  } else {
                    onConnect(session.session_id!);
                    onToggleExpanded();
                  }
                }}
                className={`
                  w-full text-left px-4 py-2.5 rounded-xl transition-all
                  ${
                    canConnect
                      ? "bg-neutral-900 border border-neutral-800 text-neutral-300 active:bg-neutral-800 cursor-pointer"
                      : "bg-neutral-900/50 border border-neutral-800/50 text-neutral-500"
                  }
                `}
              >
                <div className="flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {isConnected && (
                        <div className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                      )}
                      <span
                        className={`font-medium text-sm truncate ${!session.online ? "text-neutral-500" : ""}`}
                      >
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
                    <span className="text-[10px] text-neutral-600">
                      {timeAgo(session.last_seen)}
                    </span>
                    <SessionMenu
                      session={session}
                      onClearTranscript={onClearTranscript}
                      onRemoveSession={onRemoveSession}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
