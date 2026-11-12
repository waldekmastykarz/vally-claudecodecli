import { describe, expect, it } from "vitest";
import { buildClaudeArgs, toClaudeMcpConfig } from "./args.js";

describe("toClaudeMcpConfig", () => {
  it("maps stdio and remote servers, converting timeouts to milliseconds", () => {
    const config = JSON.parse(
      toClaudeMcpConfig({
        local: { type: "stdio", command: "node", args: ["server.js"], env: { A: "1" }, timeout: "30s" },
        remote: { type: "http", url: "https://mcp.example", headers: { Authorization: "Bearer x" } },
      }),
    );
    expect(config).toEqual({
      mcpServers: {
        local: { type: "stdio", command: "node", args: ["server.js"], env: { A: "1" }, timeout: 30_000 },
        remote: { type: "http", url: "https://mcp.example", headers: { Authorization: "Bearer x" } },
      },
    });
  });

  it("rejects options Claude Code can't honor", () => {
    expect(() => toClaudeMcpConfig({ s: { type: "stdio", command: "x", cwd: "/tmp" } })).toThrow(/'cwd' is not supported/);
  });
});

describe("buildClaudeArgs", () => {
  it("resumes sessions instead of creating throwaway ones", () => {
    const fresh = buildClaudeArgs({ config: {}, sessionId: "abc" });
    expect(fresh).toContain("--no-session-persistence");
    expect(fresh).toEqual(expect.arrayContaining(["--session-id", "abc"]));

    const resumed = buildClaudeArgs({ config: {}, resumeSessionId: "abc", sessionId: "def" });
    expect(resumed).toEqual(expect.arrayContaining(["--resume", "abc"]));
    expect(resumed).not.toContain("--no-session-persistence");
    expect(resumed).not.toContain("--session-id");
  });

  it("maps config to flags", () => {
    const args = buildClaudeArgs({
      config: { permissionMode: "acceptEdits", settingSources: [], allowedTools: ["Read", "Edit"], extraArgs: ["--betas", "x"] },
      model: "opus",
      reasoningEffort: "high",
    });
    expect(args).toEqual(
      expect.arrayContaining(["--permission-mode", "acceptEdits", "--setting-sources", "", "--allowedTools", "Read,Edit", "--model", "opus", "--effort", "high"]),
    );
    expect(args.slice(-2)).toEqual(["--betas", "x"]);
  });
});
