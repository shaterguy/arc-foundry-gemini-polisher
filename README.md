# Arc Foundry Gemini Polisher MCP

A Vercel-only remote MCP server for the final Korean-language copyediting stage of Arc Foundry novels.

## Contract

This server runs only after **FINAL CONTENT LOCK**. Gemini has no narrative authority. It may improve Korean word order, sentence structure/rhythm, translationese, particles/connectors, repetitive endings, redundant phrasing, modifier relationships, spelling, spacing, punctuation, and awkward Korean novel phrasing.

It must not change events, scene order, setting/worldbuilding, character actions or intent, relationships, dialogue meaning, emotional meaning/intensity, POV, tense, proper nouns, numbers, dates, factual relationships, foreshadowing, or add/delete narrative information.

The tool never writes to Google Drive. It returns an accepted polished candidate only after deterministic protected-value/position checks and a separate semantic-preservation validation. Any provider/configuration/validation failure returns the exact locked source as `fallback_original`.

## MCP tool

`polish_korean_novel_final`

Default unit: one Arc Foundry episode. If a caller must split a long episode, split on actual scene boundaries and send adjacent text only as `before_context` / `after_context`, which are reference-only.

Important inputs:
- `locked_text`: exact FINAL CONTENT LOCK source.
- `protected_manifest`: required manifest with `source: "arc-foundry-final-lock"` and a non-empty unique `terms` list assembled from the authoritative Arc Foundry final-lock ledgers. Missing or malformed manifests fail closed.
- `style_rules`: optional read-only Arc Foundry style rules.
- `before_context`, `after_context`: optional read-only context.

The server derives immutable line block IDs from `locked_text`. Blank lines and explicit scene separators are copied from the locked source, not generated. Gemini may only return replacement text for existing editable block IDs in the exact original order; block addition, deletion, reordering, splitting, merging, or embedded newlines are rejected before semantic validation.

## Runtime and secrets

Hosting target is Vercel only. Runtime entrypoints are framework-free Vercel Functions: `api/server.ts` for MCP and `api/health.ts` for health. `vercel.json` rewrites the public `/mcp` and `/health` paths to those functions. Next.js and React are not application dependencies.

`mcp-handler` declares Next.js as an optional peer for users who mount it in Next.js. This project does not use that integration. Vercel and CI both run `npm ci --omit=peer`, and CI explicitly fails if `next`, `react`, or `react-dom` appears in the installed runtime tree. Required MCP/Zod packages remain direct pinned dependencies.

The implementation is stateless and has no database, Blob/KV storage, Gemini File API, cached-content, or Interactions storage dependency. Raw manuscript/candidate text is not logged by application code. Both Gemini polish and semantic-validation requests use the server-side GenerateContent REST API with top-level `store: false`, overriding project-level logging for those requests.

Configure secrets only as Vercel environment variables:
- `GEMINI_API_KEY` (or `GOOGLE_API_KEY`)
- `MCP_BEARER_TOKEN`

Non-secret configuration:
- `MCP_ALLOWED_ORIGINS` (comma-separated; default `https://chatgpt.com`)
- `GEMINI_MODEL` (default `gemini-3.7-flash`)
- `GEMINI_VALIDATOR_MODEL` (defaults to `GEMINI_MODEL`)
- `GEMINI_MAX_ATTEMPTS` (1-3, default 2)
- `GEMINI_NETWORK_RETRIES` (0-2, default 1)

The `/mcp` route fails closed with HTTP 503 if `MCP_BEARER_TOKEN` is absent. A browser `Origin`, when present, must be allowlisted. `/health` exposes only name/version/status.

## Development

```bash
npm ci --omit=peer
npm audit --omit=peer --audit-level=high
npm run typecheck
npm test
```

CI performs these checks on the development branch and verifies that Next.js/React are absent from the installed runtime tree. No real Gemini key is required for unit tests; provider calls are mocked. Actual Vercel Functions packaging/build and live endpoint checks are performed in the deployment verification stage rather than by introducing a Vercel CLI dependency into the application tree.

## ChatGPT compatibility

The MCP tool is annotated read-only and non-destructive because it transforms caller-provided text and has no external write side effect. Actual ChatGPT custom-app availability and authentication compatibility are product-plan dependent and must be verified against the deployed endpoint before Arc Foundry treats the integration as operational.
