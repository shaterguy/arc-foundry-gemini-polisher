import { createGeminiProvider, type PolishProvider } from "./gemini.js";

const LONG_TEXT_THRESHOLD_CHARS = 8_000;
const LONG_CHUNK_CHARS = 20_000;
const LONG_CHUNK_CONCURRENCY = 1;
const RATE_LIMIT_RETRY_ATTEMPTS = 1;
const RATE_LIMIT_RETRY_DEFAULT_DELAY_MS = 2_000;
const RATE_LIMIT_RETRY_DELAY_MAX_MS = 30_000;
const RATE_LIMIT_RETRY_RESPONSE_RESERVE_MS = 60_000;
const LONG_REQUEST_TIMEOUT_MS = RATE_LIMIT_RETRY_DELAY_MAX_MS + RATE_LIMIT_RETRY_RESPONSE_RESERVE_MS;
const LONG_TOTAL_BUDGET_MS = 220_000;
const OVERLOAD_RETRY_ATTEMPTS = 1;
const OVERLOAD_RETRY_BASE_DELAY_MS = 1_000;
const TRANSIENT_RETRY_JITTER_MS = 250;
const FREE_TIER_REQUEST_QUOTA_METRIC = "generativelanguage.googleapis.com/generate_content_free_tier_requests";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface RateLimitMetadata {
  apiStatus: string;
  quotaMetric?: string;
  retryDelayMs?: number;
}

function abortedError(signal: AbortSignal | null | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error("request_aborted");
}

async function waitForRetry(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  if (signal?.aborted) throw abortedError(signal);
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(abortedError(signal));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cleanup only; retry/fallback eligibility is determined by status.
  }
}

function overloadRetryDelayMs(attempt: number): number {
  return OVERLOAD_RETRY_BASE_DELAY_MS * 2 ** attempt
    + Math.floor(Math.random() * TRANSIENT_RETRY_JITTER_MS);
}

function parseDurationMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^(\d+(?:\.\d+)?)s$/u);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? Math.round(seconds * 1_000) : undefined;
}

function safeDiagnosticToken(value: unknown, maxLength = 180): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || !/^[A-Za-z0-9._:/-]+$/u.test(trimmed)) return undefined;
  return trimmed;
}

function modelFromInput(input: string | URL | Request): string {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const match = url.match(/\/models\/([^/:]+):generateContent/u);
  return match?.[1] ?? "unknown";
}

async function readRateLimitMetadata(response: Response): Promise<RateLimitMetadata> {
  const metadata: RateLimitMetadata = { apiStatus: "RESOURCE_EXHAUSTED" };
  try {
    const payload = await response.clone().json() as {
      error?: {
        code?: unknown;
        status?: unknown;
        details?: Array<Record<string, unknown>>;
      };
    };
    const error = payload.error;
    const code = safeDiagnosticToken(error?.code);
    const status = safeDiagnosticToken(error?.status);
    metadata.apiStatus = code ?? status ?? metadata.apiStatus;

    for (const detail of error?.details ?? []) {
      const detailType = safeDiagnosticToken(detail["@type"]);
      if (detailType?.endsWith("google.rpc.QuotaFailure") && Array.isArray(detail.violations)) {
        for (const violation of detail.violations as Array<Record<string, unknown>>) {
          metadata.quotaMetric ??= safeDiagnosticToken(violation.quotaMetric);
        }
      }
      if (detailType?.endsWith("google.rpc.RetryInfo")) {
        metadata.retryDelayMs ??= parseDurationMs(detail.retryDelay);
      }
    }
  } catch {
    // Diagnostics are best-effort. Never block the safe retry/fallback path on malformed provider error JSON.
  }
  return metadata;
}

function rateLimitRetryDelayMs(metadata: RateLimitMetadata): number {
  const suggested = metadata.retryDelayMs ?? RATE_LIMIT_RETRY_DEFAULT_DELAY_MS;
  const bounded = Math.min(RATE_LIMIT_RETRY_DELAY_MAX_MS, Math.max(0, suggested));
  return Math.min(
    RATE_LIMIT_RETRY_DELAY_MAX_MS,
    bounded + Math.floor(Math.random() * TRANSIENT_RETRY_JITTER_MS),
  );
}

