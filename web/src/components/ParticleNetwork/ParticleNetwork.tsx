import { useEffect, useRef } from "react";
import type React from "react";
import type { Particle } from "./ParticleNetwork.types";
import { sessionHue } from "../../utils/sessionHue";
import styles from "./ParticleNetwork.module.scss";

const PARTICLE_COUNT = Math.floor(
  (window.innerWidth * window.innerHeight) / 5000,
);
const CONNECTION_DISTANCE = 150;
const PARTICLE_SPEED = 0.3;
const MAX_PARTICLE_SPEED = 0.5;
const PARTICLE_RADIUS = 1.5;
const REPULSION_MULTIPLIER = 0.001;
const BASE_DOT_OPACITY = 0.02;
const CONNECTION_BOOST = 0.03;
const LINE_OPACITY = 0.12;
const HUE_DRIFT = 0.1;
const HUE_RANGE = 40; // degrees of hue variation when session-locked
const HUE_LERP_SPEED = 0.02; // how fast particles converge to target hue
const AUDIO_SPEED_MAX = 5.0; // max speed multiplier at full amplitude
const AUDIO_LERP_UP = 0.7;   // how fast multiplier rises with audio
const AUDIO_LERP_DOWN = 0.12; // how fast multiplier decays back to 1

function getParticleLightness(): string {
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue("--particle-lightness")
      .trim() || "65%"
  );
}

interface ParticleNetworkProps {
  sessionId?: string | null;
  hueOverride?: number;
  analyserRef?: React.MutableRefObject<AnalyserNode | null>;
  audioReactive?: boolean;
}

