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

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
window.ResizeObserver = window.ResizeObserver ?? ResizeObserverStub;
window.HTMLElement.prototype.scrollIntoView =
  window.HTMLElement.prototype.scrollIntoView ?? (() => {});
