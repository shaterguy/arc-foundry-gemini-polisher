import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GET as healthGET } from "../api/health";
import { GET as metadataGET } from "../api/oauth-metadata";
import { GET as protectedResourceGET } from "../api/oauth-protected-resource";
import { GET as mcpGET } from "../api/server";
import { OAUTH_ORIGIN, OAUTH_RESOURCE, OAUTH_RESOURCE_METADATA_PATH, OAUTH_SCOPE } from "../lib/oauth";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("framework-free health function returns only safe service metadata", async () => {
  const response = healthGET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    name: "arc-foundry-gemini-polisher",
    version: "0.1.0-dev4",
    status: "ok",
  });
});

test("OAuth discovery metadata is ChatGPT CIMD-only with PKCE S256", async () => {
  const response = metadataGET();
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.issuer, OAUTH_ORIGIN);
  assert.equal(body.client_id_metadata_document_supported, true);
  assert.deepEqual(body.token_endpoint_auth_methods_supported, ["none"]);
  assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
  assert.equal(Object.hasOwn(body, "registration_endpoint"), false);
});

test("protected resource metadata binds the canonical /mcp resource", async () => {
  const response = protectedResourceGET();
  const body = await response.json();
  assert.equal(body.resource, OAUTH_RESOURCE);
  assert.deepEqual(body.authorization_servers, [OAUTH_ORIGIN]);
  assert.deepEqual(body.scopes_supported, [OAUTH_SCOPE]);
});

test("Vercel exposes only the RFC 9728 path-derived protected-resource metadata route", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
    rewrites: Array<{ source: string }>;
  };
  const sources = config.rewrites.map((rewrite) => rewrite.source);
  assert.equal(sources.includes(OAUTH_RESOURCE_METADATA_PATH), true);
  assert.equal(sources.includes("/.well-known/oauth-protected-resource"), false);
});

test("MCP function fails closed when OAuth runtime secrets are missing", async () => {
  const previousOwner = process.env.OAUTH_OWNER_SECRET;
  const previousBlob = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.OAUTH_OWNER_SECRET;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const response = await mcpGET(new Request("https://example.test/mcp"));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "oauth_not_configured" });
  } finally {
    restoreEnv("OAUTH_OWNER_SECRET", previousOwner);
    restoreEnv("BLOB_READ_WRITE_TOKEN", previousBlob);
  }
});

test("MCP unauthenticated request returns OAuth resource discovery challenge when configured", async () => {
  const previousOwner = process.env.OAUTH_OWNER_SECRET;
  const previousBlob = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.OAUTH_OWNER_SECRET = "x".repeat(43);
  process.env.BLOB_READ_WRITE_TOKEN = "test-only-placeholder";
  try {
    const response = await mcpGET(new Request(`${OAUTH_ORIGIN}/mcp`));
    assert.equal(response.status, 401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    assert.match(challenge, /resource_metadata=/u);
    assert.match(challenge, /oauth-protected-resource\/mcp/u);
    assert.match(challenge, /polish:invoke/u);
  } finally {
    restoreEnv("OAUTH_OWNER_SECRET", previousOwner);
    restoreEnv("BLOB_READ_WRITE_TOKEN", previousBlob);
  }
});

test("MCP function rejects a disallowed Origin before OAuth handling", async () => {
  const previousOrigins = process.env.MCP_ALLOWED_ORIGINS;
  process.env.MCP_ALLOWED_ORIGINS = "https://chatgpt.com";
  try {
    const response = await mcpGET(new Request(`${OAUTH_ORIGIN}/mcp`, {
      headers: { origin: "https://evil.example" },
    }));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "origin_not_allowed" });
  } finally {
    restoreEnv("MCP_ALLOWED_ORIGINS", previousOrigins);
  }
});
