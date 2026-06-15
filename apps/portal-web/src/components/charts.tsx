import { useId } from "react";

/** Tiny pure-SVG charts (ported from the design reference) — the data behind
 * them is mock until M4 metering lands, so no charting dependency. */

export function Sparkline({
  data,
  w = 120,
  h = 34,
  stroke = "var(--az-acc)",
  fill = true,
  dot = false,
}: {
  data: number[];
  w?: number;
  h?: number;
  stroke?: string;
  fill?: boolean;
  dot?: boolean;
}) {
  const id = useId();
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const rng = max - min || 1;
  const pts = data.map(
    (d, i) => [(i / (data.length - 1)) * w, h - 2 - ((d - min) / rng) * (h - 4)] as const,
  );
  const path = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1]!;
  return (
    <svg width={w} height={h} style={{ display: "block", overflow: "visible" }} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity=".22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={`${path} L${w} ${h} L0 ${h} Z`} fill={`url(#${id})`} />}
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {dot && <circle cx={last[0]} cy={last[1]} r="2.6" fill={stroke} />}
    </svg>
  );
}

export function Bars({
  data,
  w = 240,
  h = 70,
  color = "var(--az-acc)",
}: {
  data: number[];
  w?: number;
  h?: number;
  color?: string;
}) {
  const max = Math.max(...data, 1);
  const bw = w / data.length;
  return (
    <svg
      width="100%"
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ display: "block" }}
      aria-hidden
    >
      {data.map((d, i) => {
        const bh = (d / max) * (h - 4);
        const isLast = i === data.length - 1;
        return (
          <rect
            key={i}
            x={i * bw + 1.5}
            y={h - bh}
            width={bw - 3}
            height={bh}
            rx="1.5"
            fill={
              isLast ? color : "color-mix(in srgb, var(--mantine-color-dark-2) 55%, transparent)"
            }
            opacity={isLast ? 1 : 0.5}
          />
        );
      })}
    </svg>
  );
}

export function Meter({ pct, tone, h = 6 }: { pct: number; tone?: string; h?: number }) {
  const color =
    tone ?? (pct > 92 ? "var(--az-bad)" : pct > 78 ? "var(--az-warn)" : "var(--az-acc)");
  return (
    <div
      style={{
        height: h,
        borderRadius: 99,
        background: "var(--mantine-color-dark-5)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${Math.min(pct, 100)}%`,
          height: "100%",
          background: color,
          borderRadius: 99,
          transition: "width .5s ease",
        }}
      />
    </div>
  );
}

export function Donut({
  segments,
  centerTop,
  centerBottom,
}: {
  segments: Array<[label: string, value: number, color: string]>;
  centerTop: string;
  centerBottom: string;
}) {
  const total = segments.reduce((s, x) => s + x[1], 0) || 1;
  const R = 52;
  const C = 2 * Math.PI * R;
  // Precompute arc offsets (cumulative sums) — no mutation during render.
  const arcs = segments.map(([label, v, color], i) => ({
    label,
    color,
    len: (v / total) * C,
    off: segments.slice(0, i).reduce((s, x) => s + (x[1] / total) * C, 0),
  }));
  return (
    <svg width="130" height="130" viewBox="0 0 130 130" aria-hidden>
      <circle
        cx="65"
        cy="65"
        r={R}
        fill="none"
        stroke="var(--mantine-color-dark-5)"
        strokeWidth="16"
      />
      {arcs.map(({ label, color, len, off }) => {
        return (
          <circle
            key={label}
            cx="65"
            cy="65"
            r={R}
            fill="none"
            stroke={color}
            strokeWidth="16"
            strokeDasharray={`${len} ${C - len}`}
            strokeDashoffset={-off}
            transform="rotate(-90 65 65)"
          />
        );
      })}
      <text
        x="65"
        y="61"
        textAnchor="middle"
        fontFamily="var(--mantine-font-family-monospace)"
        fontSize="19"
        fontWeight="600"
        fill="var(--mantine-color-dark-0)"
      >
        {centerTop}
      </text>
      <text
        x="65"
        y="78"
        textAnchor="middle"
        fontFamily="var(--mantine-font-family-monospace)"
        fontSize="9"
        fill="var(--mantine-color-dark-2)"
        letterSpacing="1.5"
      >
        {centerBottom}
      </text>
    </svg>
  );
}
