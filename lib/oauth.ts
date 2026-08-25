import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { BlobPreconditionFailedError, get, put } from "@vercel/blob";

export const OAUTH_ORIGIN = "https://arc-foundry-gemini-polisher.vercel.app";
export const OAUTH_RESOURCE = `${OAUTH_ORIGIN}/mcp`;
export const OAUTH_SCOPE = "polish:invoke";
export const OAUTH_OFFLINE_SCOPE = "offline_access";
export const OAUTH_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";
export const OAUTH_STATE_PATH = "oauth/state-v1.json";
export const OAUTH_STATE_MAX_BYTES = 256 * 1024;
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const AUTH_CODE_TTL_MS = 2 * 60 * 1000;
export const REFRESH_FAMILY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const OWNER_ATTEMPT_TTL_MS = 5 * 60 * 1000;
export const OWNER_ATTEMPT_LIMIT = 5;
const STORE_RETRIES = 3;

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
}

interface AuthorizationCodeRecord {
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  codeChallenge: string;
  subject: "owner";
  expiresAt: number;
}

export interface AccessTokenRecord {
  clientId: string;
  resource: string;
  scopes: string[];
  subject: "owner";
  familyId: string;
  expiresAt: number;
}

interface RefreshTokenRecord {
  clientId: string;
  resource: string;
  scopes: string[];
  subject: "owner";
  familyId: string;
  status: "active" | "spent" | "revoked";
  expiresAt: number;
}

interface OwnerFailureRecord {
  count: number;
  expiresAt: number;
}

export interface OAuthState {
  version: 1;
  codes: Record<string, AuthorizationCodeRecord>;
  accessTokens: Record<string, AccessTokenRecord>;
  refreshTokens: Record<string, RefreshTokenRecord>;
  revokedFamilies: Record<string, number>;
  ownerFailures: Record<string, OwnerFailureRecord>;
}

export interface StateTransaction<T> {
  value: T;
  commit: boolean;
}

export interface OAuthStateStore {
  read(): Promise<OAuthState>;
  transact<T>(mutator: (state: OAuthState) => StateTransaction<T>): Promise<T>;
}

export class OAuthProtocolError extends Error {
  constructor(
    public readonly oauthCode: "invalid_request" | "invalid_client" | "invalid_grant" | "invalid_scope" | "temporarily_unavailable",
    public readonly status = 400,
  ) {
    super(oauthCode);
    this.name = "OAuthProtocolError";
  }
}

export class OAuthStorageError extends Error {
  constructor() {
    super("oauth_storage_unavailable");
    this.name = "OAuthStorageError";
  }
}

export function emptyOAuthState(): OAuthState {
  return {
    version: 1,
    codes: {},
    accessTokens: {},
    refreshTokens: {},
    revokedFamilies: {},
    ownerFailures: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseOAuthState(text: string): OAuthState {
  if (Buffer.byteLength(text, "utf8") > OAUTH_STATE_MAX_BYTES) throw new OAuthStorageError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OAuthStorageError();
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.codes) || !isRecord(parsed.accessTokens)
    || !isRecord(parsed.refreshTokens) || !isRecord(parsed.revokedFamilies) || !isRecord(parsed.ownerFailures)) {
    throw new OAuthStorageError();
  }
  return parsed as unknown as OAuthState;
}

function pruneState(state: OAuthState, now = Date.now()): void {
  for (const [key, record] of Object.entries(state.codes)) if (record.expiresAt <= now) delete state.codes[key];
  for (const [key, record] of Object.entries(state.accessTokens)) if (record.expiresAt <= now) delete state.accessTokens[key];
  for (const [key, record] of Object.entries(state.refreshTokens)) if (record.expiresAt <= now) delete state.refreshTokens[key];
  for (const [key, expiresAt] of Object.entries(state.revokedFamilies)) if (expiresAt <= now) delete state.revokedFamilies[key];
  for (const [key, record] of Object.entries(state.ownerFailures)) if (record.expiresAt <= now) delete state.ownerFailures[key];
}

