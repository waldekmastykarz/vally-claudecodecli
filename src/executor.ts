import type {
  Executor,
  ExecutorOptions,
  ExecutorTurnCompletion,
  Skill,
  Stimulus,
  Trajectory,
  TrajectoryEndReason,
} from "@microsoft/vally";
import { mergeEnv, redactSecrets, stimulusPrompts } from "@microsoft/vally";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachmentBlocks, buildClaudeArgs, userMessage, type ContentBlock } from "./args.js";
import { parseConfig, providerEnv, type ProviderEnv } from "./config.js";
import { ClaudeProcess, type ProcessExit } from "./process.js";
import { simulationSettings } from "./simulation.js";
import { buildTrajectory, type StreamLine } from "./trajectory.js";

export const EXECUTOR_NAME = "claude-code-cli";

/** Bound on each teardown step (interrupt settle, exit after closing stdin, SIGTERM grace). */
const CLEANUP_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Result subtypes where Claude Code stopped on a limit it was given; the run is still gradable. */
const LIMIT_RESULT_SUBTYPES = new Set(["error_max_turns", "error_max_budget_usd"]);

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface ClaudeCodeExecutorOptions {
  /** Replaces `child_process.spawn`, e.g. to run a fake Claude Code in tests. */
  spawn?: SpawnFn;
  /** Path to the compiled simulation hook script. */
  hookScript?: string;
  cleanupTimeoutMs?: number;
}

class ExecutorDeadlineExceededError extends Error {
  readonly retryable = false;
}

type StopReason = "agent_timeout" | "simulation_cap";

type Outcome =
  | { kind: "result"; line: StreamLine }
  | { kind: "exit"; exit: ProcessExit }
  | { kind: "stop" }
  | { kind: "deadline" };

interface RunResult {
  endReason: TrajectoryEndReason;
  softErrors: string[];
}

/** Runs prompts through the Claude Code CLI (`claude -p`) and returns Vally trajectories. */
export class ClaudeCodeExecutor implements Executor {
  readonly name = EXECUTOR_NAME;
  readonly supportsPreparedWorkspace = true;
  readonly supportsMultiTurn = true;
  readonly supportsTurnCompletion = true;
  readonly supportsSimulation = true;
  readonly supportsAttachments = true;
  readonly supportsEnvVars = true;

  private readonly active = new Set<ClaudeProcess>();
  private readonly spawn: SpawnFn;
  private readonly hookScript: string;
  private readonly cleanupTimeoutMs: number;

  constructor(options: ClaudeCodeExecutorOptions = {}) {
    this.spawn = options.spawn ?? (nodeSpawn as SpawnFn);
    this.hookScript = options.hookScript ?? fileURLToPath(new URL("./hook.js", import.meta.url));
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS;
  }

