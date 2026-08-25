import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCESS_TOKEN_TTL_MS,
  AUTH_CODE_TTL_MS,
  OAUTH_RESOURCE,
  OAUTH_SCOPE,
  OWNER_ATTEMPT_LIMIT,
  REFRESH_FAMILY_TTL_MS,
  OAuthProtocolError,
  type OAuthState,
  type OAuthStateStore,
  type StateTransaction,
  emptyOAuthState,
  exchangeAuthorizationCode,
  getOwnerFailureCount,
  issueAuthorizationCode,
  pkceChallenge,
  recordOwnerFailure,
  rotateRefreshToken,
  validateAuthorizationRequest,
  verifyAccessToken,
} from "../lib/oauth";

class MemoryStore implements OAuthStateStore {
  state: OAuthState = emptyOAuthState();

  async read(): Promise<OAuthState> {
    return structuredClone(this.state);
  }

  async transact<T>(mutator: (state: OAuthState) => StateTransaction<T>): Promise<T> {
    const next = structuredClone(this.state);
    const result = mutator(next);
    if (result.commit) this.state = next;
    return result.value;
  }
}

const clientId = "https://chatgpt.com/oauth/arc-foundry/client.json";
const redirectUri = "https://chatgpt.com/connector/oauth/callback-test";
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abc";

function params(overrides: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    resource: OAUTH_RESOURCE,
    scope: `${OAUTH_SCOPE} offline_access`,
    state: "state-hardening-1234",
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
    ...overrides,
  });
}

function cimd(redirects: string[] = [redirectUri]): typeof fetch {
  return async () => new Response(JSON.stringify({
    client_id: clientId,
    redirect_uris: redirects,
    token_endpoint_auth_method: "none",
  }), { status: 200, headers: { "content-type": "application/json" } });
}

async function oauthError(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof OAuthProtocolError && error.oauthCode === code);
}

test("authorization rejects redirect tampering before CIMD fetch", async () => {
  let fetched = false;
  const fetchImpl: typeof fetch = async () => {
    fetched = true;
    return new Response("{}");
  };
  await oauthError(validateAuthorizationRequest(params({ redirect_uri: "https://evil.example/callback" }), fetchImpl), "invalid_request");
  assert.equal(fetched, false);
});

test("authorization rejects CIMD that does not register the exact callback", async () => {
  await oauthError(validateAuthorizationRequest(params(), cimd(["https://chatgpt.com/connector/oauth/different"])), "invalid_client");
});

test("expired authorization code is rejected and never becomes an access token", async () => {
  const store = new MemoryStore();
  const request = await validateAuthorizationRequest(params(), cimd());
  const code = await issueAuthorizationCode(store, request, 1_000);
  await oauthError(exchangeAuthorizationCode(store, new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    resource: OAUTH_RESOURCE,
    code_verifier: verifier,
  }), 1_000 + AUTH_CODE_TTL_MS + 1), "invalid_grant");
});

test("expired access token is rejected", async () => {
  const store = new MemoryStore();
  const request = await validateAuthorizationRequest(params(), cimd());
  const issuedAt = 10_000;
  const code = await issueAuthorizationCode(store, request, issuedAt);
  const tokens = await exchangeAuthorizationCode(store, new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    resource: OAUTH_RESOURCE,
    code_verifier: verifier,
  }), issuedAt + 1);
  assert.equal(await verifyAccessToken(store, tokens.access_token, issuedAt + 1 + ACCESS_TOKEN_TTL_MS + 1), undefined);
});

test("expired refresh token cannot mint a new family member", async () => {
  const store = new MemoryStore();
  const request = await validateAuthorizationRequest(params(), cimd());
  const issuedAt = 20_000;
  const code = await issueAuthorizationCode(store, request, issuedAt);
  const tokens = await exchangeAuthorizationCode(store, new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    resource: OAUTH_RESOURCE,
    code_verifier: verifier,
  }), issuedAt + 1);
  await oauthError(rotateRefreshToken(store, new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: clientId,
    resource: OAUTH_RESOURCE,
  }), issuedAt + 1 + REFRESH_FAMILY_TTL_MS + 1), "invalid_grant");
});

test("owner authorization failures are bounded for one pending request", async () => {
  const store = new MemoryStore();
  const request = await validateAuthorizationRequest(params(), cimd());
  let count = 0;
  for (let index = 0; index < OWNER_ATTEMPT_LIMIT + 3; index += 1) {
    count = await recordOwnerFailure(store, request, 30_000 + index);
  }
  assert.equal(count, OWNER_ATTEMPT_LIMIT);
  assert.equal(await getOwnerFailureCount(store, request), OWNER_ATTEMPT_LIMIT);
});
