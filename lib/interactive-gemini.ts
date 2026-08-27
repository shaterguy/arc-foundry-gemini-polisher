import { createGeminiProvider, type PolishProvider } from "./gemini.js";

const LONG_TEXT_THRESHOLD_CHARS = 8_000;
const LONG_CHUNK_CHARS = 8_000;
const LONG_CHUNK_CONCURRENCY = 1;
const LONG_REQUEST_TIMEOUT_MS = 22_000;
const LONG_TOTAL_BUDGET_MS = 55_000;
const OVERLOAD_RETRY_ATTEMPTS = 1;
const OVERLOAD_RETRY_BASE_DELAY_MS = 1_000;
const RATE_LIMIT_FALLBACK_DELAY_MS = 2_000;
const RATE_LIMIT_FALLBACK_DELAY_MAX_MS = 4_000;
const TRANSIENT_RETRY_JITTER_MS = 250;

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
    // Diagnostics are best-effort. Never block the safe fallback path on malformed provider error JSON.
  }
  return metadata;
}

function rateLimitFallbackDelayMs(metadata: RateLimitMetadata): number {
  const suggested = metadata.retryDelayMs ?? RATE_LIMIT_FALLBACK_DELAY_MS;
  return Math.min(RATE_LIMIT_FALLBACK_DELAY_MAX_MS, Math.max(RATE_LIMIT_FALLBACK_DELAY_MS, suggested))
    + Math.floor(Math.random() * TRANSIENT_RETRY_JITTER_MS);
}

/**
 * Long-form MCP calls are latency-sensitive and may encounter provider
 * capacity/rate errors. Keep long rewrite/validation on low thinking, serialize
 * chunk traffic, avoid an immediate same-model retry on 429, and cool down
 * before the provider's existing alternate-model fallback. A 503 still gets one
 * bounded same-model retry because it represents temporary service overload.
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

    for (let attempt = 0; ; attempt += 1) {
      if (adjustedInit?.signal?.aborted) throw abortedError(adjustedInit.signal);
      const response = await fetchImpl(input, adjustedInit);

      if (response.status === 429) {
        const metadata = await readRateLimitMetadata(response);
        console.warn(JSON.stringify({
          event: "gemini_rate_limit",
          model: modelFromInput(input),
          httpStatus: 429,
          apiStatus: metadata.apiStatus,
          ...(metadata.quotaMetric ? { quotaMetric: metadata.quotaMetric } : {}),
          ...(metadata.retryDelayMs !== undefined ? { retryDelayMs: metadata.retryDelayMs } : {}),
        }));
        await waitForRetry(rateLimitFallbackDelayMs(metadata), adjustedInit?.signal);
        return response;
      }

      if (response.status !== 503 || attempt >= OVERLOAD_RETRY_ATTEMPTS) return response;
      try {
        await response.body?.cancel();
      } catch {
        // Best-effort cleanup only; retry eligibility is determined by status.
      }
      await waitForRetry(overloadRetryDelayMs(attempt), adjustedInit?.signal);
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
