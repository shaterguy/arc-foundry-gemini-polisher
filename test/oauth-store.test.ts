import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCESS_TOKEN_TTL_MS,
  BlobOAuthStore,
  OAUTH_RESOURCE,
  OAUTH_SCOPE,
  OAUTH_STATE_MAX_BYTES,
  OAuthProtocolError,
  OAuthStorageError,
  type OAuthBlobAdapter,
  type OAuthBlobGetResult,
  type AuthorizationRequest,
  emptyOAuthState,
  exchangeAuthorizationCode,
  hashOpaque,
  issueAuthorizationCode,
  pkceChallenge,
  rotateRefreshToken,
  verifyAccessToken,
} from "../lib/oauth";

process.env.OAUTH_OWNER_SECRET = "test-owner-secret-" + "x".repeat(64);

const clientId = "https://chatgpt.com/oauth/arc-foundry/client.json";
const redirectUri = "https://chatgpt.com/connector/oauth/callback-test";
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abc";

interface ReadBarrier {
  remaining: number;
  promise: Promise<void>;
  release: () => void;
}

class FakeBlobAdapter implements OAuthBlobAdapter {
  private body: string | null = null;
  private etagVersion = 0;
  private conflicts = 0;
  private barrier: ReadBarrier | null = null;

  seed(body: string): void {
    this.body = body;
    this.etagVersion += 1;
  }

  rawBody(): string | null {
    return this.body;
  }

  forceConflicts(count: number): void {
    this.conflicts = count;
  }

  synchronizeNextReads(count: number): void {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    this.barrier = { remaining: count, promise, release };
  }

  private etag(): string {
    return `etag-${this.etagVersion}`;
  }

  async get(_pathname: string, _options: { access: "private"; useCache: boolean; token: string }): Promise<OAuthBlobGetResult | null> {
    const snapshotBody = this.body;
    const snapshotEtag = this.etag();
    const barrier = this.barrier;
    if (barrier && barrier.remaining > 0) {
      barrier.remaining -= 1;
      if (barrier.remaining === 0) barrier.release();
      await barrier.promise;
      if (barrier.remaining === 0) this.barrier = null;
    }
    if (snapshotBody === null) return null;
    return {
      statusCode: 200,
      stream: new Response(snapshotBody).body,
      blob: { size: Buffer.byteLength(snapshotBody, "utf8"), etag: snapshotEtag },
    };
  }

  async put(_pathname: string, body: string, options: {
    access: "private";
    addRandomSuffix: boolean;
    allowOverwrite: boolean;
    ifMatch?: string;
    contentType: string;
    cacheControlMaxAge: number;
    token: string;
  }): Promise<unknown> {
    if (this.conflicts > 0) {
      this.conflicts -= 1;
      throw new Error("precondition failed 412");
    }
    if (!options.allowOverwrite && this.body !== null) throw new Error("already exists");
    if (options.ifMatch !== undefined && options.ifMatch !== this.etag()) throw new Error("precondition failed 412");
    this.body = body;
    this.etagVersion += 1;
    return { etag: this.etag() };
  }
}

function storeWith(
  adapter = new FakeBlobAdapter(),
  nowProvider: () => number = Date.now,
): { adapter: FakeBlobAdapter; store: BlobOAuthStore } {
  return { adapter, store: new BlobOAuthStore(adapter, () => "test-blob-token", nowProvider) };
}

function authRequest(): AuthorizationRequest {
  return {
    clientId,
    redirectUri,
    resource: OAUTH_RESOURCE,
    scopes: [OAUTH_SCOPE, "offline_access"],
    state: "state-store-test",
    codeChallenge: pkceChallenge(verifier),
  };
}

function codeForm(code: string): URLSearchParams {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    resource: OAUTH_RESOURCE,
    code_verifier: verifier,
  });
}

function refreshForm(refreshToken: string): URLSearchParams {
  return new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    resource: OAUTH_RESOURCE,
  });
}

test("Blob store resolves simultaneous initial creation through CAS retry without lost state", async () => {
  const { adapter, store } = storeWith();
  const now = Date.now();
  const keyA = hashOpaque("failure-a");
  const keyB = hashOpaque("failure-b");
  adapter.synchronizeNextReads(2);
  await Promise.all([
    store.transact((state) => {
      state.ownerFailures[keyA] = { count: 1, expiresAt: now + 60_000 };
      return { value: undefined, commit: true };
    }),
    store.transact((state) => {
      state.ownerFailures[keyB] = { count: 1, expiresAt: now + 60_000 };
      return { value: undefined, commit: true };
    }),
  ]);
  const state = await store.read();
  assert.equal(Object.hasOwn(state.ownerFailures, keyA), true);
  assert.equal(Object.hasOwn(state.ownerFailures, keyB), true);
});

test("Blob store retries ifMatch conflict and fails closed after retry exhaustion", async () => {
  const { adapter, store } = storeWith();
  adapter.seed(JSON.stringify(emptyOAuthState()));
  const now = Date.now();
  const key = hashOpaque("retry-once");
  adapter.forceConflicts(1);
  await store.transact((state) => {
    state.ownerFailures[key] = { count: 1, expiresAt: now + 60_000 };
    return { value: undefined, commit: true };
  });
  assert.equal(Object.hasOwn((await store.read()).ownerFailures, key), true);

  adapter.forceConflicts(3);
  await assert.rejects(store.transact((state) => {
    state.ownerFailures[hashOpaque("retry-exhausted")] = { count: 1, expiresAt: now + 60_000 };
    return { value: undefined, commit: true };
  }), OAuthStorageError);
});

