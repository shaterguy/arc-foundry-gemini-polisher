import assert from "node:assert/strict";
import test from "node:test";
import { buildLockedLayout, reconstructCandidate } from "../lib/blocks";
import { planEditableChunks, reconstructPolishedBlocks } from "../lib/chunks";
import { createGeminiProvider } from "../lib/gemini";
import type { PolishInput } from "../lib/types";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function promptPayload(init?: RequestInit): Record<string, unknown> {
  const body = JSON.parse(String(init?.body ?? "{}")) as {
    contents?: Array<{ parts?: Array<{ text?: string }> }>;
  };
  const prompt = body.contents?.[0]?.parts?.map((part) => part.text ?? "").join("") ?? "";
  const newline = prompt.indexOf("\n");
  if (newline < 0) throw new Error("test prompt missing payload delimiter");
  return JSON.parse(prompt.slice(newline + 1)) as Record<string, unknown>;
}

const acceptedValidation = {
  preserved: true,
  violations: [],
  summary: "preserved",
  rewrite_needed: false,
  rewrite_adequate: true,
  adequacy_summary: "already natural",
};

test("chunk plan preserves the exact locked source and reconstructs parent blocks", () => {
  const source = `${"첫 문단은 충분히 길다. ".repeat(12)}\n\n${"둘째 문단도 이어진다. ".repeat(12)}\n마지막 문장.`;
  const block = { block_id: "S000000", source_text: source };
  const chunks = planEditableChunks([block], 90);
  assert.ok(chunks.length > 2);
  assert.equal(chunks.map((chunk) => `${chunk.source_text}${chunk.separator_after}`).join(""), source);
  assert.ok(chunks.every((chunk) => chunk.source_text.length <= 90));

  const unchanged = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk.source_text]));
  const reconstructed = reconstructPolishedBlocks([block], chunks, unchanged);
  assert.equal(reconstructed[0]?.polished_text, source);
});

test("long manuscript uses bounded concurrent polish and semantic-validation units", async () => {
  const oldKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "unit-test-key-not-a-secret";
  const longInput: PolishInput = {
    locked_text: `${"민재는 문을 열었다. 그리고 다시 닫았다. ".repeat(45)}\n\n${"민재는 복도를 지나 창가에 섰다. ".repeat(45)}`,
    protected_manifest: { source: "arc-foundry-final-lock", terms: ["민재"] },
  };
  let polishCalls = 0;
  let validationCalls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let maxTargetChars = 0;

  const fetchMock = async (_request: string | URL | Request, init?: RequestInit): Promise<Response> => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const payload = promptPayload(init);
      let text: string;
      if (Array.isArray(payload.EDIT_TARGET_BLOCKS)) {
        polishCalls += 1;
        const blocks = payload.EDIT_TARGET_BLOCKS as Array<{ block_id: string; source_text: string }>;
        maxTargetChars = Math.max(maxTargetChars, ...blocks.map((block) => block.source_text.length));
        text = JSON.stringify({
          polished_blocks: blocks.map((block) => ({ block_id: block.block_id, polished_text: block.source_text })),
        });
      } else {
        validationCalls += 1;
        text = JSON.stringify(acceptedValidation);
      }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
    } finally {
      inFlight -= 1;
    }
  };

  try {
    const provider = createGeminiProvider(fetchMock, {
      longTextThresholdChars: 100,
      chunkChars: 180,
      chunkConcurrency: 3,
      contextChars: 40,
      requestTimeoutMs: 1_000,
      totalBudgetMs: 5_000,
    });
    const layout = buildLockedLayout(longInput.locked_text);
    const polished = await provider.polish(longInput, []);
    const candidate = reconstructCandidate(layout, polished);
    assert.equal(candidate, longInput.locked_text);
    const validation = await provider.validate(
      longInput.locked_text,
      candidate,
      longInput.protected_manifest.terms,
      "자연스러운 한국어",
    );

    assert.ok(polishCalls > 1);
    assert.ok(validationCalls > 1);
    assert.ok(maxInFlight >= 2);
    assert.ok(maxTargetChars <= 180);
    assert.equal(validation.preserved, true);
    assert.equal(validation.rewrite_adequate, true);
  } finally {
    restoreEnv("GEMINI_API_KEY", oldKey);
  }
});

test("long upstream stalls use a low-thinking fallback and abort before the interactive budget", async () => {
  const oldKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "unit-test-key-not-a-secret";
  const longInput: PolishInput = {
    locked_text: "민재는 아주 긴 복도를 걸었다. ".repeat(20),
    protected_manifest: { source: "arc-foundry-final-lock", terms: ["민재"] },
  };
  let calls = 0;

  const hangingFetch = async (_request: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      generationConfig?: { thinkingConfig?: { thinkingLevel?: string } };
    };
    if (calls === 1) assert.equal(body.generationConfig?.thinkingConfig, undefined);
    if (calls === 2) assert.equal(body.generationConfig?.thinkingConfig?.thinkingLevel, "low");

    const signal = init?.signal;
    if (!signal) throw new Error("missing abort signal");
    return new Promise<Response>((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("test_keepalive_expired")), 5_000);
      const abort = (): void => {
        clearTimeout(keepAlive);
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  };

  try {
    const provider = createGeminiProvider(hangingFetch, {
      longTextThresholdChars: 10,
      chunkChars: 80,
      chunkConcurrency: 1,
      contextChars: 20,
      requestTimeoutMs: 15,
      totalBudgetMs: 1_200,
    });
    await assert.rejects(provider.polish(longInput, []), /provider_(?:request_timeout|timeout_budget)/u);
    assert.equal(calls, 2);
  } finally {
    restoreEnv("GEMINI_API_KEY", oldKey);
  }
});