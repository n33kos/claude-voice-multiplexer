// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://localhost:3100/?session=s1&transcript=0" }
/**
 * Characterization tests for embed mode (?session=…): the relay connection
 * is locked to one session.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "../../sdk/src/testing/fakeWebSocket";

vi.mock("./useTranscriptDB", () => ({
  loadTranscripts: vi.fn(async () => []),
  saveTranscripts: vi.fn(),
  deleteTranscripts: vi.fn(),
  loadPersistedSessions: vi.fn(async () => []),
  savePersistedSession: vi.fn(),
  deletePersistedSession: vi.fn(),
  pruneStaleData: vi.fn(async () => {}),
}));

vi.mock("./useAuth", () => ({
  authFetch: vi.fn(async () => new Response("{}", { status: 200 })),
}));

import { useRelay } from "./useRelay";
import { embed } from "../embed";

const S1 = { session_id: "s1", name: "a", cwd: "/a", dir_name: "a", room_name: "vmux_s1", connected_clients: [], created_at: 1, last_heartbeat: 1 };
const S2 = { ...S1, session_id: "s2", room_name: "vmux_s2" };

const connects = (ws: FakeWebSocket) => ws.sentJson.filter((m) => m.type === "connect_session");

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

describe("embed lock", () => {
  it("parses the URL", () => {
    expect(embed).toEqual({ lockedSessionId: "s1", hideTranscript: true, active: true });
  });

  it("joins the locked session on open, once", () => {
    const hook = renderHook(() => useRelay(true));
    const ws = FakeWebSocket.last();
    act(() => ws.serverOpen());
    act(() => ws.serverSend({ type: "sessions", sessions: [S1, S2] }));
    expect(connects(ws)).toEqual([{ type: "connect_session", session_id: "s1" }]);
    act(() => ws.serverSend({ type: "session_connected", session_id: "s1" }));
    act(() => ws.serverSend({ type: "sessions", sessions: [S1, S2] }));
    expect(connects(ws)).toHaveLength(1);
    expect(hook.result.current.connectedSessionId).toBe("s1");
  });

  it("retries when the session comes online after a not-found", () => {
    renderHook(() => useRelay(true));
    const ws = FakeWebSocket.last();
    act(() => ws.serverOpen());
    act(() => ws.serverSend({ type: "session_not_found", session_id: "s1" }));
    act(() => ws.serverSend({ type: "sessions", sessions: [S2] }));
    expect(connects(ws)).toHaveLength(1);
    act(() => ws.serverSend({ type: "sessions", sessions: [S1, S2] }));
    expect(connects(ws)).toHaveLength(2);
  });

  it("rejoins after the session drops out of the list and returns", () => {
    renderHook(() => useRelay(true));
    const ws = FakeWebSocket.last();
    act(() => ws.serverOpen());
    act(() => ws.serverSend({ type: "session_connected", session_id: "s1" }));
    act(() => ws.serverSend({ type: "sessions", sessions: [S2] }));
    act(() => ws.serverSend({ type: "sessions", sessions: [S1, S2] }));
    expect(connects(ws)).toHaveLength(2);
  });

  it("ignores voice 'switch to' requests", () => {
    const hook = renderHook(() => useRelay(true));
    const ws = FakeWebSocket.last();
    act(() => ws.serverOpen());
    act(() => ws.serverSend({ type: "session_connected", session_id: "s1" }));
    act(() => ws.serverSend({ type: "request_session_switch", target_session_id: "s2" }));
    expect(connects(ws)).toHaveLength(1);
    expect(hook.result.current.connectedSessionId).toBe("s1");
  });
});
