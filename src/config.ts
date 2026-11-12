export const PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "dontAsk",
  "manual",
  "plan",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const SETTING_SOURCES = ["user", "project", "local"] as const;
export type SettingSource = (typeof SETTING_SOURCES)[number];

export const PROVIDER_TYPES = ["anthropic", "bedrock", "vertex", "foundry"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/**
 * Model provider for Claude Code, the counterpart of the copilot-sdk executor's
 * BYOK `provider`. Credentials are referenced by environment-variable name so
 * secrets never live in the eval spec.
 */
export interface ClaudeCodeProviderConfig {
  /** Defaults to `anthropic` (Claude API or an Anthropic-compatible gateway). */
  type?: ProviderType;
  /** Endpoint override (ANTHROPIC_BASE_URL or the provider-specific base URL variable). */
  baseUrl?: string;
  /** Name of the env var holding the API key (anthropic, foundry) or Bedrock API key (bedrock). */
  apiKeyEnv?: string;
  /** Name of the env var holding a bearer token (anthropic only; sent as `Authorization: Bearer`). */
  bearerTokenEnv?: string;
  /** Extra HTTP headers sent with every model request (anthropic only). */
  headers?: Record<string, string>;
  /** Cloud region (bedrock: AWS_REGION, vertex: CLOUD_ML_REGION). */
  region?: string;
  /** GCP project ID (vertex only). */
  projectId?: string;
  /** Microsoft Foundry resource name (foundry only). */
  resource?: string;
}

export interface ClaudeCodeExecutorConfig {
  /** Path to the Claude Code executable. Defaults to `claude` on PATH. */
  claudePath?: string;
  /** Defaults to `bypassPermissions`, so the agent never stalls on a permission prompt. */
  permissionMode?: PermissionMode;
  /** Claude Code setting sources to load. Defaults to Claude Code's own default (all sources). */
  settingSources?: SettingSource[];
  allowedTools?: string[];
  disallowedTools?: string[];
  appendSystemPrompt?: string;
  systemPrompt?: string;
  maxBudgetUsd?: number;
  fallbackModel?: string;
  /** Extra CLI arguments appended verbatim. Flags managed by the executor are rejected. */
  extraArgs?: string[];
  provider?: ClaudeCodeProviderConfig;
}

const LABEL = "defaults.executor.config";

/** Flags the executor sets itself; passing them through `extraArgs` would break the protocol. */
export const MANAGED_FLAGS = new Set([
  "-p",
  "--print",
  "--output-format",
  "--input-format",
  "--verbose",
  "--replay-user-messages",
  "--include-partial-messages",
  "--mcp-config",
  "--strict-mcp-config",
  "--permission-mode",
  "--dangerously-skip-permissions",
  "--model",
  "--effort",
  "--resume",
  "-r",
  "--continue",
  "-c",
  "--session-id",
  "--no-session-persistence",
  "--settings",
  "--setting-sources",
  "--add-dir",
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--disallowed-tools",
  "--append-system-prompt",
  "--system-prompt",
  "--max-budget-usd",
  "--fallback-model",
]);

const CONFIG_KEYS = new Set<string>([
  "claudePath",
  "permissionMode",
  "settingSources",
  "allowedTools",
  "disallowedTools",
  "appendSystemPrompt",
  "systemPrompt",
  "maxBudgetUsd",
  "fallbackModel",
  "extraArgs",
  "provider",
]);

const PROVIDER_KEYS = new Set<string>([
  "type",
  "baseUrl",
  "apiKeyEnv",
  "bearerTokenEnv",
  "headers",
  "region",
  "projectId",
  "resource",
]);

const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function assertString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function assertStringArray(value: unknown, field: string, allowEmpty = true): void {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${field} must be ${allowEmpty ? "an" : "a non-empty"} array of strings`);
  }
  for (const item of value) assertString(item, `${field}[]`);
}

function assertEnvName(value: unknown, field: string): void {
  if (typeof value !== "string" || !ENV_VAR_NAME.test(value)) {
    throw new Error(`${field} must be the name of an environment variable`);
  }
}

function assertUrl(value: unknown, field: string): void {
  assertString(value, field);
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    throw new Error(`${field} must be an absolute http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${field} must be an absolute http(s) URL`);
  }
}

function validateProvider(value: unknown, label: string): ClaudeCodeProviderConfig {
  if (!isRecord(value)) throw new Error(`${label} must be a mapping, got ${describe(value)}`);
  for (const key of Object.keys(value)) {
    if (!PROVIDER_KEYS.has(key)) {
      throw new Error(`${label} has unknown field '${key}' (allowed: ${[...PROVIDER_KEYS].join(", ")})`);
    }
  }
  const type = (value.type ?? "anthropic") as ProviderType;
  if (!PROVIDER_TYPES.includes(type)) {
    throw new Error(`${label}.type must be one of: ${PROVIDER_TYPES.join(", ")}`);
  }
  if (value.baseUrl !== undefined) assertUrl(value.baseUrl, `${label}.baseUrl`);
  if (value.apiKeyEnv !== undefined) assertEnvName(value.apiKeyEnv, `${label}.apiKeyEnv`);
  if (value.bearerTokenEnv !== undefined) assertEnvName(value.bearerTokenEnv, `${label}.bearerTokenEnv`);
  for (const field of ["region", "projectId", "resource"] as const) {
    if (value[field] !== undefined) assertString(value[field], `${label}.${field}`);
  }
  if (value.headers !== undefined) {
    if (!isRecord(value.headers)) throw new Error(`${label}.headers must be a mapping of header names to values`);
    for (const [name, header] of Object.entries(value.headers)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error(`${label}.headers has an invalid header name '${name}'`);
      if (typeof header !== "string" || /[\r\n]/.test(header)) {
        throw new Error(`${label}.headers.${name} must be a single-line string`);
      }
    }
  }

  const allowed: Record<ProviderType, string[]> = {
    anthropic: ["baseUrl", "apiKeyEnv", "bearerTokenEnv", "headers"],
    bedrock: ["baseUrl", "apiKeyEnv", "region"],
    vertex: ["baseUrl", "region", "projectId"],
    foundry: ["baseUrl", "apiKeyEnv", "resource"],
  };
  for (const key of Object.keys(value)) {
    if (key !== "type" && !allowed[type].includes(key)) {
      throw new Error(`${label}.${key} is not supported for provider type '${type}'`);
    }
  }
  if (type === "foundry" && value.baseUrl === undefined && value.resource === undefined) {
    throw new Error(`${label} with type 'foundry' requires either 'resource' or 'baseUrl'`);
  }
  return { ...(value as ClaudeCodeProviderConfig), type };
}

/** Parses and validates `defaults.executor.config`. Throws actionable errors. */
export function parseConfig(value: unknown, label = LABEL): ClaudeCodeExecutorConfig {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${label} must be a mapping, got ${describe(value)}`);
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`${label} has unknown field '${key}' (allowed: ${[...CONFIG_KEYS].join(", ")})`);
    }
  }

  for (const field of ["claudePath", "appendSystemPrompt", "systemPrompt", "fallbackModel"] as const) {
    if (value[field] !== undefined) assertString(value[field], `${label}.${field}`);
  }
  if (value.permissionMode !== undefined && !PERMISSION_MODES.includes(value.permissionMode as PermissionMode)) {
    throw new Error(`${label}.permissionMode must be one of: ${PERMISSION_MODES.join(", ")}`);
  }
  if (value.settingSources !== undefined) {
    if (!Array.isArray(value.settingSources)) throw new Error(`${label}.settingSources must be an array`);
    for (const source of value.settingSources) {
      if (!SETTING_SOURCES.includes(source as SettingSource)) {
        throw new Error(`${label}.settingSources entries must be one of: ${SETTING_SOURCES.join(", ")}`);
      }
    }
  }
  for (const field of ["allowedTools", "disallowedTools"] as const) {
    if (value[field] !== undefined) assertStringArray(value[field], `${label}.${field}`, false);
  }
  if (
    value.maxBudgetUsd !== undefined &&
    (typeof value.maxBudgetUsd !== "number" || !Number.isFinite(value.maxBudgetUsd) || value.maxBudgetUsd <= 0)
  ) {
    throw new Error(`${label}.maxBudgetUsd must be a positive number`);
  }
  if (value.extraArgs !== undefined) {
    if (!Array.isArray(value.extraArgs) || value.extraArgs.some((arg) => typeof arg !== "string")) {
      throw new Error(`${label}.extraArgs must be an array of strings`);
    }
    for (const arg of value.extraArgs as string[]) {
      const flag = arg.split("=", 1)[0]!;
      if (MANAGED_FLAGS.has(flag)) {
        throw new Error(`${label}.extraArgs must not contain '${flag}': the executor manages it`);
      }
    }
  }
  const provider = value.provider !== undefined ? validateProvider(value.provider, `${label}.provider`) : undefined;
  return { ...(value as ClaudeCodeExecutorConfig), ...(provider && { provider }) };
}

