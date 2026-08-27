import { createGeminiProvider, type PolishProvider } from "./gemini.js";

const LONG_TEXT_THRESHOLD_CHARS = 8_000;
const LONG_CHUNK_CHARS = 6_000;
const LONG_CHUNK_CONCURRENCY = 2;
const LONG_REQUEST_TIMEOUT_MS = 22_000;
const LONG_TOTAL_BUDGET_MS = 55_000;
const TRANSIENT_RETRY_ATTEMPTS = 1;
const TRANSIENT_RETRY_BASE_DELAY_MS = 1_000;
const TRANSIENT_RETRY_JITTER_MS = 250;
const RETRYABLE_TRANSIENT_STATUSES = new Set([429, 503]);

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

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

function retryDelayMs(attempt: number): number {
  return TRANSIENT_RETRY_BASE_DELAY_MS * 2 ** attempt
    + Math.floor(Math.random() * TRANSIENT_RETRY_JITTER_MS);
}

/**
 * Long-form MCP calls are latency-sensitive and may encounter temporary
 * provider capacity/rate errors. Keep long rewrite/validation on low thinking,
 * reduce request burst, and give 429/503 one bounded backoff retry before the
 * provider's existing model fallback path takes over.
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
      if (!RETRYABLE_TRANSIENT_STATUSES.has(response.status) || attempt >= TRANSIENT_RETRY_ATTEMPTS) {
        return response;
      }
      try {
        await response.body?.cancel();
      } catch {
        // Best-effort cleanup only; retry eligibility is determined by status.
      }
      await waitForRetry(retryDelayMs(attempt), adjustedInit?.signal);
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
