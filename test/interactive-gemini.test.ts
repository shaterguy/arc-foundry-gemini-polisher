import assert from "node:assert/strict";
import test from "node:test";
import { buildLockedLayout, reconstructCandidate } from "../lib/blocks";
import { createInteractiveGeminiProvider, withInteractiveGeminiPolicy } from "../lib/interactive-gemini";
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

test("long interactive provider forces low thinking and serial bounded units for rewrite and validation", async () => {
  const oldKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "unit-test-key-not-a-secret";
  const input: PolishInput = {
    locked_text: "민재는 복도를 걸었다. 창가에서 잠시 멈췄다. ".repeat(340),
    protected_manifest: { source: "arc-foundry-final-lock", terms: ["민재"] },
  };
  assert.ok(input.locked_text.length >= 8_000);
  assert.ok(input.locked_text.length <= 12_000);

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
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        generationConfig?: { thinkingConfig?: { thinkingLevel?: string } };
      };
      assert.equal(body.generationConfig?.thinkingConfig?.thinkingLevel, "low");

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
    const provider = createInteractiveGeminiProvider(input.locked_text.length, fetchMock);
    const layout = buildLockedLayout(input.locked_text);
    const polished = await provider.polish(input, []);
    const candidate = reconstructCandidate(layout, polished);
    const validation = await provider.validate(input.locked_text, candidate, ["민재"], "자연스러운 한국어");

    assert.ok(polishCalls >= 2);
    assert.ok(validationCalls >= 2);
    assert.ok(polishCalls <= 2);
    assert.ok(validationCalls <= 2);
    assert.equal(maxInFlight, 1);
    assert.ok(maxTargetChars <= 8_000);
    assert.equal(candidate, input.locked_text);
    assert.equal(validation.preserved, true);
  } finally {
    restoreEnv("GEMINI_API_KEY", oldKey);
  }
});

test("interactive Gemini policy cools down a 429 without same-model retry and logs only sanitized quota metadata", async () => {
  let calls = 0;
  const observedThinking: unknown[] = [];
  const warnings: string[] = [];
  const oldWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };

  const fetchMock = async (_request: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      generationConfig?: { thinkingConfig?: { thinkingLevel?: string } };
    };
    observedThinking.push(body.generationConfig?.thinkingConfig?.thinkingLevel);
    return new Response(JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "project-number-should-never-be-logged",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [{
              quotaMetric: "generativelanguage.googleapis.com/generate_content_paid_tier_input_token_count",
              quotaId: "sensitive-quota-id-should-not-be-logged",
            }],
          },
          {
            "@type": "type.googleapis.com/google.rpc.RetryInfo",
            retryDelay: "0.01s",
          },
        ],
      },
    }), { status: 429, headers: { "content-type": "application/json" } });
  };

  try {
    const wrapped = withInteractiveGeminiPolicy(fetchMock);
    const response = await wrapped("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent", {
      method: "POST",
      body: JSON.stringify({ generationConfig: { responseMimeType: "application/json" } }),
    });

    assert.equal(response.status, 429);
    assert.equal(calls, 1);
    assert.deepEqual(observedThinking, ["low"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /gemini_rate_limit/u);
    assert.match(warnings[0]!, /generate_content_paid_tier_input_token_count/u);
    assert.doesNotMatch(warnings[0]!, /project-number-should-never-be-logged/u);
    assert.doesNotMatch(warnings[0]!, /sensitive-quota-id-should-not-be-logged/u);
  } finally {
    console.warn = oldWarn;
  }
});

test("interactive Gemini policy retries one 503 on the same model", async () => {
  let calls = 0;
  const observedThinking: unknown[] = [];
  const fetchMock = async (_request: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      generationConfig?: { thinkingConfig?: { thinkingLevel?: string } };
    };
    observedThinking.push(body.generationConfig?.thinkingConfig?.thinkingLevel);
    if (calls === 1) return new Response("transient", { status: 503 });
    return new Response("ok", { status: 200 });
  };

  const wrapped = withInteractiveGeminiPolicy(fetchMock);
  const response = await wrapped("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent", {
    method: "POST",
    body: JSON.stringify({ generationConfig: { responseMimeType: "application/json" } }),
  });

  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(observedThinking, ["low", "low"]);
});

test("short interactive provider keeps the default thinking policy", async () => {
  const oldKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "unit-test-key-not-a-secret";
  const input: PolishInput = {
    locked_text: "민재는 문을 열었다.",
    protected_manifest: { source: "arc-foundry-final-lock", terms: ["민재"] },
  };
  let observedThinking: unknown = "not-called";

  const fetchMock = async (_request: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      generationConfig?: { thinkingConfig?: unknown };
    };
    observedThinking = body.generationConfig?.thinkingConfig;
    const payload = promptPayload(init);
    const blocks = payload.EDIT_TARGET_BLOCKS as Array<{ block_id: string; source_text: string }>;
    const text = JSON.stringify({
      polished_blocks: blocks.map((block) => ({ block_id: block.block_id, polished_text: block.source_text })),
    });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
  };

  try {
    const provider = createInteractiveGeminiProvider(input.locked_text.length, fetchMock);
    await provider.polish(input, []);
    assert.equal(observedThinking, undefined);
  } finally {
    restoreEnv("GEMINI_API_KEY", oldKey);
  }
});
