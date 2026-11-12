import type { SimulationConfig } from "@microsoft/vally";

/** Vally's shell override keys; they alias one another. */
const SHELL_KEYS = ["bash", "shell", "powershell"];
/** Claude Code's shell tools and the Vally key each answers to first. */
const CLAUDE_SHELL_TOOLS: Record<string, string> = { Bash: "bash", PowerShell: "powershell" };

type Overrides = NonNullable<SimulationConfig["tool_overrides"]>;
type OverrideValue = Overrides[string];

export interface SimulatedResult {
  output: string;
  isError: boolean;
  shell: boolean;
}

interface PatternOverride {
  patterns: Array<{ match?: string; args?: Record<string, string>; pattern?: string; output: string; is_error?: boolean }>;
  default?: string | { output: string; is_error?: boolean };
}

function isPatternOverride(value: unknown): value is PatternOverride {
  return typeof value === "object" && value !== null && "patterns" in value;
}

function normalizeFixed(value: string | { output?: unknown; is_error?: boolean }): Omit<SimulatedResult, "shell"> {
  if (typeof value === "string") return { output: value, isError: false };
  return { output: typeof value.output === "string" ? value.output : String(value.output ?? ""), isError: value.is_error === true };
}

/** Builds a RegExp, honoring a leading inline-flags group such as `(?i)`. */
function toRegExp(source: string, defaultFlags?: string): RegExp {
  const inline = /^\(\?([ims]+)\)/.exec(source);
  return inline ? new RegExp(source.slice(inline[0].length), inline[1]) : new RegExp(source, defaultFlags);
}

function resolveKey(toolName: string, overrides: Overrides): string | undefined {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(overrides, key);
  if (has(toolName)) return toolName;
  const shellKey = CLAUDE_SHELL_TOOLS[toolName];
  if (!shellKey) return undefined;
  return [shellKey, ...SHELL_KEYS].find(has);
}

function matches(pattern: PatternOverride["patterns"][number], args: Record<string, unknown>, shell: boolean): boolean {
  if (pattern.match === undefined && pattern.args === undefined && pattern.pattern === undefined) return false;
  if (pattern.match !== undefined) {
    const command = typeof args.command === "string" ? args.command : "";
    if (!shell || !toRegExp(pattern.match, "i").test(command)) return false;
  }
  for (const [name, source] of Object.entries(pattern.args ?? {})) {
    const value = args[name];
    if (typeof value !== "string" || !toRegExp(source).test(value)) return false;
  }
  if (pattern.pattern !== undefined) {
    let serialized: string;
    try {
      serialized = JSON.stringify(args);
    } catch {
      return false;
    }
    if (!toRegExp(pattern.pattern).test(serialized)) return false;
  }
  return true;
}

/**
 * Decides the simulated result for a Claude Code tool call, or `null` to run the
 * real tool. Shell overrides (`bash`/`shell`/`powershell`) apply to Claude's
 * `Bash` and `PowerShell` tools; other keys match Claude tool names exactly.
 */
export function resolveToolOverride(
  toolName: string,
  args: unknown,
  overrides: Overrides | undefined,
): SimulatedResult | null {
  if (!overrides) return null;
  const key = resolveKey(toolName, overrides);
  if (key === undefined) return null;
  const shell = toolName in CLAUDE_SHELL_TOOLS;
  const record = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const value: OverrideValue = overrides[key]!;
  if (isPatternOverride(value)) {
    for (const pattern of value.patterns) {
      if (matches(pattern, record, shell)) return { output: pattern.output, isError: pattern.is_error === true, shell };
    }
    return value.default === undefined ? null : { ...normalizeFixed(value.default), shell };
  }
  return { ...normalizeFixed(value as string | { output: string; is_error?: boolean }), shell };
}

/** A shell command that prints the canned output and exits with the matching status. */
export function renderShellCommand(toolName: string, result: SimulatedResult): string {
  const exitCode = result.isError ? 1 : 0;
  if (toolName === "PowerShell") {
    // Base64 keeps PowerShell's many quote characters from terminating the literal.
    const b64 = Buffer.from(result.output, "utf8").toString("base64");
    const stream = result.isError ? "Error" : "Out";
    return `[Console]::${stream}.Write([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))); exit ${exitCode}`;
  }
  const escaped = result.output.replace(/'/g, `'\\''`);
  return `printf '%s' '${escaped}'${result.isError ? " >&2" : ""}; exit ${exitCode}`;
}

/** The PreToolUse hook response for a tool call, or `undefined` to let it run unchanged. */
export function hookResponse(
  toolName: string,
  toolInput: unknown,
  overrides: Overrides | undefined,
): Record<string, unknown> | undefined {
  const result = resolveToolOverride(toolName, toolInput, overrides);
  if (!result) return undefined;
  if (result.shell) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...(toolInput as Record<string, unknown>), command: renderShellCommand(toolName, result) },
      },
    };
  }
  // Claude Code can't return a canned result for non-shell tools; denying the call surfaces
  // the output to the model as the tool's error, which is what Vally allows for these tools.
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: result.output,
    },
  };
}

function quote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** `--settings` JSON that routes every tool call through the simulation hook. */
export function simulationSettings(hookScript: string, overridesFile: string): string {
  const command = [process.execPath, hookScript, overridesFile].map(quote).join(" ");
  return JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command }] }] },
  });
}