function ensureStateCapacity(state: OAuthState): void {
  if (Object.keys(state.codes).length > 128 || Object.keys(state.accessTokens).length > 256
    || Object.keys(state.refreshTokens).length > 256 || Object.keys(state.revokedFamilies).length > 128
    || Object.keys(state.ownerFailures).length > 128) {
    throw new OAuthStorageError();
  }
}

function blobToken(): string {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new OAuthStorageError();
  return token;
}

function isCasConflict(error: unknown): boolean {
  if (error instanceof BlobPreconditionFailedError) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /precondition|already exists|conflict|\b409\b|\b412\b/iu.test(message);
}

export class BlobOAuthStore implements OAuthStateStore {
  private async snapshot(): Promise<{ state: OAuthState; etag: string | null; exists: boolean }> {
    try {
      const result = await get(OAUTH_STATE_PATH, { access: "private", useCache: false, token: blobToken() });
      if (!result) return { state: emptyOAuthState(), etag: null, exists: false };
      if (result.statusCode !== 200 || result.blob.size > OAUTH_STATE_MAX_BYTES) throw new OAuthStorageError();
      const text = await new Response(result.stream).text();
      const state = parseOAuthState(text);
      pruneState(state);
      return { state, etag: result.blob.etag || null, exists: true };
    } catch (error) {
      if (error instanceof OAuthStorageError) throw error;
      throw new OAuthStorageError();
    }
  }

  async read(): Promise<OAuthState> {
    return (await this.snapshot()).state;
  }

  async transact<T>(mutator: (state: OAuthState) => StateTransaction<T>): Promise<T> {
    for (let attempt = 0; attempt < STORE_RETRIES; attempt += 1) {
      const snapshot = await this.snapshot();
      const state = structuredClone(snapshot.state);
      pruneState(state);
      const result = mutator(state);
      if (!result.commit) return result.value;
      ensureStateCapacity(state);
      const body = JSON.stringify(state);
      if (Buffer.byteLength(body, "utf8") > OAUTH_STATE_MAX_BYTES) throw new OAuthStorageError();
      try {
        await put(OAUTH_STATE_PATH, body, {
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: snapshot.exists,
          ...(snapshot.exists && snapshot.etag ? { ifMatch: snapshot.etag } : {}),
          contentType: "application/json",
          cacheControlMaxAge: 60,
          token: blobToken(),
        });
        return result.value;
      } catch (error) {
        if (isCasConflict(error) && attempt + 1 < STORE_RETRIES) continue;
        throw new OAuthStorageError();
      }
    }
    throw new OAuthStorageError();
  }
}

export const defaultOAuthStore = new BlobOAuthStore();

export function hashOpaque(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function randomOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function validateVerifier(verifier: string): void {
  if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) throw new OAuthProtocolError("invalid_grant");
}

export function oauthRuntimeConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN && process.env.OAUTH_OWNER_SECRET && process.env.OAUTH_OWNER_SECRET.length >= 43);
}

export function getOwnerSecret(): string {
  const secret = process.env.OAUTH_OWNER_SECRET;
  if (!secret || secret.length < 43) throw new OAuthProtocolError("temporarily_unavailable", 503);
  return secret;
}

function normalizeScopes(raw: string): string[] {
  if (!raw || raw.length > 200) throw new OAuthProtocolError("invalid_scope");
  const scopes = [...new Set(raw.split(/\s+/u).filter(Boolean))];
  if (!scopes.includes(OAUTH_SCOPE) || scopes.some((scope) => scope !== OAUTH_SCOPE && scope !== OAUTH_OFFLINE_SCOPE)) {
    throw new OAuthProtocolError("invalid_scope");
  }
  return scopes;
}

