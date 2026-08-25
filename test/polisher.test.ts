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

function blocksFor(source: string, polishedLines: string[]): PolishedBlock[] {
  const layout = buildLockedLayout(source);
  return layout.editable_blocks.map((block, index) => ({
    block_id: block.block_id,
    polished_text: polishedLines[index] ?? block.source_text,
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
      return { preserved: true, violations: [], summary: "preserved" };
    },
    ...overrides,
  };
}

test("accepted candidate is returned only after deterministic and semantic checks", async () => {
  const result = await polishLockedText(input, provider(), { maxAttempts: 2 });
  assert.equal(result.status, "accepted");
  assert.equal(result.final_text, "민재는 천천히 3층으로 올라갔다.");
  assert.equal(result.validation.deterministic_passed, true);
  assert.equal(result.validation.semantic_passed, true);
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

test("reordered block manifest is rejected without semantic acceptance", async () => {
  const multi: PolishInput = {
    locked_text: "민재가 말했다.\n수진이 답했다.",
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
      };
    },
  });
  const result = await polishLockedText(input, mock, { maxAttempts: 2 });
  assert.equal(result.status, "fallback_original");
  assert.equal(result.reason, "validation_failed");
  assert.equal(result.final_text, input.locked_text);
});

test("provider failure falls back to exact locked source", async () => {
  const mock = provider({
    async polish() {
      throw new Error("simulated outage");
    },
  });
  const result = await polishLockedText(input, mock, { maxAttempts: 2 });
  assert.equal(result.status, "fallback_original");
  assert.equal(result.reason, "provider_failure");
  assert.equal(result.final_text, input.locked_text);
});