  validateConfig(config: unknown): void {
    parseConfig(config);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.active].map((proc) => proc.kill(this.cleanupTimeoutMs)));
  }

  async execute(stimulus: Stimulus, options: ExecutorOptions): Promise<Trajectory> {
    const config = parseConfig(options.executorConfig);
    let reasoningEffort: string | undefined;
    if (options.reasoningEffort !== undefined) {
      reasoningEffort = options.reasoningEffort.trim();
      if (!reasoningEffort) throw new Error("Reasoning effort must be a non-empty string");
    }
    const command = config.claudePath ?? "claude";
    const prompts = stimulusPrompts(stimulus);
    const startedAt = new Date();
    const provider = config.provider ? providerEnv(config.provider) : undefined;
    const secrets = [...(provider?.secrets ?? []), ...Object.values(options.env ?? {})];

    const runDir = await mkdtemp(path.join(tmpdir(), "vally-claude-code-"));
    const artifacts = await openArtifacts(options.sessionLog?.executorArtifactsDir);
    let proc: ClaudeProcess | undefined;
    try {
      const skillsDir = await linkSkills(runDir, options.skills);
      let settings: string | undefined;
      const overrides = stimulus.simulation?.tool_overrides;
      if (overrides && Object.keys(overrides).length > 0) {
        const overridesFile = path.join(runDir, "simulation.json");
        await writeFile(overridesFile, JSON.stringify(overrides), "utf8");
        settings = simulationSettings(this.hookScript, overridesFile);
      }
      const attachments = stimulus.attachments?.length ? await attachmentBlocks(stimulus.attachments) : [];
      const sessionLogId = options.sessionLog?.sessionID;
      const args = buildClaudeArgs({
        config,
        model: options.model,
        reasoningEffort,
        mcpServers: options.mcpServers,
        resumeSessionId: options.sessionID,
        sessionId: sessionLogId && UUID.test(sessionLogId) ? sessionLogId : undefined,
        skillsDir,
        settings,
      });

      proc = new ClaudeProcess(
        this.spawn(command, args, { cwd: options.workDir, env: buildEnv(options, provider), stdio: "pipe" }),
        (line, raw) => {
          artifacts.stream?.write(`${raw}\n`);
          options.onRawEvent?.(line);
        },
        (chunk) => artifacts.stderr?.write(chunk),
      );
      this.active.add(proc);

      const run = await new TurnRunner(proc, stimulus, options, prompts, attachments, this.cleanupTimeoutMs).run();
      const completedAt = new Date();
      const { trajectory, atif } = await buildTrajectory({
        lines: proc.lines,
        stimulus,
        prompts,
        workDir: options.workDir,
        executor: this.name,
        requestedModel: options.model,
        skills: options.skills,
        startedAt,
        completedAt,
        endReason: run.endReason,
        softErrors: run.softErrors,
      });
      if (artifacts.dir) {
        await writeFile(path.join(artifacts.dir, "trajectory.atif.json"), `${JSON.stringify(atif, null, 2)}\n`, "utf8");
      }
      return trajectory;
    } catch (error) {
      if (error instanceof Error) {
        const errno = error as NodeJS.ErrnoException;
        if (errno.code === "ENOENT" && errno.syscall?.startsWith("spawn")) {
          error.message =
            `Claude Code executable '${command}' was not found. ` +
            `Install Claude Code or set defaults.executor.config.claudePath.`;
        }
        error.message = redactSecrets(error.message, secrets);
      }
      throw error;
    } finally {
      if (proc) {
        if (!proc.hasExited) await proc.kill(this.cleanupTimeoutMs);
        this.active.delete(proc);
      }
      await artifacts.close();
      await rm(runDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
    }
  }
}

/** Drives one Claude Code session through the configured turns. */
class TurnRunner {
  private readonly softErrors: string[] = [];
  private readonly notified = new Set<number>();
  private readonly expiresAt: { value: number };
  private stopReason?: StopReason;
  private readonly stopped: Promise<Outcome>;
  private signalStop!: () => void;
  private budgetRemaining?: number;
  private budgetTimer?: NodeJS.Timeout;
  private budgetStartedAt?: number;

  constructor(
    private readonly proc: ClaudeProcess,
    private readonly stimulus: Stimulus,
    private readonly options: ExecutorOptions,
    private readonly prompts: string[],
    private readonly attachments: ContentBlock[],
    private readonly cleanupTimeoutMs: number,
  ) {
    this.expiresAt = { value: performance.now() + options.timeout };
    this.stopped = new Promise((resolve) => {
      this.signalStop = () => resolve({ kind: "stop" });
    });
    const budget = options.maxAgentDurationMs;
    if (budget !== undefined && budget > 0 && Number.isFinite(budget)) this.budgetRemaining = budget;

    const maxIterations = stimulus.simulation?.max_iterations;
    if (maxIterations !== undefined) {
      // Each root model response counts as one iteration.
      const responses = new Set<string>();
      proc.onLine((line) => {
        if (line.type !== "assistant" || line.parent_tool_use_id || !line.message?.id) return;
        responses.add(line.message.id);
        if (responses.size > maxIterations) this.requestStop("simulation_cap");
      });
    }
  }