function validateClientIdUrl(clientId: string): URL {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new OAuthProtocolError("invalid_client");
  }
  if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || url.port || url.username || url.password
    || url.search || url.hash || clientId.length > 512 || !url.pathname.startsWith("/oauth/")
    || !url.pathname.endsWith("/client.json") || url.pathname.includes("..")) {
    throw new OAuthProtocolError("invalid_client");
  }
  return url;
}

function validateRedirectUri(redirectUri: string): void {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new OAuthProtocolError("invalid_request");
  }
  if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || url.port || url.username || url.password
    || url.search || url.hash || !/^\/connector\/oauth\/[A-Za-z0-9._~-]{1,240}$/u.test(url.pathname)) {
    throw new OAuthProtocolError("invalid_request");
  }
}

interface CimdDocument {
  client_id?: unknown;
  redirect_uris?: unknown;
  token_endpoint_auth_method?: unknown;
  token_endpoint_auth_methods_supported?: unknown;
}

async function fetchCimd(clientId: string, redirectUri: string, fetchImpl: typeof fetch): Promise<void> {
  validateClientIdUrl(clientId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetchImpl(clientId, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new OAuthProtocolError("invalid_client");
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > 32 * 1024) throw new OAuthProtocolError("invalid_client");
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 32 * 1024) throw new OAuthProtocolError("invalid_client");
    let document: CimdDocument;
    try {
      document = JSON.parse(text) as CimdDocument;
    } catch {
      throw new OAuthProtocolError("invalid_client");
    }
    if (document.client_id !== clientId || !Array.isArray(document.redirect_uris)
      || !document.redirect_uris.every((item) => typeof item === "string")
      || !(document.redirect_uris as string[]).includes(redirectUri)) {
      throw new OAuthProtocolError("invalid_client");
    }
    const single = document.token_endpoint_auth_method;
    const supported = document.token_endpoint_auth_methods_supported;
    const supportsNone = single === "none" || (Array.isArray(supported) && supported.includes("none"));
    if (!supportsNone) throw new OAuthProtocolError("invalid_client");
  } catch (error) {
    if (error instanceof OAuthProtocolError) throw error;
    throw new OAuthProtocolError("invalid_client");
  } finally {
    clearTimeout(timeout);
  }
}

