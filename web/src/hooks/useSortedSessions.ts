import { useMemo } from "react";
import type { DisplaySession } from "./useRelay";

export function useSortedSessions(
  sessions: DisplaySession[],
  connectedSessionId: string | null,
  unreadSessions: Set<string>,
): DisplaySession[] {
  return useMemo(() => {
    return [...sessions].sort((a, b) => {
      // Connected session always first
      if (connectedSessionId) {
        if (a.session_id === connectedSessionId) return -1;
        if (b.session_id === connectedSessionId) return 1;
      }
      // Unread sessions above read sessions
      const aUnread = unreadSessions.has(a.session_id) ? 1 : 0;
      const bUnread = unreadSessions.has(b.session_id) ? 1 : 0;
      if (aUnread !== bUnread) return bUnread - aUnread;
      // Within each group, sort by most recent activity
      const aTime = a.last_interaction ?? 0;
      const bTime = b.last_interaction ?? 0;
      return bTime - aTime;
    });
  }, [sessions, connectedSessionId, unreadSessions]);
}
