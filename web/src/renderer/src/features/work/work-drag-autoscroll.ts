// Edge auto-scroll while dragging a card or a column: native drag and drop
// never scrolls an overflowing container, so what sits off screen could not
// be reached. Near an edge (a hot zone inside the container) it scrolls,
// faster the closer the pointer is, after a short delay so passing over an
// edge does not scroll; it stops on leaving the zone, dropping or ending.
import { type RefObject, useEffect } from "react";

/** Hot zone depth inside each edge, in px. */
export const EDGE_ZONE = 72;
/** Fastest scroll, at the very edge, in px per frame. */
export const MAX_SPEED = 24;
/** How long the pointer rests in a zone before scrolling starts, in ms. */
export const START_DELAY = 150;

/** Scroll speed for a pointer at `pointer` on an axis spanning `start`–`end`:
 *  negative toward the start, positive toward the end, 0 outside the zones.
 *  It ramps up quadratically, so the inner part of a zone scrolls slowly
 *  enough to aim. */
export function edgeScrollSpeed(
  pointer: number,
  start: number,
  end: number,
  zone = EDGE_ZONE,
  max = MAX_SPEED,
): number {
  const size = end - start;
  if (size <= 0) return 0;
  const depth = Math.min(zone, size / 2);
  const fromStart = pointer - start;
  const fromEnd = end - pointer;
  const ramp = (distance: number) => {
    const t = 1 - Math.max(0, distance) / depth;
    return Math.max(1, Math.round(max * t * t));
  };
  if (fromStart < depth) return -ramp(fromStart);
  if (fromEnd < depth) return ramp(fromEnd);
  return 0;
}

/** Scrolls `ref` along `axis` while a drag of one of `types` nears an edge. */
export function useDragAutoScroll(
  ref: RefObject<HTMLElement | null>,
  axis: "x" | "y",
  types: readonly string[],
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Looked up per call, not captured once, so a swapped clock is honoured.
    const raf = (cb: FrameRequestCallback): number =>
      typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame(cb)
        : window.setTimeout(() => cb(performance.now()), 16);
    const cancelRaf = (id: number) =>
      typeof window.cancelAnimationFrame === "function"
        ? window.cancelAnimationFrame(id)
        : window.clearTimeout(id);
    let speed = 0;
    let frame: number | null = null;
    let delay: number | null = null;

    const stop = () => {
      speed = 0;
      if (frame !== null) cancelRaf(frame);
      if (delay !== null) window.clearTimeout(delay);
      frame = null;
      delay = null;
    };
    const step = () => {
      frame = null;
      if (speed === 0) return;
      if (axis === "x") el.scrollLeft += speed;
      else el.scrollTop += speed;
      frame = raf(step);
    };
    const onDragOver = (event: DragEvent) => {
      const dragged = event.dataTransfer?.types ?? [];
      if (!types.some((type) => Array.from(dragged).includes(type))) return;
      const rect = el.getBoundingClientRect();
      speed =
        axis === "x"
          ? edgeScrollSpeed(event.clientX, rect.left, rect.right)
          : edgeScrollSpeed(event.clientY, rect.top, rect.bottom);
      if (speed === 0) {
        stop();
        return;
      }
      if (frame === null && delay === null) {
        delay = window.setTimeout(() => {
          delay = null;
          if (speed !== 0 && frame === null) frame = raf(step);
        }, START_DELAY);
      }
    };
    const onDragLeave = (event: DragEvent) => {
      if (!el.contains(event.relatedTarget as Node | null)) stop();
    };
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("dragleave", onDragLeave);
    el.addEventListener("drop", stop);
    window.addEventListener("dragend", stop);
    window.addEventListener("drop", stop);
    return () => {
      stop();
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("dragleave", onDragLeave);
      el.removeEventListener("drop", stop);
      window.removeEventListener("dragend", stop);
      window.removeEventListener("drop", stop);
    };
  }, [ref, axis, types]);
}