test("Blob store rejects corrupt nested state and oversized state at the persistence boundary", async () => {
  const first = storeWith();
  const corrupt = emptyOAuthState() as unknown as Record<string, unknown>;
  corrupt.codes = { [hashOpaque("code")]: { clientId: "https://evil.example/client.json" } };
  first.adapter.seed(JSON.stringify(corrupt));
  await assert.rejects(first.store.read(), OAuthStorageError);

  const second = storeWith();
  second.adapter.seed("x".repeat(OAUTH_STATE_MAX_BYTES + 1));
  await assert.rejects(second.store.read(), OAuthStorageError);
});

test("concurrent exchange of the same authorization code commits exactly once", async () => {
  const { adapter, store } = storeWith();
  const now = Date.now();
  const code = await issueAuthorizationCode(store, authRequest(), now);
  adapter.synchronizeNextReads(2);
  const results = await Promise.allSettled([
    exchangeAuthorizationCode(store, codeForm(code), now + 1),
    exchangeAuthorizationCode(store, codeForm(code), now + 1),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected"
    && result.reason instanceof OAuthProtocolError && result.reason.oauthCode === "invalid_grant").length, 1);
  const state = await store.read();
  assert.equal(Object.keys(state.refreshFamilies).length, 1);
  assert.equal(Object.keys(state.accessTokens).length, 1);
});

test("concurrent rotation of the same refresh token detects replay and revokes the family", async () => {
  const { adapter, store } = storeWith();
  const now = Date.now();
  const code = await issueAuthorizationCode(store, authRequest(), now);
  const initial = await exchangeAuthorizationCode(store, codeForm(code), now + 1);
  adapter.synchronizeNextReads(2);
  const results = await Promise.allSettled([
    rotateRefreshToken(store, refreshForm(initial.refresh_token), now + 2),
    rotateRefreshToken(store, refreshForm(initial.refresh_token), now + 2),
  ]);
  const fulfilled = results.find((result) => result.status === "fulfilled");
  assert.ok(fulfilled && fulfilled.status === "fulfilled");
  assert.equal(results.filter((result) => result.status === "rejected"
    && result.reason instanceof OAuthProtocolError && result.reason.oauthCode === "invalid_grant").length, 1);
  assert.equal(await verifyAccessToken(store, fulfilled.value.access_token, now + 3), undefined);
  const state = await store.read();
  assert.equal(Object.keys(state.refreshFamilies).length, 1);
  assert.equal(Object.keys(state.revokedFamilies).length, 1);
  assert.equal(Object.keys(state.accessTokens).length, 0);
});

test("more than 256 refresh rotations keep one bounded family record and preserve stale-token replay detection", async () => {
  const { adapter, store } = storeWith();
  const now = Date.now();
  const code = await issueAuthorizationCode(store, authRequest(), now);
  const initial = await exchangeAuthorizationCode(store, codeForm(code), now + 1);
  const staleToken = initial.refresh_token;
  let currentToken = initial.refresh_token;
  for (let generation = 0; generation < 300; generation += 1) {
    const rotated = await rotateRefreshToken(store, refreshForm(currentToken), now + 2 + generation);
    currentToken = rotated.refresh_token;
  }
  const state = await store.read();
  assert.equal(Object.keys(state.refreshFamilies).length, 1);
  assert.equal(Object.values(state.refreshFamilies)[0].currentGeneration, 301);
  assert.equal(Object.keys(state.accessTokens).length, 1);
  assert.ok(Buffer.byteLength(adapter.rawBody() ?? "", "utf8") < OAUTH_STATE_MAX_BYTES);

  await assert.rejects(rotateRefreshToken(store, refreshForm(staleToken), now + 500),
    (error: unknown) => error instanceof OAuthProtocolError && error.oauthCode === "invalid_grant");
  assert.equal(Object.keys((await store.read()).revokedFamilies).length, 1);
});

test("access token never outlives its refresh family and state writes recover immediately after family expiry", async () => {
  let clock = Date.now();
  const adapter = new FakeBlobAdapter();
  const { store } = storeWith(adapter, () => clock);
  const code = await issueAuthorizationCode(store, authRequest(), clock);
  const initial = await exchangeAuthorizationCode(store, codeForm(code), clock + 1);
  const initialState = await store.read();
  const familyKey = Object.keys(initialState.refreshFamilies)[0];
  const familyExpiresAt = clock + 60_000;

  await store.transact((state) => {
    state.refreshFamilies[familyKey].expiresAt = familyExpiresAt;
    for (const record of Object.values(state.accessTokens)) {
      if (record.familyKey === familyKey) record.expiresAt = familyExpiresAt;
    }
    return { value: undefined, commit: true };
  });

  const rotatedAt = familyExpiresAt - 5_000;
  const rotated = await rotateRefreshToken(store, refreshForm(initial.refresh_token), rotatedAt);
  assert.equal(rotated.expires_in, 5);
  const beforeExpiry = await store.read();
  assert.equal(Object.values(beforeExpiry.accessTokens)[0].expiresAt, familyExpiresAt);
  assert.ok(familyExpiresAt - rotatedAt < ACCESS_TOKEN_TTL_MS);

  clock = familyExpiresAt + 1;
  const expired = await store.read();
  assert.equal(Object.keys(expired.refreshFamilies).length, 0);
  assert.equal(Object.keys(expired.accessTokens).length, 0);
  assert.equal(Object.keys(expired.revokedFamilies).length, 0);

  const nextCode = await issueAuthorizationCode(store, authRequest(), clock);
  assert.ok(nextCode.length > 0);
  const recovered = await store.read();
  assert.equal(Object.keys(recovered.codes).length, 1);
  assert.equal(Object.keys(recovered.refreshFamilies).length, 0);
  assert.equal(Object.keys(recovered.accessTokens).length, 0);
});
