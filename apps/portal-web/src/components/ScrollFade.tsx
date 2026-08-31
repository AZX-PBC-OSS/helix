import { useCallback, useEffect, useRef, type ReactNode } from "react";

/**
 * Horizontal **scroll shadows** — the affordance also travels as "scroll hints"
 * or "overflow indicators": a frosted gradient over whichever edge still has
 * table behind it, so a table too wide for its frame says so instead of looking
 * like it simply ends at the border. Scroll to an end and that end's fade goes
 * away; scroll back and the other one lights up.
 *
 * Replaces `Table.ScrollContainer` at every table wide enough to scroll, rather
 * than wrapping it. Two reasons to own the scroller: Mantine's default
 * `type="scrollarea"` buries the element that actually scrolls a few divs down
 * inside a `ScrollArea`, and the fades have to be positioned against the
 * viewport while the overflow is measured from the content — so we need a
 * handle on both boxes, not just the outer one.
 *
 * Everything visual lives in `.az-scrollfade` in theme/global.css; this owns
 * only the two data attributes it keys off.
 */

/**
 * Slack, in px, for sub-pixel layout. A table a fraction of a pixel wider than
 * its viewport can never reach a `scrollLeft` that makes the arithmetic come
 * out exact, so an exact comparison strands the right-hand fade lit at the end
 * of the travel — the one place it must be off.
 */
const EPSILON = 1;

/** Which edges have content hidden past them. Pure, so the arithmetic is testable
 *  without a layout engine — jsdom measures every box at zero. */
export function scrollEdges(m: { scrollLeft: number; scrollWidth: number; clientWidth: number }): {
  left: boolean;
  right: boolean;
} {
  // `scrollLeft` runs negative in an RTL container; only the distance travelled
  // matters, and which side it uncovers is the direction's business, not ours.
  const travelled = Math.abs(m.scrollLeft);
  const total = m.scrollWidth - m.clientWidth;
  return { left: travelled > EPSILON, right: total - travelled > EPSILON };
}

export function ScrollFade({
  minWidth,
  children,
}: {
  /** Width below which the content scrolls instead of being crushed, as
   *  `Table.ScrollContainer` takes it. Omit for a table whose columns are
   *  data-driven and have no sensible floor. */
  minWidth?: number | string;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);

  const sync = useCallback(() => {
    const rootEl = root.current;
    const view = viewport.current;
    if (!rootEl || !view) return;
    const { left, right } = scrollEdges(view);
    rootEl.toggleAttribute("data-fade-left", left);
    rootEl.toggleAttribute("data-fade-right", right);
  }, []);

  // Deliberately every render, and deliberately not through React state: the
  // audit table renders 200 rows, and a scroll handler that called `setState`
  // would re-render all of them on the frame a fade turns on. Re-measuring on
  // render is what catches a content change — a filter that drops the widest
  // cell can end the overflow, and no scroll or resize event announces that.
  useEffect(sync);

  useEffect(() => {
    const view = viewport.current;
    if (!view) return;
    view.addEventListener("scroll", sync, { passive: true });
    // The viewport resizes when the window or the sidebar does, neither of
    // which re-renders this subtree.
    const ro = new ResizeObserver(sync);
    ro.observe(view);
    return () => {
      view.removeEventListener("scroll", sync);
      ro.disconnect();
    };
  }, [sync]);

  return (
    <div className="az-scrollfade" ref={root}>
      <div className="az-scrollfade-viewport" ref={viewport}>
        <div style={{ minWidth }}>{children}</div>
      </div>
    </div>
  );
}