  async run(): Promise<RunResult> {
    const { proc, prompts } = this;
    let activeTurn = 0;
    let pendingResult: Promise<StreamLine> | undefined;
    this.resumeBudget();
    try {
      for (let turn = 0; turn < prompts.length && !this.stopReason; turn++) {
        const stage = `turn ${turn + 1} of ${prompts.length}`;
        activeTurn = turn;
        const content: ContentBlock[] = [...(turn === 0 ? this.attachments : []), { type: "text", text: prompts[turn]! }];
        proc.send(userMessage(content));
        pendingResult = proc.nextResult();
        const outcome = await this.waitFor(pendingResult, stage);
        if (outcome.kind === "stop") break;
        if (outcome.kind === "deadline") throw this.timeoutError(stage);
        if (outcome.kind === "exit") throw this.exitError(outcome.exit, stage);
        pendingResult = undefined;
        if (outcome.line.is_error) {
          if (this.stopReason) break;
          const message = resultError(outcome.line);
          if (!LIMIT_RESULT_SUBTYPES.has(outcome.line.subtype ?? "")) {
            throw Object.assign(
              new Error(`Claude Code failed during ${stage} of stimulus '${this.stimulus.name}': ${message}`),
              { retryable: isRetryableStatus(outcome.line.api_error_status) },
            );
          }
          this.softErrors.push(message);
          break;
        }
        if (turn < prompts.length - 1) await this.notify(turn, "completed");
      }

      if (this.stopReason) {
        // Interrupt the active turn, give it a moment to settle, then end the session.
        let settled = pendingResult === undefined;
        if (!settled && !proc.hasExited) {
          proc.interrupt();
          settled = await settleWithin(pendingResult!, this.cleanupTimeoutMs);
        }
        const closed = await proc.close(this.cleanupTimeoutMs);
        await this.notify(activeTurn, settled && closed ? "interrupted" : "unavailable", true);
        return { endReason: this.stopReason, softErrors: this.softErrors };
      }

      // Claude Code can keep working after its last result (e.g. reacting to finished
      // background tasks), so the final turn completes only when the process exits.
      proc.endInput();
      const stage = `turn ${prompts.length} of ${prompts.length}`;
      const ended = await this.waitFor(undefined, stage);
      if (ended.kind === "deadline") throw this.timeoutError(stage);
      if (ended.kind === "exit" && ended.exit.error) throw this.exitError(ended.exit, stage);
      if (ended.kind === "stop") {
        proc.interrupt();
        const closed = await proc.close(this.cleanupTimeoutMs);
        await this.notify(activeTurn, closed ? "interrupted" : "unavailable", true);
        return { endReason: this.stopReason!, softErrors: this.softErrors };
      }
      await this.notify(activeTurn, "completed", true);
      return { endReason: "completed", softErrors: this.softErrors };
    } finally {
      clearTimeout(this.budgetTimer);
      this.budgetTimer = undefined;
    }
  }

  private requestStop(reason: StopReason): void {
    if (this.stopReason) return;
    this.stopReason = reason;
    this.signalStop();
  }

  /** Waits for a result (or, without one, for the process to exit), a stop request, or the deadline. */
  private async waitFor(result: Promise<StreamLine> | undefined, stage: string): Promise<Outcome> {
    const remaining = this.expiresAt.value - performance.now();
    if (remaining <= 0) throw this.timeoutError(stage);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race<Outcome>([
        ...(result ? [result.then((line): Outcome => ({ kind: "result", line }))] : []),
        this.proc.exited.then((exit): Outcome => ({ kind: "exit", exit })),
        this.stopped,
        new Promise<Outcome>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "deadline" }), Math.ceil(remaining));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async notify(turn: number, status: ExecutorTurnCompletion["status"], final = false): Promise<void> {
    if (!this.options.onTurnComplete || this.notified.has(turn)) return;
    this.notified.add(turn);
    this.pauseBudget();
    const callbackStartedAt = performance.now();
    try {
      await this.options.onTurnComplete({ turn, status, ...(final && { final: true }) });
    } finally {
      // Host-side work doesn't count against the agent's budgets.
      this.expiresAt.value += performance.now() - callbackStartedAt;
      this.resumeBudget();
    }
  }

  private pauseBudget(): void {
    if (this.budgetTimer === undefined || this.budgetStartedAt === undefined || this.budgetRemaining === undefined) return;
    clearTimeout(this.budgetTimer);
    this.budgetTimer = undefined;
    this.budgetRemaining = Math.max(0, this.budgetRemaining - (performance.now() - this.budgetStartedAt));
    this.budgetStartedAt = undefined;
  }

