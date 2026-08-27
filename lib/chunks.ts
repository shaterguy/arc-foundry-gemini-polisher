import type { EditableBlock, PolishedBlock } from "./types.js";

export interface PlannedChunk {
  chunk_id: string;
  parent_block_id: string;
  source_text: string;
  separator_after: string;
}

interface TextPiece {
  source_text: string;
  separator_after: string;
}

interface Boundary {
  start: number;
  end: number;
}

function lastBoundary(window: string, pattern: RegExp, separatorGroup = 0): Boundary | undefined {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  let last: Boundary | undefined;
  while ((match = pattern.exec(window)) !== null) {
    const separator = separatorGroup > 0 ? match[separatorGroup] : match[0];
    if (!separator) continue;
    const offset = separatorGroup > 0 ? match[0].lastIndexOf(separator) : 0;
    last = {
      start: match.index + offset,
      end: match.index + offset + separator.length,
    };
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return last;
}

function preferredBoundary(window: string, minRelativeEnd: number): Boundary | undefined {
  const candidates = [
    lastBoundary(window, /\r?\n(?:[ \t]*\r?\n)+/gu),
    lastBoundary(window, /\r?\n/gu),
    lastBoundary(window, /[.!?…][”’"'）)\]]?([ \t]+)/gu, 1),
    lastBoundary(window, /[ \t]+/gu),
  ];
  return candidates.find((boundary) => boundary && boundary.start >= minRelativeEnd);
}

function safeHardEnd(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return end;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  const highSurrogate = previous >= 0xD800 && previous <= 0xDBFF;
  const lowSurrogate = next >= 0xDC00 && next <= 0xDFFF;
  return highSurrogate && lowSurrogate ? end - 1 : end;
}

export function splitTextPreservingBoundaries(text: string, maxChars: number): TextPiece[] {
  if (!Number.isFinite(maxChars) || maxChars < 40) throw new Error("invalid_chunk_size");
  if (text.length <= maxChars) return [{ source_text: text, separator_after: "" }];

  const pieces: TextPiece[] = [];
  let cursor = 0;
  while (text.length - cursor > maxChars) {
    const hardTarget = safeHardEnd(text, cursor + maxChars);
    const window = text.slice(cursor, hardTarget);
    const minRelativeEnd = Math.max(1, Math.floor(window.length * 0.45));
    const boundary = preferredBoundary(window, minRelativeEnd);

    if (boundary) {
      const absoluteStart = cursor + boundary.start;
      const absoluteEnd = cursor + boundary.end;
      const sourceText = text.slice(cursor, absoluteStart);
      if (sourceText.trim()) {
        pieces.push({
          source_text: sourceText,
          separator_after: text.slice(absoluteStart, absoluteEnd),
        });
        cursor = absoluteEnd;
        continue;
      }
    }

    pieces.push({ source_text: text.slice(cursor, hardTarget), separator_after: "" });
    cursor = hardTarget;
  }

  const tail = text.slice(cursor);
  if (!tail.trim() && pieces.length > 0) {
    pieces[pieces.length - 1]!.separator_after += tail;
  } else if (tail) {
    pieces.push({ source_text: tail, separator_after: "" });
  }
  return pieces;
}

export function planEditableChunks(blocks: EditableBlock[], maxChars: number): PlannedChunk[] {
  const chunks: PlannedChunk[] = [];
  for (const block of blocks) {
    const pieces = splitTextPreservingBoundaries(block.source_text, maxChars);
    pieces.forEach((piece, index) => {
      chunks.push({
        chunk_id: `${block.block_id}.C${String(index).padStart(3, "0")}`,
        parent_block_id: block.block_id,
        source_text: piece.source_text,
        separator_after: piece.separator_after,
      });
    });
  }
  return chunks;
}

export function reconstructPolishedBlocks(
  originalBlocks: EditableBlock[],
  chunks: PlannedChunk[],
  polishedByChunk: ReadonlyMap<string, string>,
): PolishedBlock[] {
  const chunksByParent = new Map<string, PlannedChunk[]>();
  for (const chunk of chunks) {
    const group = chunksByParent.get(chunk.parent_block_id) ?? [];
    group.push(chunk);
    chunksByParent.set(chunk.parent_block_id, group);
  }

  return originalBlocks.map((block) => {
    const group = chunksByParent.get(block.block_id);
    if (!group || group.length === 0) throw new Error("chunk_manifest_parent_missing");
    const polishedText = group.map((chunk) => {
      const replacement = polishedByChunk.get(chunk.chunk_id);
      if (replacement === undefined) throw new Error("chunk_manifest_candidate_missing");
      if (!replacement.trim()) throw new Error("chunk_manifest_empty_text");
      return `${replacement}${chunk.separator_after}`;
    }).join("");
    return { block_id: block.block_id, polished_text: polishedText };
  });
}
