import { type CSSProperties, useEffect, useRef } from "react";
import { SEMANTIC } from "../theme/theme";

/** Horizon height as a fraction of the scene. CSS (sky step, glow), the canvas
 *  and the main glass panel's minimum height (Shell) all read this one value, so
 *  they share a horizon on every viewport. */
export const HORIZON = 0.46;

/** One floor cell, in units of camera height. 0.25 puts the nearest cell at
 *  roughly 80px on a laptop screen. */
const CELL = 0.25;

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const { accent: CYAN, magenta: MAG, orange: ORANGE, gold: GOLD } = SEMANTIC;
const CREAM = "#fff3c8";

/**
 * The fixed vaporwave backdrop the whole app floats on: a banded sun setting
 * behind the horizon, its reflection on a perspective grid floor, and a
 * breathing glow. Every app surface is frosted glass over this scene (see
 * theme.ts / global.css).
 *
 * The sun, reflection, horizon and grid are one canvas so they share a single
 * coordinate system; the canvas measures its own box rather than the window,
 * because `vh` and `innerHeight` disagree while a mobile URL bar is showing.
 * Only the glow stays CSS, because it animates. Redraws on resize only.
 *
 * Pure decoration — `aria-hidden`, `pointer-events: none`, behind everything.
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
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Snap to device pixels so band edges and grid lines stay crisp.
      const snap = (v: number) => Math.round(v * dpr) / dpr;
      const horizon = snap(h * HORIZON);
      const cx = w / 2;
      const floor = h - horizon;

      // ---- Sun: ~70% above the horizon, the rest hidden behind it ----
      const r = Math.max(90, Math.min(150, w * 0.26, h * 0.26));
      const cy = horizon - r * 0.42;
      const sunTop = cy - r;

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w, horizon);
      ctx.clip();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      const sunFill = ctx.createLinearGradient(0, sunTop, 0, horizon);
      sunFill.addColorStop(0, CREAM);
      sunFill.addColorStop(0.28, GOLD);
      sunFill.addColorStop(0.62, ORANGE);
      sunFill.addColorStop(1, MAG);
      ctx.fillStyle = sunFill;
      ctx.fill();

      // Bands: gaps cut through to the sky, widening toward the horizon.
      // Cut with destination-out (the sun is the only thing drawn so far),
      // so the gaps show the CSS glow and sky behind the canvas.
      ctx.globalCompositeOperation = "destination-out";
      const bandStart = cy - r * 0.12;
      const bands = 6;
      const pitch = (horizon - bandStart) / bands;
      for (let i = 0; i < bands; i++) {
        const t = i / (bands - 1);
        const gap = Math.max(1, pitch * (0.12 + 0.43 * t));
        ctx.fillRect(cx - r, snap(bandStart + pitch * (i + 1) - gap), r * 2, snap(gap));
      }
      ctx.restore();

      // ---- Floor grid in true perspective ----
      // Camera height 1, nearest row (z = 1) at the bottom edge, so a floor point
      // at depth z sits at horizon + floor / z and lateral x at cx + floor * x / z.
      // Both line sets run all the way to the horizon. Where they crowd closer
      // than about 6px, each line dims in proportion, so the far floor reads
      // as an even glow meeting the horizon line rather than a band or a gap.
      const fade = (y: number) => {
        // Nearer lines are brighter, but far ones never fade out entirely.
        const d = (y - horizon) / floor;
        return 0.4 + 0.6 * Math.min(1, Math.pow(d, 0.6) * 1.1);
      };
      const rowColor = (a: number) => {
        const g = ctx.createLinearGradient(0, 0, w, 0);
        g.addColorStop(0, rgba(CYAN, a));
        g.addColorStop(0.5, rgba(MAG, a));
        g.addColorStop(1, rgba(ORANGE, a));
        return g;
      };

      ctx.lineWidth = 1;
      // Rows: one per world cell while they are at least 2px apart, then one
      // per 2px up to the horizon, each standing in for several cells.
      const minGap = 2;
      let y = h;
      let z = 1;
      while (y - horizon > 0.5) {
        const gap = (y - horizon) ** 2 * (CELL / floor); // on-screen row spacing
        const a = 0.42 * fade(y) * Math.min(1, gap / 6) * Math.max(1, minGap / gap);
        ctx.strokeStyle = rowColor(a);
        ctx.beginPath();
        ctx.moveTo(0, snap(y) + 0.5);
        ctx.lineTo(w, snap(y) + 0.5);
        ctx.stroke();
        if (gap >= minGap) {
          z += CELL;
          y = horizon + floor / z;
        } else {
          y -= minGap;
        }
      }

      // Verticals at the same world spacing, so cells stay square at any aspect.
      // Line j leaves the side of the screen at depth (w / 2) / (j * CELL) px, so
      // they reach far enough that every line meets the edge within 2px of the
      // horizon; stopping sooner leaves an empty wedge at each edge. On-screen
      // spacing at depth d px is CELL * d, so alpha ramps up linearly over the
      // first 40px to keep the converging lines an even tint. All lines of one
      // color share a gradient, so each color is a single stroke.
      const reach = Math.ceil(w / (4 * CELL));
      const ramp = Math.min(0.5, 40 / floor);
      const sides: [string, number, number][] = [
        [CYAN, -reach, -1],
        [ORANGE, 0, 0],
        [MAG, 1, reach],
      ];
      for (const [c, from, to] of sides) {
        const g = ctx.createLinearGradient(0, horizon, 0, h);
        g.addColorStop(0, rgba(c, 0));
        g.addColorStop(ramp, rgba(c, 0.08));
        g.addColorStop(1, rgba(c, 0.3));
        ctx.strokeStyle = g;
        ctx.beginPath();
        for (let j = from; j <= to; j++) {
          ctx.moveTo(cx, horizon);
          ctx.lineTo(cx + floor * j * CELL, h);
        }
        ctx.stroke();
      }

      // ---- Reflection: the visible sun mirrored and squashed onto the floor,
      // broken into ripples that thin out away from the horizon ----
      const depth = (horizon - sunTop) * 0.55;
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.beginPath();
      ctx.ellipse(cx, horizon, r * 0.96, depth, 0, 0, Math.PI);
      ctx.clip();
      const refl = ctx.createLinearGradient(0, horizon, 0, horizon + depth);
      refl.addColorStop(0, rgba(MAG, 0.6));
      refl.addColorStop(0.4, rgba(ORANGE, 0.32));
      refl.addColorStop(1, rgba(GOLD, 0));
      ctx.fillStyle = refl;
      let ry = horizon + 2;
      for (let i = 0; ry < horizon + depth; i++) {
        const t = (ry - horizon) / depth;
        const line = Math.max(1, 4 * (1 - t));
        const inset = r * 0.35 * t * (i % 2 ? 1 : 0.6);
        ctx.fillRect(cx - r + inset, snap(ry), (r - inset) * 2, snap(line));
        ry += line + 2 + 5 * t;
      }
      ctx.restore();

      // ---- Horizon: haze over the far floor, then one crisp line ----
      const hazeDepth = floor * 0.14;
      const haze = ctx.createLinearGradient(0, horizon, 0, horizon + hazeDepth);
      haze.addColorStop(0, "rgba(46,14,50,.3)");
      haze.addColorStop(0.5, "rgba(46,14,50,.1)");
      haze.addColorStop(1, "rgba(46,14,50,0)");
      ctx.fillStyle = haze;
      ctx.fillRect(0, horizon, w, hazeDepth);

      const line = ctx.createLinearGradient(0, 0, w, 0);
      line.addColorStop(0, rgba(CYAN, 0.25));
      line.addColorStop(0.5 - (r * 1.4) / w, rgba(MAG, 0.55));
      line.addColorStop(0.5, rgba(ORANGE, 0.95));
      line.addColorStop(0.5 + (r * 1.4) / w, rgba(MAG, 0.55));
      line.addColorStop(1, rgba(ORANGE, 0.25));
      ctx.fillStyle = line;
      ctx.fillRect(0, horizon, w, 1);
    }

    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, []);

  return (
    <div
      className="az-scene"
      aria-hidden="true"
      style={{ "--az-horizon": `${HORIZON * 100}%` } as CSSProperties}
    >
      <div className="az-sun-glow" />
      <canvas ref={canvasRef} className="az-grid" />
    </div>
  );
}
