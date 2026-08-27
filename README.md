# Arc Foundry Gemini Polisher MCP

A Vercel-only remote MCP server for the final Korean-language literary rewrite stage of Arc Foundry novels.

## Contract

This server runs only after **FINAL CONTENT LOCK**. Gemini has no narrative authority, but it has broad authority over Korean surface expression inside each existing scene. It may substantially restructure word order, sentences, clauses, and paragraph boundaries; merge or split sentences and paragraphs; remove mechanical subject/pronoun/connector repetition; recast nominalizations and modifier chains; vary repetitive endings; remove translationese and redundant phrasing; improve literary rhythm and breath; and correct spelling, spacing, and punctuation.

The goal is meaning-preserving literary rewriting, not typo-level proofreading. Gemini should not preserve awkward source sentence boundaries merely because they exist, and should leave already-natural prose alone rather than changing it gratuitously.

It must not change events, scene order, setting/worldbuilding, character actions or intent, relationships, dialogue meaning, emotional meaning/intensity, POV, tense, proper-noun identity, numbers, dates, factual relationships, foreshadowing, or add/delete meaningful narrative information. It must not invent description, implication, motivation, chronology, sensory detail, or facts absent from the source.

The tool never writes to Google Drive. It returns an accepted rewritten candidate only after deterministic protected-value/scene checks and a separate Gemini validation that independently judges semantic preservation and rewrite adequacy. Any provider/configuration/validation failure returns the exact locked source as `fallback_original`.

## MCP tool

`polish_korean_novel_final`

Default unit: one Arc Foundry episode. If a caller must split a long episode, split on actual scene boundaries and send adjacent text only as `before_context` / `after_context`, which are reference-only.

Important inputs:
- `locked_text`: exact FINAL CONTENT LOCK source.
- `protected_manifest`: required manifest with `source: "arc-foundry-final-lock"` and a non-empty unique `terms` list assembled from the authoritative Arc Foundry final-lock ledgers. Missing or malformed manifests fail closed.
- `style_rules`: optional read-only Arc Foundry style rules. They may guide surface expression but never override narrative meaning or protected facts.
- `before_context`, `after_context`: optional read-only context.

The server derives immutable scene block IDs from `locked_text`. A scene block is the text between explicit scene-separator lines such as `***`, `---`, or equivalent separators. Gemini may freely restructure sentence and paragraph boundaries inside an existing scene block, including embedded newlines. The existing scene blocks, their order, and separator sequence are immutable; block addition, deletion, or reordering is rejected before semantic validation. Deterministic validation also preserves the numeric/date token sequence and requires protected terms present in the locked source to retain their exact identity, while allowing redundant repeated mentions to be reduced when meaning remains intact.

The semantic validator explicitly permits substantial rewriting and rejects only narrative or factual drift. In the same validation call it separately decides whether the source actually needed rewriting and, if so, whether the candidate materially improved Korean naturalness, syntax, rhythm, and literary readability beyond spelling/particle-level edits. An inadequate but meaning-preserving candidate is retried from the locked source. Already-natural source text does not need gratuitous change.

## Runtime and secrets

Hosting, OAuth endpoints, MCP runtime, and OAuth persistence are Vercel-only. Framework-free Vercel Functions expose `/mcp`, `/health`, RFC 9728 protected-resource metadata, OAuth authorization-server metadata, `/oauth/authorize`, and `/oauth/token`. Next.js and React are not application dependencies.

`mcp-handler` declares Next.js as an optional peer for users who mount it in Next.js. This project does not use that integration. Vercel and CI both run `npm ci --omit=peer`, and CI explicitly fails if `next`, `react`, or `react-dom` appears in the installed runtime tree. Required MCP/Zod packages and the Vercel Blob client remain exact pinned dependencies.

