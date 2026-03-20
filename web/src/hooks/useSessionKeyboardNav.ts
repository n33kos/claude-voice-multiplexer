import { useEffect, useRef } from "react";
import type { DisplaySession } from "./useRelay";

export function useSessionKeyboardNav(
  sortedSessions: DisplaySession[],
  connectedSessionId: string | null,
  unreadSessions: Set<string>,
  onConnect: (sessionId: string) => void,
) {
  const sortedRef = useRef(sortedSessions);
  const connectedRef = useRef(connectedSessionId);
  const unreadRef = useRef(unreadSessions);
  const onConnectRef = useRef(onConnect);
  sortedRef.current = sortedSessions;
  connectedRef.current = connectedSessionId;
  unreadRef.current = unreadSessions;
  onConnectRef.current = onConnect;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey && e.key === "Tab")) return;

      const sessions = sortedRef.current;
      if (sessions.length === 0) return;

      e.preventDefault();
      e.stopPropagation();

      const connected = connectedRef.current;
      const unread = unreadRef.current;

      // Find online sessions that aren't the currently connected one
      const candidates = sessions.filter(
        (s) => s.online && s.session_id !== connected,
      );
      if (candidates.length === 0) return;

      // Prefer the first unread session, otherwise take the first candidate
      const nextUnread = candidates.find((s) => unread.has(s.session_id));
      const next = nextUnread ?? candidates[0];

      onConnectRef.current(next.session_id);
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);
}
