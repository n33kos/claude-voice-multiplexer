// @vitest-environment jsdom
/**
 * Characterization tests for useRelay: the web app's view of the relay
 * protocol.  They pin today's behavior so the SDK extraction can be checked
 * against it rather than assumed to match.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  authFetch: vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
}));

import { useRelay } from "./useRelay";
import { authFetch } from "./useAuth";

const SESSION = {
  session_id: "s1",
  name: "proj",
  cwd: "/p/proj",
  dir_name: "proj",
  room_name: "vmux_s1",
  connected_clients: [],
  created_at: 1,
  last_heartbeat: 2,
};

function setup() {
  const hook = renderHook(() => useRelay(true));
  const ws = FakeWebSocket.last();
  act(() => ws.serverOpen());
  return { hook, ws };
}

function connected() {
  const { hook, ws } = setup();
  act(() => ws.serverSend({ type: "sessions", sessions: [SESSION] }));
  act(() =>
    ws.serverSend({ type: "session_connected", session_id: "s1", session_name: "proj" }),
  );
  return { hook, ws };
}

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.mocked(authFetch).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("connection", () => {
  it("does not connect until authenticated", () => {
    renderHook(() => useRelay(false));
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("opens /ws/client on the page's host and reports status", () => {
    const hook = renderHook(() => useRelay(true));
    const ws = FakeWebSocket.last();
    expect(ws.url).toBe(`ws://${window.location.host}/ws/client`);
    expect(hook.result.current.status).toBe("connecting");
    act(() => ws.serverOpen());
    expect(hook.result.current.status).toBe("connected");
    expect(authFetch).toHaveBeenCalledWith("/api/session-metadata");
  });

  it("answers ping with pong", () => {
    const { ws } = setup();
    act(() => ws.serverSend({ type: "ping" }));
    expect(ws.sentJson).toContainEqual({ type: "pong" });
  });

  it("ignores binary and unknown messages", () => {
    const { hook, ws } = setup();
    act(() => ws.serverSendBinary(new ArrayBuffer(4)));
    act(() => ws.serverSend({ type: "something_new", x: 1 }));
    expect(hook.result.current.status).toBe("connected");
  });

  it("resets on close, reconnects with backoff, and rejoins the last session", () => {
    vi.useFakeTimers();
    const { hook, ws } = connected();
    act(() => ws.serverClose(1006));
    expect(hook.result.current.status).toBe("disconnected");
    expect(hook.result.current.connectedSessionId).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1000));
    expect(FakeWebSocket.instances).toHaveLength(2);
    const ws2 = FakeWebSocket.last();
    act(() => ws2.serverOpen());
    expect(ws2.sentJson).toContainEqual({ type: "connect_session", session_id: "s1" });
  });

  it("does not reconnect after an auth failure (4001)", () => {
    vi.useFakeTimers();
    const { ws } = setup();
    act(() => ws.serverClose(4001));
    act(() => vi.advanceTimersByTime(30_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe("sessions", () => {
  it("lists live sessions as online display sessions", () => {
    const { hook, ws } = setup();
    act(() => ws.serverSend({ type: "sessions", sessions: [SESSION] }));
    const [s] = hook.result.current.sessions;
    expect(s).toMatchObject({
      session_id: "s1",
      display_name: "proj",
      online: true,
      room_name: "vmux_s1",
    });
  });

  it("connects, tracks name and initial status, and disconnects", () => {
    const { hook, ws } = setup();
    act(() => hook.result.current.connectSession("s1"));
    expect(ws.sentJson).toContainEqual({ type: "connect_session", session_id: "s1" });
    act(() =>
      ws.serverSend({
        type: "session_connected",
        session_id: "s1",
        session_name: "proj",
        current_status: { state: "thinking", activity: "Reading" },
      }),
    );
    expect(hook.result.current.connectedSessionId).toBe("s1");
    expect(hook.result.current.connectedSessionName).toBe("proj");
    expect(hook.result.current.agentStatus).toEqual({ state: "thinking", activity: "Reading" });

    act(() => hook.result.current.disconnectSession());
    expect(ws.sentJson).toContainEqual({ type: "disconnect_session" });
    expect(hook.result.current.connectedSessionId).toBeNull();
  });

  it("clears the connection on session_not_found and session_disconnected", () => {
    const { hook, ws } = connected();
    act(() => ws.serverSend({ type: "session_disconnected", session_id: "s1" }));
    expect(hook.result.current.connectedSessionId).toBeNull();
    act(() => ws.serverSend({ type: "session_connected", session_id: "s1" }));
    act(() => ws.serverSend({ type: "session_not_found", session_id: "s1" }));
    expect(hook.result.current.connectedSessionId).toBeNull();
  });

  it("follows a voice 'switch to' request", () => {
    const { ws } = connected();
    act(() => ws.serverSend({ type: "request_session_switch", target_session_id: "s2" }));
    expect(ws.sentJson).toContainEqual({ type: "connect_session", session_id: "s2" });
  });

  it("applies and removes server metadata overrides", () => {
    const { hook, ws } = setup();
    act(() => ws.serverSend({ type: "sessions", sessions: [SESSION] }));
    act(() =>
      ws.serverSend({
        type: "session_metadata_updated",
        metadata: { session_id: "s1", display_name: "Renamed", hue_override: 120, updated_at: 5 },
      }),
    );
    expect(hook.result.current.sessions[0]).toMatchObject({ display_name: "Renamed", hue_override: 120 });
    act(() =>
      ws.serverSend({
        type: "session_metadata_updated",
        metadata: { session_id: "s1", display_name: null, hue_override: null, updated_at: null },
      }),
    );
    expect(hook.result.current.sessions[0].display_name).toBe("proj");
  });
});

describe("transcript", () => {
  it("appends entries for the connected session", () => {
    const { hook, ws } = connected();
    act(() => ws.serverSend({ type: "transcript", speaker: "user", text: "hi", session_id: "s1", ts: 10 }));
    act(() => ws.serverSend({ type: "transcript", speaker: "claude", text: "yo", session_id: "s1", ts: 11 }));
    expect(hook.result.current.transcript.map((e) => [e.speaker, e.text, e.timestamp])).toEqual([
      ["user", "hi", 10_000],
      ["claude", "yo", 11_000],
    ]);
  });

  it("keeps transcripts of other sessions without showing them", () => {
    const { hook, ws } = connected();
    act(() => ws.serverSend({ type: "transcript", speaker: "claude", text: "x", session_id: "s2" }));
    expect(hook.result.current.transcript).toHaveLength(0);
    expect(hook.result.current.transcripts.s2).toHaveLength(1);
  });

  it("grows one entry per streamed message_id", () => {
    const { hook, ws } = connected();
    for (const text of ["Intro:\n\n", "- a\n- b\n\n", "Done."]) {
      act(() =>
        ws.serverSend({ type: "transcript", speaker: "claude", text, session_id: "s1", message_id: "m1" }),
      );
    }
    expect(hook.result.current.transcript).toHaveLength(1);
    expect(hook.result.current.transcript[0].text).toBe("Intro:\n\n- a\n- b\n\nDone.");
  });

  it("merges a reconnect replay, keeping only user/claude/code entries", () => {
    const { hook, ws } = connected();
    act(() => ws.serverSend({ type: "transcript", speaker: "user", text: "hi", session_id: "s1", ts: 10 }));
    act(() =>
      ws.serverSend({
        type: "transcript_sync",
        session_id: "s1",
        entries: [
          { speaker: "user", text: "hi", session_id: "s1", ts: 10.5 },
          { speaker: "activity", text: "Reading", session_id: "s1", ts: 11 },
          { speaker: "claude", text: "new", session_id: "s1", ts: 12 },
        ],
      }),
    );
    expect(hook.result.current.transcript.map((e) => e.text)).toEqual(["hi", "new"]);
  });

  it("records activity changes as transcript entries and counts silence signals", () => {
    const { hook, ws } = connected();
    act(() => ws.serverSend({ type: "agent_status", state: "thinking", activity: "Reading", tool_use_id: "t1" }));
    act(() => ws.serverSend({ type: "agent_status", state: "thinking", activity: "Reading" }));
    expect(hook.result.current.agentStatus).toEqual({ state: "thinking", activity: "Reading" });
    expect(hook.result.current.transcript.filter((e) => e.speaker === "activity")).toHaveLength(1);
    expect(hook.result.current.disableAutoListenSeq).toBe(0);
    act(() => ws.serverSend({ type: "agent_status", state: "idle", activity: null, disable_auto_listen: true }));
    expect(hook.result.current.disableAutoListenSeq).toBe(1);
    expect(hook.result.current.agentStatus.state).toBe("idle");
  });

  it("attaches a tool result to its activity entry", () => {
    const { hook, ws } = connected();
    act(() => ws.serverSend({ type: "agent_status", state: "thinking", activity: "Bash", tool_use_id: "t1" }));
    act(() =>
      ws.serverSend({ type: "tool_result", session_id: "s1", tool_use_id: "t1", result_text: "ok", lines_total: 1 }),
    );
    const entry = hook.result.current.transcript.find((e) => e.tool_use_id === "t1");
    expect(entry?.tool_result).toEqual({ result_text: "ok", lines_total: 1, truncated: false });
  });

  it("clears a session's transcript, tasks and PRs", () => {
    const { hook, ws } = connected();
    act(() => ws.serverSend({ type: "transcript", speaker: "user", text: "hi", session_id: "s1" }));
    act(() => ws.serverSend({ type: "task_list", session_id: "s1", tasks: [{ task_id: "1" }] }));
    act(() => hook.result.current.clearTranscript("s1"));
    expect(hook.result.current.transcript).toHaveLength(0);
    expect(hook.result.current.tasks).toHaveLength(0);
  });
});

describe("tasks and PRs", () => {
  it("replaces the task and PR lists per session", () => {
    const { hook, ws } = connected();
    act(() => ws.serverSend({ type: "task_list", session_id: "s1", tasks: [{ task_id: "1", subject: "a" }] }));
    act(() => ws.serverSend({ type: "pr_list", session_id: "s1", prs: [{ pr_number: 7 }] }));
    expect(hook.result.current.tasks).toEqual([{ task_id: "1", subject: "a" }]);
    expect(hook.result.current.prs).toEqual([{ pr_number: 7 }]);
  });
});

describe("commands", () => {
  it("sends trimmed text and ignores blank text", () => {
    const { hook, ws } = connected();
    act(() => hook.result.current.sendTextMessage("  hello  "));
    act(() => hook.result.current.sendTextMessage("   "));
    expect(ws.sentJson.filter((m) => m.type === "text_message")).toEqual([{ type: "text_message", text: "hello" }]);
  });

  it("interrupt forces idle locally and tells the relay", () => {
    const { hook, ws } = connected();
    act(() => ws.serverSend({ type: "agent_status", state: "speaking", activity: null }));
    act(() => hook.result.current.interruptAgent());
    expect(hook.result.current.agentStatus).toEqual({ state: "idle", activity: null });
    expect(ws.sentJson).toContainEqual({ type: "interrupt" });
  });

  it("answers a specific question card by timestamp", () => {
    const { hook, ws } = connected();
    for (const ts of [1, 2]) {
      act(() =>
        ws.serverSend({
          type: "transcript",
          speaker: "question",
          text: "q",
          session_id: "s1",
          ts,
          question: { question: "q", options: [{ label: "a" }] },
        }),
      );
    }
    act(() => hook.result.current.answerQuestion("s1", 0, "a", 1000, true));
    expect(ws.sentJson).toContainEqual({ type: "answer_question", session_id: "s1", option_index: 0, submit_after: true });
    const qs = hook.result.current.transcript;
    expect(qs[0].answered).toEqual({ optionIndex: 0, label: "a" });
    expect(qs[1].answered).toBeUndefined();
  });

  it("answers the latest open permission card", () => {
    const { hook, ws } = connected();
    for (const ts of [1, 2]) {
      act(() =>
        ws.serverSend({
          type: "transcript",
          speaker: "permission",
          text: "p",
          session_id: "s1",
          ts,
          permission: { tool_name: "Bash" },
        }),
      );
    }
    act(() => hook.result.current.answerPermission("s1", "allow"));
    expect(ws.sentJson).toContainEqual({ type: "answer_permission", session_id: "s1", choice: "allow" });
    const ps = hook.result.current.transcript;
    expect(ps.map((e) => e.permissionAnswered)).toEqual([undefined, "allow"]);
  });

  it("drives the terminal", () => {
    const { hook, ws } = connected();
    const onData = vi.fn();
    act(() => hook.result.current.setTerminalDataCallback(onData));
    act(() => hook.result.current.requestTerminalCapture(20));
    expect(hook.result.current.terminalSnapshotLoading).toBe(true);
    act(() => ws.serverSend({ type: "terminal_snapshot", session_id: "s1", content: "$ ls", timestamp: 3 }));
    expect(hook.result.current.terminalSnapshot).toEqual({
      sessionId: "s1",
      content: "$ ls",
      error: undefined,
      timestamp: 3000,
    });
    expect(hook.result.current.terminalSnapshotLoading).toBe(false);
    act(() => ws.serverSend({ type: "terminal_data", data: "\u001b[1mx" }));
    expect(onData).toHaveBeenCalledWith("\u001b[1mx");
    act(() => {
      hook.result.current.sendTerminalKeys("ls");
      hook.result.current.sendTerminalSpecialKey("Enter");
      hook.result.current.sendTerminalResize(80, 24);
      hook.result.current.startTerminalStream();
      hook.result.current.stopTerminalStream();
    });
    expect(ws.sentJson.slice(-6)).toEqual([
      { type: "capture_terminal", lines: 20 },
      { type: "terminal_input", keys: "ls" },
      { type: "terminal_input", special_key: "Enter" },
      { type: "terminal_resize", cols: 80, rows: 24 },
      { type: "terminal_stream_start" },
      { type: "terminal_stream_stop" },
    ]);
  });

  it("calls the session REST endpoints", async () => {
    const { hook } = connected();
    await act(async () => {
      await hook.result.current.killSession("s1");
      await hook.result.current.restartSession("s1");
      await hook.result.current.hardInterruptSession("s1");
      await hook.result.current.cancelTts("s1");
      await hook.result.current.clearContextSession("s1");
      await hook.result.current.compactSession("s1");
      await hook.result.current.changeModel("s1", "opus");
      await hook.result.current.changeEffort("s1", "high");
      await hook.result.current.spawnSession("/p", "n");
    });
    const calls = vi.mocked(authFetch).mock.calls.map(([url, init]) => [url, init?.method, init?.body]);
    expect(calls).toEqual(
      expect.arrayContaining([
        ["/api/sessions/s1", "DELETE", undefined],
        ["/api/sessions/s1/restart", "POST", undefined],
        ["/api/sessions/s1/interrupt", "POST", undefined],
        ["/api/sessions/s1/cancel-tts", "POST", undefined],
        ["/api/sessions/s1/clear-context", "POST", undefined],
        ["/api/sessions/s1/compact", "POST", undefined],
        ["/api/sessions/s1/model", "POST", JSON.stringify({ model: "opus" })],
        ["/api/sessions/s1/effort", "POST", JSON.stringify({ level: "high" })],
        ["/api/sessions/spawn", "POST", JSON.stringify({ cwd: "/p", session_name: "n" })],
      ]),
    );
  });
});
