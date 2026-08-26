import assert from "node:assert/strict";
import test from "node:test";
import { buildLockedLayout, reconstructCandidate } from "../lib/blocks";

test("scene blocks allow sentence and paragraph restructuring while preserving separators", () => {
  const source = "첫 문장. 둘째 문장.\n\n***\n둘째 장면.";
  const layout = buildLockedLayout(source);
  assert.deepEqual(layout.editable_blocks.map((block) => block.block_id), ["S000000", "S000001"]);

  const candidate = reconstructCandidate(layout, [
    { block_id: "S000000", polished_text: "첫 문장과 둘째 문장을 합쳤다.\n새 문단." },
    { block_id: "S000001", polished_text: "둘째 장면." },
  ]);

  assert.equal(candidate, "첫 문장과 둘째 문장을 합쳤다.\n새 문단.\n***\n둘째 장면.");
});

test("reordered scene block ids are rejected", () => {
  const layout = buildLockedLayout("첫 장면.\n***\n둘째 장면.");
  assert.throws(() => reconstructCandidate(layout, [
    { block_id: "S000001", polished_text: "둘째 장면." },
    { block_id: "S000000", polished_text: "첫 장면." },
  ]), /block_manifest_order_mismatch/u);
});

test("added or deleted scene blocks are rejected", () => {
  const layout = buildLockedLayout("첫 장면.\n***\n둘째 장면.");
  assert.throws(() => reconstructCandidate(layout, [
    { block_id: "S000000", polished_text: "첫 장면." },
  ]), /block_manifest_length_mismatch/u);
});

test("embedded newlines are allowed inside an existing scene block", () => {
  const layout = buildLockedLayout("첫 줄. 둘째 줄.");
  const candidate = reconstructCandidate(layout, [
    { block_id: "S000000", polished_text: "첫 줄.\n\n둘째 줄." },
  ]);
  assert.equal(candidate, "첫 줄.\n\n둘째 줄.");
});
