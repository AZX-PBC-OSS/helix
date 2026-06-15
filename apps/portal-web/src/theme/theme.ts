import { createTheme, type CSSVariablesResolver, type MantineColorsTuple } from "@mantine/core";

/**
 * The AZX control-plane look: dark, engineered, instrument-grade. Tokens come
 * from the approved design reference — lime accent on near-black surfaces,
 * Space Grotesk display / Hanken Grotesk UI / JetBrains Mono data.
 */

/** Lime accent scale centered on #cdfa50 (index 4 = the brand accent). */
const accent: MantineColorsTuple = [
  "#f8ffe1",
  "#f0ffc0",
  "#e5ff94",
  "#dcfd72",
  "#cdfa50", // ← brand
  "#b9e644",
  "#9cc434",
  "#7fa226",
  "#64801a",
  "#4b6110",
];

/**
 * Mantine's dark scale mapped onto the reference surfaces: 8 = page (#08090b),
 * 7 = cards (#0d0f12), 6/5/4 = raised surfaces, 3–0 = ink from faint to full.
 */
const dark: MantineColorsTuple = [
  "#eef1f0",
  "#a4abad",
  "#6a7176",
  "#474d52",
  "#23282e",
  "#1a1e23",
  "#13161a",
  "#0d0f12",
  "#08090b",
  "#060708",
];

export const FONT_DISPLAY = "'Space Grotesk Variable', system-ui, sans-serif";
export const FONT_UI = "'Hanken Grotesk Variable', system-ui, sans-serif";
export const FONT_MONO = "'JetBrains Mono Variable', ui-monospace, monospace";

/** Semantic colors (status, severity) shared by CSS and SVG components. */
export const SEMANTIC = {
  live: "#7ee787",
  warn: "#f7b955",
  bad: "#ff6a55",
  info: "#7cb0ff",
  violet: "#b692ff",
  accent: "#cdfa50",
  accentInk: "#0b1000",
} as const;

export const theme = createTheme({
  colors: { accent, dark },
  primaryColor: "accent",
  primaryShade: 4,
  autoContrast: true,
  luminanceThreshold: 0.4,
  fontFamily: FONT_UI,
  fontFamilyMonospace: FONT_MONO,
  headings: {
    fontFamily: FONT_DISPLAY,
    fontWeight: "600",
  },
  defaultRadius: "md",
  radius: { xs: "4px", sm: "6px", md: "9px", lg: "14px", xl: "20px" },
  cursorType: "pointer",
  components: {
    Card: {
      defaultProps: { withBorder: true, padding: "lg", radius: "lg" },
      styles: {
        root: {
          backgroundColor: "var(--mantine-color-dark-7)",
          borderColor: "var(--az-line)",
        },
      },
    },
    Paper: {
      styles: {
        root: { backgroundColor: "var(--mantine-color-dark-7)" },
      },
    },
    Badge: {
      styles: {
        root: { fontFamily: FONT_MONO, letterSpacing: "0.04em", fontWeight: 600 },
      },
    },
    Table: {
      styles: {
        th: {
          fontFamily: FONT_MONO,
          fontSize: "10.5px",
          letterSpacing: "0.18em",
          textTransform: "uppercase" as const,
          color: "var(--mantine-color-dark-2)",
          fontWeight: 500,
        },
      },
    },
    Modal: {
      defaultProps: {
        overlayProps: { backgroundOpacity: 0.6, blur: 4 },
        radius: "xl",
      },
      styles: {
        content: { border: "1px solid var(--az-line-2)" },
        header: { backgroundColor: "transparent" },
      },
    },
    Tooltip: {
      defaultProps: { withArrow: true },
    },
  },
});

/** Page chrome + semantic vars the Mantine theme object can't express. */
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {},
  dark: {
    "--mantine-color-body": dark[8],
    "--mantine-color-text": dark[0],
    "--az-line": "rgba(255,255,255,.07)",
    "--az-line-2": "rgba(255,255,255,.12)",
    "--az-line-3": "rgba(255,255,255,.18)",
    "--az-acc": SEMANTIC.accent,
    "--az-acc-ink": SEMANTIC.accentInk,
    "--az-acc-dim": "rgba(205,250,80,.14)",
    "--az-live": SEMANTIC.live,
    "--az-live-dim": "rgba(126,231,135,.13)",
    "--az-warn": SEMANTIC.warn,
    "--az-warn-dim": "rgba(247,185,85,.13)",
    "--az-bad": SEMANTIC.bad,
    "--az-bad-dim": "rgba(255,106,85,.13)",
    "--az-info": SEMANTIC.info,
    "--az-info-dim": "rgba(124,176,255,.13)",
    "--az-violet": SEMANTIC.violet,
    "--az-violet-dim": "rgba(182,146,255,.13)",
  },
});
