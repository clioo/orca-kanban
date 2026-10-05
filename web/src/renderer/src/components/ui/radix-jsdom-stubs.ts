// Test-only helpers for mounting Radix-based primitives under jsdom.
// Not imported by any product code: only *.test.tsx files use this.
// jsdom lacks the layout/pointer APIs Radix popper and Select rely on.

type ResizeObserverStub = {
  observe: () => void;
  unobserve: () => void;
  disconnect: () => void;
};

type DOMRectLike = {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
  toJSON: () => DOMRectLike;
};

let installed = false;

export function installRadixJsdomStubs(): void {
  if (installed) return;
  installed = true;

  const g = globalThis as typeof globalThis & {
    ResizeObserver?: new (cb: ResizeObserverCallback) => ResizeObserverStub;
  };
  const mutableGlobal = globalThis as { DOMRectReadOnly?: unknown };

  g.ResizeObserver ??= class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  // Radix popper measures trigger/content rects; jsdom returns zeros, which is
  // fine — but DOMRectReadOnly construction inside popper needs a constructor.
  mutableGlobal.DOMRectReadOnly ??= class DOMRectReadOnlyStub implements DOMRectLike {
    x = 0;
    y = 0;
    width = 0;
    height = 0;
    top = 0;
    right = 0;
    bottom = 0;
    left = 0;
    toJSON() {
      return this;
    }
  };

  // Highlight/scroll management in menus and selects calls these.
  Element.prototype.scrollIntoView ??= () => {};
  HTMLElement.prototype.hasPointerCapture ??= () => false;
  HTMLElement.prototype.releasePointerCapture ??= () => {};
  HTMLElement.prototype.setPointerCapture ??= () => {};
}

/** First element carrying the source's `data-slot` marker, searching from
 *  `root` (defaults to document, so portaled content is found too). */
export function getSlot(slot: string, root?: ParentNode): HTMLElement {
  const el = (root ?? document).querySelector<HTMLElement>(`[data-slot="${slot}"]`);
  if (!el) throw new Error(`no element with data-slot="${slot}"`);
  return el;
}

export function querySlot(slot: string, root?: ParentNode): HTMLElement | null {
  return (root ?? document).querySelector<HTMLElement>(`[data-slot="${slot}"]`);
}
