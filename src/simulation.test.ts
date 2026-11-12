import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { hookResponse, renderShellCommand, resolveToolOverride } from "./simulation.js";

describe("resolveToolOverride", () => {
  it("applies shell overrides to Claude's Bash tool", () => {
    expect(resolveToolOverride("Bash", { command: "ls" }, { shell: "files" })).toEqual({ output: "files", isError: false, shell: true });
    expect(resolveToolOverride("bash", { command: "ls" }, { shell: "files" })).toBeNull();
  });

  it("matches patterns and falls back to the default", () => {
    const overrides = {
      bash: {
        patterns: [{ match: "^git status", output: "clean" }],
        default: { output: "denied", is_error: true },
      },
      Read: { patterns: [{ args: { file_path: "secret" }, output: "no access", is_error: true }] },
    };
    expect(resolveToolOverride("Bash", { command: "GIT STATUS" }, overrides)).toMatchObject({ output: "clean" });
    expect(resolveToolOverride("Bash", { command: "rm -rf /" }, overrides)).toMatchObject({ output: "denied", isError: true });
    expect(resolveToolOverride("Read", { file_path: "/a/secret.txt" }, overrides)).toMatchObject({ output: "no access" });
    expect(resolveToolOverride("Read", { file_path: "/a/public.txt" }, overrides)).toBeNull();
  });
});

describe("hookResponse", () => {
  it("rewrites shell commands and denies other simulated tools", () => {
    expect(hookResponse("Bash", { command: "ls", description: "list" }, { bash: "out" })).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: "printf '%s' 'out'; exit 0", description: "list" },
      },
    });
    expect(hookResponse("WebFetch", { url: "https://x" }, { WebFetch: { output: "offline", is_error: true } })).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "offline" },
    });
    expect(hookResponse("Read", {}, { bash: "out" })).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("renderShellCommand", () => {
  it("prints the canned output verbatim and sets the exit code", () => {
    const output = `it's "quoted" $HOME \`date\`\nline 2`;
    expect(execFileSync("sh", ["-c", renderShellCommand("Bash", { output, isError: false, shell: true })], { encoding: "utf8" })).toBe(output);
    expect(() => execFileSync("sh", ["-c", renderShellCommand("Bash", { output, isError: true, shell: true })], { stdio: "pipe" })).toThrow();
  });
});
