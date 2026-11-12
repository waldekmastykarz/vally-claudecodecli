import type { AtifTrajectory, Skill, Stimulus, Trajectory, TrajectoryEndReason, TrajectoryEvent } from "@microsoft/vally";
import { computeMetrics, fromAtif, validateAtifTrajectory } from "@microsoft/vally";
import { convert } from "atifact";
import { resolveToolOverride } from "./simulation.js";

type Overrides = NonNullable<Stimulus["simulation"]>["tool_overrides"];

/** A parsed Claude Code stream-json line. Only the fields the executor reads are typed. */
export interface StreamLine {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  parent_tool_use_id?: string | null;
  isReplay?: boolean;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  api_error_status?: number | null;
  terminal_reason?: string;
  message?: { id?: string; content?: unknown };
  [key: string]: unknown;
}

export interface BuildTrajectoryInput {
  lines: StreamLine[];
  stimulus: Stimulus;
  prompts: string[];
  workDir: string;
  executor: string;
  requestedModel?: string;
  skills?: Skill[];
  startedAt: Date;
  completedAt: Date;
  endReason: TrajectoryEndReason;
  /** Error results the agent hit but that still produced a gradable run (e.g. budget exhausted). */
  softErrors: string[];
  sessionID?: string;
}

export async function toAtif(lines: StreamLine[]): Promise<AtifTrajectory> {
  const content = lines.map((line) => JSON.stringify(line)).join("\n");
  let trajectory: unknown;
  try {
    ({ trajectory } = await convert(content, { format: "claude-code-jsonl", sourceName: "claude-code stream-json" }));
  } catch (error) {
    throw new Error("Failed to convert the Claude Code log to ATIF", { cause: error });
  }
  return validateAtifTrajectory(trajectory);
}

/**
 * Stamps each event with the configured turn it belongs to. Turns advance only on
 * a root user message matching the next configured prompt, so other user
 * messages (interrupt notices, subagent prompts) don't shift the count.
 */
export function stampTurns(events: TrajectoryEvent[], prompts: string[]): void {
  let turn = 0;
  for (const event of events) {
    if (
      event.type === "user_message" &&
      event.agentId == null &&
      turn + 1 < prompts.length &&
      event.data.content.trim() === prompts[turn + 1]!.trim()
    ) {
      turn++;
    }
    event.turn = turn;
  }
}

/** The final answer: the last root `result` text, falling back to the last assistant message. */
export function finalOutput(lines: StreamLine[], events: TrajectoryEvent[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.type === "result" && typeof line.result === "string" && !line.is_error) return line.result;
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "assistant_message" && event.agentId == null && event.data.content) return event.data.content;
  }
  return "";
}

export async function buildTrajectory(input: BuildTrajectoryInput): Promise<{ trajectory: Trajectory; atif: AtifTrajectory }> {
  const atif = await toAtif(input.lines);
  const trajectory = fromAtif(atif, {
    stimulusName: input.stimulus.name,
    stimulusPrompt: input.stimulus.prompt,
    workDir: input.workDir,
  });
  const events = trajectory.events;

  stampTurns(events, input.prompts);

  const overrides: Overrides = input.stimulus.simulation?.tool_overrides;
  const skillPaths = new Map(input.skills?.flatMap((skill) => (skill.path ? [[skill.name, skill.path] as const] : [])));
  for (const event of events) {
    if (event.type === "tool_call" && resolveToolOverride(event.data.toolName, event.data.arguments, overrides)) {
      event.data.simulated = true;
    }
    if (event.type === "skill_activation" && !event.data.path) {
      const skillPath = skillPaths.get(event.data.name);
      if (skillPath) event.data.path = skillPath;
    }
  }
  const lastTurn = events.at(-1)?.turn ?? 0;
  for (const message of input.softErrors) {
    events.push({ type: "error", timestamp: input.completedAt, turn: lastTurn, data: { message } });
  }

  const init = input.lines.find((line) => line.type === "system" && line.subtype === "init");
  const metrics = computeMetrics(events);
  trajectory.output = finalOutput(input.lines, events);
  trajectory.stimulus = input.stimulus;
  trajectory.endReason = input.endReason;
  trajectory.metrics = { ...metrics, wallTimeMs: input.completedAt.getTime() - input.startedAt.getTime() };
  trajectory.metadata = {
    ...trajectory.metadata,
    model: init?.model ?? trajectory.metadata.model ?? input.requestedModel ?? "unknown",
    executor: input.executor,
    sessionID: input.sessionID ?? init?.session_id ?? trajectory.metadata.sessionID,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  };
  return { trajectory, atif };
}

