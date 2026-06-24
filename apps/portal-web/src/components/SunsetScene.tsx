import { useEffect, useRef } from "react";

/**
 * The fixed vaporwave backdrop the whole app floats on: a banded sun + breathing
 * glow + its grid-floor reflection, with a perspective grid drawn on canvas. Every
 * app surface is frosted glass over this scene (see theme.ts / global.css).
 *
 * Pure decoration — `aria-hidden`, `pointer-events: none`, behind everything at
 * z-index 0. The grid is canvas (cheap, redraws only on resize); the sun/glow/
 * reflection are CSS so they cost nothing to keep on screen.
 */
export function SunsetScene() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function draw() {
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const horizon = h * 0.46;
      const vx = w / 2;

      // Receding floor lines, accelerating toward the viewer, tinted along the sunset.
      const rows = 20;
      for (let i = 1; i <= rows; i++) {
        const t = i / rows;
        const y = horizon + (h - horizon) * (t * t);
        const a = 0.5 * (1 - t) + 0.05;
        const g = ctx.createLinearGradient(0, y, w, y);
        g.addColorStop(0, `rgba(45,226,230,${a})`);
        g.addColorStop(0.5, `rgba(255,43,214,${a})`);
        g.addColorStop(1, `rgba(255,138,61,${a})`);
        ctx.strokeStyle = g;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Verticals converging on the vanishing point.
      const cols = 26;
      for (let i = -cols; i <= cols; i++) {
        const xb = vx + (i / cols) * w * 1.6;
        const g = ctx.createLinearGradient(vx, horizon, xb, h);
        g.addColorStop(0, "rgba(255,138,61,0)");
        g.addColorStop(1, i < 0 ? "rgba(45,226,230,.28)" : "rgba(255,43,214,.28)");
        ctx.strokeStyle = g;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(vx, horizon);
        ctx.lineTo(xb, h);
        ctx.stroke();
      }
    }

    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, []);

  return (
    <div className="az-scene" aria-hidden="true">
      <div className="az-sun-glow" />
      <div className="az-sun" />
      <div className="az-reflection" />
      <canvas ref={canvasRef} className="az-grid" />
    </div>
  );
}