function isSharedFreeTierRequestQuota(metadata: RateLimitMetadata): boolean {
  return metadata.quotaMetric === FREE_TIER_REQUEST_QUOTA_METRIC;
}

function projectRequestQuotaError(): Error {
  return new Error("provider_project_request_quota_exhausted");
}

function logRateLimit(input: string | URL | Request, metadata: RateLimitMetadata): void {
  console.warn(JSON.stringify({
    event: "gemini_rate_limit",
    model: modelFromInput(input),
    httpStatus: 429,
    apiStatus: metadata.apiStatus,
    ...(metadata.quotaMetric ? { quotaMetric: metadata.quotaMetric } : {}),
    ...(metadata.retryDelayMs !== undefined ? { retryDelayMs: metadata.retryDelayMs } : {}),
  }));
}

/**
 * Long-form MCP calls are latency-sensitive and may encounter provider
 * capacity/rate errors. Keep long rewrite/validation on low thinking, minimize
 * request units, serialize chunk traffic, and honor one provider RetryInfo wait
 * on the same model for 429. The upstream AbortSignal covers the whole fetch
 * wrapper retry loop, so the request envelope reserves a full 60 seconds after
 * the bounded 30-second RetryInfo wait. If the shared project free-tier request
 * quota is still exhausted after that retry, fail closed instead of spending
 * another request on the alternate model. A 503 keeps one bounded same-model
 * retry.
 */
export function withInteractiveGeminiPolicy(fetchImpl: FetchLike = fetch): FetchLike {
  return async (input, init) => {
    let adjustedInit = init;
    if (typeof init?.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as Record<string, unknown>;
        const generationConfig = parsed.generationConfig;
        if (generationConfig && typeof generationConfig === "object" && !Array.isArray(generationConfig)) {
          adjustedInit = {
            ...init,
            body: JSON.stringify({
              ...parsed,
              generationConfig: {
                ...(generationConfig as Record<string, unknown>),
                thinkingConfig: { thinkingLevel: "low" },
              },
            }),
          };
        }
      } catch {
        adjustedInit = init;
      }
    }

    let overloadRetries = 0;
    let rateLimitRetries = 0;
    for (;;) {
      if (adjustedInit?.signal?.aborted) throw abortedError(adjustedInit.signal);
      const response = await fetchImpl(input, adjustedInit);

      if (response.status === 429) {
        const metadata = await readRateLimitMetadata(response);
        logRateLimit(input, metadata);
        if (rateLimitRetries >= RATE_LIMIT_RETRY_ATTEMPTS) {
          if (isSharedFreeTierRequestQuota(metadata)) {
            await cancelResponseBody(response);
            throw projectRequestQuotaError();
          }
          return response;
        }
        rateLimitRetries += 1;
        await cancelResponseBody(response);
        await waitForRetry(rateLimitRetryDelayMs(metadata), adjustedInit?.signal);
        continue;
      }

      if (response.status === 503) {
        if (overloadRetries >= OVERLOAD_RETRY_ATTEMPTS) return response;
        overloadRetries += 1;
        await cancelResponseBody(response);
        await waitForRetry(overloadRetryDelayMs(overloadRetries - 1), adjustedInit?.signal);
        continue;
      }

      return response;
    }
  };
}

export function createInteractiveGeminiProvider(
  lockedTextLength: number,
  fetchImpl: FetchLike = fetch,
): PolishProvider {
  if (lockedTextLength < LONG_TEXT_THRESHOLD_CHARS) return createGeminiProvider(fetchImpl);

  return createGeminiProvider(withInteractiveGeminiPolicy(fetchImpl), {
    longTextThresholdChars: LONG_TEXT_THRESHOLD_CHARS,
    chunkChars: LONG_CHUNK_CHARS,
    chunkConcurrency: LONG_CHUNK_CONCURRENCY,
    requestTimeoutMs: LONG_REQUEST_TIMEOUT_MS,
    totalBudgetMs: LONG_TOTAL_BUDGET_MS,
  });
}
