import type { McpServerConfig } from "@microsoft/vally";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ClaudeCodeExecutorConfig } from "./config.js";

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(value: string): number {
  const match = DURATION.exec(value.trim());
  if (!match) throw new Error(`Invalid duration '${value}' (expected e.g. 500ms, 30s, 5m)`);
  return Math.round(Number(match[1]) * UNIT_MS[match[2]!]!);
}

/** Converts Vally MCP server configs to Claude Code's `--mcp-config` JSON. */
export function toClaudeMcpConfig(servers: Record<string, McpServerConfig>): string {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const [name, server] of Object.entries(servers)) {
    const timeout = server.timeout !== undefined ? { timeout: parseDuration(server.timeout) } : {};
    if (server.type === "stdio") {
      if (server.cwd !== undefined) {
        throw new Error(`MCP server '${name}': 'cwd' is not supported by Claude Code; wrap the command instead`);
      }
      mcpServers[name] = {
        type: "stdio",
        command: server.command,
        args: server.args ?? [],
        ...(server.env && { env: server.env }),
        ...timeout,
      };
    } else {
      mcpServers[name] = {
        type: server.type,
        url: server.url,
        ...(server.headers && { headers: server.headers }),
        ...timeout,
      };
    }
  }
  return JSON.stringify({ mcpServers });
}

export interface ClaudeArgsInput {
  config: ClaudeCodeExecutorConfig;
  model?: string;
  reasoningEffort?: string;
  mcpServers?: Record<string, McpServerConfig>;
  resumeSessionId?: string;
  sessionId?: string;
  skillsDir?: string;
  settings?: string;
}

export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const { config } = input;
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    // Echoes each prompt back so the log (and the ATIF built from it) contains the user turns.
    "--replay-user-messages",
    "--permission-mode",
    config.permissionMode ?? "bypassPermissions",
    // MCP servers come only from the eval spec, like the copilot-sdk executor.
    "--strict-mcp-config",
  ];
  if (input.mcpServers && Object.keys(input.mcpServers).length > 0) {
    args.push("--mcp-config", toClaudeMcpConfig(input.mcpServers));
  }
  if (input.model) args.push("--model", input.model);
  if (input.reasoningEffort) args.push("--effort", input.reasoningEffort);
  if (input.resumeSessionId) {
    args.push("--resume", input.resumeSessionId);
  } else {
    // Sessions created for a trial aren't kept around, mirroring the copilot-sdk executor.
    args.push("--no-session-persistence");
    if (input.sessionId) args.push("--session-id", input.sessionId);
  }
  if (config.settingSources) args.push("--setting-sources", config.settingSources.join(","));
  if (input.settings) args.push("--settings", input.settings);
  if (input.skillsDir) args.push("--add-dir", input.skillsDir);
  if (config.allowedTools) args.push("--allowedTools", config.allowedTools.join(","));
  if (config.disallowedTools) args.push("--disallowedTools", config.disallowedTools.join(","));
  if (config.systemPrompt) args.push("--system-prompt", config.systemPrompt);
  if (config.appendSystemPrompt) args.push("--append-system-prompt", config.appendSystemPrompt);
  if (config.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(config.maxBudgetUsd));
  if (config.fallbackModel) args.push("--fallback-model", config.fallbackModel);
  if (config.extraArgs) args.push(...config.extraArgs);
  return args;
}

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string }; title?: string };

/** Reads attachments as Anthropic content blocks. Supports images and PDFs. */
export async function attachmentBlocks(paths: readonly string[]): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  for (const file of paths) {
    const ext = path.extname(file).toLowerCase();
    const data = await readFile(file).catch((error: unknown) => {
      throw new Error(`Failed to read attachment '${file}'`, { cause: error });
    });
    if (IMAGE_TYPES[ext]) {
      blocks.push({ type: "image", source: { type: "base64", media_type: IMAGE_TYPES[ext]!, data: data.toString("base64") } });
    } else if (ext === ".pdf") {
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") },
        title: path.basename(file),
      });
    } else {
      throw new Error(
        `Unsupported attachment '${file}': Claude Code accepts images (${Object.keys(IMAGE_TYPES).join(", ")}) and PDFs (.pdf)`,
      );
    }
  }
  return blocks;
}

export function userMessage(content: ContentBlock[]): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "" })}\n`;
}

export function interruptRequest(id: string): string {
  return `${JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "interrupt" } })}\n`;
}