/** Env vars that select or authenticate a model provider; cleared when a provider is configured. */
const PROVIDER_ENV_VARS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_FOUNDRY_API_KEY",
];

function readRequiredEnv(name: string, field: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${field} references environment variable '${name}', which is not set`);
  }
  return value;
}

export interface ProviderEnv {
  /** Variables to set on the Claude Code process. */
  set: Record<string, string>;
  /** Inherited variables to remove so they can't override the configured provider. */
  unset: string[];
  /** Resolved credentials, for redaction. */
  secrets: string[];
}

/**
 * Maps a provider config to Claude Code environment variables, resolving the
 * referenced credentials from `env` (the Vally process environment).
 */
export function providerEnv(
  provider: ClaudeCodeProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
  label = `${LABEL}.provider`,
): ProviderEnv {
  const set: Record<string, string> = {};
  const secrets: string[] = [];
  const secret = (name: string, field: string): string => {
    const value = readRequiredEnv(name, `${label}.${field}`, env);
    secrets.push(value);
    return value;
  };

  switch (provider.type ?? "anthropic") {
    case "anthropic":
      if (provider.baseUrl) set.ANTHROPIC_BASE_URL = provider.baseUrl;
      // Claude Code prefers ANTHROPIC_AUTH_TOKEN over ANTHROPIC_API_KEY, so a bearer token wins.
      if (provider.bearerTokenEnv) set.ANTHROPIC_AUTH_TOKEN = secret(provider.bearerTokenEnv, "bearerTokenEnv");
      else if (provider.apiKeyEnv) set.ANTHROPIC_API_KEY = secret(provider.apiKeyEnv, "apiKeyEnv");
      if (provider.headers && Object.keys(provider.headers).length > 0) {
        set.ANTHROPIC_CUSTOM_HEADERS = Object.entries(provider.headers)
          .map(([name, value]) => `${name}: ${value}`)
          .join("\n");
      }
      break;
    case "bedrock":
      set.CLAUDE_CODE_USE_BEDROCK = "1";
      if (provider.baseUrl) set.ANTHROPIC_BEDROCK_BASE_URL = provider.baseUrl;
      if (provider.apiKeyEnv) set.AWS_BEARER_TOKEN_BEDROCK = secret(provider.apiKeyEnv, "apiKeyEnv");
      if (provider.region) set.AWS_REGION = provider.region;
      break;
    case "vertex":
      set.CLAUDE_CODE_USE_VERTEX = "1";
      if (provider.baseUrl) set.ANTHROPIC_VERTEX_BASE_URL = provider.baseUrl;
      if (provider.region) set.CLOUD_ML_REGION = provider.region;
      if (provider.projectId) set.ANTHROPIC_VERTEX_PROJECT_ID = provider.projectId;
      break;
    case "foundry":
      set.CLAUDE_CODE_USE_FOUNDRY = "1";
      if (provider.baseUrl) set.ANTHROPIC_FOUNDRY_BASE_URL = provider.baseUrl;
      if (provider.resource) set.ANTHROPIC_FOUNDRY_RESOURCE = provider.resource;
      if (provider.apiKeyEnv) set.ANTHROPIC_FOUNDRY_API_KEY = secret(provider.apiKeyEnv, "apiKeyEnv");
      break;
  }
  return { set, unset: PROVIDER_ENV_VARS.filter((name) => !(name in set)), secrets };
}
