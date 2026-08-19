import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Testing-library's auto-cleanup needs vitest globals, which we don't enable —
// register it explicitly so the DOM doesn't accumulate across tests.
afterEach(cleanup);

// Mantine-in-jsdom shims (https://mantine.dev/guides/vitest/): components use
// matchMedia, ResizeObserver, and scrollIntoView, none of which jsdom provides.

window.matchMedia = (query: string): MediaQueryList =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

// Recharts' ResponsiveContainer (via @mantine/charts) sizes itself from the
// ResizeObserver entry, and jsdom lays everything out at 0 — an observer that
// never fires leaves the chart unmeasured and console.erroring about its
// container. Report one fixed box on observe so charts mount at a plausible
// size. Assigned unconditionally rather than only when absent: a jsdom that
// grows a real ResizeObserver would measure the same 0-height layout and put
// the warning back. (ResponsiveContainer still logs once for its pre-measurement
// render — initialDimension defaults to -1 and @mantine/charts doesn't forward
// it — which is dev-only and equally true in a browser.)
const OBSERVED_BOX = { width: 800, height: 400 };

class ResizeObserverStub implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    const box: ResizeObserverSize = {
      inlineSize: OBSERVED_BOX.width,
      blockSize: OBSERVED_BOX.height,
    };
    const entry: ResizeObserverEntry = {
      target,
      contentRect: DOMRectReadOnly.fromRect({ x: 0, y: 0, ...OBSERVED_BOX }),
      borderBoxSize: [box],
      contentBoxSize: [box],
      devicePixelContentBoxSize: [box],
    };
    this.callback([entry], this);
  }
  unobserve(): void {}
  disconnect(): void {}
}
window.ResizeObserver = ResizeObserverStub;
window.HTMLElement.prototype.scrollIntoView =
  window.HTMLElement.prototype.scrollIntoView ?? (() => {});

// jsdom implements neither downloads nor navigation, so the synthetic anchor in
// lib/download.ts makes it try to navigate to the blob: URL and log "Not
// implemented: navigation to another Document" on stderr. A real browser saves
// the file and stays on the page — model that by swallowing the click when the
// anchor carries `download`. Tests assert on the Blob handed to
// URL.createObjectURL, so nothing observable is lost.
const anchorClick = window.HTMLAnchorElement.prototype.click;
window.HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement): void {
  if (this.hasAttribute("download")) return;
  anchorClick.call(this);
};
