import { timingSafeEqual } from "node:crypto";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { polishLockedText } from "../../lib/polisher";
import { PROTECTED_MANIFEST_SOURCE } from "../../lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const inputSchema = z.object({
  locked_text: z.string().min(1).max(120_000).describe("Exact FINAL CONTENT LOCK text to polish"),
  before_context: z.string().max(30_000).optional().describe("Read-only context before the target"),
  after_context: z.string().max(30_000).optional().describe("Read-only context after the target"),
  style_rules: z.string().max(20_000).optional().describe("Read-only Arc Foundry style rules"),
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
    violations: z.array(z.string()),
  }).strict(),
}).strict();

const mcpHandler = createMcpHandler((server) => {
  server.registerTool(
    "polish_korean_novel_final",
    {
      title: "Polish Korean Novel After Final Content Lock",
      description: "Surface-level Korean novel copyediting after FINAL CONTENT LOCK. Never changes narrative authority; rejected or failed candidates fall back to the exact locked source.",
      inputSchema,
      outputSchema,
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
  serverInfo: { name: "arc-foundry-gemini-polisher", version: "0.1.0-dev1" },
  verboseLogs: false,
});

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function allowedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const allowed = (process.env.MCP_ALLOWED_ORIGINS ?? "https://chatgpt.com")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

function unauthorized(): Response {
  return Response.json(
    { error: "unauthorized" },
    { status: 401, headers: { "WWW-Authenticate": "Bearer realm=\"arc-foundry-gemini-polisher\"" } },
  );
}

async function guardedHandler(request: Request): Promise<Response> {
  if (!allowedOrigin(request)) return Response.json({ error: "origin_not_allowed" }, { status: 403 });

  const expectedToken = process.env.MCP_BEARER_TOKEN;
  if (!expectedToken) return Response.json({ error: "mcp_auth_not_configured" }, { status: 503 });

  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return unauthorized();
  const actualToken = authorization.slice("Bearer ".length);
  if (!constantTimeEqual(actualToken, expectedToken)) return unauthorized();

  return mcpHandler(request);
}

export { guardedHandler as GET, guardedHandler as POST };
