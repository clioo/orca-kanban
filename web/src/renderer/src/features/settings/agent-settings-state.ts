import { useSyncExternalStore } from "react";
import {
  AGENT_SETTINGS_DEFAULTS,
  agentIdSchema,
  type AgentSettings,
  type AgentSettingsBridge,
  type AgentSettingsUpdate,
} from "../../../../shared/agent-settings-contract";
import type { HarnessAgentDefault } from "../../settings-store";

export type AgentSettingsState = {
  settings: AgentSettings;
  ready: boolean;
  saving: boolean;
  error: string | null;
};
export type AgentSettingsMutation =
  AgentSettingsUpdate | ((settings: AgentSettings) => AgentSettingsUpdate);
export function migrateAgentPreferences(legacy: {
  defaultHarnessId?: string;
  harnessDefaults?: Record<string, HarnessAgentDefault>;
}): AgentSettingsUpdate {
  const updates: AgentSettingsUpdate = {};
  if (legacy.defaultHarnessId !== undefined) {
    updates.defaultTuiAgent = agentIdSchema.safeParse(legacy.defaultHarnessId)
      .success
      ? (legacy.defaultHarnessId as AgentSettings["defaultTuiAgent"])
      : "blank";
  }
  const args: NonNullable<AgentSettingsUpdate["agentDefaultArgs"]> = {};
  for (const [id, value] of Object.entries(legacy.harnessDefaults ?? {})) {
    const parsed = agentIdSchema.safeParse(id);
    if (!parsed.success) continue;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const fields: string[] = [];
    if (value.permissionMode === "unattended") {
      const flag = AGENT_SETTINGS_DEFAULTS.agentDefaultArgs[parsed.data];
      if (flag) fields.push(flag);
    }
    if (value.model) fields.push("--model", quote(value.model));
    if (value.effort) {
      if (id === "codex")
        fields.push("-c", quote(`model_reasoning_effort=${value.effort}`));
      else
        fields.push(
          id === "pi" ? "--thinking" : "--effort",
          quote(value.effort),
        );
    }
    args[parsed.data] = fields.join(" ");
  }
  if (Object.keys(args).length) updates.agentDefaultArgs = args;
  return updates;
}

export function createAgentSettingsState(
  getBridge: () => AgentSettingsBridge | undefined,
) {
  let state: AgentSettingsState = {
    settings: AGENT_SETTINGS_DEFAULTS,
    ready: false,
    saving: false,
    error: null,
  };
  const listeners = new Set<() => void>();
  let queue: Promise<void> = Promise.resolve();
  let loading: Promise<void> | undefined;
  let migration: AgentSettingsUpdate = {};
  let pending = 0;
  const publish = (next: Partial<AgentSettingsState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const load = (legacy?: AgentSettingsUpdate): Promise<void> => {
    // Child effects can request loading before App supplies the legacy snapshot.
    if (legacy !== undefined) migration = legacy;
    if (loading) return loading;
    loading = (async () => {
      try {
        const bridge = getBridge();
        if (!bridge)
          throw new Error(
            "Agent settings are unavailable. Reconnect to the desktop service.",
          );
        let result = await bridge.get();
        if (!result.ok) throw new Error(result.error.message);
        if (!result.result.initialized)
          result = await bridge.update({
            updates: migration,
            onlyIfUninitialized: true,
          });
        if (!result.ok) throw new Error(result.error.message);
        publish({ settings: result.result.settings, ready: true, error: null });
      } catch (error) {
        publish({
          error:
            error instanceof Error
              ? error.message
              : "Could not load agent settings.",
        });
      }
    })().finally(() => {
      loading = undefined;
    });
    return loading;
  };
  const update = (updates: AgentSettingsMutation): Promise<void> => {
    pending++;
    publish({ saving: true });
    const task = queue.then(async () => {
      try {
        const bridge = getBridge();
        if (!bridge) throw new Error("Agent settings are unavailable.");
        const result = await bridge.update({
          updates:
            typeof updates === "function" ? updates(state.settings) : updates,
        });
        if (!result.ok) throw new Error(result.error.message);
        publish({ settings: result.result.settings, ready: true, error: null });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Could not save agent settings.";
        publish({ error: message });
        throw new Error(message);
      } finally {
        pending--;
        publish({ saving: pending > 0 });
      }
    });
    queue = task.catch(() => {});
    return task;
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    ensureReady: async (): Promise<boolean> => {
      if (!state.ready) await load();
      return state.ready;
    },
    update,
  };
}
export const agentSettingsState = createAgentSettingsState(() =>
  typeof window === "undefined" ? undefined : window.drogon?.agentSettings,
);
export function useAgentSettings(): AgentSettingsState {
  return useSyncExternalStore(
    agentSettingsState.subscribe,
    agentSettingsState.getSnapshot,
    agentSettingsState.getSnapshot,
  );
}
export function saveAgentSettings(updates: AgentSettingsMutation): void {
  void agentSettingsState.update(updates).catch(() => {});
}
