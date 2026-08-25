import assert from "node:assert/strict";
import test from "node:test";
import { buildGenerateContentRequest, createGeminiProvider } from "../lib/gemini";
import type { PolishInput } from "../lib/types";

test("GenerateContent request always sets top-level store=false", () => {
  const body = buildGenerateContentRequest("system", "prompt", { type: "object" });
  assert.equal(body.store, false);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
});

test("both polish and semantic validation calls transmit store=false", async () => {
  const oldKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "unit-test-key-not-a-secret";
  const seenBodies: Array<Record<string, unknown>> = [];
  let call = 0;
  const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    seenBodies.push(body);
    call += 1;
    const text = call === 1
      ? JSON.stringify({ polished_blocks: [{ block_id: "L000000", polished_text: "민재는 문을 열었다." }] })
      : JSON.stringify({ preserved: true, violations: [], summary: "preserved" });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const provider = createGeminiProvider(fetchMock);
    const input: PolishInput = {
      locked_text: "민재는 문을 열었다.",
      protected_manifest: { source: "arc-foundry-final-lock", terms: ["민재"] },
    };
    await provider.polish(input, []);
    await provider.validate(input.locked_text, input.locked_text, input.protected_manifest.terms);
    assert.equal(seenBodies.length, 2);
    assert.ok(seenBodies.every((body) => body.store === false));
  } finally {
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldKey;
  }
});
