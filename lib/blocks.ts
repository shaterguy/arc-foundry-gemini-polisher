import type { EditableBlock, PolishedBlock } from "./types.js";

const SCENE_SEPARATOR_RE = /^[\s]*(?:\*{3,}|-{3,}|_{3,}|#{3,}|[◆◇◈※]+)[\s]*$/u;

interface EditableSegment {
  kind: "editable";
  block_id: string;
  source_text: string;
}

interface LiteralSegment {
  kind: "literal";
  source_text: string;
}

type LayoutSegment = EditableSegment | LiteralSegment;

export interface LockedLayout {
  newline: "\n" | "\r\n";
  segments: LayoutSegment[];
  editable_blocks: EditableBlock[];
}

export function isSceneSeparator(line: string): boolean {
  return SCENE_SEPARATOR_RE.test(line);
}

function normalizeSeparator(line: string): string {
  return line.trim().replace(/\s+/gu, "");
}

export function extractSceneSeparators(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .filter((line) => isSceneSeparator(line))
    .map(normalizeSeparator);
}

export function buildLockedLayout(text: string): LockedLayout {
  const newline: "\n" | "\r\n" = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/u);
  const segments: LayoutSegment[] = [];
  const editable_blocks: EditableBlock[] = [];
  let bufferedLines: string[] = [];
  let sceneIndex = 0;

  const flushScene = (): void => {
    if (bufferedLines.length === 0) return;
    const sourceText = bufferedLines.join(newline);
    bufferedLines = [];
    if (!sourceText.trim()) {
      segments.push({ kind: "literal", source_text: sourceText });
      return;
    }
    const block: EditableBlock = {
      block_id: `S${String(sceneIndex).padStart(6, "0")}`,
      source_text: sourceText,
    };
    sceneIndex += 1;
    editable_blocks.push(block);
    segments.push({ kind: "editable", ...block });
  };

  for (const line of lines) {
    if (isSceneSeparator(line)) {
      flushScene();
      segments.push({ kind: "literal", source_text: line });
    } else {
      bufferedLines.push(line);
    }
  }
  flushScene();

  return { newline, segments, editable_blocks };
}

export function reconstructCandidate(layout: LockedLayout, polishedBlocks: PolishedBlock[]): string {
  if (polishedBlocks.length !== layout.editable_blocks.length) {
    throw new Error("block_manifest_length_mismatch");
  }

  const replacementById = new Map<string, string>();
  for (let index = 0; index < layout.editable_blocks.length; index += 1) {
    const expected = layout.editable_blocks[index];
    const actual = polishedBlocks[index];
    if (!expected || !actual || actual.block_id !== expected.block_id) {
      throw new Error("block_manifest_order_mismatch");
    }
    if (!actual.polished_text.trim()) {
      throw new Error("block_manifest_empty_text");
    }
    replacementById.set(expected.block_id, actual.polished_text);
  }

  return layout.segments
    .map((segment) => segment.kind === "editable"
      ? replacementById.get(segment.block_id) ?? segment.source_text
      : segment.source_text)
    .join(layout.newline);
}
