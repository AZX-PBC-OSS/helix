import type { CSSProperties } from "react";
import { createTheme, type CSSVariablesResolver, type MantineColorsTuple } from "@mantine/core";

/**
 * The AZX control-plane look — "Sunset" key. A fixed vaporwave scene (banded sun
 * + grid + reflection, see SunsetScene) sits behind the whole app; every surface
 * is a frosted, scanlined sheet of glass over it. Warm orange leads (CTAs), with
 * the cyan↔magenta duotone living in the sunset gradient, grid, and accents.
 * Space Grotesk display / Hanken Grotesk UI / JetBrains Mono data.
 *
 * This is a single, self-contained restyle layered on the prior "Outrun" tokens
 * — revertible as one commit if the warmth proves divisive.
 */

/** Cyan accent scale centered on #2de2e6 (index 4 = the brand accent / primary). */
const accent: MantineColorsTuple = [
  "#e0fcfd",
  "#c0f8fa",
  "#93f1f4",
  "#5ee9ed",
  "#2de2e6", // ← brand (primary)
  "#22cace",
  "#1aa9ad",
  "#15888b",
  "#116a6d",
  "#0c4d4f",
];

/** Magenta scale centered on #ff2bd6 (index 4) — the hot secondary of the duotone. */
const magenta: MantineColorsTuple = [
  "#ffe3f8",
  "#ffc0f1",
  "#ff93e6",
  "#ff5cdc",
  "#ff2bd6", // ← brand (secondary)
  "#e622bf",
  "#c21aa0",
  "#9c1581",
  "#7a1065",
  "#570b49",
];

/** Sunset orange scale centered on #ff8a3d (index 4) — the warm lead (primary/CTA). */
const orange: MantineColorsTuple = [
  "#fff4e6",
  "#ffe3c4",
  "#ffcb96",
  "#ffae63",
  "#ff8a3d", // ← brand (primary / CTA)
  "#f5701f",
  "#d65a14",
  "#ad470f",
  "#84360b",
  "#5c2507",
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
  accent: "#2de2e6", // cyan — accent (chevrons, links, info)
  accentInk: "#04201f", // dark teal ink for text on the cyan accent
  magenta: "#ff2bd6", // hot secondary
  orange: "#ff8a3d", // sunset orange — primary / CTA
  orangeInk: "#2a1200", // dark ink for text on the orange CTA
  gold: "#ffd166", // sun core
  slate: "#8f99ac", // the logo chevron — neutral bridge
} as const;

/** The signature cyan→magenta→orange sunset, reused by heroes, rules, and the grid. */
const SUNSET = "linear-gradient(100deg, #2de2e6 0%, #ff2bd6 52%, #ff8a3d 100%)";

/** One sheet of frosted, scanlined glass — every surface floats on the sunset. */
const SCANLINES =
  "repeating-linear-gradient(to bottom, transparent 0 2px, rgba(0,0,0,.10) 2px 3px)";

export const theme = createTheme({
  colors: { accent, magenta, orange, dark },
  primaryColor: "orange",
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
    // Inner panels are plain frosted slabs (no scanlines — those live on the
    // screen glass only, so cards don't moiré against it).
    Card: {
      defaultProps: { withBorder: true, padding: "lg", radius: "lg" },
      styles: {
        root: {
          backgroundColor: "var(--az-frost-solid)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          borderColor: "var(--az-line)",
        },
      },
    },
    Paper: {
      styles: {
        root: {
          backgroundColor: "var(--az-frost-solid)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        },
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
    // Stock Mantine dresses an accordion for light mode — a gray-3 border and
    // a dark-6 active fill, both wrong against the frosted glass. Left chevron
    // so the disclosure arrow lands where the eyebrow's own chevron used to.
    Accordion: {
      defaultProps: {
        variant: "separated",
        chevronPosition: "left",
        radius: "md",
        chevronSize: 11,
      },
      styles: {
        // Component-scoped vars Mantine sets on its own root class, so a
        // cssVariablesResolver entry on :root would lose to it.
        root: {
          "--item-border-color": "var(--az-line)",
          "--item-filled-color": "rgba(255,255,255,.03)",
        } as CSSProperties,
        control: { paddingInline: 14 },
        content: { paddingInline: 14, paddingBottom: 14 },
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
    "--az-line": "rgba(255,255,255,.09)",
    "--az-line-2": "rgba(255,255,255,.15)",
    "--az-line-3": "rgba(255,255,255,.20)",
    "--az-acc": SEMANTIC.accent,
    "--az-acc-ink": SEMANTIC.accentInk,
    "--az-acc-dim": "rgba(45,226,230,.14)",
    "--az-mag": SEMANTIC.magenta,
    "--az-mag-dim": "rgba(255,43,214,.14)",
    "--az-orange": SEMANTIC.orange,
    "--az-orange-ink": SEMANTIC.orangeInk,
    "--az-orange-dim": "rgba(255,138,61,.14)",
    "--az-gold": SEMANTIC.gold,
    "--az-sunset": SUNSET,
    "--az-scanlines": SCANLINES,
    "--az-frost": "rgba(11,13,17,.62)",
    "--az-frost-solid": "rgba(13,15,19,.80)",
    "--az-slate": SEMANTIC.slate,
    "--az-slate-dim": "rgba(143,153,172,.16)",
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
