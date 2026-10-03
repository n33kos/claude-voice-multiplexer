/**
 * Just enough of AudioContext for SpeechPlayer tests: a controllable clock and
 * buffer sources that record when they were started/stopped.
 */
export class FakeAudioNode {
  connections: unknown[] = [];
  connect(dest: unknown) {
    this.connections.push(dest);
    return dest;
  }
  disconnect() {
    this.connections = [];
  }
}

export class FakeGainNode extends FakeAudioNode {
  gain = { value: 1 };
}

export class FakeAnalyserNode extends FakeAudioNode {
  fftSize = 2048;
  /** Value every sample of getFloatTimeDomainData() reports. */
  amplitude = 0;
  getFloatTimeDomainData(buf: Float32Array) {
    buf.fill(this.amplitude);
  }
}

export class FakeAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly duration: number;
  private data: Float32Array;
  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.data = new Float32Array(length);
  }
  getChannelData() {
    return this.data;
  }
}

export class FakeBufferSource extends FakeAudioNode {
  buffer: FakeAudioBuffer | null = null;
  startedAt: number | null = null;
  stopped = false;
  start(when = 0) {
    this.startedAt = when;
  }
  stop() {
    this.stopped = true;
  }
}

export class FakeAudioContext {
  currentTime = 0;
  state: AudioContextState = "running";
  destination = new FakeAudioNode();
  sources: FakeBufferSource[] = [];
  analysers: FakeAnalyserNode[] = [];

  createGain() {
    return new FakeGainNode();
  }
  createAnalyser() {
    const a = new FakeAnalyserNode();
    this.analysers.push(a);
    return a;
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return new FakeAudioBuffer(channels, length, sampleRate);
  }
  createBufferSource() {
    const s = new FakeBufferSource();
    this.sources.push(s);
    return s;
  }
  async resume() {
    this.state = "running";
  }
}
