/**
 * RelayClient: one connection to the vmux relay (/ws/client + REST).
 *
 * Owns reconnects, session joining (optionally locked to one session), the
 * relay state (sessions, transcripts, agent status, speech…) and every
 * command a UI can send.  Framework-free: subscribe() fits React's
 * useSyncExternalStore, or listen to events directly.
 *
 *   const relay = new RelayClient({ url: "http://localhost:3100", token });
 *   relay.on("speech", (m) => …);
 *   relay.start();
 *   relay.connectSession("abc123def456");
 */
import { decodeAudioFrame, type AudioFrame } from "./audioFrame";
import { Emitter } from "./emitter";
import type { ClientMessage, PermissionChoice, ServerMessage, SpeechMessage, TranscriptEntry } from "./protocol";
import {
  connectionClosed,
  initialRelayState,
  interrupted,
  permissionAnswered,
  questionAnswered,
  reduceServerMessage,
  sessionDataCleared,
  sessionLeft,
  transcriptHydrated,
  type RelayState,
} from "./relayState";

export interface RelayClientOptions {
  /** Relay base URL, e.g. "http://localhost:3100".  Default: the current page's origin. */
  url?: string;
  /** Paired device token (from POST /api/auth/pair), or a function returning it. */
  token?: string | null | (() => string | null);
  /**
   * How the WebSocket authenticates.  "subprotocol" sends the token as
   * `vmux-token.<jwt>` (works from any origin); "cookie" relies on the
   * browser's vmux_token cookie (same-origin web app).  Default:
   * "subprotocol" when a token is given, else "cookie".
   */
  wsAuth?: "subprotocol" | "cookie";
  /** fetch implementation for REST calls (default: global fetch). */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Lock to one session: join it whenever it's online and ignore every request to switch. */
  lockSessionId?: string | null;
  /** Receive TTS audio as binary frames (see SpeechPlayer).  Default false. */
  subscribeAudio?: boolean;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  /** Reconnect on tab focus if nothing arrived for this long (the relay pings every 30s). */
  staleAfterMs?: number;
  /** Watch document visibility to catch dead sockets after sleep (default: true in browsers). */
  watchVisibility?: boolean;
  /** WebSocket implementation (default: global WebSocket). */
  WebSocket?: typeof WebSocket;
}

export interface RelayClientEvents extends Record<string, unknown> {
  /** Any state change. */
  state: RelayState;
  /** Every JSON message from the relay, after it has been applied to the state. */
  message: ServerMessage;
  speech: SpeechMessage;
  audio: AudioFrame;
  terminalData: string;
  open: void;
  close: { code: number };
}

/**
 * What a device may do (relay-server/auth.py), least to most privileged:
 *   listen:  observe — sessions, transcript, speech events/audio, voice room without a mic
 *   speak:   talk to Claude — send text, use the mic, stop Claude speaking, answer questions
 *   control: operate the machine — permissions, terminal, spawn/kill/restart, settings
 * Ask for the least a UI needs.
 */
export type DeviceScope = "listen" | "speak" | "control";

export interface PairResult {
  token: string;
  deviceId: string;
  deviceName: string;
  scope: DeviceScope;
}

/**
 * Pair a device with a 6-digit code (shown by the vmux web app's Settings or
 * `/voice-multiplexer:auth-code`) and get its token.  Store the token; it
 * lasts until revoked (default 90 days).
 */
