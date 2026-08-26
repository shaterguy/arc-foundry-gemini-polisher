import assert from "node:assert/strict";
import test from "node:test";
import { BlobAccessError, BlobNotFoundError, BlobServiceNotAvailable } from "@vercel/blob";
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
  oauthErrorResponse,
  pkceChallenge,
  rotateRefreshToken,
  verifyAccessToken,
} from "../lib/oauth";

process.env.OAUTH_OWNER_SECRET = "test-owner-secret-" + "x".repeat(64);

const clientId = "https://chatgpt.com/oauth/arc-foundry/client.json";
const redirectUri = "https://chatgpt.com/connector/oauth/callback-test";
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abc";

type DiagnosticSink = NonNullable<ConstructorParameters<typeof BlobOAuthStore>[3]>;
type Diagnostic = Parameters<DiagnosticSink>[0];

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
  private headFailure: unknown | undefined;
  private getFailure: unknown | undefined;
  private putFailure: unknown | undefined;
  private headEtagOverride: string | undefined;
  private getEtagOverride: string | undefined;
  private afterHead: (() => void) | null = null;
  private afterGet: (() => void) | null = null;
  private puts = 0;
  private seenTokens: string[] = [];

  seed(body: string): void {
    this.body = body;
    this.etagVersion += 1;
  }

  rawBody(): string | null {
    return this.body;
  }

  putCount(): number {
    return this.puts;
  }

  tokens(): string[] {
    return [...this.seenTokens];
  }

  forceConflicts(count: number): void {
    this.conflicts = count;
  }

  failNextHead(error: unknown): void {
    this.headFailure = error;
  }

  failNextGet(error: unknown): void {
    this.getFailure = error;
  }

  failNextPut(error: unknown): void {
    this.putFailure = error;
  }

  overrideNextHeadEtag(etag: string): void {
    this.headEtagOverride = etag;
  }

  overrideNextGetEtag(etag: string): void {
    this.getEtagOverride = etag;
  }

  writeAfterNextHead(body: string): void {
    this.afterHead = () => this.seed(body);
  }

  deleteAfterNextHead(): void {
    this.afterHead = () => {
      this.body = null;
      this.etagVersion += 1;
    };
  }

  writeAfterNextGet(body: string): void {
    this.afterGet = () => this.seed(body);
  }

  synchronizeNextReads(count: number): void {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    this.barrier = { remaining: count, promise, release };
  }

  private etag(): string {
    return `etag-${this.etagVersion}`;
  }

  async head(_pathname: string, options: { token: string }): Promise<{ etag: string }> {
    this.seenTokens.push(options.token);
    if (this.headFailure !== undefined) {
      const failure = this.headFailure;
      this.headFailure = undefined;
      throw failure;
    }
    const exists = this.body !== null;
    const etag = this.headEtagOverride !== undefined ? this.headEtagOverride : this.etag();
    this.headEtagOverride = undefined;
    const afterHead = this.afterHead;
    this.afterHead = null;
    afterHead?.();
    if (!exists) throw new BlobNotFoundError();
    return { etag };
  }

  async get(_pathname: string, options: { access: "private"; useCache: boolean; token: string }): Promise<OAuthBlobGetResult | null> {
    this.seenTokens.push(options.token);
    if (this.getFailure !== undefined) {
      const failure = this.getFailure;
      this.getFailure = undefined;
      throw failure;
    }
    const snapshotBody = this.body;
    const snapshotEtag = this.getEtagOverride !== undefined ? this.getEtagOverride : this.etag();
    this.getEtagOverride = undefined;
    const barrier = this.barrier;
    if (barrier && barrier.remaining > 0) {
      barrier.remaining -= 1;
      if (barrier.remaining === 0) barrier.release();
      await barrier.promise;
      if (barrier.remaining === 0) this.barrier = null;
    }
    const afterGet = this.afterGet;
    this.afterGet = null;
    afterGet?.();
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
    this.seenTokens.push(options.token);
    this.puts += 1;
    if (this.putFailure !== undefined) {
      const failure = this.putFailure;
      this.putFailure = undefined;
      throw failure;
    }
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
  diagnosticSink: DiagnosticSink = () => {},
): { adapter: FakeBlobAdapter; store: BlobOAuthStore } {
  return { adapter, store: new BlobOAuthStore(adapter, () => "test-blob-token", nowProvider, diagnosticSink) };
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

test("Blob store uses control-plane head ETag and one token per write attempt", async () => {
  const adapter = new FakeBlobAdapter();
  adapter.seed(JSON.stringify(emptyOAuthState()));
  adapter.overrideNextGetEtag("data-plane-etag-that-put-would-reject");
  let tokenCalls = 0;
  const store = new BlobOAuthStore(adapter, () => {
    tokenCalls += 1;
    return "stable-write-token";
  }, Date.now, () => {});
  const now = Date.now();
  const key = hashOpaque("head-etag-recovery");

  await store.transact((state) => {
    state.ownerFailures[key] = { count: 1, expiresAt: now + 60_000 };
    return { value: undefined, commit: true };
  });

  assert.equal(tokenCalls, 1);
  assert.deepEqual(adapter.tokens(), ["stable-write-token", "stable-write-token", "stable-write-token"]);
  assert.equal(Object.hasOwn(JSON.parse(adapter.rawBody() ?? "{}").ownerFailures, key), true);
});

test("Blob store preserves concurrent state when writers interleave after head or get", async () => {
  for (const interleave of ["after-head", "after-get"] as const) {
    const { adapter, store } = storeWith();
    adapter.seed(JSON.stringify(emptyOAuthState()));
    const now = Date.now();
    const concurrentKey = hashOpaque(`concurrent-${interleave}`);
    const targetKey = hashOpaque(`target-${interleave}`);
    const concurrent = emptyOAuthState();
    concurrent.ownerFailures[concurrentKey] = { count: 1, expiresAt: now + 60_000 };
    if (interleave === "after-head") adapter.writeAfterNextHead(JSON.stringify(concurrent));
    else adapter.writeAfterNextGet(JSON.stringify(concurrent));
    let mutatorCalls = 0;

    await store.transact((state) => {
      mutatorCalls += 1;
      state.ownerFailures[targetKey] = { count: 1, expiresAt: now + 60_000 };
      return { value: undefined, commit: true };
    });

    const state = await store.read();
    assert.equal(mutatorCalls, 2);
    assert.equal(Object.hasOwn(state.ownerFailures, concurrentKey), true);
    assert.equal(Object.hasOwn(state.ownerFailures, targetKey), true);
  }
});

test("Blob store retries head/get existence disagreement before mutating or writing", async () => {
  const now = Date.now();

  const createdBetween = storeWith();
  const concurrent = emptyOAuthState();
  const concurrentKey = hashOpaque("created-between-head-get");
  concurrent.ownerFailures[concurrentKey] = { count: 1, expiresAt: now + 60_000 };
  createdBetween.adapter.writeAfterNextHead(JSON.stringify(concurrent));
  let firstMutatorCalls = 0;
  await createdBetween.store.transact((state) => {
    firstMutatorCalls += 1;
    state.ownerFailures[hashOpaque("after-created-between")] = { count: 1, expiresAt: now + 60_000 };
    return { value: undefined, commit: true };
  });
  assert.equal(firstMutatorCalls, 1);
  assert.equal(createdBetween.adapter.putCount(), 1);
  assert.equal(Object.hasOwn((await createdBetween.store.read()).ownerFailures, concurrentKey), true);

  const deletedBetween = storeWith();
  deletedBetween.adapter.seed(JSON.stringify(emptyOAuthState()));
  deletedBetween.adapter.deleteAfterNextHead();
  let secondMutatorCalls = 0;
  await deletedBetween.store.transact((state) => {
    secondMutatorCalls += 1;
    state.ownerFailures[hashOpaque("after-deleted-between")] = { count: 1, expiresAt: now + 60_000 };
    return { value: undefined, commit: true };
  });
  assert.equal(secondMutatorCalls, 1);
  assert.equal(deletedBetween.adapter.putCount(), 1);
});

test("Blob store fails closed on non-notfound head errors and empty existing ETag", async () => {
  const now = Date.now();

  const headFailure = storeWith();
  headFailure.adapter.seed(JSON.stringify(emptyOAuthState()));
  headFailure.adapter.failNextHead(new BlobServiceNotAvailable());
  let headFailureMutatorCalls = 0;
  await assert.rejects(headFailure.store.transact((state) => {
    headFailureMutatorCalls += 1;
    state.ownerFailures[hashOpaque("head-error")] = { count: 1, expiresAt: now + 60_000 };
    return { value: undefined, commit: true };
  }), OAuthStorageError);
  assert.equal(headFailureMutatorCalls, 0);
  assert.equal(headFailure.adapter.putCount(), 0);

  const emptyEtag = storeWith();
  emptyEtag.adapter.seed(JSON.stringify(emptyOAuthState()));
  emptyEtag.adapter.overrideNextHeadEtag("");
  let emptyEtagMutatorCalls = 0;
  await assert.rejects(emptyEtag.store.transact((state) => {
    emptyEtagMutatorCalls += 1;
    state.ownerFailures[hashOpaque("empty-etag")] = { count: 1, expiresAt: now + 60_000 };
    return { value: undefined, commit: true };
  }), OAuthStorageError);
  assert.equal(emptyEtagMutatorCalls, 0);
  assert.equal(emptyEtag.adapter.putCount(), 0);
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

test("Blob store diagnostics expose only fixed stage and allowlisted error kind", async () => {
  const diagnostics: Diagnostic[] = [];
  const capture: DiagnosticSink = (diagnostic) => diagnostics.push(diagnostic);
  const now = Date.now();

  const access = storeWith(new FakeBlobAdapter(), Date.now, capture);
  access.adapter.failNextGet(new BlobAccessError());
  await assert.rejects(access.store.read(), OAuthStorageError);

  const service = storeWith(new FakeBlobAdapter(), Date.now, capture);
  service.adapter.seed(JSON.stringify(emptyOAuthState()));
  service.adapter.failNextPut(new BlobServiceNotAvailable());
  await assert.rejects(service.store.transact((state) => {
    state.ownerFailures[hashOpaque("service-failure")] = { count: 1, expiresAt: now + 60_000 };
    return { value: undefined, commit: true };
  }), OAuthStorageError);

  const parse = storeWith(new FakeBlobAdapter(), Date.now, capture);
  parse.adapter.seed("{");
  await assert.rejects(parse.store.read(), OAuthStorageError);

  const cas = storeWith(new FakeBlobAdapter(), Date.now, capture);
  cas.adapter.seed(JSON.stringify(emptyOAuthState()));
  cas.adapter.forceConflicts(3);
  await assert.rejects(cas.store.transact((state) => {
    state.ownerFailures[hashOpaque("cas-exhaustion")] = { count: 1, expiresAt: now + 60_000 };
    return { value: undefined, commit: true };
  }), OAuthStorageError);

  const secretLikeSentinel = "BLOB_READ_WRITE_TOKEN=sentinel-must-not-appear";
  const unknown = storeWith(new FakeBlobAdapter(), Date.now, capture);
  unknown.adapter.failNextGet(new Error(`provider detail ${secretLikeSentinel}`));
  await assert.rejects(unknown.store.read(), OAuthStorageError);

  assert.deepEqual(diagnostics, [
    { event: "oauth_storage_failure", stage: "read_get", error_kind: "access_denied" },
    { event: "oauth_storage_failure", stage: "write_put", error_kind: "service_unavailable" },
    { event: "oauth_storage_failure", stage: "read_parse", error_kind: "unknown" },
    { event: "oauth_storage_failure", stage: "cas_exhausted", error_kind: "unknown" },
    { event: "oauth_storage_failure", stage: "read_get", error_kind: "unknown" },
  ]);
  assert.equal(JSON.stringify(diagnostics).includes(secretLikeSentinel), false);

  const external = oauthErrorResponse(new Error(secretLikeSentinel));
  assert.equal(external.status, 503);
  assert.deepEqual(await external.json(), { error: "temporarily_unavailable" });
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