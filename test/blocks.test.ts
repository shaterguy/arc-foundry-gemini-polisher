import assert from "node:assert/strict";
import test from "node:test";
import { buildLockedLayout, reconstructCandidate } from "../lib/blocks";

test("fixed block ids reconstruct text without changing paragraph or scene positions", () => {
  const source = "첫 문단.\n\n***\n둘째 문단.";
  const layout = buildLockedLayout(source);
  const candidate = reconstructCandidate(layout, [
    { block_id: "L000000", polished_text: "첫 번째 문단." },
    { block_id: "L000003", polished_text: "두 번째 문단." },
  ]);
  assert.equal(candidate, "첫 번째 문단.\n\n***\n두 번째 문단.");
});

test("reordered dialogue or paragraph block ids are rejected", () => {
  const layout = buildLockedLayout("\"첫 대사.\"\n\"둘째 대사.\"");
  assert.throws(() => reconstructCandidate(layout, [
    { block_id: "L000001", polished_text: "\"둘째 대사.\"" },
    { block_id: "L000000", polished_text: "\"첫 대사.\"" },
  ]), /block_manifest_order_mismatch/u);
});

test("added or deleted blocks are rejected", () => {
  const layout = buildLockedLayout("첫 줄.\n둘째 줄.");
  assert.throws(() => reconstructCandidate(layout, [
    { block_id: "L000000", polished_text: "첫 줄." },
  ]), /block_manifest_length_mismatch/u);
});

test("embedded newline cannot create a new paragraph or scene", () => {
  const layout = buildLockedLayout("첫 줄.");
  assert.throws(() => reconstructCandidate(layout, [
    { block_id: "L000000", polished_text: "첫 줄.\n새 설정." },
  ]), /block_manifest_embedded_newline/u);
});