export async function pairDevice(opts: {
  url: string;
  code: string;
  deviceName: string;
  scope?: DeviceScope;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}): Promise<PairResult> {
  const doFetch = opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const resp = await doFetch(opts.url.replace(/\/$/, "") + "/api/auth/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: opts.code, device_name: opts.deviceName, ...(opts.scope ? { scope: opts.scope } : {}) }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `Pairing failed (${resp.status})`);
  return { token: data.token, deviceId: data.device_id, deviceName: data.device_name, scope: data.scope ?? "control" };
}

export class RelayClient extends Emitter<RelayClientEvents> {
  private opts: RelayClientOptions;
  private state: RelayState = initialRelayState();
  private ws: WebSocket | null = null;
  private stopped = true;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private lastMessageTime = Date.now();
  private lastSessionId: string | null;
  private lockedJoin: "idle" | "pending" | "joined" = "idle";
  private audioSubscribed: boolean;
  private stateListeners = new Set<() => void>();

  constructor(opts: RelayClientOptions = {}) {
    super();
    this.opts = opts;
    // Seeded with the locked session so the rejoin in onopen also does the initial join.
    this.lastSessionId = opts.lockSessionId ?? null;
    this.audioSubscribed = !!opts.subscribeAudio;
  }

  // --- state ---------------------------------------------------------------------

  getState = (): RelayState => this.state;

  /** Subscribe to state changes (React: useSyncExternalStore(relay.subscribe, relay.getState)). */
  subscribe = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  };

  private setState(next: RelayState) {
    if (next === this.state) return;
    this.state = next;
    for (const l of [...this.stateListeners]) l();
    this.emit("state", next);
  }

  get lockedSessionId(): string | null {
    return this.opts.lockSessionId ?? null;
  }

  // --- connection ------------------------------------------------------------------

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.watchVisibility) document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    if (this.watchVisibility) document.removeEventListener("visibilitychange", this.onVisibilityChange);
    // Detach first so the socket's late close event can't touch a later connection.
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    if (ws) {
      const prev = this.state.connectedSessionId;
      if (prev) this.lastSessionId = prev;
      this.lockedJoin = "idle";
      this.setState(connectionClosed(this.state));
    }
  }

  private get watchVisibility(): boolean {
    return (this.opts.watchVisibility ?? true) && typeof document !== "undefined";
  }

  private token(): string | null {
    const t = this.opts.token;
    return typeof t === "function" ? t() : (t ?? null);
  }

  private wsUrl(): string {
    if (this.opts.url) return this.opts.url.replace(/^http/, "ws").replace(/\/$/, "") + "/ws/client";
    if (typeof window === "undefined") throw new Error("RelayClient: pass `url` outside a browser page");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws/client`;
  }

  private connect = () => {
    if (this.stopped) return;
    const WS = this.opts.WebSocket ?? WebSocket;
    if (this.ws?.readyState === WS.OPEN) return;

    this.setState({ ...this.state, status: "connecting" });

    const token = this.token();
    const useSubprotocol = (this.opts.wsAuth ?? (token ? "subprotocol" : "cookie")) === "subprotocol" && token;
    const ws = useSubprotocol ? new WS(this.wsUrl(), [`vmux-token.${token}`]) : new WS(this.wsUrl());
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    // Handlers ignore events from a socket that's no longer current
    // (replaced by stop()/start() or a reconnect).
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectAttempt = 0;
      this.setState({ ...this.state, status: "connected" });
      this.request("/api/session-metadata")
        .then((r) => r.json())
        .then((data) => {
          if (data.metadata) this.setState({ ...this.state, serverMetadata: data.metadata });
        })
        .catch(() => {
          // Non-fatal — server metadata is best-effort
        });
      if (this.lastSessionId) {
        if (this.lockedSessionId) this.lockedJoin = "pending";
        this.send({ type: "connect_session", session_id: this.lastSessionId });
      }
      if (this.audioSubscribed) this.send({ type: "audio_subscribe", enabled: true });
      this.emit("open", undefined);
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.lastMessageTime = Date.now();
      if (typeof event.data !== "string") {
        if (event.data instanceof ArrayBuffer) {
          const frame = decodeAudioFrame(event.data);
          if (frame) this.emit("audio", frame);
        }
        return;
      }
      let data: ServerMessage;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      this.handleMessage(data);
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      // Remember the session for the rejoin after reconnecting.
      const prev = this.state.connectedSessionId;
      if (prev) this.lastSessionId = prev;
      this.lockedJoin = "idle";
      this.setState(connectionClosed(this.state));
      this.emit("close", { code: event.code });
      if (this.stopped) return;
      // Don't reconnect on auth failure (4001) or a rejected origin (4003).
      if (event.code === 4001 || event.code === 4003) return;
      const delay = Math.min(
        (this.opts.reconnectBaseDelayMs ?? 1_000) * 2 ** this.reconnectAttempt,
        this.opts.reconnectMaxDelayMs ?? 10_000,
      );
      this.reconnectAttempt++;
      this.reconnectTimer = setTimeout(this.connect, delay);
    };

    ws.onerror = () => {
      ws.close();
    };
  };

  /** iOS/PWA resume: a socket can look open but be dead.  Reconnect if it's gone quiet. */
  private onVisibilityChange = () => {
    if (document.hidden) return;
    const stale = Date.now() - this.lastMessageTime > (this.opts.staleAfterMs ?? 30_000);
    const WS = this.opts.WebSocket ?? WebSocket;
    if (stale && this.ws?.readyState === WS.OPEN) this.ws.close();
  };

  private handleMessage(data: ServerMessage) {
    this.setState(reduceServerMessage(this.state, data));

    switch (data.type) {
      case "ping":
        this.send({ type: "pong" });
        break;
      case "sessions":
        this.maybeJoinLocked(data.sessions.some((s) => s.session_id === this.lockedSessionId));
        break;
      case "session_connected":
        if (this.lockedSessionId) {
          this.lockedJoin = data.session_id === this.lockedSessionId ? "joined" : "idle";
        }
        break;
      case "session_not_found":
      case "session_disconnected":
        this.lockedJoin = "idle";
        break;
      case "request_session_switch":
        // Voice "switch to <name>" matched a session server-side.  A locked client stays put.
        if (!this.lockedSessionId && typeof data.target_session_id === "string" && data.target_session_id) {
          this.send({ type: "connect_session", session_id: data.target_session_id });
        }
        break;
      case "terminal_data":
        if (data.data) this.emit("terminalData", data.data);
        break;
      case "speech_start":
      case "speech_chunk":
      case "speech_end":
        this.emit("speech", data);
        break;
      case "error":
        console.error("[relay]", data.message);
        break;
    }
    this.emit("message", data);
  }

  /** Locked mode: (re)join once the session is listed.  The relay drops client
   *  links when a session unregisters without telling us, so treat its absence
   *  as needing a fresh join. */
  private maybeJoinLocked(online: boolean) {
    const sid = this.lockedSessionId;
    if (!sid) return;
    if (!online && this.lockedJoin === "joined") {
      this.lockedJoin = "idle";
    } else if (online && this.lockedJoin === "idle") {
      this.lockedJoin = "pending";
      this.send({ type: "connect_session", session_id: sid });
    }
  }

  /** Send a message if the socket is open.  Returns whether it was sent. */
  send(msg: ClientMessage): boolean {
    const WS = this.opts.WebSocket ?? WebSocket;
    if (!this.ws || this.ws.readyState !== WS.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  // --- sessions ----------------------------------------------------------------------

  /** Join a session (ignored while locked to a different one). */
  connectSession(sessionId: string): void {
    if (this.lockedSessionId && sessionId !== this.lockedSessionId) return;
    this.send({ type: "connect_session", session_id: sessionId });
  }

  disconnectSession(): void {
    if (this.lockedSessionId) return;
    this.send({ type: "disconnect_session" });
    this.setState(sessionLeft(this.state));
  }

  // --- conversation --------------------------------------------------------------------

  /** Send typed text to the connected session (as if spoken). */
  sendText(text: string): void {
    if (!text.trim()) return;
    this.send({ type: "text_message", text: text.trim() });
  }

  /** Stop Claude's speech and hand the turn to the user (Claude keeps working). */
  interrupt(): void {
    this.setState(interrupted(this.state));
    this.send({ type: "interrupt" });
  }

  /**
   * Answer an AskUserQuestion card.  `entryTimestamp` identifies the card;
   * `isFinal` also presses Enter on Claude Code's final submit prompt.
   */
  answerQuestion(sessionId: string, optionIndex: number, label: string, entryTimestamp: number, isFinal: boolean): void {
    this.send({ type: "answer_question", session_id: sessionId, option_index: optionIndex, submit_after: isFinal });
    this.setState(questionAnswered(this.state, sessionId, entryTimestamp, { optionIndex, label }));
  }

  answerPermission(sessionId: string, choice: PermissionChoice): void {
    this.send({ type: "answer_permission", session_id: sessionId, choice });
    this.setState(permissionAnswered(this.state, sessionId, choice));
  }

  /** Receive TTS audio as binary frames (emitted as "audio" events). */
  setAudioSubscribed(enabled: boolean): void {
    this.audioSubscribed = enabled;
    this.send({ type: "audio_subscribe", enabled });
  }

  // --- local transcript management -------------------------------------------------------

  clearTranscript(sessionId: string): void {
    this.setState(sessionDataCleared(this.state, sessionId));
  }

  /** Merge transcript entries kept in local storage (stored entries first). */
  hydrateTranscript(sessionId: string, stored: TranscriptEntry[]): void {
    this.setState(transcriptHydrated(this.state, sessionId, stored));
  }

  // --- terminal --------------------------------------------------------------------------

  captureTerminal(lines = 50): void {
    this.setState({ ...this.state, terminalSnapshotLoading: true });
    this.send({ type: "capture_terminal", lines });
  }

  dismissTerminalSnapshot(): void {
    this.setState({ ...this.state, terminalSnapshot: null, terminalSnapshotLoading: false });
  }

  sendTerminalKeys(keys: string): void {
    this.send({ type: "terminal_input", keys });
  }

  sendTerminalSpecialKey(key: string): void {
    this.send({ type: "terminal_input", special_key: key });
  }

  resizeTerminal(cols: number, rows: number): void {
    this.send({ type: "terminal_resize", cols, rows });
  }

  startTerminalStream(): void {
    this.send({ type: "terminal_stream_start" });
  }

  stopTerminalStream(): void {
    this.send({ type: "terminal_stream_stop" });
  }

  // --- REST --------------------------------------------------------------------------------

  /** Authenticated request to the relay's REST API (`path` starts with "/api/"). */
  request(path: string, init?: RequestInit): Promise<Response> {
    const url = (this.opts.url ? this.opts.url.replace(/\/$/, "") : "") + path;
    const doFetch = this.opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
    const token = this.token();
    if (!token) return init ? doFetch(url, init) : doFetch(url);
    const headers = { ...(init?.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` };
    return doFetch(url, { ...init, headers });
  }

  private async ok(path: string, init?: RequestInit): Promise<boolean> {
    try {
      return (await this.request(path, init)).ok;
    } catch {
      return false;
    }
  }

  private json(body: unknown): RequestInit {
    return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  }

  killSession(sessionId: string): Promise<boolean> {
    return this.ok(`/api/sessions/${sessionId}`, { method: "DELETE" });
  }

  restartSession(sessionId: string): Promise<boolean> {
    return this.ok(`/api/sessions/${sessionId}/restart`, { method: "POST" });
  }

  /** Esc-interrupt Claude in its terminal (stops the current tool call). */
  hardInterrupt(sessionId: string): Promise<boolean> {
    return this.ok(`/api/sessions/${sessionId}/interrupt`, { method: "POST" });
  }

  cancelTts(sessionId: string): Promise<boolean> {
    return this.ok(`/api/sessions/${sessionId}/cancel-tts`, { method: "POST" });
  }

  clearContext(sessionId: string): Promise<boolean> {
    return this.ok(`/api/sessions/${sessionId}/clear-context`, { method: "POST" });
  }

  compact(sessionId: string): Promise<boolean> {
    return this.ok(`/api/sessions/${sessionId}/compact`, { method: "POST" });
  }

  changeModel(sessionId: string, model: string): Promise<boolean> {
    return this.ok(`/api/sessions/${sessionId}/model`, this.json({ model }));
  }

  changeEffort(sessionId: string, level: string): Promise<boolean> {
    return this.ok(`/api/sessions/${sessionId}/effort`, this.json({ level }));
  }

  async spawnSession(cwd: string, name?: string): Promise<{ ok: boolean; error?: string; session_id?: string }> {
    try {
      const resp = await this.request("/api/sessions/spawn", this.json({ cwd, session_name: name ?? "" }));
      const data = await resp.json();
      if (!resp.ok) return { ok: false, error: data.error || "Spawn failed" };
      return { ok: true, session_id: data.session_id };
    } catch {
      return { ok: false, error: "Network error" };
    }
  }

  async restartAllSessions(): Promise<{ ok: boolean; total?: number; succeeded?: number; failed?: number; error?: string }> {
    try {
      const resp = await this.request("/api/sessions/restart-all", { method: "POST" });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) return { ok: false, error: data.error || "Restart-all failed" };
      return { ok: true, ...data };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Set a session's display name / color / TTS voice on the relay (null clears a field). */
  setSessionMetadata(
    sessionId: string,
    patch: { display_name?: string | null; hue_override?: number | null; voice_override?: string | null },
  ): Promise<boolean> {
    return this.ok(`/api/session-metadata/${sessionId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  /** LiveKit credentials for a session's voice room (see VoiceClient). */
  async fetchVoiceToken(room: string): Promise<{ token: string; url: string; room: string; identity: string }> {
    const resp = await this.request(`/api/token?room=${encodeURIComponent(room)}`);
    if (!resp.ok) throw new Error(`Token fetch failed: ${resp.status}`);
    return resp.json();
  }
}
