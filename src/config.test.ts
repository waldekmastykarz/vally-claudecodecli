import { describe, expect, it } from "vitest";
import { parseConfig, providerEnv } from "./config.js";

describe("parseConfig", () => {
  it("accepts a full config", () => {
    const config = {
      claudePath: "/opt/claude",
      permissionMode: "acceptEdits",
      settingSources: ["project", "local"],
      allowedTools: ["Bash(git *)", "Edit"],
      maxBudgetUsd: 1.5,
      extraArgs: ["--betas", "x"],
      provider: { type: "bedrock", region: "us-east-1" },
    };
    expect(parseConfig(config)).toMatchObject(config);
  });

  it.each([
    [{ model: "x" }, /unknown field 'model'/],
    [{ permissionMode: "yolo" }, /permissionMode must be one of/],
    [{ settingSources: ["global"] }, /settingSources entries must be one of/],
    [{ maxBudgetUsd: 0 }, /maxBudgetUsd must be a positive number/],
    [{ extraArgs: ["--output-format=json"] }, /must not contain '--output-format'/],
    [{ provider: { type: "vertex", apiKeyEnv: "KEY" } }, /apiKeyEnv is not supported for provider type 'vertex'/],
    [{ provider: { apiKeyEnv: "not a name" } }, /apiKeyEnv must be the name of an environment variable/],
    [{ provider: { type: "foundry" } }, /requires either 'resource' or 'baseUrl'/],
    [{ provider: { headers: { "X-Bad": "a\nb" } } }, /must be a single-line string/],
  ])("rejects %j", (config, message) => {
    expect(() => parseConfig(config)).toThrow(message);
  });
});

describe("providerEnv", () => {
  it("prefers a bearer token over an API key and clears other credentials", () => {
    const result = providerEnv(
      {
        type: "anthropic",
        baseUrl: "https://gateway.example",
        apiKeyEnv: "MY_KEY",
        bearerTokenEnv: "MY_TOKEN",
        headers: { "X-Team": "evals", "X-Env": "ci" },
      },
      { MY_KEY: "key-value", MY_TOKEN: "token-value" },
    );
    expect(result.set).toEqual({
      ANTHROPIC_BASE_URL: "https://gateway.example",
      ANTHROPIC_AUTH_TOKEN: "token-value",
      ANTHROPIC_CUSTOM_HEADERS: "X-Team: evals\nX-Env: ci",
    });
    expect(result.unset).toContain("ANTHROPIC_API_KEY");
    expect(result.unset).toContain("CLAUDE_CODE_USE_BEDROCK");
    expect(result.secrets).toEqual(["token-value"]);
  });

  it("maps cloud providers", () => {
    expect(providerEnv({ type: "bedrock", region: "us-west-2", apiKeyEnv: "BR" }, { BR: "br-key" }).set).toEqual({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-west-2",
      AWS_BEARER_TOKEN_BEDROCK: "br-key",
    });
    expect(providerEnv({ type: "vertex", region: "global", projectId: "p" }, {}).set).toEqual({
      CLAUDE_CODE_USE_VERTEX: "1",
      CLOUD_ML_REGION: "global",
      ANTHROPIC_VERTEX_PROJECT_ID: "p",
    });
    expect(providerEnv({ type: "foundry", resource: "r", apiKeyEnv: "F" }, { F: "f-key" }).set).toEqual({
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_RESOURCE: "r",
      ANTHROPIC_FOUNDRY_API_KEY: "f-key",
    });
  });

  it("fails when a referenced credential isn't set", () => {
    expect(() => providerEnv({ apiKeyEnv: "MISSING_KEY" }, {})).toThrow(/'MISSING_KEY', which is not set/);
  });
});
