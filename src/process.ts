import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { interruptRequest } from "./args.js";
import type { StreamLine } from "./trajectory.js";

const STDERR_TAIL_BYTES = 16 * 1024;

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

/** Wraps a Claude Code process speaking stream-json on stdin/stdout. */
export class ClaudeProcess {
  readonly lines: StreamLine[] = [];
  readonly exited: Promise<ProcessExit>;
  private stderrTail = "";
  private readonly results: StreamLine[] = [];
  private resultWaiters: Array<(line: StreamLine) => void> = [];
  private readonly listeners: Array<(line: StreamLine) => void> = [];
  private exit?: ProcessExit;
  private interrupts = 0;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    onLine: (line: StreamLine, raw: string) => void,
    onStderr: (chunk: string) => void,
  ) {
    this.exited = new Promise((resolve) => {
      let spawnError: Error | undefined;
      child.once("error", (error) => {
        spawnError = error;
        // A process that failed to spawn never emits 'close'.
        if (child.pid === undefined) resolve((this.exit = { code: null, signal: null, error }));
      });
      child.once("close", (code, signal) => resolve((this.exit = { code, signal, error: spawnError })));
    });
    // Writes after the process exits fail with EPIPE; the exit is reported separately.
    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
      onStderr(chunk);
    });
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (raw) => {
      if (!raw.trim()) return;
      let line: StreamLine;
      try {
        line = JSON.parse(raw) as StreamLine;
      } catch {
        onStderr(`${raw}\n`);
        return;
      }
      if (typeof line !== "object" || line === null || typeof line.type !== "string") return;
      this.lines.push(line);
      onLine(line, raw);
      for (const listener of this.listeners) listener(line);
      if (line.type === "result") {
        const waiter = this.resultWaiters.shift();
        if (waiter) waiter(line);
        else this.results.push(line);
      }
    });
  }

  onLine(listener: (line: StreamLine) => void): void {
    this.listeners.push(listener);
  }

  /** Closes stdin and waits for a clean exit, killing the process if it doesn't exit in time. */
  async close(timeoutMs: number): Promise<boolean> {
    this.endInput();
    let timer: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      this.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (!exited) await this.kill(timeoutMs);
    return exited;
  }

  get stderr(): string {
    return this.stderrTail;
  }

  get hasExited(): boolean {
    return this.exit !== undefined;
  }

  /** Resolves with the next `result` line, i.e. the end of the current agent turn. */
  nextResult(): Promise<StreamLine> {
    const queued = this.results.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.resultWaiters.push(resolve));
  }

  send(message: string): void {
    this.child.stdin.write(message);
  }

  interrupt(): void {
    this.send(interruptRequest(`vally-interrupt-${++this.interrupts}`));
  }

  endInput(): void {
    if (!this.child.stdin.writableEnded) this.child.stdin.end();
  }

  /** Terminates the process, escalating to SIGKILL after `graceMs`. */
  async kill(graceMs: number): Promise<ProcessExit> {
    if (this.exit) return this.exit;
    this.child.kill("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      this.exited,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), graceMs);
      }),
    ]);
    clearTimeout(timer);
    if (exited) return exited;
    this.child.kill("SIGKILL");
    return this.exited;
  }
}
