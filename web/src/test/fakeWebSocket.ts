/**
 * Minimal WebSocket stand-in for tests.  Install with
 * `vi.stubGlobal("WebSocket", FakeWebSocket)`; each constructed socket is
 * pushed to `FakeWebSocket.instances` so a test can play the relay's side.
 */
export class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  static reset() {
    FakeWebSocket.instances = [];
  }

  static last(): FakeWebSocket {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!ws) throw new Error("no FakeWebSocket constructed");
    return ws;
  }

  readonly url: string;
  readonly protocols: string[];
  protocol = "";
  readyState = FakeWebSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  sent: string[] = [];

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols == null ? [] : Array.isArray(protocols) ? protocols : [protocols];
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("FakeWebSocket.send while not open");
    }
    this.sent.push(data);
  }

  close(code = 1000) {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }

  // --- relay side ---

  /** Parsed JSON of every message the client sent. */
  get sentJson(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }

  serverOpen(protocol = "") {
    this.protocol = protocol;
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  serverSend(msg: unknown) {
    const data = typeof msg === "string" ? msg : JSON.stringify(msg);
    this.onmessage?.({ data } as MessageEvent);
  }

  serverSendBinary(data: ArrayBuffer) {
    this.onmessage?.({ data } as MessageEvent);
  }

  serverClose(code = 1006) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }
}
