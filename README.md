# Vally Claude Code CLI executor

**Evaluate Claude Code the way developers run it: the real `claude` CLI, in a real workspace.**

`vally-claudecodecli` is a [Vally](https://aka.ms/vally) executor plugin that runs evals against the [Claude Code](https://code.claude.com/docs) CLI. Test your agent skills, MCP servers, and prompts with Claude Code, then grade the resulting files, tool calls, and responses with Vally.

- **Real CLI, headless:** runs `claude -p` with streaming JSON input and output. No UI automation.
- **Full Vally feature set:** multi-turn stimuli with per-turn workspace diffs, skills, MCP servers, attachments, tool-call simulation, agent working-time limits, reasoning effort, env vars, and session resume.
- **Detailed trajectories:** tool calls, results, skill activations, and token usage, converted to [ATIF](https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md) with [atifact](https://github.com/waldekmastykarz/atifact) and saved with every trial.

## Run your first eval

### 1. Install

You need:

- Node.js 22.15 or newer
- [Claude Code](https://code.claude.com/docs/en/setup) on your `PATH`, signed in (run `claude` once and complete `/login`, or set `ANTHROPIC_API_KEY`)

Install the CLI and executor in the project that contains your evals:

```sh
npm install --save-dev @microsoft/vally-cli vally-claudecodecli
```

Already using Vally? Install just `vally-claudecodecli`. It requires `@microsoft/vally` 0.21 or newer; npm installs that peer dependency if needed.

### 2. Create an eval

Save this as `eval.yaml`:

```yaml
name: claude-file-creation
defaults:
  executor: claude-code-cli
  model: sonnet
  timeout: 5m
stimuli:
  - name: creates-the-requested-file
    prompt: "Create hello.txt containing exactly: Hello from Vally"
    graders:
      - type: file-contains
        config:
          path: hello.txt
          value: Hello from Vally
```

`model` accepts anything `claude --model` does: an alias such as `sonnet`, `opus`, or `haiku`, or a full model name. Omit it to use Claude Code's default model.

### 3. Run it

```sh
npx vally eval -e eval.yaml --executor-plugin vally-claudecodecli
```

Vally prepares a workspace for each trial, the executor runs Claude Code in it, and Vally grades the result. Trials run in parallel, one Claude Code process per trial.

To avoid repeating the flag, add this to your project's `.vally.yaml`:

```yaml
plugins:
  executor:
    - vally-claudecodecli
```

## How it works

For each trial, the executor starts one Claude Code process in the trial workspace:

```sh
claude -p --input-format stream-json --output-format stream-json --verbose \
  --replay-user-messages --permission-mode bypassPermissions --strict-mcp-config ...
```

It sends each prompt over stdin and waits for Claude Code to finish the turn. For a multi-turn stimulus (`turns`), every prompt goes to the same session, and Vally captures the workspace after each turn. After the last turn, the executor closes stdin and waits for Claude Code to exit, because Claude Code can keep working, for example when a background task finishes.

**Only run trusted evals, fixtures, and MCP servers.** By default, Claude Code runs with `bypassPermissions`, so it runs commands and edits files without asking, using your account and credentials. Change this with [`permissionMode`](#configuration).

### What Claude Code loads

The executor doesn't isolate Claude Code from your machine's configuration. Like running `claude` yourself, a trial loads your user, project, and local settings, including authentication (such as an `apiKeyHelper`), installed plugins, `CLAUDE.md` files, hooks, and skills. This keeps your sign-in working, but it means results can depend on the machine. Keep configuration consistent when comparing runs, or narrow it:

- [`settingSources`](#configuration) limits which settings files load. `[]` loads none, so authenticate with an environment variable or [`provider`](#model-provider) instead.
- `extraArgs: ["--bare"]` or `["--safe-mode"]` turn off customizations. See `claude --help`.

MCP servers are the exception: Claude Code loads only the servers declared in the eval (`agent_environment.mcpServers`).

## Supported Vally features

| Feature | How it maps to Claude Code |
| --- | --- |
| `model` | `--model` |
| `reasoning_effort` | `--effort` (`low`, `medium`, `high`, `xhigh`, `max`, depending on the model) |
| `turns` | Sent one after another to the same session; Vally captures the workspace after each turn, so turn-scoped diff graders work |
| `agent_environment.skills` | Linked into a temporary directory outside the workspace and added with `--add-dir`, so skill names stay as they are and the graded workspace stays clean |
| `agent_environment.mcpServers` | `--mcp-config` with `--strict-mcp-config`. `timeout` becomes the server's tool-call timeout. `cwd` isn't supported by Claude Code and is rejected |
| `agent_environment.env` | Set on the Claude Code process |
| `attachments` | Sent with the first prompt. Images (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) and PDFs |
| `simulation` | See [Tool-call simulation](#tool-call-simulation) |
| `constraints.max_agent_duration` | Interrupts Claude Code when time runs out; the partial run is graded with `endReason: agent_timeout` |
| `constraints.max_duration` / `timeout` | Hard limit; Claude Code is stopped and the trial fails |
| Session resume | `--resume <session id>`. The resumed conversation continues to be saved |
| Trace context | Vally's W3C trace context is passed as `TRACEPARENT`/`TRACESTATE`, which Claude Code uses as the parent of its spans when [telemetry](https://code.claude.com/docs/en/monitoring-usage) is enabled |

Sessions created for a trial aren't saved (`--no-session-persistence`). Claude Code still creates an empty project directory for each trial workspace under `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`); the executor leaves these in place.

### Tool-call simulation

Simulated calls are answered by a Claude Code `PreToolUse` hook that the executor adds for the trial:

- **Shell commands:** overrides keyed `bash`, `shell`, or `powershell` apply to Claude Code's `Bash` and `PowerShell` tools. The command is replaced with one that prints the canned output, so it can succeed or fail.
- **Other tools:** key overrides by the Claude Code tool name, such as `Read`, `WebFetch`, or `mcp__<server>__<tool>`. Claude Code can't return a canned result for these, so the call is blocked and the model sees the output as the tool's error. Vally allows only error results for these tools.
- `max_iterations` counts Claude Code's model responses; the run stops cleanly with `endReason: simulation_cap`.

Simulated calls are marked `simulated: true` in the trajectory.

```yaml
stimuli:
  - name: handles-failing-tests
    prompt: Run the tests and summarize the failures.
    simulation:
      tool_overrides:
        bash:
          patterns:
            - match: "npm test"
              output: "1 failing: add() returns NaN"
              is_error: true
        WebFetch: { output: "Network is unavailable", is_error: true }
```

## Configuration

Most evals need no executor configuration. These options go under `defaults.executor.config`:

| Option | Purpose |
| --- | --- |
| `claudePath` | Path to the Claude Code executable. Default: `claude` on `PATH` |
| `permissionMode` | `acceptEdits`, `auto`, `bypassPermissions` (default), `dontAsk`, `manual`, or `plan` |
| `settingSources` | Settings files to load: any of `user`, `project`, `local`. Default: all |
| `allowedTools` / `disallowedTools` | Tool rules, for example `["Bash(git *)", "Edit"]` |
| `systemPrompt` / `appendSystemPrompt` | Replace or extend Claude Code's system prompt |
| `maxBudgetUsd` | Spending limit per trial. When it's reached, the run ends and is graded with an `error` event |
| `fallbackModel` | Model to fall back to when the main model is overloaded |
| `extraArgs` | Additional `claude` arguments. Flags the executor sets itself are rejected |
| `provider` | See [Model provider](#model-provider) |

```yaml
defaults:
  executor:
    name: claude-code-cli
    config:
      permissionMode: acceptEdits
      settingSources: [project]
      disallowedTools: [WebFetch, WebSearch]
```

`vally lint` doesn't load executor plugins, so `vally eval` validates this configuration.

### Model provider

`provider` points Claude Code at a specific model provider, like the `copilot-sdk` executor's `provider`. Credentials are read from environment variables you name, so secrets never appear in the eval spec. When `provider` is set, inherited provider and credential variables (such as `ANTHROPIC_API_KEY` or `CLAUDE_CODE_USE_BEDROCK`) are removed first, so the configured provider is the one used.

| `type` | Options | Claude Code variables |
| --- | --- | --- |
| `anthropic` (default) | `baseUrl`, `apiKeyEnv`, `bearerTokenEnv`, `headers` | `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` (wins over the API key), `ANTHROPIC_CUSTOM_HEADERS` |
| `bedrock` | `region`, `apiKeyEnv`, `baseUrl` | `CLAUDE_CODE_USE_BEDROCK`, `AWS_REGION`, `AWS_BEARER_TOKEN_BEDROCK`, `ANTHROPIC_BEDROCK_BASE_URL` |
| `vertex` | `region`, `projectId`, `baseUrl` | `CLAUDE_CODE_USE_VERTEX`, `CLOUD_ML_REGION`, `ANTHROPIC_VERTEX_PROJECT_ID`, `ANTHROPIC_VERTEX_BASE_URL` |
| `foundry` | `resource` or `baseUrl`, `apiKeyEnv` | `CLAUDE_CODE_USE_FOUNDRY`, `ANTHROPIC_FOUNDRY_RESOURCE`, `ANTHROPIC_FOUNDRY_BASE_URL`, `ANTHROPIC_FOUNDRY_API_KEY` |

```yaml
defaults:
  executor:
    name: claude-code-cli
    config:
      provider:
        baseUrl: https://llm-gateway.example.com
        bearerTokenEnv: LLM_GATEWAY_TOKEN
```

Cloud providers otherwise use their usual credentials, such as your AWS or Google Cloud sign-in. Variables in `agent_environment.env` are applied last and override the provider.

## Artifacts

Each trial's `executor-artifacts` directory contains:

| File | Contents |
| --- | --- |
| `claude-code.jsonl` | Claude Code's raw `stream-json` output |
| `claude-code.stderr.log` | Claude Code's stderr |
| `trajectory.atif.json` | The ATIF trajectory the Vally trajectory was built from |

**Review artifacts before sharing them.** They contain prompts, generated code, tool output, and local paths.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `Claude Code executable 'claude' was not found` | Install Claude Code or set `claudePath`. |
| `Not logged in · Please run /login` | Sign in with `claude`, or set `ANTHROPIC_API_KEY`. If you limited `settingSources`, your `apiKeyHelper` or login may not load; use `provider` instead. |
| Trial times out | Raise `timeout`, or use `constraints.max_agent_duration` to grade partial runs. Check `claude-code.jsonl` to see what the agent was doing. |
| Unexpected skills, hooks, or instructions | Your user configuration is loaded. See [What Claude Code loads](#what-claude-code-loads). |

## Limitations

- **Token metrics are approximate.** The trajectory comes from atifact's Claude Code parser, which currently counts usage once per content block rather than once per model response and reads output tokens before a response finishes. It also drops reasoning, failed-tool status, subagent activity, and timestamps. These are tracked in atifact ([#27](https://github.com/waldekmastykarz/atifact/issues/27)–[#32](https://github.com/waldekmastykarz/atifact/issues/32)) and improve as atifact is updated. Check `claude-code.jsonl` for exact values; the `result` line has Claude Code's totals and cost.
- **Simulation of non-shell tools is error-only**, and MCP tools can't be given canned successful results.
- **Machine-dependent configuration.** See [What Claude Code loads](#what-claude-code-loads).

## License

[MIT](LICENSE)
