// Deep-link seam for the Tasks page's initial source (#346). The fork's
// openTaskPage({ taskSource }) rides the zustand store; Drogon routes by
// bare route id with no query channel, so a sidebar chip click parks the
// requested source here and routes. The Tasks page consumes the pending
// value on mount and subscribes while mounted (App keeps the page alive,
// hidden, across route switches), so both the first visit and a later
// chip click land on the requested source.
export type TaskSource = "github" | "gitlab" | "linear" | "jira";

const TASK_SOURCES: readonly string[] = [
  "github",
  "gitlab",
  "linear",
  "jira",
] satisfies TaskSource[];

/** Narrows a provider id (e.g. a Work source) to a Tasks page source. */
export function isTaskSource(id: string): id is TaskSource {
  return TASK_SOURCES.includes(id);
}

let pendingTaskSource: TaskSource | null = null;
const listeners = new Set<(source: TaskSource) => void>();

/** Parks the source and notifies a mounted Tasks page immediately. */
export function requestTaskSourceNavigation(source: TaskSource): void {
  pendingTaskSource = source;
  for (const listener of listeners) listener(source);
}

/** Read-and-clear of the source requested before the page mounted. */
export function consumePendingTaskSource(): TaskSource | null {
  const source = pendingTaskSource;
  pendingTaskSource = null;
  return source;
}

/** Live channel for chip clicks while the page stays mounted. */
export function subscribeTaskSourceNavigation(
  listener: (source: TaskSource) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A source whose connect flow was asked for (Work's "Connect Jira on the
 *  Tasks page"): parked like the source itself, consumed by the page. */
let pendingConnectSource: TaskSource | null = null;
const connectListeners = new Set<(source: TaskSource) => void>();

/** Routes to `source` and asks the page to open its connect flow. */
export function requestTaskSourceConnect(source: TaskSource): void {
  pendingConnectSource = source;
  requestTaskSourceNavigation(source);
  for (const listener of connectListeners) listener(source);
}

export function consumePendingTaskSourceConnect(): TaskSource | null {
  const source = pendingConnectSource;
  pendingConnectSource = null;
  return source;
}

export function subscribeTaskSourceConnect(
  listener: (source: TaskSource) => void,
): () => void {
  connectListeners.add(listener);
  return () => {
    connectListeners.delete(listener);
  };
}

/** Fork resolveVisibleTaskProvider semantics against the renderable
 *  sources: a request for a source the page cannot render yet (Jira
 *  before R17-B) falls back to the default instead of blanking the page. */
export function resolveRequestedTaskSource(
  requested: TaskSource | null,
  renderableSourceIds: readonly string[],
): TaskSource {
  if (requested && renderableSourceIds.includes(requested)) {
    return requested;
  }
  // Why: the fork's resolveVisibleTaskProvider fallback shape — the first
  // renderable source, with GitHub as the hard floor.
  return (renderableSourceIds[0] as TaskSource | undefined) ?? "github";
}

/** Test seam: drops the pending value and every subscription. */
export function resetTaskSourceNavigation(): void {
  pendingTaskSource = null;
  listeners.clear();
  pendingConnectSource = null;
  connectListeners.clear();
}
