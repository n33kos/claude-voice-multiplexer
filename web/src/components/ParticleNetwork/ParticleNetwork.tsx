import { useEffect, useRef } from "react";
import type { Particle } from "./ParticleNetwork.types";

const PARTICLE_COUNT = Math.floor(window.innerWidth / 10);
const CONNECTION_DISTANCE = 120;
const PARTICLE_SPEED = 0.3;
const PARTICLE_RADIUS = 1.5;
const BASE_DOT_OPACITY = 0.25;
const CONNECTION_BOOST = 0.08;
const LINE_OPACITY = 0.18;
const HUE_DRIFT = 0.1;

export function ParticleNetwork() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particles = useRef<Particle[]>([]);
  const animRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);

    particles.current = Array.from({ length: PARTICLE_COUNT }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * PARTICLE_SPEED * 2,
      vy: (Math.random() - 0.5) * PARTICLE_SPEED * 2,
      hue: Math.random() * 360,
      connections: 0,
    }));

    const animate = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const pts = particles.current;

      for (const p of pts) {
        p.x += p.vx;
        p.y += p.vy;
        p.hue = (p.hue + HUE_DRIFT) % 360;
        p.connections = 0;

        if (p.x < 0) p.x = w;
        if (p.x > w) p.x = 0;
        if (p.y < 0) p.y = h;
        if (p.y > h) p.y = 0;
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

            const grad = ctx.createLinearGradient(
              pts[i].x,
              pts[i].y,
              pts[j].x,
              pts[j].y,
            );
            grad.addColorStop(0, `hsla(${pts[i].hue}, 80%, 65%, ${opacity})`);
            grad.addColorStop(1, `hsla(${pts[j].hue}, 80%, 65%, ${opacity})`);

            ctx.beginPath();
            ctx.moveTo(pts[i].x, pts[i].y);
            ctx.lineTo(pts[j].x, pts[j].y);
            ctx.strokeStyle = grad;
            ctx.lineWidth = 1 * proximity;
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
        ctx.fillStyle = `hsla(${p.hue}, 80%, 65%, ${opacity})`;
        ctx.fill();
      }

      animRef.current = requestAnimationFrame(animate);
    };

    animRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      data-component="ParticleNetwork"
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: 0 }}
    />
  );
}
