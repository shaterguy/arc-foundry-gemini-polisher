import { createHash } from "node:crypto";
import { isSceneSeparator } from "./blocks";

const NUMERIC_TOKEN_RE = /(?:\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}:\d{2}(?::\d{2})?|[+-]?\d+(?:,\d{3})*(?:\.\d+)?(?:\s?(?:%|퍼센트|원|만원|억원|조원|년|개월|월|일|시|분|초|명|개|회|층|km|m|cm|mm|kg|g|℃|°C))?)/gu;
const DIALOGUE_LINE_RE = /^[\s]*["“‘'「『].+["”’'」』][.!?…~]*[\s]*$/u;

export interface DeterministicValidation {
  passed: boolean;
  violations: string[];
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function extractNumericTokens(text: string): string[] {
  return text.match(NUMERIC_TOKEN_RE) ?? [];
}

function countLiteral(text: string, term: string): number {
  if (!term) return 0;
  let count = 0;
  let start = 0;
  while (true) {
    const index = text.indexOf(term, start);
    if (index === -1) return count;
    count += 1;
    start = index + term.length;
  }
}

function normalizeSeparator(line: string): string {
  return line.trim().replace(/\s+/gu, "");
}

function validateLineStructure(original: string, candidate: string): string[] {
  const violations: string[] = [];
  const originalLines = original.split(/\r?\n/u);
  const candidateLines = candidate.split(/\r?\n/u);

  if (originalLines.length !== candidateLines.length) {
    return ["scene_order: line/paragraph count changed"];
  }

  for (let index = 0; index < originalLines.length; index += 1) {
    const left = originalLines[index] ?? "";
    const right = candidateLines[index] ?? "";
    const leftBlank = !left.trim();
    const rightBlank = !right.trim();
    if (leftBlank !== rightBlank) {
      violations.push(`scene_order: paragraph boundary changed at line ${index + 1}`);
      continue;
    }

    const leftSeparator = isSceneSeparator(left);
    const rightSeparator = isSceneSeparator(right);
    if (leftSeparator || rightSeparator) {
      if (!leftSeparator || !rightSeparator || normalizeSeparator(left) !== normalizeSeparator(right)) {
        violations.push(`scene_order: scene separator changed at line ${index + 1}`);
      }
      continue;
    }

    if (DIALOGUE_LINE_RE.test(left) !== DIALOGUE_LINE_RE.test(right)) {
      violations.push(`dialogue_meaning: dialogue position changed at line ${index + 1}`);
    }
  }

  return violations;
}

function sameSequence(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function validateDeterministic(
  original: string,
  candidate: string,
  protectedTerms: string[],
): DeterministicValidation {
  const violations = validateLineStructure(original, candidate);

  if (!candidate.trim()) {
    return { passed: false, violations: ["deletion: empty candidate"] };
  }

  const originalNumbers = extractNumericTokens(original);
  const candidateNumbers = extractNumericTokens(candidate);
  if (!sameSequence(originalNumbers, candidateNumbers)) {
    violations.push("number/date: numeric token sequence changed");
  }

  for (const term of [...new Set(protectedTerms.filter(Boolean))]) {
    if (countLiteral(original, term) !== countLiteral(candidate, term)) {
      violations.push(`proper_noun: protected term count changed: ${term}`);
    }
  }

  const ratio = candidate.length / Math.max(1, original.length);
  if (ratio < 0.7) violations.push("deletion: candidate is materially shorter than locked source");
  if (ratio > 1.3) violations.push("addition: candidate is materially longer than locked source");

  return { passed: violations.length === 0, violations };
}
