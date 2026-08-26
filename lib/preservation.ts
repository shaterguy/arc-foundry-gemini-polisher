import { createHash } from "node:crypto";
import { extractSceneSeparators } from "./blocks.js";

const NUMERIC_TOKEN_RE = /(?:\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}:\d{2}(?::\d{2})?|[+-]?\d+(?:,\d{3})*(?:\.\d+)?(?:\s?(?:%|퍼센트|원|만원|억원|조원|년|개월|월|일|시|분|초|명|개|회|층|km|m|cm|mm|kg|g|℃|°C))?)/gu;

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

  const originalSeparators = extractSceneSeparators(original);
  const candidateSeparators = extractSceneSeparators(candidate);
  if (!sameSequence(originalSeparators, candidateSeparators)) {
    violations.push("scene_order: scene separator sequence changed");
  }

  const originalNumbers = extractNumericTokens(original);
  const candidateNumbers = extractNumericTokens(candidate);
  if (!sameSequence(originalNumbers, candidateNumbers)) {
    violations.push("number/date: numeric token sequence changed");
  }

  for (const term of [...new Set(protectedTerms.filter(Boolean))]) {
    const originalCount = countLiteral(original, term);
    if (originalCount > 0 && countLiteral(candidate, term) === 0) {
      violations.push(`proper_noun: protected term missing: ${term}`);
    }
  }

  return { passed: violations.length === 0, violations };
}
