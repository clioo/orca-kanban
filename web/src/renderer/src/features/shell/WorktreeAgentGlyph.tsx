/* MIT Copyright (c) 2026 Lovecast Inc.
   Sidebar-local provider glyphs (owner's guide 2026-09-21): the sidebar
   rows need the recognizable Codex/OpenAI knot and a legible Pi, while the
   shared menu/tab branding in TabCreateMenuIcons.tsx stays exactly as it
   ships — this wrapper is the only sidebar entry point, and the menus and
   tab strip keep importing HarnessMenuIcon directly. Codex reuses the
   shipped OpenAIIcon from features/settings/agent-openai-icon.tsx (ported
   from Orca's status-bar/icons.tsx); Pi reuses the shipped pi.dev geometry
   from TabCreateMenuIcons.tsx with the viewBox cropped to the glyph's own
   ink (165..635 of the 800 canvas), so the same paths render legible at
   row size instead of sitting tiny in padding. Every other harness
   delegates to HarnessMenuIcon unchanged, and a null harness renders
   nothing so the row keeps its truthful Terminal fallback. Each glyph is
   aria-hidden: the row's own accessible label carries the announcement. */
import type { HarnessId } from "../../../../shared/session-contract";
import { HarnessMenuIcon } from "./TabCreateMenuIcons";
import { OpenAIIcon } from "../settings/agent-openai-icon";

/** The Pi ink bounds on the shipped 800 canvas: x/y 165..635 both ways. */
export const SIDEBAR_PI_VIEW_BOX = "165 165 470 470";

/** Shipped Pi geometry, verbatim from TabCreateMenuIcons.tsx's PiIcon. */
export const SIDEBAR_PI_BOWL_PATH =
  "M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z";
export const SIDEBAR_PI_LEG_PATH = "M517.36 400 H634.72 V634.72 H517.36 Z";

function SidebarPiGlyph({ size = 13 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      height={size}
      width={size}
      viewBox={SIDEBAR_PI_VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="shrink-0 text-current"
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d={SIDEBAR_PI_BOWL_PATH}
      />
      <path fill="currentColor" d={SIDEBAR_PI_LEG_PATH} />
    </svg>
  );
}

export function SidebarProviderGlyph({
  harnessId,
  displayName,
  size = 13,
}: {
  harnessId: HarnessId | null;
  displayName: string;
  size?: number;
}): React.JSX.Element | null {
  if (harnessId === null || harnessId === undefined) return null;
  if (harnessId === "codex") {
    return (
      <span className="inline-flex shrink-0" aria-hidden="true">
        <OpenAIIcon size={size} />
      </span>
    );
  }
  if (harnessId === "pi") {
    return (
      <span className="inline-flex shrink-0" aria-hidden="true">
        <SidebarPiGlyph size={size} />
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0" aria-hidden="true">
      <HarnessMenuIcon harnessId={harnessId} displayName={displayName} size={size} />
    </span>
  );
}
