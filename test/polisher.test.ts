import assert from "node:assert/strict";
import test from "node:test";
import { buildLockedLayout } from "../lib/blocks";
import { polishLockedText } from "../lib/polisher";
import type { PolishInput, PolishedBlock } from "../lib/types";
import type { PolishProvider } from "../lib/gemini";

const input: PolishInput = {
  locked_text: "민재는 3층으로 천천히 올라갔다.",
  protected_manifest: { source: "arc-foundry-final-lock", terms: ["민재"] },
  unit_id: "episode-001",
};

function blocksFor(source: string, polishedScenes: string[]): PolishedBlock[] {
  const layout = buildLockedLayout(source);
  return layout.editable_blocks.map((block, index) => ({
    block_id: block.block_id,
    polished_text: polishedScenes[index] ?? block.source_text,
  }));
}

function provider(overrides: Partial<PolishProvider> = {}): PolishProvider {
  return {
    model: "test-polisher",
    validatorModel: "test-validator",
    async polish() {
      return blocksFor(input.locked_text, ["민재는 천천히 3층으로 올라갔다."]);
    },
    async validate() {
      return {
        preserved: true,
        violations: [],
        summary: "preserved",
        rewrite_needed: true,
        rewrite_adequate: true,
        adequacy_summary: "materially improved",
      };
    },
    ...overrides,
  };
}

test("accepted candidate is returned only after deterministic semantic and adequacy checks", async () => {
  const result = await polishLockedText(input, provider(), { maxAttempts: 2 });
  assert.equal(result.status, "accepted");
  assert.equal(result.final_text, "민재는 천천히 3층으로 올라갔다.");
  assert.equal(result.validation.deterministic_passed, true);
  assert.equal(result.validation.semantic_passed, true);
  assert.equal(result.validation.rewrite_adequacy_passed, true);
});

test("missing protected manifest fails closed before provider use", async () => {
  let calls = 0;
  const invalidInput = { ...input, protected_manifest: undefined } as unknown as PolishInput;
  const result = await polishLockedText(invalidInput, provider({
    async polish() {
      calls += 1;
      return [];
    },
  }));
  assert.equal(calls, 0);
  assert.equal(result.status, "fallback_original");
  assert.equal(result.reason, "configuration_failure");
  assert.equal(result.final_text, input.locked_text);
});

test("deterministic violation retries from locked source and can recover", async () => {
  let calls = 0;
  const mock = provider({
    async polish(received) {
      assert.equal(received.locked_text, input.locked_text);
      calls += 1;
      return blocksFor(received.locked_text, [calls === 1 ? "민재는 천천히 4층으로 올라갔다." : "민재는 천천히 3층으로 올라갔다."]);
    },
  });
  const result = await polishLockedText(input, mock, { maxAttempts: 2 });
  assert.equal(calls, 2);
  assert.equal(result.status, "accepted");
  assert.equal(result.attempts, 2);
});

test("reordered scene block manifest is rejected without semantic acceptance", async () => {
  const multi: PolishInput = {
    locked_text: "민재가 말했다.\n***\n수진이 답했다.",
    protected_manifest: { source: "arc-foundry-final-lock", terms: ["민재", "수진"] },
  };
  const layout = buildLockedLayout(multi.locked_text);
  const mock = provider({
    async polish() {
      return [
        { block_id: layout.editable_blocks[1]!.block_id, polished_text: "수진이 답했다." },
        { block_id: layout.editable_blocks[0]!.block_id, polished_text: "민재가 말했다." },
      ];
    },
  });
  const result = await polishLockedText(multi, mock, { maxAttempts: 1 });
  assert.equal(result.status, "fallback_original");
  assert.equal(result.reason, "validation_failed");
  assert.equal(result.final_text, multi.locked_text);
});

