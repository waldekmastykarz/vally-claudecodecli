#!/usr/bin/env node
// Claude Code PreToolUse hook that answers simulated tool calls.
// Usage: node hook.js <overrides.json>; the hook event arrives as JSON on stdin.
import { readFileSync } from "node:fs";
import { hookResponse } from "./simulation.js";

const chunks: Buffer[] = [];
process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
process.stdin.on("end", () => {
  try {
    const event = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tool_name?: string; tool_input?: unknown };
    const overrides = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
    const response = event.tool_name ? hookResponse(event.tool_name, event.tool_input, overrides) : undefined;
    if (response) process.stdout.write(JSON.stringify(response));
  } catch (error) {
    // Exit code 2 blocks the call, so a broken simulation never lets the real tool run.
    process.stderr.write(`vally simulation hook failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
});
