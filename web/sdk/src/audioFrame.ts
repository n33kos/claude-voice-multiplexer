/**
 * Binary TTS audio frames (relay-server/speech_stream.py):
 *   b"VMXA" | u8 version | u32be header length | JSON header | s16le PCM
 */

export interface AudioFrameHeader {
  session_id: string;
  utterance_id: string;
  seq: number;
  /** Position of the first sample within the utterance. */
  offset_samples: number;
  sample_rate: number;
  channels: number;
  format: "s16le";
}

export interface AudioFrame {
  header: AudioFrameHeader;
  /** Mono samples in [-1, 1]. */
  samples: Float32Array;
}

const MAGIC = [0x56, 0x4d, 0x58, 0x41]; // "VMXA"
const VERSION = 1;

/** Decode a frame, or return null if `data` isn't a vmux audio frame. */
export function decodeAudioFrame(data: ArrayBuffer): AudioFrame | null {
  if (data.byteLength < 9) return null;
  const bytes = new Uint8Array(data);
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) return null;
  if (bytes[4] !== VERSION) return null;
  const view = new DataView(data);
  const headLen = view.getUint32(5, false);
  if (9 + headLen > data.byteLength) return null;
  let header: AudioFrameHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(9, 9 + headLen)));
  } catch {
    return null;
  }
  const pcmStart = 9 + headLen;
  const count = Math.floor((data.byteLength - pcmStart) / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = view.getInt16(pcmStart + i * 2, true) / 32768;
  }
  return { header, samples };
}

/** Encode a frame (tests and tools; the relay is the normal producer). */
export function encodeAudioFrame(header: AudioFrameHeader, pcm: Int16Array): ArrayBuffer {
  const head = new TextEncoder().encode(JSON.stringify(header));
  const buf = new ArrayBuffer(9 + head.length + pcm.length * 2);
  const bytes = new Uint8Array(buf);
  bytes.set(MAGIC, 0);
  bytes[4] = VERSION;
  const view = new DataView(buf);
  view.setUint32(5, head.length, false);
  bytes.set(head, 9);
  for (let i = 0; i < pcm.length; i++) view.setInt16(9 + head.length + i * 2, pcm[i], true);
  return buf;
}
