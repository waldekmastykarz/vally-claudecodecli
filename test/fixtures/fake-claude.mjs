#!/usr/bin/env node
// Minimal stand-in for `claude -p --input-format stream-json --output-format stream-json`.
// Behavior is selected with FAKE_CLAUDE_MODE.
import { createInterface } from "node:readline";

const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
const sessionId = "11111111-2222-3333-4444-555555555555";
let messages = 0;
let pendingInterrupt = false;
const emit = (line) => process.stdout.write(`${JSON.stringify({ session_id: sessionId, ...line })}\n`);
const assistant = (content, id = `msg_${++messages}`) =>
  emit({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id,
      model: "claude-fake-1",
      role: "assistant",
      content,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
const result = (fields) => emit({ type: "result", subtype: "success", is_error: false, ...fields });

emit({ type: "system", subtype: "init", model: "claude-fake-1", claude_code_version: "0.0.0", tools: [], fake_args: process.argv.slice(2) });

if (mode === "deaf") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}

createInterface({ input: process.stdin }).on("line", (raw) => {
  const input = JSON.parse(raw);
  if (input.type === "control_request" && input.request.subtype === "interrupt") {
    if (mode === "deaf") return;
    emit({ type: "control_response", response: { subtype: "success", request_id: input.request_id } });
    if (pendingInterrupt) {
      pendingInterrupt = false;
      emit({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
      result({ subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming" });
    }
    return;
  }
  if (input.type !== "user") return;
  emit({ ...input, isReplay: true });
  const prompt = input.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  switch (mode) {
    case "hang":
    case "deaf":
      assistant([{ type: "thinking", thinking: "working", signature: "x" }]);
      pendingInterrupt = true;
      return;
    case "tools":
      assistant([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo hi" } }]);
      emit({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hi" }] } });
      assistant([{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "echo again" } }]);
      emit({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "again" }] } });
      pendingInterrupt = true;
      return;
    case "auth-error":
      assistant([{ type: "text", text: "Not logged in · Please run /login" }]);
      return result({ is_error: true, result: "Not logged in · Please run /login", api_error_status: null });
    case "overloaded":
      return result({ is_error: true, result: "Overloaded", api_error_status: 529 });
    case "budget":
      assistant([{ type: "text", text: "partial" }]);
      return result({ subtype: "error_max_budget_usd", is_error: true, errors: ["Reached maximum budget ($0.01)"] });
    case "crash":
      process.stderr.write("boom: something broke\n");
      process.exit(3);
    default:
      assistant([{ type: "text", text: `echo: ${prompt}` }]);
      result({ result: `echo: ${prompt}` });
  }
});
