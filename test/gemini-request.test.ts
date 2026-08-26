import assert from "node:assert/strict";
import test from "node:test";
import { buildGenerateContentRequest, createGeminiProvider } from "../lib/gemini";
import type { PolishInput } from "../lib/types";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const input: PolishInput = {
  locked_text: "민재는 문을 열었다.",
  protected_manifest: { source: "arc-foundry-final-lock", terms: ["민재"] },
};

const acceptedValidation = {
  preserved: true,
  violations: [],
  summary: "preserved",
  rewrite_needed: false,
  rewrite_adequate: true,
  adequacy_summary: "already natural",
};

test("GenerateContent request always sets top-level store=false", () => {
  const body = buildGenerateContentRequest("system", "prompt", { type: "object" });
  assert.equal(body.store, false);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
});

test("polish request explicitly permits literary restructuring instead of mere proofreading", async () => {
  const oldKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "unit-test-key-not-a-secret";
  let seenBody: Record<string, unknown> | undefined;
  const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seenBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const text = JSON.stringify({ polished_blocks: [{ block_id: "S000000", polished_text: "민재는 문을 열었다." }] });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
  };

  try {
    const provider = createGeminiProvider(fetchMock);
    await provider.polish(input, []);
    const systemInstruction = seenBody?.systemInstruction as { parts?: Array<{ text?: string }> } | undefined;
    const systemText = systemInstruction?.parts?.map((part) => part.text ?? "").join("") ?? "";
    assert.match(systemText, /NOT mere proofreading/u);
    assert.match(systemText, /splitting or merging sentences and paragraphs/u);
    assert.match(systemText, /Do not preserve source sentence boundaries/u);
  } finally {
    restoreEnv("GEMINI_API_KEY", oldKey);
  }
});

test("both polish and dual validation calls transmit store=false", async () => {
  const oldKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "unit-test-key-not-a-secret";
  const seenBodies: Array<Record<string, unknown>> = [];
  let call = 0;
  const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    seenBodies.push(body);
    call += 1;
    const text = call === 1
      ? JSON.stringify({ polished_blocks: [{ block_id: "S000000", polished_text: "민재는 문을 열었다." }] })
      : JSON.stringify(acceptedValidation);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const provider = createGeminiProvider(fetchMock);
    await provider.polish(input, []);
    const validation = await provider.validate(input.locked_text, input.locked_text, input.protected_manifest.terms, "자연스러운 한국어");
    assert.equal(seenBodies.length, 2);
    assert.ok(seenBodies.every((body) => body.store === false));
    assert.equal(validation.rewrite_adequate, true);
    const validationPrompt = ((seenBodies[1]?.contents as Array<{ parts?: Array<{ text?: string }> }> | undefined)?.[0]?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("");
    assert.match(validationPrompt, /STYLE_RULES/u);
  } finally {
    restoreEnv("GEMINI_API_KEY", oldKey);
  }
});

test("transient primary model failure falls back to gemini-3.6-flash", async () => {
  const previous = {
    key: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL,
    fallback: process.env.GEMINI_FALLBACK_MODEL,
    retries: process.env.GEMINI_NETWORK_RETRIES,
  };
  process.env.GEMINI_API_KEY = "unit-test-key-not-a-secret";
  process.env.GEMINI_MODEL = "gemini-3.7-flash";
  process.env.GEMINI_FALLBACK_MODEL = "gemini-3.6-flash";
  process.env.GEMINI_NETWORK_RETRIES = "0";
  const urls: string[] = [];

  const fetchMock = async (request: string | URL | Request): Promise<Response> => {
    const url = String(request);
    urls.push(url);
    if (url.includes("gemini-3.7-flash")) {
      return new Response("", { status: 503 });
    }
    const text = JSON.stringify({ polished_blocks: [{ block_id: "S000000", polished_text: "민재는 문을 열었다." }] });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
  };

  try {
    const provider = createGeminiProvider(fetchMock);
    const blocks = await provider.polish(input, []);
    assert.equal(blocks.length, 1);
    assert.equal(urls.length, 2);
    assert.match(urls[0] ?? "", /gemini-3\.7-flash/u);
    assert.match(urls[1] ?? "", /gemini-3\.6-flash/u);
    assert.equal(provider.model, "gemini-3.6-flash");
  } finally {
    restoreEnv("GEMINI_API_KEY", previous.key);
    restoreEnv("GEMINI_MODEL", previous.model);
    restoreEnv("GEMINI_FALLBACK_MODEL", previous.fallback);
    restoreEnv("GEMINI_NETWORK_RETRIES", previous.retries);
  }
});

test("non-transient primary model failure does not fail over", async () => {
  const previous = {
    key: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL,
    fallback: process.env.GEMINI_FALLBACK_MODEL,
    retries: process.env.GEMINI_NETWORK_RETRIES,
  };
  process.env.GEMINI_API_KEY = "unit-test-key-not-a-secret";
  process.env.GEMINI_MODEL = "gemini-3.7-flash";
  process.env.GEMINI_FALLBACK_MODEL = "gemini-3.6-flash";
  process.env.GEMINI_NETWORK_RETRIES = "0";
  const urls: string[] = [];
  const fetchMock = async (request: string | URL | Request): Promise<Response> => {
    urls.push(String(request));
    return new Response("", { status: 400 });
  };

  try {
    const provider = createGeminiProvider(fetchMock);
    await assert.rejects(provider.polish(input, []), /gemini_http_400/u);
    assert.equal(urls.length, 1);
    assert.match(urls[0] ?? "", /gemini-3\.7-flash/u);
    assert.equal(provider.model, "gemini-3.7-flash");
  } finally {
    restoreEnv("GEMINI_API_KEY", previous.key);
    restoreEnv("GEMINI_MODEL", previous.model);
    restoreEnv("GEMINI_FALLBACK_MODEL", previous.fallback);
    restoreEnv("GEMINI_NETWORK_RETRIES", previous.retries);
  }
});

test("semantic validator independently fails over on transient errors", async () => {
  const previous = {
    key: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_VALIDATOR_MODEL,
    fallback: process.env.GEMINI_VALIDATOR_FALLBACK_MODEL,
    retries: process.env.GEMINI_NETWORK_RETRIES,
  };
  process.env.GEMINI_API_KEY = "unit-test-key-not-a-secret";
  process.env.GEMINI_VALIDATOR_MODEL = "gemini-3.7-flash";
  process.env.GEMINI_VALIDATOR_FALLBACK_MODEL = "gemini-3.6-flash";
  process.env.GEMINI_NETWORK_RETRIES = "0";
  const urls: string[] = [];

  const fetchMock = async (request: string | URL | Request): Promise<Response> => {
    const url = String(request);
    urls.push(url);
    if (url.includes("gemini-3.7-flash")) return new Response("", { status: 429 });
    const text = JSON.stringify(acceptedValidation);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
  };

  try {
    const provider = createGeminiProvider(fetchMock);
    const validation = await provider.validate(input.locked_text, input.locked_text, input.protected_manifest.terms);
    assert.equal(validation.preserved, true);
    assert.equal(validation.rewrite_adequate, true);
    assert.equal(urls.length, 2);
    assert.equal(provider.validatorModel, "gemini-3.6-flash");
  } finally {
    restoreEnv("GEMINI_API_KEY", previous.key);
    restoreEnv("GEMINI_VALIDATOR_MODEL", previous.model);
    restoreEnv("GEMINI_VALIDATOR_FALLBACK_MODEL", previous.fallback);
    restoreEnv("GEMINI_NETWORK_RETRIES", previous.retries);
  }
});
