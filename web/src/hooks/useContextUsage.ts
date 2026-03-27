import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "./useAuth";
import type { ContextUsage } from "../components/ContextBar/ContextBar";

const POLL_INTERVAL_MS = 30_000;

/**
 * Polls context window usage for the currently active session.
 * Only fetches when a session is connected; stops when disconnected.
 */
export function useContextUsage(activeSessionId: string | null) {
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const activeRef = useRef(activeSessionId);
  activeRef.current = activeSessionId;

  const fetchUsage = useCallback(async (sessionId: string) => {
    try {
      const resp = await authFetch(`/api/sessions/${sessionId}/context`);
      if (!resp.ok) {
        // Session may not have usage data yet — not an error
        return;
      }
      const data: ContextUsage = await resp.json();
      // Only update if we're still on the same session
      if (activeRef.current === sessionId) {
        setUsage(data);
      }
    } catch {
      // Network errors are non-fatal — will retry on next poll
    }
  }, []);

  useEffect(() => {
    // Clear stale data when switching sessions
    setUsage(null);

    if (!activeSessionId) {
      return;
    }

    // Fetch immediately on connect/switch
    fetchUsage(activeSessionId);

    // Then poll on interval
    timerRef.current = setInterval(() => {
      if (activeRef.current) {
        fetchUsage(activeRef.current);
      }
    }, POLL_INTERVAL_MS);

    return () => {
      clearInterval(timerRef.current);
    };
  }, [activeSessionId, fetchUsage]);

  return usage;
}
