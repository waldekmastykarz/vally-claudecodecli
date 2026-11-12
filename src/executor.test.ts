import type { ExecutorOptions, ExecutorTurnCompletion, Stimulus } from "@microsoft/vally";
import { createExecutorRegistry } from "@microsoft/vally";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEnv, ClaudeCodeExecutor, type SpawnFn } from "./executor.js";
import { registerExecutors } from "./index.js";

const fakeClaude = fileURLToPath(new URL("../test/fixtures/fake-claude.mjs", import.meta.url));

function executorFor(mode: string, spawnedArgs: string[][] = []): ClaudeCodeExecutor {
  const fakeSpawn: SpawnFn = (_command, args, options) => {
    spawnedArgs.push([...args]);
    return spawn(process.execPath, [fakeClaude, ...args], {
      ...options,
      env: { ...options.env, FAKE_CLAUDE_MODE: mode },
    });
  };
  return new ClaudeCodeExecutor({ spawn: fakeSpawn, cleanupTimeoutMs: 500 });
}

describe("ClaudeCodeExecutor", () => {
  let workDir: string;
  let completions: ExecutorTurnCompletion[];
  const options = (overrides: Partial<ExecutorOptions> = {}): ExecutorOptions => ({
    workDir,
    timeout: 10_000,
    onTurnComplete: async (completion) => {
      completions.push(completion);
    },
    ...overrides,
  });

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "vally-claude-test-"));
    completions = [];
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("is registered by the plugin entry point", () => {
    const registry = createExecutorRegistry();
    registerExecutors(registry);
    expect(registry.names()).toContain("claude-code-cli");
  });

  it("runs every turn in one session and reports turn completion", async () => {
    const stimulus: Stimulus = { name: "multi", prompt: "first\nsecond", turns: ["first", "second"] };

    const trajectory = await executorFor("ok").execute(stimulus, options({ model: "sonnet" }));

    expect(trajectory.output).toBe("echo: second");
    expect(trajectory.endReason).toBe("completed");
    expect(trajectory.metadata).toMatchObject({ executor: "claude-code-cli", model: "claude-fake-1" });
    expect(trajectory.metadata.sessionID).toBe("11111111-2222-3333-4444-555555555555");
    const userTurns = trajectory.events.filter((event) => event.type === "user_message").map((event) => event.turn);
    expect(userTurns).toEqual([0, 1]);
    expect(completions).toEqual([
      { turn: 0, status: "completed" },
      { turn: 1, status: "completed", final: true },
    ]);
  });

  it("writes the raw log and ATIF to the executor artifacts directory", async () => {
    const artifactsDir = path.join(workDir, "..", `${path.basename(workDir)}-artifacts`);
    try {
      await executorFor("ok").execute(
        { name: "a", prompt: "hello" },
        options({ sessionLog: { rootDir: workDir, executorArtifactsDir: artifactsDir } }),
      );
      const log = await readFile(path.join(artifactsDir, "claude-code.jsonl"), "utf8");
      expect(log).toContain('"type":"result"');
      const atif = JSON.parse(await readFile(path.join(artifactsDir, "trajectory.atif.json"), "utf8"));
      expect(atif.schema_version).toMatch(/^ATIF-/);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it("interrupts the agent when its working time runs out and returns the partial run", async () => {
    const trajectory = await executorFor("hang").execute({ name: "slow", prompt: "go" }, options({ maxAgentDurationMs: 200 }));

    expect(trajectory.endReason).toBe("agent_timeout");
    expect(completions).toEqual([{ turn: 0, status: "interrupted", final: true }]);
    // The interrupt notice is a user message but doesn't start a new turn.
    expect(trajectory.events.every((event) => event.turn === 0)).toBe(true);
  });

  it("stops at the simulation iteration cap", async () => {
    const trajectory = await executorFor("tools").execute(
      { name: "loop", prompt: "go", simulation: { max_iterations: 1, tool_overrides: { bash: "SIM" } } },
      options(),
    );

    expect(trajectory.endReason).toBe("simulation_cap");
    const calls = trajectory.events.filter((event) => event.type === "tool_call");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((event) => event.type === "tool_call" && event.data.simulated)).toBe(true);
  });

  it("fails with a non-retryable timeout and kills an unresponsive process", async () => {
    await expect(executorFor("deaf").execute({ name: "stuck", prompt: "go" }, options({ timeout: 300 }))).rejects.toMatchObject({
      message: expect.stringContaining("timed out after 300 ms"),
      retryable: false,
    });
  });

  it("fails on error results, marking overloads as retryable", async () => {
    await expect(executorFor("auth-error").execute({ name: "x", prompt: "go" }, options())).rejects.toMatchObject({
      message: expect.stringContaining("Not logged in"),
      retryable: false,
    });
    await expect(executorFor("overloaded").execute({ name: "x", prompt: "go" }, options())).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("returns a gradable run with an error event when Claude Code hits its budget", async () => {
    const trajectory = await executorFor("budget").execute({ name: "x", prompt: "go" }, options());

    expect(trajectory.endReason).toBe("completed");
    expect(trajectory.events.at(-1)).toMatchObject({ type: "error", data: { message: "Reached maximum budget ($0.01)" } });
    expect(completions).toEqual([{ turn: 0, status: "completed", final: true }]);
  });

  it("includes stderr when the process exits unexpectedly", async () => {
    await expect(executorFor("crash").execute({ name: "x", prompt: "go" }, options())).rejects.toThrow(/code 3[\s\S]*boom/);
  });

  it("explains how to fix a missing executable", async () => {
    const executor = new ClaudeCodeExecutor();
    await expect(
      executor.execute(
        { name: "x", prompt: "go" },
        options({ executorConfig: { claudePath: path.join(workDir, "missing-claude") } }),
      ),
    ).rejects.toThrow(/was not found\. Install Claude Code or set defaults\.executor\.config\.claudePath/);
  });

  it("redacts agent env values from errors", async () => {
    const executor = executorFor("auth-error");
    const error = await executor
      .execute({ name: "x", prompt: "go" }, options({ env: { SECRET: "Not logged in" } }))
      .catch((caught: Error) => caught);
    expect((error as Error).message).not.toContain("Not logged in");
  });

  it("links skills through --add-dir instead of the workspace", async () => {
    const spawned: string[][] = [];
    const skillPath = path.join(workDir, "skills", "my-skill", "SKILL.md");
    await executorFor("ok", spawned).execute(
      { name: "x", prompt: "go" },
      options({ skills: [{ name: "my-skill", description: "", path: skillPath, rawContent: "", frontmatter: {}, fileReferences: [] }] }),
    );
    const args = spawned[0]!;
    const addDir = args[args.indexOf("--add-dir") + 1]!;
    expect(path.relative(workDir, addDir).startsWith("..")).toBe(true);
  });
});

describe("buildEnv", () => {
  it("lets agent env override the provider, and propagates trace context", () => {
    const env = buildEnv(
      {
        env: { ANTHROPIC_BASE_URL: "https://agent.example" },
        traceContext: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
      },
      { set: { ANTHROPIC_BASE_URL: "https://provider.example", ANTHROPIC_API_KEY: "k" }, unset: ["ANTHROPIC_AUTH_TOKEN"], secrets: [] },
    );
    expect(env.ANTHROPIC_BASE_URL).toBe("https://agent.example");
    expect(env.ANTHROPIC_API_KEY).toBe("k");
    expect(env.TRACEPARENT).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
  });

  it("removes inherited provider credentials when a provider is configured", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "inherited";
    try {
      const env = buildEnv({}, { set: { ANTHROPIC_API_KEY: "k" }, unset: ["ANTHROPIC_AUTH_TOKEN"], secrets: [] });
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    } finally {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
  });
});