export function ParticleNetwork({ sessionId, hueOverride, analyserRef, audioReactive }: ParticleNetworkProps = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particles = useRef<Particle[]>([]);
  const animRef = useRef<number>(0);
  const lightnessRef = useRef(getParticleLightness());
  const sessionIdRef = useRef(sessionId);
  const hueOverrideRef = useRef(hueOverride);
  const analyserRefRef = useRef(analyserRef);
  const audioReactiveRef = useRef(audioReactive);
  const speedMultiplierRef = useRef(1.0);
  const freqDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);

  // Keep refs in sync so animation loop sees latest value
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    hueOverrideRef.current = hueOverride;
  }, [hueOverride]);

  useEffect(() => {
    analyserRefRef.current = analyserRef;
  }, [analyserRef]);

  useEffect(() => {
    audioReactiveRef.current = audioReactive;
  }, [audioReactive]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Update cached lightness on theme change
    const observer = new MutationObserver(() => {
      lightnessRef.current = getParticleLightness();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);

    const onClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      particles.current.forEach((p) => {
        const dx = p.x - x;
        const dy = p.y - y;
        p.vx -= dx / 2000;
        p.vy -= dy / 2000;
      });
    };
    window.addEventListener("click", onClick);

    particles.current = Array.from({ length: PARTICLE_COUNT }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * PARTICLE_SPEED * 2,
      vy: (Math.random() - 0.5) * PARTICLE_SPEED * 2,
      hue: Math.random() * 360,
      connections: 0,
      targetHueOffset: (Math.random() - 0.5) * HUE_RANGE,
    }));

    const animate = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const lightness = lightnessRef.current;
      const pts = particles.current;
      const sid = sessionIdRef.current;
      const baseHue = hueOverrideRef.current != null
        ? hueOverrideRef.current
        : (sid ? sessionHue(sid) : null);

      // Audio-reactive speed multiplier
      if (audioReactiveRef.current) {
        const analyser = analyserRefRef.current?.current;
        if (analyser) {
          if (!freqDataRef.current || freqDataRef.current.length !== analyser.frequencyBinCount) {
            freqDataRef.current = new Uint8Array(analyser.frequencyBinCount);
          }
          analyser.getByteFrequencyData(freqDataRef.current);
          let sum = 0;
          for (let k = 0; k < freqDataRef.current.length; k++) sum += freqDataRef.current[k];
          const amplitude = sum / (freqDataRef.current.length * 255);
          const target = 1 + amplitude * (AUDIO_SPEED_MAX - 1);
          const lerpRate = target > speedMultiplierRef.current ? AUDIO_LERP_UP : AUDIO_LERP_DOWN;
          speedMultiplierRef.current += (target - speedMultiplierRef.current) * lerpRate;
        } else {
          // No analyser — decay back to 1
          speedMultiplierRef.current += (1 - speedMultiplierRef.current) * AUDIO_LERP_DOWN;
        }
      } else {
        speedMultiplierRef.current = 1.0;
      }
      const speedMult = speedMultiplierRef.current;

      for (const p of pts) {
        p.x += p.vx * speedMult;
        p.y += p.vy * speedMult;

        if (baseHue !== null) {
          // Lerp toward a target within the session's hue range
          const target = baseHue + (p.targetHueOffset ?? 0);
          // Shortest-path hue lerp on the 0-360 circle
          let delta = ((target - p.hue + 540) % 360) - 180;
          p.hue = (p.hue + delta * HUE_LERP_SPEED + 360) % 360;
        } else {
          // Free drift across full spectrum
          p.hue = (p.hue + HUE_DRIFT) % 360;
        }

        p.connections = 0;

        // Bounce off edges
        if (p.x <= 0) { p.x = 0; p.vx = Math.abs(p.vx); }
        if (p.x >= w) { p.x = w; p.vx = -Math.abs(p.vx); }
        if (p.y <= 0) { p.y = 0; p.vy = Math.abs(p.vy); }
        if (p.y >= h) { p.y = h; p.vy = -Math.abs(p.vy); }

        // Apply drag back down to default speed
        if (Math.abs(p.vx) > MAX_PARTICLE_SPEED) p.vx *= 0.99;
        if (Math.abs(p.vy) > MAX_PARTICLE_SPEED) p.vy *= 0.99;
      }

      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const dx = pts[i].x - pts[j].x;
          const dy = pts[i].y - pts[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < CONNECTION_DISTANCE) {
            const proximity = 1 - dist / CONNECTION_DISTANCE;
            const opacity = LINE_OPACITY * proximity;

            pts[i].connections++;
            pts[j].connections++;

            // Push away from each other slightly based on proximity
            const pushFactor =
              ((CONNECTION_DISTANCE - dist) / CONNECTION_DISTANCE) *
              REPULSION_MULTIPLIER;
            pts[i].vx += (dx / dist) * pushFactor;
            pts[i].vy += (dy / dist) * pushFactor;
            pts[j].vx -= (dx / dist) * pushFactor;
            pts[j].vy -= (dy / dist) * pushFactor;

            const grad = ctx.createLinearGradient(
              pts[i].x,
              pts[i].y,
              pts[j].x,
              pts[j].y,
            );
            grad.addColorStop(
              0,
              `hsla(${pts[i].hue}, 80%, ${lightness}, ${opacity})`,
            );
            grad.addColorStop(
              1,
              `hsla(${pts[j].hue}, 80%, ${lightness}, ${opacity})`,
            );

            ctx.beginPath();
            ctx.moveTo(pts[i].x, pts[i].y);
            ctx.lineTo(pts[j].x, pts[j].y);
            ctx.strokeStyle = grad;
            ctx.lineWidth = PARTICLE_RADIUS * proximity;
            ctx.stroke();
          }
        }
      }

      for (const p of pts) {
        const opacity = Math.min(
          1,
          BASE_DOT_OPACITY + p.connections * CONNECTION_BOOST,
        );
        ctx.beginPath();
        ctx.arc(p.x, p.y, PARTICLE_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${p.hue}, 80%, ${lightness}, ${opacity})`;
        ctx.fill();
      }

      animRef.current = requestAnimationFrame(animate);
    };

    animRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener("resize", resize);
      window.removeEventListener("click", onClick);
      observer.disconnect();
    };
  }, []);

  return (
    <canvas
      data-component="ParticleNetwork"
      ref={canvasRef}
      className={styles.Canvas}
    />
  );
}
