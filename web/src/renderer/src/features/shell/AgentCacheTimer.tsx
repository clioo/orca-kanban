// MIT Copyright (c) 2026 Lovecast Inc.
// Ported from components/sidebar/CacheTimer.tsx; session hook timestamps replace pane keys.
import { useSyncExternalStore } from "react";
import { Timer } from "lucide-react";
import type { Session } from "../../../../shared/session-contract";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "../../components/ui/tooltip";
import { useAgentSettings } from "../settings/agent-settings-state";
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer)
    timer = setInterval(() => {
      now = Date.now();
      for (const listener of listeners) listener();
    }, 1000);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
export function cacheCountdown(startedAt: number, ttlMs: number, now: number) {
  const remainingMs = Math.max(0, ttlMs - (now - startedAt));
  const seconds = Math.ceil(remainingMs / 1000);
  return {
    label: `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`,
    expired: remainingMs === 0,
    warning: remainingMs > 0 && remainingMs <= 60000,
  };
}
function CacheTimer({
  startedAt,
  ttlMs,
}: {
  startedAt: number;
  ttlMs: number;
}) {
  const time = useSyncExternalStore(
    subscribe,
    () => now,
    () => now,
  );
  const { label, expired, warning } = cacheCountdown(startedAt, ttlMs, time);
  const tooltipText = expired
    ? "The next message will re-send the full context as uncached tokens"
    : `Prompt cache expires in ${label}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={tooltipText}
          className={
            "inline-flex items-center gap-1 text-[10px] font-mono tabular-nums select-none leading-none " +
            (expired
              ? "text-red-400"
              : warning
                ? "text-yellow-400"
                : "text-muted-foreground")
          }
        >
          <Timer className="size-2.5" />
          {!expired && <span>{label}</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        <span>{tooltipText}</span>
      </TooltipContent>
    </Tooltip>
  );
}
export function AgentCacheTimer({ session }: { session: Session }) {
  const { settings } = useAgentSettings();
  if (
    !settings.promptCacheTimerEnabled ||
    session.harnessId !== "claude" ||
    session.verdict !== "live"
  )
    return null;
  const at =
    session.cacheIdleAt ??
    (session.agentState === "idle" ? session.agentStateAt : null);
  const startedAt = at ? Date.parse(at) : NaN;
  return Number.isFinite(startedAt) ? (
    <CacheTimer startedAt={startedAt} ttlMs={settings.promptCacheTtlMs} />
  ) : null;
}
