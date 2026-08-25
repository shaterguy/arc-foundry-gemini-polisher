import type { EditableBlock, PolishedBlock } from "./types.js";

const SCENE_SEPARATOR_RE = /^[\s]*(?:\*{3,}|-{3,}|_{3,}|#{3,}|[◆◇◈※]+)[\s]*$/u;

export interface LockedLayout {
  newline: "\n" | "\r\n";
  lines: string[];
  editable_blocks: Array<EditableBlock & { line_index: number }>;
}

export function isSceneSeparator(line: string): boolean {
  return SCENE_SEPARATOR_RE.test(line);
}

export function buildLockedLayout(text: string): LockedLayout {
  const newline: "\n" | "\r\n" = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/u);
  const editable_blocks: LockedLayout["editable_blocks"] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const sourceText = lines[lineIndex] ?? "";
    if (!sourceText.trim() || isSceneSeparator(sourceText)) continue;
    editable_blocks.push({
      block_id: `L${String(lineIndex).padStart(6, "0")}`,
      source_text: sourceText,
      line_index: lineIndex,
    });
  }

  return { newline, lines, editable_blocks };
}

export function reconstructCandidate(layout: LockedLayout, polishedBlocks: PolishedBlock[]): string {
  if (polishedBlocks.length !== layout.editable_blocks.length) {
    throw new Error("block_manifest_length_mismatch");
  }

  const lines = [...layout.lines];
  for (let index = 0; index < layout.editable_blocks.length; index += 1) {
    const expected = layout.editable_blocks[index];
    const actual = polishedBlocks[index];
    if (!expected || !actual || actual.block_id !== expected.block_id) {
      throw new Error("block_manifest_order_mismatch");
    }
    if (!actual.polished_text.trim()) {
      throw new Error("block_manifest_empty_text");
    }
    if (/\r|\n/u.test(actual.polished_text)) {
      throw new Error("block_manifest_embedded_newline");
    }
    lines[expected.line_index] = actual.polished_text;
  }

  return lines.join(layout.newline);
}
