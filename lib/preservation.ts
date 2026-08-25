import { createHash } from "node:crypto";

const NUMERIC_TOKEN_RE = /(?:\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}:\d{2}(?::\d{2})?|[+-]?\d+(?:,\d{3})*(?:\.\d+)?(?:\s?(?:%|퍼센트|원|만원|억원|조원|년|개월|월|일|시|분|초|명|개|회|층|km|m|cm|mm|kg|g|℃|°C))?)/gu;
const DIALOGUE_LINE_RE = /^[\s]*["“‘'「『].+["”’'」』][.!?…~]*[\s]*$/u;
const SCENE_SEPARATOR_RE = /^[\s]*(?:\*{3,}|-{3,}|_{3,}|#{3,}|[◆◇◈※]+)[\s]*$/u;

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

function countDialogueLines(text: string): number {
  return text.split(/\r?\n/u).filter((line) => DIALOGUE_LINE_RE.test(line)).length;
}

function extractSceneSeparators(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .filter((line) => SCENE_SEPARATOR_RE.test(line))
    .map((line) => line.trim().replace(/\s+/gu, ""));
}

function sameSequence(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function validateDeterministic(
  original: string,
  candidate: string,
  protectedTerms: string[],
): DeterministicValidation {
  const violations: string[] = [];

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

  if (countDialogueLines(original) !== countDialogueLines(candidate)) {
    violations.push("dialogue_meaning: dialogue block count changed");
  }

  const originalSeparators = extractSceneSeparators(original);
  const candidateSeparators = extractSceneSeparators(candidate);
  if (!sameSequence(originalSeparators, candidateSeparators)) {
    violations.push("scene_order: explicit scene separator sequence changed");
  }

  const ratio = candidate.length / Math.max(1, original.length);
  if (ratio < 0.7) violations.push("deletion: candidate is materially shorter than locked source");
  if (ratio > 1.3) violations.push("addition: candidate is materially longer than locked source");

  return { passed: violations.length === 0, violations };
}