test("semantic violation falls back to exact locked source", async () => {
  const mock = provider({
    async validate() {
      return {
        preserved: false,
        violations: [{ category: "character_intent", explanation: "intent changed" }],
        summary: "rejected",
        rewrite_needed: true,
        rewrite_adequate: true,
        adequacy_summary: "surface improved",
      };
    },
  });
  const result = await polishLockedText(input, mock, { maxAttempts: 2 });
  assert.equal(result.status, "fallback_original");
  assert.equal(result.reason, "validation_failed");
  assert.equal(result.final_text, input.locked_text);
  assert.equal(result.validation.semantic_passed, false);
});

test("rewrite inadequacy retries even when meaning is preserved", async () => {
  let polishCalls = 0;
  let validateCalls = 0;
  const mock = provider({
    async polish(received, rejectionNotes) {
      polishCalls += 1;
      if (polishCalls === 2) {
        assert.ok(rejectionNotes.some((note) => note.startsWith("rewrite_adequacy:")));
      }
      return blocksFor(received.locked_text, [
        polishCalls === 1
          ? "민재는 3층으로 천천히 올라갔다."
          : "민재는 천천히 3층으로 올라갔다.",
      ]);
    },
    async validate() {
      validateCalls += 1;
      return {
        preserved: true,
        violations: [],
        summary: "preserved",
        rewrite_needed: true,
        rewrite_adequate: validateCalls > 1,
        adequacy_summary: validateCalls > 1 ? "materially improved" : "only surface-level changes",
      };
    },
  });
  const result = await polishLockedText(input, mock, { maxAttempts: 2 });
  assert.equal(polishCalls, 2);
  assert.equal(validateCalls, 2);
  assert.equal(result.status, "accepted");
  assert.equal(result.attempts, 2);
});

test("already-natural source does not require gratuitous rewriting", async () => {
  const natural: PolishInput = {
    locked_text: "비가 그친 골목에는 젖은 흙냄새가 남아 있었다.",
    protected_manifest: { source: "arc-foundry-final-lock", terms: ["골목"] },
  };
  const mock = provider({
    async polish(received) {
      return blocksFor(received.locked_text, [received.locked_text]);
    },
    async validate() {
      return {
        preserved: true,
        violations: [],
        summary: "preserved",
        rewrite_needed: false,
        rewrite_adequate: true,
        adequacy_summary: "already natural",
      };
    },
  });
  const result = await polishLockedText(natural, mock, { maxAttempts: 1 });
  assert.equal(result.status, "accepted");
  assert.equal(result.final_text, natural.locked_text);
});

test("provider failure falls back to exact locked source with sanitized status", async () => {
  const mock = provider({
    async polish() {
      throw new Error("gemini_http_503");
    },
  });
  const result = await polishLockedText(input, mock, { maxAttempts: 2 });
  assert.equal(result.status, "fallback_original");
  assert.equal(result.reason, "provider_failure");
  assert.equal(result.final_text, input.locked_text);
  assert.deepEqual(result.validation.violations, ["Gemini polish request failed: gemini_http_503"]);
});

for (const code of ["provider_request_timeout", "provider_timeout_budget"]) {
  test(`bounded timeout failure keeps the diagnostic code: ${code}`, async () => {
    const mock = provider({
      async polish() {
        throw new Error(code);
      },
    });
    const result = await polishLockedText(input, mock, { maxAttempts: 1 });
    assert.equal(result.status, "fallback_original");
    assert.equal(result.reason, "provider_failure");
    assert.equal(result.final_text, input.locked_text);
    assert.deepEqual(result.validation.violations, [`Gemini polish request failed: ${code}`]);
  });
}

test("unknown provider failure does not leak exception text", async () => {
  const mock = provider({
    async polish() {
      throw new Error("do-not-expose-upstream-detail");
    },
  });
  const result = await polishLockedText(input, mock, { maxAttempts: 1 });
  assert.equal(result.status, "fallback_original");
  assert.equal(result.final_text, input.locked_text);
  assert.deepEqual(result.validation.violations, ["Gemini polish request failed: provider_error"]);
});