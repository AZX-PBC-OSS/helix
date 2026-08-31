import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { ScrollFade, scrollEdges } from "../components/ScrollFade";

/**
 * jsdom lays every box out at zero, so the interesting arithmetic is tested
 * against `scrollEdges` directly and the component test stubs the three
 * measurements a real layout would have supplied.
 */
describe("scrollEdges", () => {
  it("shows nothing when the content fits", () => {
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 800, clientWidth: 800 })).toEqual({
      left: false,
      right: false,
    });
  });

  it("shows only the right edge at the start of a scrollable table", () => {
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 1160, clientWidth: 960 })).toEqual({
      left: false,
      right: true,
    });
  });

  it("shows both edges mid-scroll", () => {
    expect(scrollEdges({ scrollLeft: 100, scrollWidth: 1160, clientWidth: 960 })).toEqual({
      left: true,
      right: true,
    });
  });

  it("drops the right edge once scrolled all the way over", () => {
    expect(scrollEdges({ scrollLeft: 200, scrollWidth: 1160, clientWidth: 960 })).toEqual({
      left: true,
      right: false,
    });
  });

  /**
   * The bug the epsilon exists for: a content width that is a fraction of a
   * pixel over the viewport can never be scrolled to an exact match, so a `> 0`
   * test leaves the fade lit at the end of the travel — the one position where
   * there is provably nothing more to reveal.
   */
  it("treats a sub-pixel remainder as fully scrolled", () => {
    expect(scrollEdges({ scrollLeft: 199.6, scrollWidth: 1160.4, clientWidth: 960 })).toEqual({
      left: true,
      right: false,
    });
  });

  /** RTL containers count the same travel with a negative `scrollLeft`. */
  it("reads a negative scrollLeft as travel, not as an underflow", () => {
    expect(scrollEdges({ scrollLeft: -200, scrollWidth: 1160, clientWidth: 960 })).toEqual({
      left: true,
      right: false,
    });
  });
});

/** Stand in for the layout jsdom never performs. */
function measure(el: Element, m: { scrollLeft: number; scrollWidth: number; clientWidth: number }) {
  for (const [k, value] of Object.entries(m)) {
    Object.defineProperty(el, k, { configurable: true, writable: true, value });
  }
}

describe("<ScrollFade>", () => {
  /** No providers: ScrollFade touches nothing but its own two boxes, and
   *  keeping the rendered root the same element across a `rerender` is what
   *  makes the re-measure-on-render case observable at all. */
  const ui = (rows: number) => (
    <ScrollFade minWidth={1160}>
      <table>
        <tbody>
          {Array.from({ length: rows }, (_, i) => (
            <tr key={i}>
              <td>row {i}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollFade>
  );

  function setup() {
    const { container, rerender } = render(ui(3));
    const root = container.querySelector(".az-scrollfade");
    const viewport = container.querySelector(".az-scrollfade-viewport");
    if (!root || !viewport) throw new Error("ScrollFade did not render its boxes");
    return { root, viewport, rerender: (rows: number) => rerender(ui(rows)) };
  }

  it("marks the right edge, then swaps to the left as it scrolls over", () => {
    const { root, viewport } = setup();

    measure(viewport, { scrollLeft: 0, scrollWidth: 1160, clientWidth: 960 });
    fireEvent.scroll(viewport);
    expect(root.hasAttribute("data-fade-left")).toBe(false);
    expect(root.hasAttribute("data-fade-right")).toBe(true);

    measure(viewport, { scrollLeft: 100, scrollWidth: 1160, clientWidth: 960 });
    fireEvent.scroll(viewport);
    expect(root.hasAttribute("data-fade-left")).toBe(true);
    expect(root.hasAttribute("data-fade-right")).toBe(true);

    measure(viewport, { scrollLeft: 200, scrollWidth: 1160, clientWidth: 960 });
    fireEvent.scroll(viewport);
    expect(root.hasAttribute("data-fade-left")).toBe(true);
    expect(root.hasAttribute("data-fade-right")).toBe(false);
  });

  /**
   * The case no event reports: filtering out the widest row can end the
   * overflow without the viewport resizing or anything scrolling, so the fade
   * has to be re-measured on the render itself or it stays lit over a table
   * that now fits.
   */
  it("clears the fade when a re-render leaves the content fitting", () => {
    const { root, viewport, rerender } = setup();

    measure(viewport, { scrollLeft: 0, scrollWidth: 1160, clientWidth: 960 });
    fireEvent.scroll(viewport);
    expect(root.hasAttribute("data-fade-right")).toBe(true);

    measure(viewport, { scrollLeft: 0, scrollWidth: 960, clientWidth: 960 });
    rerender(1);
    expect(root.hasAttribute("data-fade-right")).toBe(false);
  });

  it("applies minWidth to the content, not to the scrolling box", () => {
    const { viewport } = setup();
    const content = viewport.firstElementChild as HTMLElement;
    expect(content.style.minWidth).toBe("1160px");
    expect((viewport as HTMLElement).style.minWidth).toBe("");
  });
});