export async function validateAuthorizationRequest(
  params: URLSearchParams,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthorizationRequest> {
  if (params.get("response_type") !== "code") throw new OAuthProtocolError("invalid_request");
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const resource = params.get("resource") ?? "";
  const state = params.get("state") ?? "";
  const codeChallenge = params.get("code_challenge") ?? "";
  if (resource !== OAUTH_RESOURCE || state.length < 8 || state.length > 2048
    || params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/u.test(codeChallenge)) {
    throw new OAuthProtocolError("invalid_request");
  }
  validateRedirectUri(redirectUri);
  const scopes = normalizeScopes(params.get("scope") ?? "");
  await fetchCimd(clientId, redirectUri, fetchImpl);
  return { clientId, redirectUri, resource, scopes, state, codeChallenge };
}

function ownerAttemptKey(request: AuthorizationRequest): string {
  return hashOpaque([request.clientId, request.redirectUri, request.resource, request.state, request.codeChallenge].join("\u0000"));
}

export async function getOwnerFailureCount(store: OAuthStateStore, request: AuthorizationRequest): Promise<number> {
  const state = await store.read();
  return state.ownerFailures[ownerAttemptKey(request)]?.count ?? 0;
}

export async function recordOwnerFailure(store: OAuthStateStore, request: AuthorizationRequest, now = Date.now()): Promise<number> {
  const key = ownerAttemptKey(request);
  return store.transact((state) => {
    const current = state.ownerFailures[key];
    const count = Math.min(OWNER_ATTEMPT_LIMIT, (current?.count ?? 0) + 1);
    state.ownerFailures[key] = { count, expiresAt: now + OWNER_ATTEMPT_TTL_MS };
    return { value: count, commit: true };
  });
}

export async function issueAuthorizationCode(store: OAuthStateStore, request: AuthorizationRequest, now = Date.now()): Promise<string> {
  const code = randomOpaqueToken();
  const key = hashOpaque(code);
  await store.transact((state) => {
    state.codes[key] = {
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      resource: request.resource,
      scopes: request.scopes,
      codeChallenge: request.codeChallenge,
      subject: "owner",
      expiresAt: now + AUTH_CODE_TTL_MS,
    };
    delete state.ownerFailures[ownerAttemptKey(request)];
    return { value: undefined, commit: true };
  });
  return code;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function revokeFamily(state: OAuthState, familyId: string, until: number): void {
  state.revokedFamilies[familyId] = until;
  for (const [key, record] of Object.entries(state.refreshTokens)) {
    if (record.familyId === familyId) state.refreshTokens[key] = { ...record, status: "revoked" };
  }
  for (const [key, record] of Object.entries(state.accessTokens)) {
    if (record.familyId === familyId) delete state.accessTokens[key];
  }
}

export async function exchangeAuthorizationCode(
  store: OAuthStateStore,
  form: URLSearchParams,
  now = Date.now(),
): Promise<TokenResponse> {
  const code = form.get("code") ?? "";
  const clientId = form.get("client_id") ?? "";
  const redirectUri = form.get("redirect_uri") ?? "";
  const resource = form.get("resource") ?? "";
  const verifier = form.get("code_verifier") ?? "";
  if (!code || !clientId || !redirectUri || resource !== OAUTH_RESOURCE) throw new OAuthProtocolError("invalid_grant");
  validateClientIdUrl(clientId);
  validateRedirectUri(redirectUri);
  validateVerifier(verifier);
  const codeKey = hashOpaque(code);
  const accessToken = randomOpaqueToken();
  const refreshToken = randomOpaqueToken();
  const familyId = randomOpaqueToken();
  const result = await store.transact((state) => {
    const record = state.codes[codeKey];
    if (!record || record.expiresAt <= now || record.clientId !== clientId || record.redirectUri !== redirectUri
      || record.resource !== resource || !constantTimeEqual(record.codeChallenge, pkceChallenge(verifier))) {
      return { value: null, commit: false };
    }
    delete state.codes[codeKey];
    const absoluteExpiry = now + REFRESH_FAMILY_TTL_MS;
    state.accessTokens[hashOpaque(accessToken)] = {
      clientId, resource, scopes: record.scopes, subject: "owner", familyId, expiresAt: now + ACCESS_TOKEN_TTL_MS,
    };
    state.refreshTokens[hashOpaque(refreshToken)] = {
      clientId, resource, scopes: record.scopes, subject: "owner", familyId, status: "active", expiresAt: absoluteExpiry,
    };
    return { value: { scopes: record.scopes }, commit: true };
  });
  if (!result) throw new OAuthProtocolError("invalid_grant");
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_MS / 1000,
    refresh_token: refreshToken,
    scope: result.scopes.join(" "),
  };
}

export async function rotateRefreshToken(
  store: OAuthStateStore,
  form: URLSearchParams,
  now = Date.now(),
): Promise<TokenResponse> {
  const refreshToken = form.get("refresh_token") ?? "";
  const clientId = form.get("client_id") ?? "";
  const resource = form.get("resource") ?? "";
  if (!refreshToken || !clientId || resource !== OAUTH_RESOURCE) throw new OAuthProtocolError("invalid_grant");
  validateClientIdUrl(clientId);
  const requestedScopeRaw = form.get("scope");
  const requestedScopes = requestedScopeRaw ? normalizeScopes(requestedScopeRaw) : null;
  const oldKey = hashOpaque(refreshToken);
  const newAccessToken = randomOpaqueToken();
  const newRefreshToken = randomOpaqueToken();
  const outcome = await store.transact((state) => {
    const record = state.refreshTokens[oldKey];
    if (!record || record.clientId !== clientId || record.resource !== resource || record.expiresAt <= now) {
      return { value: { kind: "invalid" as const }, commit: false };
    }
    if (record.status !== "active" || state.revokedFamilies[record.familyId]) {
      revokeFamily(state, record.familyId, record.expiresAt);
      return { value: { kind: "replay" as const }, commit: true };
    }
    const scopes = requestedScopes ?? record.scopes;
    if (!scopes.every((scope) => record.scopes.includes(scope)) || !scopes.includes(OAUTH_SCOPE)) {
      return { value: { kind: "scope" as const }, commit: false };
    }
    state.refreshTokens[oldKey] = { ...record, status: "spent" };
    state.refreshTokens[hashOpaque(newRefreshToken)] = { ...record, scopes, status: "active" };
    state.accessTokens[hashOpaque(newAccessToken)] = {
      clientId, resource, scopes, subject: "owner", familyId: record.familyId, expiresAt: now + ACCESS_TOKEN_TTL_MS,
    };
    return { value: { kind: "ok" as const, scopes }, commit: true };
  });
  if (outcome.kind === "scope") throw new OAuthProtocolError("invalid_scope");
  if (outcome.kind !== "ok") throw new OAuthProtocolError("invalid_grant");
  return {
    access_token: newAccessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_MS / 1000,
    refresh_token: newRefreshToken,
    scope: outcome.scopes.join(" "),
  };
}

export async function verifyAccessToken(
  store: OAuthStateStore,
  token: string,
  now = Date.now(),
): Promise<AccessTokenRecord | undefined> {
  if (!token || token.length > 512) return undefined;
  const state = await store.read();
  const record = state.accessTokens[hashOpaque(token)];
  if (!record || record.expiresAt <= now || record.resource !== OAUTH_RESOURCE || !record.scopes.includes(OAUTH_SCOPE)
    || state.revokedFamilies[record.familyId]) return undefined;
  return record;
}

export async function readFormUrlEncoded(request: Request, maxBytes = 8192): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type") ?? "";
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded") || declared > maxBytes) {
    throw new OAuthProtocolError("invalid_request");
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new OAuthProtocolError("invalid_request");
  return new URLSearchParams(text);
}

