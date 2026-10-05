// MIT Copyright (c) 2026 Lovecast Inc.
// Source vocabulary: global-settings-types.ts and tui-agent-launch-defaults.ts.
import { z } from "zod";
import type { Result } from "./session-contract";

export const agentIdSchema = z.enum([
  "claude",
  "codex",
  "opencode",
  "pi",
  "antigravity",
]);
export type AgentId = z.infer<typeof agentIdSchema>;
const command = z
  .string()
  .max(4096)
  .regex(/^[^\x00-\x1f\x7f]*$/);
const args = z
  .string()
  .max(8192)
  .refine((value) => !value.includes("\0"));
const env = z.record(z.string().min(1).max(128), z.string().max(8192));
const record = <T extends z.ZodType>(value: T) =>
  z.partialRecord(agentIdSchema, value);
export const agentSettingsSchema = z
  .object({
    defaultTuiAgent: agentIdSchema.or(z.literal("blank")).nullable(),
    disabledTuiAgents: z.array(agentIdSchema).max(5),
    agentCmdOverrides: record(command),
    agentDefaultArgs: record(args),
    agentDefaultEnv: record(env),
    agentStatusHooksEnabled: z.boolean(),
    tabAutoGenerateTitle: z.boolean(),
    promptCacheTimerEnabled: z.boolean(),
    promptCacheTtlMs: z.union([z.literal(300000), z.literal(3600000)]),
    codexSessionSourceHome: command,
  })
  .strict();
export type AgentSettings = z.infer<typeof agentSettingsSchema>;
export const agentSettingsUpdateSchema = agentSettingsSchema
  .partial()
  .extend({
    agentCmdOverrides: record(command.nullable()).optional(),
    agentDefaultArgs: record(args.nullable()).optional(),
    agentDefaultEnv: record(env.nullable()).optional(),
  })
  .strict();
export type AgentSettingsUpdate = z.infer<typeof agentSettingsUpdateSchema>;
export const agentSettingsResultSchema = z.object({
  settings: agentSettingsSchema,
  initialized: z.boolean(),
});
export type AgentSettingsResult = z.infer<typeof agentSettingsResultSchema>;
export interface AgentSettingsBridge {
  get(): Promise<Result<AgentSettingsResult>>;
  update(input: {
    updates: AgentSettingsUpdate;
    onlyIfUninitialized?: boolean;
  }): Promise<Result<AgentSettingsResult>>;
}
declare module "./session-contract" {
  interface DesktopBridge {
    agentSettings: AgentSettingsBridge;
  }
}
export const AGENT_SETTINGS_DEFAULTS: AgentSettings = {
  defaultTuiAgent: null,
  disabledTuiAgents: [],
  agentCmdOverrides: {},
  agentDefaultArgs: {
    claude: "--dangerously-skip-permissions",
    codex: "--dangerously-bypass-approvals-and-sandbox",
    antigravity: "--dangerously-skip-permissions",
  },
  agentDefaultEnv: {},
  agentStatusHooksEnabled: true,
  tabAutoGenerateTitle: false,
  promptCacheTimerEnabled: false,
  promptCacheTtlMs: 300000,
  codexSessionSourceHome: "",
};