Manuscript processing is stateless. The only persistent application state is OAuth transactional metadata in a **Private Vercel Blob** object (`oauth/state-v2.json`). Authorization codes and access tokens are persisted only by SHA-256 hash with binding/expiry metadata. Each refresh family stores only its current token hash and generation; older refresh tokens are not accumulated. Refresh tokens carry only random family/generation material plus a random secret and an HMAC integrity tag, so any authentic stale generation can revoke the family without persisting plaintext or an unbounded spent-token ledger. Raw manuscript/candidate text, adjacent context, protected manifests, Gemini request/response content, owner credentials, and OAuth token plaintext are never written to Blob by application code. Raw manuscript/candidate text is not logged by application code. Gemini rewrite and semantic/adequacy-validation requests use GenerateContent with `store: false`.

Configure secrets only as Vercel environment variables:
- `GEMINI_API_KEY` (or `GOOGLE_API_KEY`)
- `OAUTH_OWNER_SECRET` — high-entropy owner credential; the server also domain-separates its use as the refresh-token HMAC integrity key
- `BLOB_READ_WRITE_TOKEN` — credential for the private OAuth state Blob store

Non-secret configuration:
- `MCP_ALLOWED_ORIGINS` (comma-separated; default `https://chatgpt.com`)
- `GEMINI_MODEL` (default `gemini-3.7-flash`)
- `GEMINI_VALIDATOR_MODEL` (defaults to `GEMINI_MODEL`)
- `GEMINI_MAX_ATTEMPTS` (1-3, default 2)
- `GEMINI_NETWORK_RETRIES` (0-2, default 1)

`MCP_BEARER_TOKEN` is not accepted by the OAuth candidate and must not be used as a fallback. Missing OAuth/Blob configuration fails closed. A browser `Origin`, when present, must be allowlisted. `/health` exposes only name/version/status.

## ChatGPT OAuth flow

The canonical protected resource is `https://arc-foundry-gemini-polisher.vercel.app/mcp` with scope `polish:invoke`. RFC 9728 metadata is served only at the path-derived `/.well-known/oauth-protected-resource/mcp`; the host-root metadata alias is intentionally absent.

The server is deliberately narrow rather than a general-purpose identity provider:
- ChatGPT CIMD client identification only; no dynamic client-registration endpoint.
- Only `https://chatgpt.com/oauth/.../client.json` client IDs are fetched, with redirects disabled and strict response limits.
- Redirect URIs must be both present in the CIMD document and match the exact ChatGPT connector OAuth callback form.
- Authorization Code + PKCE `S256` only; token endpoint client authentication is `none` for the public ChatGPT client.
- Authorization codes are short-lived and single-use.
- Access tokens are short-lived and bound to client/resource/scope.
- Refresh tokens rotate; any authentic stale generation revokes the family, with a fixed maximum family lifetime and constant-size per-family persisted state.
- OAuth state reads validate the complete nested schema and fail closed before use; updates use optimistic-concurrency writes and fail closed on storage corruption or exhausted conflicts.

The owner authorization page contains no external script or asset and uses restrictive no-cache, referrer, framing, and CSP headers. OAuth secrets/tokens and Authorization headers must not be written to application logs.

## Development

```bash
npm ci --omit=peer
npm audit --omit=peer --audit-level=high
npm run typecheck
npm run runtime-check
npm test
```

CI performs the same checks on the development branch and verifies that Next.js/React are absent from the installed runtime tree. No real Gemini key, owner secret, or Blob credential is required for unit tests; provider and state-store behavior are tested with dependency-injected deterministic fakes. Actual Vercel Functions packaging, OAuth discovery, ChatGPT linking, and live endpoint behavior are deployment-stage gates.

## ChatGPT compatibility

The MCP tool is read-only and non-destructive because it transforms caller-provided text and has no external write side effect. Tool metadata advertises OAuth scope `polish:invoke`; the resource server independently validates access-token resource, scope, expiry, client, and refresh-family revocation before MCP execution.

Operational compatibility is not assumed from unit tests alone. Release verification must connect the deployed endpoint through ChatGPT OAuth, complete tool discovery/Scan Tools, invoke `polish_korean_novel_final`, and confirm both successful Gemini literary rewriting and exact locked-source fallback behavior before Arc Foundry treats the integration as operational.
