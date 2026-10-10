import { useCallback, useLayoutEffect, useState } from "react";

export type ScrollEdges = {
  /** Content is hidden above the top edge. */
  above: boolean;
  /** Content is hidden below the bottom edge. */
  below: boolean;
};

const NONE: ScrollEdges = { above: false, below: false };

/**
 * Which edges of a scroll area have more content past them, so the area can
 * fade that edge instead of cutting a row in half. `revision` is anything
 * that changes when the content's height may have.
 */
export function useScrollEdges(
  element: HTMLElement | null,
  revision: unknown,
): ScrollEdges {
  const [edges, setEdges] = useState(NONE);
  const measure = useCallback(() => {
    if (!element) return;
    const above = element.scrollTop > 1;
    const below =
      element.scrollTop + element.clientHeight < element.scrollHeight - 1;
    setEdges((previous) =>
      previous.above === above && previous.below === below
        ? previous
        : { above, below },
    );
  }, [element]);
  useLayoutEffect(() => {
    if (!element) return;
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [element, measure]);
  useLayoutEffect(measure, [measure, revision]);
  return edges;
}

/** A mask that fades whichever edges have content past them. */
export function edgeFadeMask(
  edges: ScrollEdges,
  size = 28,
): string | undefined {
  if (!edges.above && !edges.below) return undefined;
  const top = edges.above ? `${size}px` : "0px";
  const bottom = edges.below ? `${size}px` : "0px";
  return `linear-gradient(to bottom, transparent 0, #000 ${top}, #000 calc(100% - ${bottom}), transparent 100%)`;
}