  private resumeBudget(): void {
    if (this.stopReason || this.budgetRemaining === undefined || this.budgetTimer !== undefined) return;
    this.budgetStartedAt = performance.now();
    this.budgetTimer = setTimeout(() => {
      this.budgetTimer = undefined;
      this.budgetRemaining = 0;
      this.requestStop("agent_timeout");
    }, this.budgetRemaining);
  }

  private timeoutError(stage: string): Error {
    return new ExecutorDeadlineExceededError(
      `Stimulus '${this.stimulus.name}' timed out after ${this.options.timeout} ms during ${stage}`,
    );
  }

  private exitError(exit: ProcessExit, stage: string): Error {
    const how = exit.error
      ? exit.error.message
      : `exited unexpectedly with ${exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`}`;
    const stderr = this.proc.stderr.trim();
    const error = new Error(
      `Claude Code ${how} during ${stage} of stimulus '${this.stimulus.name}'${stderr ? `:\n${stderr}` : ""}`,
      exit.error ? { cause: exit.error } : undefined,
    );
    if (exit.error) {
      const { code, syscall } = exit.error as NodeJS.ErrnoException;
      Object.assign(error, { code, syscall });
    }
    return error;
  }
}

function resultError(result: StreamLine): string {
  const parts = [
    typeof result.result === "string" && result.result ? result.result : undefined,
    ...(Array.isArray(result.errors) ? result.errors : []),
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : `${result.subtype ?? "error"} (${result.terminal_reason ?? "unknown reason"})`;
}

function isRetryableStatus(status: unknown): boolean {
  return typeof status === "number" && (status === 408 || status === 429 || status >= 500);
}

async function settleWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function buildEnv(options: Pick<ExecutorOptions, "env" | "traceContext">, provider?: ProviderEnv): Record<string, string> {
  const inherited: NodeJS.ProcessEnv = { ...process.env };
  if (provider) {
    for (const name of provider.unset) delete inherited[name];
    Object.assign(inherited, provider.set);
  }
  const env = mergeEnv(inherited, options.env);
  const trace = options.traceContext;
  if (trace?.traceparent) {
    env.TRACEPARENT = trace.traceparent;
    if (trace.tracestate) env.TRACESTATE = trace.tracestate;
    else delete env.TRACESTATE;
  }
  return env;
}

/**
 * Exposes Vally skills to Claude Code without touching the workspace: each skill
 * directory is linked under `<dir>/.claude/skills/<name>`, and `<dir>` is passed
 * with `--add-dir`.
 */
async function linkSkills(runDir: string, skills: Skill[] | undefined): Promise<string | undefined> {
  const withPaths = skills?.filter((skill) => skill.path) ?? [];
  if (withPaths.length === 0) return undefined;
  const root = path.join(runDir, "skills");
  const skillsDir = path.join(root, ".claude", "skills");
  await mkdir(skillsDir, { recursive: true });
  const names = new Set<string>();
  for (const skill of withPaths) {
    const source = path.dirname(skill.path!);
    const name = (skill.name || path.basename(source)).replace(/[^A-Za-z0-9._-]/g, "-");
    if (names.has(name)) throw new Error(`Two skills resolve to the same name '${name}'`);
    names.add(name);
    await symlink(source, path.join(skillsDir, name), "junction");
  }
  return root;
}

interface Artifacts {
  dir?: string;
  stream?: WriteStream;
  stderr?: WriteStream;
  close(): Promise<void>;
}

async function openArtifacts(dir: string | undefined): Promise<Artifacts> {
  if (!dir) return { close: async () => {} };
  await mkdir(dir, { recursive: true });
  const stream = createWriteStream(path.join(dir, "claude-code.jsonl"));
  const stderr = createWriteStream(path.join(dir, "claude-code.stderr.log"));
  const end = (file: WriteStream) => new Promise<void>((resolve) => file.end(resolve));
  return {
    dir,
    stream,
    stderr,
    close: async () => {
      await Promise.all([end(stream), end(stderr)]);
    },
  };
}
