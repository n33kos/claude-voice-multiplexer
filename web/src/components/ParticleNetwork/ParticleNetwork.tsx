import { useEffect, useRef } from "react";
import type { Connection, Particle } from "./ParticleNetwork.types";
import styles from "./ParticleNetwork.module.scss";

const PARTICLE_COUNT = Math.floor(window.innerWidth / 5);
const CONNECTION_DISTANCE = 200;
const PARTICLE_SPEED = 0.3;
const MAX_PARTICLE_SPEED = 0.5;
const PARTICLE_RADIUS = 1.5;
const REPULSION_MULTIPLIER = 0.001;
const BASE_DOT_OPACITY = 0.05;
const CONNECTION_BOOST = 0.05;
const LINE_OPACITY = 0.15;
const HUE_DRIFT = 0.1;

function getParticleLightness(): string {
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue("--particle-lightness")
      .trim() || "65%"
  );
}

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
    }));

    const animate = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const lightness = getParticleLightness();
      const pts = particles.current;

      for (const p of pts) {
        p.x += p.vx;
        p.y += p.vy;
        p.hue = (p.hue + HUE_DRIFT) % 360;
        p.connections = 0;

        if (p.x < 0 - CONNECTION_DISTANCE) p.x = w;
        if (p.x > w + CONNECTION_DISTANCE) p.x = 0;
        if (p.y < 0 - CONNECTION_DISTANCE) p.y = h;
        if (p.y > h + CONNECTION_DISTANCE) p.y = 0;

        // Apply drag back down to default speed
        if (Math.abs(p.vx) > MAX_PARTICLE_SPEED) p.vx *= 0.99;
        if (Math.abs(p.vy) > MAX_PARTICLE_SPEED) p.vy *= 0.99;
      }

      const connections: Map<string, Connection> = new Map();
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

            const connectionName = `${Math.min(i, j)}-${Math.max(i, j)}`;

            if (!connections.has(connectionName)) {
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

              connections.set(connectionName, { i, j, distance: dist });
            }
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
