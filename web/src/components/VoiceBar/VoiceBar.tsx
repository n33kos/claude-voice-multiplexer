import { useEffect, useRef } from "react";
import type { VoiceBarProps, RGB } from "./VoiceBar.types";
import { lerp, lerpColor } from "./VoiceBar.utils";

const BAR_COUNT = 20;
const BAR_GAP = 3;
const BAR_MIN_HEIGHT = 2;
const BOOST_LEVEL = 1;

const COLORS: Record<string, RGB> = {
  recording: { r: 239, g: 68, b: 68 },
  thinking: { r: 168, g: 85, b: 247 },
  speaking: { r: 59, g: 130, b: 246 },
  error: { r: 245, g: 158, b: 11 },
  idle: { r: 115, g: 115, b: 115 },
};

export function VoiceBar({ agentStatus, isMicEnabled, analyserRef }: VoiceBarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const barsRef = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const colorRef = useRef(COLORS.idle);
  const timeRef = useRef(0);
  const freqDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);

  const agentState = agentStatus.state;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const barWidth = (width - BAR_GAP * (BAR_COUNT - 1)) / BAR_COUNT;
    const barRadius = barWidth / 2;

    function getTargetColor() {
      if (agentState === "speaking") return COLORS.speaking;
      if (agentState === "error") return COLORS.error;
      if (agentState === "thinking") return COLORS.thinking;
      if (isMicEnabled) return COLORS.recording;
      return COLORS.idle;
    }

    function getAudioLevels(): number[] | null {
      const analyser = analyserRef.current;
      if (!analyser) return null;

      if (
        !freqDataRef.current ||
        freqDataRef.current.length !== analyser.frequencyBinCount
      ) {
        freqDataRef.current = new Uint8Array(analyser.frequencyBinCount);
      }

      analyser.getByteFrequencyData(freqDataRef.current);

      const binCount = freqDataRef.current.length;
      const usableBins = Math.floor(binCount * 0.4);
      const halfBars = Math.ceil(BAR_COUNT / 2);
      const halfLevels: number[] = [];
      const binsPerBar = Math.max(1, Math.floor(usableBins / halfBars));

      for (let i = 0; i < halfBars; i++) {
        let sum = 0;
        const start = Math.min(i * binsPerBar, usableBins - 1);
        const end = Math.min(start + binsPerBar, usableBins);
        for (let j = start; j < end; j++) {
          sum += freqDataRef.current[j];
        }
        halfLevels.push(sum / (end - start) / 255);
      }

      const mirrored: number[] = [];
      for (let i = halfBars - 1; i >= 0; i--) {
        mirrored.push(halfLevels[i]);
      }
      for (let i = 0; i < halfBars && mirrored.length < BAR_COUNT; i++) {
        mirrored.push(halfLevels[i]);
      }

      return mirrored;
    }

    function animate() {
      timeRef.current += 0.016;
      const t = timeRef.current;

      const targetColor = getTargetColor();
      colorRef.current = lerpColor(colorRef.current, targetColor, 0.08);
      const { r, g, b } = colorRef.current;

      const useRealAudio = isMicEnabled || agentState === "speaking";
      const audioLevels = useRealAudio ? getAudioLevels() : null;

      const bars = barsRef.current;
      for (let i = 0; i < BAR_COUNT; i++) {
        let target: number;

        if (useRealAudio && audioLevels) {
          const level = audioLevels[i];
          const boosted = Math.min(1, level * BOOST_LEVEL);
          const curved = Math.pow(boosted, 0.6);
          target = Math.max(BAR_MIN_HEIGHT, curved * height * 0.85);
        } else if (agentState === "thinking") {
          const wave = Math.sin(t * 2.5 + i * 0.35) * 0.5 + 0.5;
          const wave2 = Math.sin(t * 1.8 + i * 0.5 + 1.2) * 0.3 + 0.3;
          target = (wave * 0.6 + wave2 * 0.4) * height * 0.6 + BAR_MIN_HEIGHT;
        } else if (agentState === "error") {
          const pulse = Math.sin(t * 1.5) * 0.3 + 0.4;
          target = pulse * height * 0.4 + BAR_MIN_HEIGHT;
        } else if (agentState === "speaking") {
          const wave = Math.sin(t * 4 + i * 0.4) * 0.4 + 0.5;
          const burst = Math.sin(t * 7 + i * 0.8) * 0.3;
          const envelope = Math.sin(t * 1.5) * 0.3 + 0.7;
          target = Math.max(
            BAR_MIN_HEIGHT,
            (wave + burst) * envelope * height * 0.75,
          );
        } else {
          target = BAR_MIN_HEIGHT;
        }

        const easeFactor = useRealAudio && audioLevels ? 0.3 : 0.12;
        bars[i] = lerp(bars[i], target, easeFactor);
      }

      ctx!.clearRect(0, 0, width, height);

      for (let i = 0; i < BAR_COUNT; i++) {
        const barHeight = Math.max(BAR_MIN_HEIGHT, bars[i]);
        const x = i * (barWidth + BAR_GAP);
        const y = (height - barHeight) / 2;

        const opacity =
          agentState === "idle" && !isMicEnabled
            ? 0.3
            : 0.6 + Math.sin(t * 2 + i * 0.5) * 0.2;

        ctx!.fillStyle = `rgba(${r}, ${g}, ${b}, ${opacity})`;
        ctx!.beginPath();
        ctx!.roundRect(x, y, barWidth, barHeight, barRadius);
        ctx!.fill();
      }

      animRef.current = requestAnimationFrame(animate);
    }

    animRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animRef.current);
  }, [agentState, isMicEnabled, analyserRef]);

  return (
    <canvas
      data-component="VoiceBar"
      ref={canvasRef}
      className="mx-auto h-16"
      style={{ width: "65%", height: 64 }}
    />
  );
}
