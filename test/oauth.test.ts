import assert from "node:assert/strict";
import test from "node:test";
import {
  OAUTH_RESOURCE,
  OAUTH_SCOPE,
  OAuthProtocolError,
  type OAuthState,
  type OAuthStateStore,
  type StateTransaction,
  emptyOAuthState,
  exchangeAuthorizationCode,
  issueAuthorizationCode,
  pkceChallenge,
  rotateRefreshToken,
  validateAuthorizationRequest,
  verifyAccessToken,
} from "../lib/oauth";

process.env.OAUTH_OWNER_SECRET = "test-owner-secret-" + "x".repeat(64);

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

function authorizationParams(overrides: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    resource: OAUTH_RESOURCE,
    scope: `${OAUTH_SCOPE} offline_access`,
    state: "state-12345678",
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
    ...overrides,
  });
}

const cimdFetch: typeof fetch = async (input) => {
  assert.equal(String(input), clientId);
  return new Response(JSON.stringify({
    client_id: clientId,
    client_name: "ChatGPT",
    redirect_uris: [redirectUri],
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
  }), { status: 200, headers: { "content-type": "application/json" } });
};

async function assertOAuthError(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof OAuthProtocolError && error.oauthCode === code);
}

test("authorization validates ChatGPT CIMD, exact redirect, resource, scope and S256 PKCE", async () => {
  const result = await validateAuthorizationRequest(authorizationParams(), cimdFetch);
  assert.equal(result.clientId, clientId);
  assert.equal(result.redirectUri, redirectUri);
  assert.equal(result.resource, OAUTH_RESOURCE);
  assert.deepEqual(result.scopes, [OAUTH_SCOPE, "offline_access"]);
});

test("authorization rejects CIMD without a bounded non-empty client_name", async () => {
  const makeFetch = (clientName: unknown, includeName = true): typeof fetch => async () => new Response(JSON.stringify({
    client_id: clientId,
    ...(includeName ? { client_name: clientName } : {}),
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
  }), { status: 200, headers: { "content-type": "application/json" } });
  await assertOAuthError(validateAuthorizationRequest(authorizationParams(), makeFetch(undefined, false)), "invalid_client");
  await assertOAuthError(validateAuthorizationRequest(authorizationParams(), makeFetch("   ")), "invalid_client");
  await assertOAuthError(validateAuthorizationRequest(authorizationParams(), makeFetch("x".repeat(201))), "invalid_client");
});

test("authorization rejects non-ChatGPT client IDs before network fetch", async () => {
  let called = false;
  const fetchImpl: typeof fetch = async () => { called = true; return new Response("{}"); };
  await assertOAuthError(validateAuthorizationRequest(authorizationParams({ client_id: "https://evil.example/client.json" }), fetchImpl), "invalid_client");
  assert.equal(called, false);
});

test("authorization code is single-use, PKCE-bound and tokens are stored only by hash", async () => {
  const store = new MemoryStore();
  const request = await validateAuthorizationRequest(authorizationParams(), cimdFetch);
  const code = await issueAuthorizationCode(store, request, 1_000);
  const tokens = await exchangeAuthorizationCode(store, new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    resource: OAUTH_RESOURCE,
    code_verifier: verifier,
  }), 2_000);
  assert.equal(tokens.token_type, "Bearer");
  assert.equal((await verifyAccessToken(store, tokens.access_token, 2_001))?.clientId, clientId);
  assert.equal(Object.keys(store.state.refreshFamilies).length, 1);
  const family = Object.values(store.state.refreshFamilies)[0];
  assert.equal(family.currentTokenHash.length, 64);
  assert.equal(family.currentGeneration, 1);
  assert.equal(JSON.stringify(store.state).includes(tokens.access_token), false);
  assert.equal(JSON.stringify(store.state).includes(tokens.refresh_token), false);
  assert.equal(JSON.stringify(store.state).includes(code), false);
  await assertOAuthError(exchangeAuthorizationCode(store, new URLSearchParams({
    grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirectUri,
    resource: OAUTH_RESOURCE, code_verifier: verifier,
  }), 2_100), "invalid_grant");
});

test("wrong PKCE verifier does not consume the authorization code", async () => {
  const store = new MemoryStore();
  const request = await validateAuthorizationRequest(authorizationParams(), cimdFetch);
  const code = await issueAuthorizationCode(store, request, 1_000);
  await assertOAuthError(exchangeAuthorizationCode(store, new URLSearchParams({
    grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirectUri,
    resource: OAUTH_RESOURCE, code_verifier: "z".repeat(50),
  }), 2_000), "invalid_grant");
  const tokens = await exchangeAuthorizationCode(store, new URLSearchParams({
    grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirectUri,
    resource: OAUTH_RESOURCE, code_verifier: verifier,
  }), 2_001);
  assert.equal(tokens.token_type, "Bearer");
});

test("refresh rotation detects replay and revokes the entire family", async () => {
  const store = new MemoryStore();
  const request = await validateAuthorizationRequest(authorizationParams(), cimdFetch);
  const code = await issueAuthorizationCode(store, request, 1_000);
  const initial = await exchangeAuthorizationCode(store, new URLSearchParams({
    grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirectUri,
    resource: OAUTH_RESOURCE, code_verifier: verifier,
  }), 2_000);
  const rotated = await rotateRefreshToken(store, new URLSearchParams({
    grant_type: "refresh_token", refresh_token: initial.refresh_token, client_id: clientId, resource: OAUTH_RESOURCE,
  }), 3_000);
  assert.equal((await verifyAccessToken(store, rotated.access_token, 3_001))?.clientId, clientId);
  await assertOAuthError(rotateRefreshToken(store, new URLSearchParams({
    grant_type: "refresh_token", refresh_token: initial.refresh_token, client_id: clientId, resource: OAUTH_RESOURCE,
  }), 3_100), "invalid_grant");
  assert.equal(await verifyAccessToken(store, rotated.access_token, 3_101), undefined);
  assert.equal(Object.keys(store.state.refreshFamilies).length, 1);
  assert.equal(Object.keys(store.state.revokedFamilies).length, 1);
});

test("wrong resource and scope expansion are rejected", async () => {
  await assertOAuthError(validateAuthorizationRequest(authorizationParams({ resource: "https://evil.example/mcp" }), cimdFetch), "invalid_request");
  const store = new MemoryStore();
  const request = await validateAuthorizationRequest(authorizationParams(), cimdFetch);
  const code = await issueAuthorizationCode(store, request, 1_000);
  const initial = await exchangeAuthorizationCode(store, new URLSearchParams({
    grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirectUri,
    resource: OAUTH_RESOURCE, code_verifier: verifier,
  }), 2_000);
  await assertOAuthError(rotateRefreshToken(store, new URLSearchParams({
    grant_type: "refresh_token", refresh_token: initial.refresh_token, client_id: clientId,
    resource: OAUTH_RESOURCE, scope: `${OAUTH_SCOPE} admin`,
  }), 3_000), "invalid_scope");
});
