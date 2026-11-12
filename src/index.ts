import type { ExecutorRegistry } from "@microsoft/vally";
import { ClaudeCodeExecutor } from "./executor.js";

export function registerExecutors(registry: ExecutorRegistry): void {
  registry.register(new ClaudeCodeExecutor());
}

export { ClaudeCodeExecutor, EXECUTOR_NAME } from "./executor.js";
export type { ClaudeCodeExecutorOptions, SpawnFn } from "./executor.js";
export type {
  ClaudeCodeExecutorConfig,
  ClaudeCodeProviderConfig,
  PermissionMode,
  ProviderType,
  SettingSource,
} from "./config.js";