export function oauthJson(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

export function oauthErrorResponse(error: unknown): Response {
  if (error instanceof OAuthProtocolError) return oauthJson({ error: error.oauthCode }, error.status);
  return oauthJson({ error: "temporarily_unavailable" }, 503);
}

export function parseCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export const OAUTH_CSRF_COOKIE = "__Host-af_oauth_csrf";

export function renderAuthorizationPage(request: AuthorizationRequest, csrf: string, message = ""): Response {
  const hidden = [
    ["response_type", "code"], ["client_id", request.clientId], ["redirect_uri", request.redirectUri],
    ["resource", request.resource], ["scope", request.scopes.join(" ")], ["state", request.state],
    ["code_challenge", request.codeChallenge], ["code_challenge_method", "S256"], ["csrf", csrf],
  ].map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`).join("");
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Arc Foundry MCP 승인</title></head><body><main><h1>Arc Foundry Gemini Polisher 연결</h1><p>ChatGPT에 최종 윤문 도구 권한(polish:invoke)을 부여합니다.</p>${message ? `<p>${escapeHtml(message)}</p>` : ""}<form method="post" action="/oauth/authorize">${hidden}<label>Owner secret <input type="password" name="owner_secret" autocomplete="current-password" required></label><button type="submit">승인</button></form></main></body></html>`;
  return new Response(html, {
    status: message ? 401 : 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "set-cookie": `${OAUTH_CSRF_COOKIE}=${encodeURIComponent(csrf)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`,
    },
  });
}

export function clearCsrfCookie(): string {
  return `${OAUTH_CSRF_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
