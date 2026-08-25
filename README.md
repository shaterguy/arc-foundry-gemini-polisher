# Arc Foundry Gemini Polisher MCP

A Vercel-only remote MCP server for the final Korean-language copyediting stage of Arc Foundry novels.

## Contract

This server runs only after **FINAL CONTENT LOCK**. Gemini has no narrative authority. It may improve Korean word order, sentence structure/rhythm, translationese, particles/connectors, repetitive endings, redundant phrasing, modifier relationships, spelling, spacing, punctuation, and awkward Korean novel phrasing.

It must not change events, scene order, setting/worldbuilding, character actions or intent, relationships, dialogue meaning, emotional meaning/intensity, POV, tense, proper nouns, numbers, dates, factual relationships, foreshadowing, or add/delete narrative information.

The tool never writes to Google Drive. It returns an accepted polished candidate only after deterministic protected-value checks and a separate semantic-preservation validation. Any provider/configuration/validation failure returns the exact locked source as `fallback_original`.

## MCP tool

`polish_korean_novel_final`

Default unit: one Arc Foundry episode. If a caller must split a long episode, split on actual scene boundaries and send adjacent text only as `before_context` / `after_context`, which are reference-only.

Important inputs:
- `locked_text`: exact FINAL CONTENT LOCK source.
- `protected_terms`: character/place/item names and other tokens that must retain their exact occurrence counts.
- `style_rules`: optional read-only Arc Foundry style rules.
- `before_context`, `after_context`: optional read-only context.

## Runtime and secrets

Hosting target is Vercel only. The implementation is stateless and has no database, Blob/KV storage, Gemini File API, cached-content, or Interactions storage dependency. Raw manuscript/candidate text is not logged by application code. It uses Gemini `generateContent`, which is the non-persistent request path rather than the stored Interactions API.

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
npm install
npm run typecheck
npm test
npm run build
```

CI performs the same checks on the development branch. No real Gemini key is required for unit tests; provider calls are mocked.

## ChatGPT compatibility

The MCP tool is annotated read-only and non-destructive because it transforms caller-provided text and has no external write side effect. Actual ChatGPT custom-app availability and authentication compatibility are product-plan dependent and must be verified against the deployed endpoint before Arc Foundry treats the integration as operational.
