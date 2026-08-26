import type { AuthInfo } from "@modelcontextprotocol/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import {
  OAUTH_ORIGIN,
  OAUTH_RESOURCE,
  OAUTH_RESOURCE_METADATA_PATH,
  OAUTH_SCOPE,
  defaultOAuthStore,
  oauthRuntimeConfigured,
  verifyAccessToken,
} from "../lib/oauth.js";
import { polishLockedText } from "../lib/polisher.js";
import { PROTECTED_MANIFEST_SOURCE } from "../lib/types.js";

const inputSchema = z.object({
  locked_text: z.string().min(1).max(120_000).describe("Exact FINAL CONTENT LOCK text to rewrite without changing narrative meaning"),
  before_context: z.string().max(30_000).optional().describe("Read-only context before the target"),
  after_context: z.string().max(30_000).optional().describe("Read-only context after the target"),
  style_rules: z.string().max(20_000).optional().describe("Read-only Arc Foundry style rules for surface expression only"),
  protected_manifest: z.object({
    source: z.literal(PROTECTED_MANIFEST_SOURCE),
    terms: z.array(z.string().trim().min(1).max(100)).min(1).max(500),
  }).strict().describe("Required authoritative protected-term manifest built from Arc Foundry final-lock ledgers"),
  unit_id: z.string().max(200).optional().describe("Episode/scene identifier for caller traceability; not stored"),
}).strict();

const outputSchema = z.object({
  status: z.enum(["accepted", "fallback_original"]),
  reason: z.enum(["accepted", "validation_failed", "provider_failure", "configuration_failure"]),
  final_text: z.string(),
  lock_sha256: z.string().length(64),
  model: z.string(),
  validator_model: z.string(),
  attempts: z.number().int().min(0).max(3),
  validation: z.object({
    deterministic_passed: z.boolean(),
    semantic_passed: z.boolean(),
    rewrite_adequacy_passed: z.boolean(),
    violations: z.array(z.string()),
  }).strict(),
}).strict();

const mcpHandler = createMcpHandler((server) => {
  server.registerTool(
    "polish_korean_novel_final",
    {
      title: "Rewrite Korean Novel After Final Content Lock",
      description: "Meaning-preserving Korean literary rewrite after FINAL CONTENT LOCK. May substantially restructure sentences and paragraphs within existing scenes while preserving narrative authority; rejected or failed candidates fall back to the exact locked source.",
      inputSchema,
      outputSchema,
      _meta: { securitySchemes: [{ type: "oauth2", scopes: [OAUTH_SCOPE] }] },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const result = await polishLockedText(input);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: result.status,
            reason: result.reason,
            lock_sha256: result.lock_sha256,
            attempts: result.attempts,
            validation: result.validation,
          }),
        }],
        structuredContent: result,
      };
    },
  );
}, {
  serverInfo: { name: "arc-foundry-gemini-polisher", version: "0.1.0-dev7" },
  verboseLogs: false,
});

const requestAuth = new WeakMap<Request, AuthInfo | undefined>();

const authHandler = withMcpAuth(
  mcpHandler,
  async (request) => requestAuth.get(request),
  {
    required: true,
    requiredScopes: [OAUTH_SCOPE],
    resourceMetadataPath: OAUTH_RESOURCE_METADATA_PATH,
    resourceUrl: OAUTH_ORIGIN,
  },
);

function allowedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const allowed = (process.env.MCP_ALLOWED_ORIGINS ?? "https://chatgpt.com")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization") ?? "";
  const [type, token] = authorization.split(" ");
  return type?.toLowerCase() === "bearer" && token ? token : undefined;
}

async function guardedHandler(request: Request): Promise<Response> {
  if (!allowedOrigin(request)) return Response.json({ error: "origin_not_allowed" }, { status: 403 });
  if (!oauthRuntimeConfigured()) return Response.json({ error: "oauth_not_configured" }, { status: 503 });

  const token = bearerToken(request);
  let authInfo: AuthInfo | undefined;
  if (token) {
    try {
      const record = await verifyAccessToken(defaultOAuthStore, token);
      if (record) {
        authInfo = {
          token,
          clientId: record.clientId,
          scopes: record.scopes,
          expiresAt: Math.floor(record.expiresAt / 1000),
          extra: { subject: record.subject, resource: OAUTH_RESOURCE },
        };
      }
    } catch {
      return Response.json({ error: "oauth_store_unavailable" }, { status: 503 });
    }
  }
  requestAuth.set(request, authInfo);
  return authHandler(request);
}

export { guardedHandler as GET, guardedHandler as POST };
