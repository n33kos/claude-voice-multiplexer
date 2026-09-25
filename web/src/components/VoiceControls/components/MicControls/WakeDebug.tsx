import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { WakeDebugState } from "../../../../wake-word/useWakeWord";

type WakeDebugProps = {
  scoreRef: MutableRefObject<WakeDebugState>;
  threshold: number;
  status: string;
  phraseLabel: string;
};

const POINTS = 120;

/**
 * Temporary debug meter for the wake-word pipeline: a rolling graph of the
 * live detection score with the threshold line, plus the model status and
 * current score / speech-active readout.  Reads the score from a ref via
 * requestAnimationFrame so it never re-renders the parent per frame.
 */
export function WakeDebug({ scoreRef, threshold, status, phraseLabel }: WakeDebugProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bufRef = useRef<number[]>(new Array(POINTS).fill(0));
  const animRef = useRef<number>(0);
  const readoutRef = useRef<HTMLSpanElement>(null);

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
    const w = rect.width;
    const h = rect.height;

    function draw() {
      const state = scoreRef.current;
      const buf = bufRef.current;
      buf.push(state.score);
      if (buf.length > POINTS) buf.shift();

      ctx!.clearRect(0, 0, w, h);

      // Threshold line.
      const ty = h - threshold * h;
      ctx!.strokeStyle = "rgba(239, 68, 68, 0.6)";
      ctx!.lineWidth = 1;
      ctx!.setLineDash([4, 3]);
      ctx!.beginPath();
      ctx!.moveTo(0, ty);
      ctx!.lineTo(w, ty);
      ctx!.stroke();
      ctx!.setLineDash([]);

      // Score line.
      const above = state.score >= threshold;
      ctx!.strokeStyle = above ? "rgb(139, 92, 246)" : "rgba(139, 92, 246, 0.7)";
      ctx!.lineWidth = above ? 2 : 1.5;
      ctx!.beginPath();
      for (let i = 0; i < buf.length; i++) {
        const x = (i / (POINTS - 1)) * w;
        const y = h - Math.max(0, Math.min(1, buf[i])) * h;
        if (i === 0) ctx!.moveTo(x, y);
        else ctx!.lineTo(x, y);
      }
      ctx!.stroke();

      if (readoutRef.current) {
        readoutRef.current.textContent =
          `${state.score.toFixed(2)} · speech ${state.speech ? "●" : "○"}`;
      }

      animRef.current = requestAnimationFrame(draw);
    }
    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [scoreRef, threshold]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "6px 8px",
        borderRadius: 8,
        background: "rgba(139, 92, 246, 0.06)",
        border: "1px solid rgba(139, 92, 246, 0.2)",
        fontSize: 11,
        fontFamily: "ui-monospace, monospace",
        color: "var(--text-secondary, #9ca3af)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span>wake: {phraseLabel} · {status}</span>
        <span ref={readoutRef}>0.00 · speech ○</span>
      </div>
      <canvas ref={canvasRef} style={{ width: "100%", height: 44, display: "block" }} />
      <div style={{ display: "flex", justifyContent: "space-between", opacity: 0.6 }}>
        <span>0.0</span>
        <span>threshold {threshold.toFixed(2)}</span>
        <span>1.0</span>
      </div>
    </div>
  );
}
