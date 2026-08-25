import assert from "node:assert/strict";
import test from "node:test";
import { polishLockedText } from "../lib/polisher";
import type { PolishInput } from "../lib/types";
import type { PolishProvider } from "../lib/gemini";

const input: PolishInput = {
  locked_text: "민재는 3층으로 천천히 올라갔다.",
  protected_terms: ["민재"],
  unit_id: "episode-001",
};

function provider(overrides: Partial<PolishProvider> = {}): PolishProvider {
  return {
    model: "test-polisher",
    validatorModel: "test-validator",
    async polish() {
      return "민재는 천천히 3층으로 올라갔다.";
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

test("deterministic violation retries from locked source and can recover", async () => {
  let calls = 0;
  const mock = provider({
    async polish(received) {
      assert.equal(received.locked_text, input.locked_text);
      calls += 1;
      return calls === 1 ? "민재는 천천히 4층으로 올라갔다." : "민재는 천천히 3층으로 올라갔다.";
    },
  });
  const result = await polishLockedText(input, mock, { maxAttempts: 2 });
  assert.equal(calls, 2);
  assert.equal(result.status, "accepted");
  assert.equal(result.attempts, 2);
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
