import assert from "node:assert/strict";
import test from "node:test";
import { sha256, validateDeterministic } from "../lib/preservation";

test("surface edit with protected facts preserved passes deterministic validation", () => {
  const original = "민재는 2026-08-25에 3층으로 올라갔다.\n\n\"문을 닫아.\"";
  const candidate = "민재는 2026-08-25, 3층으로 올라갔다.\n\n\"문을 닫아.\"";
  assert.deepEqual(validateDeterministic(original, candidate, ["민재"]), { passed: true, violations: [] });
});

test("number or date change is rejected", () => {
  const result = validateDeterministic("민재는 3층에 있었다.", "민재는 4층에 있었다.", ["민재"]);
  assert.equal(result.passed, false);
  assert.ok(result.violations.some((value) => value.startsWith("number/date:")));
});

test("protected term deletion is rejected", () => {
  const result = validateDeterministic("민재가 문을 열었다.", "그가 문을 열었다.", ["민재"]);
  assert.equal(result.passed, false);
  assert.ok(result.violations.some((value) => value.includes("protected term")));
});

test("scene separator changes are rejected", () => {
  const result = validateDeterministic("첫 장면\n***\n둘째 장면", "첫 장면\n둘째 장면", []);
  assert.equal(result.passed, false);
  assert.ok(result.violations.some((value) => value.startsWith("scene_order:")));
});

test("gross deletion is rejected", () => {
  const original = "가".repeat(1000);
  const candidate = "가".repeat(400);
  const result = validateDeterministic(original, candidate, []);
  assert.equal(result.passed, false);
  assert.ok(result.violations.some((value) => value.startsWith("deletion:")));
});

test("lock hash is stable", () => {
  assert.equal(sha256("FINAL CONTENT LOCK"), sha256("FINAL CONTENT LOCK"));
  assert.notEqual(sha256("A"), sha256("B"));
});
