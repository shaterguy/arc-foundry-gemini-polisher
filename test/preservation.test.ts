import assert from "node:assert/strict";
import test from "node:test";
import { sha256, validateDeterministic } from "../lib/preservation";

test("substantial rewrite with changed paragraph boundaries passes when protected facts remain", () => {
  const original = "민재는 2026-08-25에 3층으로 올라갔다.\n민재는 복도를 바라보았다.\n\n***\n\"문을 닫아.\"";
  const candidate = "민재는 2026-08-25에 3층으로 올라가 복도를 바라보았다.\n***\n\"문을 닫아.\"";
  assert.deepEqual(validateDeterministic(original, candidate, ["민재"]), { passed: true, violations: [] });
});

test("number or date change is rejected", () => {
  const result = validateDeterministic("민재는 3층에 있었다.", "민재는 4층에 있었다.", ["민재"]);
  assert.equal(result.passed, false);
  assert.ok(result.violations.some((value) => value.startsWith("number/date:")));
});

test("protected term deletion or mutation is rejected", () => {
  const result = validateDeterministic("민재가 문을 열었다.", "민수가 문을 열었다.", ["민재"]);
  assert.equal(result.passed, false);
  assert.ok(result.violations.some((value) => value.includes("protected term")));
});

test("redundant protected-term repetition may be reduced", () => {
  const result = validateDeterministic(
    "민재는 문을 열었다. 민재는 안으로 들어갔다.",
    "민재는 문을 열고 안으로 들어갔다.",
    ["민재"],
  );
  assert.deepEqual(result, { passed: true, violations: [] });
});

test("scene separator changes are rejected", () => {
  const result = validateDeterministic("첫 장면\n***\n둘째 장면", "첫 장면\n---\n둘째 장면", ["첫 장면"]);
  assert.equal(result.passed, false);
  assert.ok(result.violations.some((value) => value.startsWith("scene_order:")));
});

test("paragraph splitting inside one scene is allowed", () => {
  const result = validateDeterministic("민재는 문을 열고 들어갔다.", "민재는 문을 열었다.\n\n안으로 들어갔다.", ["민재"]);
  assert.deepEqual(result, { passed: true, violations: [] });
});

test("empty candidate is rejected", () => {
  const result = validateDeterministic("민재가 있었다.", "   ", ["민재"]);
  assert.equal(result.passed, false);
  assert.ok(result.violations.some((value) => value.startsWith("deletion:")));
});

test("lock hash is stable", () => {
  assert.equal(sha256("FINAL CONTENT LOCK"), sha256("FINAL CONTENT LOCK"));
  assert.notEqual(sha256("A"), sha256("B"));
});
