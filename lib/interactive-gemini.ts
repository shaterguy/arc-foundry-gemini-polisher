import { createGeminiProvider, type PolishProvider } from "./gemini.js";

const LONG_TEXT_THRESHOLD_CHARS = 8_000;
const LONG_REQUEST_TIMEOUT_MS = 22_000;
const LONG_TOTAL_BUDGET_MS = 55_000;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Long-form MCP calls are latency-sensitive. Gemini 3.7 Flash defaults to a
 * higher thinking level than this interactive path can reliably afford, so
 * long requests explicitly use low thinking for both rewrite and validation.
 */
export function withLowThinking(fetchImpl: FetchLike = fetch): FetchLike {
  return async (input, init) => {
    if (typeof init?.body !== "string") return fetchImpl(input, init);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return fetchImpl(input, init);
    }

    const generationConfig = parsed.generationConfig;
    if (!generationConfig || typeof generationConfig !== "object" || Array.isArray(generationConfig)) {
      return fetchImpl(input, init);
    }

    return fetchImpl(input, {
      ...init,
      body: JSON.stringify({
        ...parsed,
        generationConfig: {
          ...(generationConfig as Record<string, unknown>),
          thinkingConfig: { thinkingLevel: "low" },
        },
      }),
    });
  };
}

export function createInteractiveGeminiProvider(
  lockedTextLength: number,
  fetchImpl: FetchLike = fetch,
): PolishProvider {
  if (lockedTextLength < LONG_TEXT_THRESHOLD_CHARS) return createGeminiProvider(fetchImpl);

  return createGeminiProvider(withLowThinking(fetchImpl), {
    longTextThresholdChars: LONG_TEXT_THRESHOLD_CHARS,
    requestTimeoutMs: LONG_REQUEST_TIMEOUT_MS,
    totalBudgetMs: LONG_TOTAL_BUDGET_MS,
  });
}
