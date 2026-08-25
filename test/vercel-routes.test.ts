import assert from "node:assert/strict";
import test from "node:test";
import { GET as healthGET } from "../api/health";
import { GET as mcpGET } from "../api/server";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("framework-free health function returns only safe service metadata", async () => {
  const response = healthGET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    name: "arc-foundry-gemini-polisher",
    version: "0.1.0-dev1",
    status: "ok",
  });
});

test("framework-free MCP function fails closed when auth secret is missing", async () => {
  const previous = process.env.MCP_BEARER_TOKEN;
  delete process.env.MCP_BEARER_TOKEN;
  try {
    const response = await mcpGET(new Request("https://example.test/mcp"));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "mcp_auth_not_configured" });
  } finally {
    restoreEnv("MCP_BEARER_TOKEN", previous);
  }
});

test("framework-free MCP function rejects a disallowed Origin before MCP handling", async () => {
  const previousToken = process.env.MCP_BEARER_TOKEN;
  const previousOrigins = process.env.MCP_ALLOWED_ORIGINS;
  process.env.MCP_BEARER_TOKEN = "test-only-token";
  process.env.MCP_ALLOWED_ORIGINS = "https://chatgpt.com";
  try {
    const response = await mcpGET(new Request("https://example.test/mcp", {
      headers: { origin: "https://evil.example" },
    }));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "origin_not_allowed" });
  } finally {
    restoreEnv("MCP_BEARER_TOKEN", previousToken);
    restoreEnv("MCP_ALLOWED_ORIGINS", previousOrigins);
  }
});
