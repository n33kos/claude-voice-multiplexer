import { useEffect, useRef } from "react";

export function useTrackAnalyser(mediaStreamTrack: MediaStreamTrack | undefined) {
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (!mediaStreamTrack) {
      if (sourceRef.current) {
        sourceRef.current.disconnect();
        sourceRef.current = null;
      }
      analyserRef.current = null;
      return;
    }

    const ctx = ctxRef.current ?? new AudioContext();
    ctxRef.current = ctx;
    if (ctx.state === "suspended") ctx.resume();

    const stream = new MediaStream([mediaStreamTrack]);
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);

    analyserRef.current = analyser;
    sourceRef.current = source;

    return () => {
      source.disconnect();
      analyserRef.current = null;
      sourceRef.current = null;
    };
  }, [mediaStreamTrack]);

  return analyserRef;
}
