import { buildLockedLayout, reconstructCandidate } from "./blocks";
import { createGeminiProvider, getMaxPolishAttempts, getRuntimeModels, type PolishProvider } from "./gemini";
import { sha256, validateDeterministic } from "./preservation";
import { PROTECTED_MANIFEST_SOURCE, type PolishInput, type PolishResult } from "./types";

export interface PolishOptions {
  maxAttempts?: number;
}

function fallback(
  input: PolishInput,
  reason: PolishResult["reason"],
  model: string,
  validatorModel: string,
  attempts: number,
  deterministicPassed: boolean,
  semanticPassed: boolean,
  violations: string[],
): PolishResult {
  return {
    status: "fallback_original",
    reason,
    final_text: input.locked_text,
    lock_sha256: sha256(input.locked_text),
    model,
    validator_model: validatorModel,
    attempts,
    validation: {
      deterministic_passed: deterministicPassed,
      semantic_passed: semanticPassed,
      violations,
    },
  };
}

function protectedTermsOrNull(input: PolishInput): string[] | null {
  const manifest = input.protected_manifest;
  if (!manifest || manifest.source !== PROTECTED_MANIFEST_SOURCE || !Array.isArray(manifest.terms)) return null;
  const terms = manifest.terms.map((term) => term.trim());
  if (terms.length === 0 || terms.some((term) => term.length === 0 || term.length > 100)) return null;
  if (new Set(terms).size !== terms.length) return null;
  return terms;
}

export async function polishLockedText(
  input: PolishInput,
  provider?: PolishProvider,
  options: PolishOptions = {},
): Promise<PolishResult> {
  const runtimeModels = getRuntimeModels();
  const protectedTerms = protectedTermsOrNull(input);
  if (!protectedTerms) {
    return fallback(input, "configuration_failure", runtimeModels.model, runtimeModels.validatorModel, 0, false, false, ["protected manifest missing or invalid"]);
  }

  const layout = buildLockedLayout(input.locked_text);
  if (layout.editable_blocks.length === 0) {
    return fallback(input, "configuration_failure", runtimeModels.model, runtimeModels.validatorModel, 0, false, false, ["locked source has no editable blocks"]);
  }

  let activeProvider = provider;
  if (!activeProvider) {
    try {
      activeProvider = createGeminiProvider();
    } catch {
      return fallback(input, "configuration_failure", runtimeModels.model, runtimeModels.validatorModel, 0, false, false, ["provider configuration unavailable"]);
    }
  }

  const maxAttempts = Math.min(3, Math.max(1, options.maxAttempts ?? getMaxPolishAttempts()));
  let rejectionNotes: string[] = [];
  let latestViolations: string[] = [];
  let deterministicPassed = false;
  let semanticPassed = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let candidate: string;
    try {
      const polishedBlocks = await activeProvider.polish(input, rejectionNotes);
      candidate = reconstructCandidate(layout, polishedBlocks);
    } catch (error) {
      const message = error instanceof Error && error.message.startsWith("block_manifest_")
        ? `scene_order: ${error.message}`
        : "Gemini polish request failed";
      if (message.startsWith("scene_order:")) {
        latestViolations = [message];
        rejectionNotes = latestViolations;
        continue;
      }
      return fallback(input, "provider_failure", activeProvider.model, activeProvider.validatorModel, attempt, false, false, [message]);
    }

    const deterministic = validateDeterministic(input.locked_text, candidate, protectedTerms);
    deterministicPassed = deterministic.passed;
    if (!deterministic.passed) {
      latestViolations = deterministic.violations;
      rejectionNotes = deterministic.violations;
      continue;
    }

    let semantic;
    try {
      semantic = await activeProvider.validate(input.locked_text, candidate, protectedTerms);
    } catch {
      return fallback(input, "provider_failure", activeProvider.model, activeProvider.validatorModel, attempt, true, false, ["Gemini validation request failed"]);
    }

    semanticPassed = semantic.preserved && semantic.violations.length === 0;
    if (!semanticPassed) {
      latestViolations = semantic.violations.map((item) => `${item.category}: ${item.explanation}`);
      rejectionNotes = latestViolations;
      continue;
    }

    return {
      status: "accepted",
      reason: "accepted",
      final_text: candidate,
      lock_sha256: sha256(input.locked_text),
      model: activeProvider.model,
      validator_model: activeProvider.validatorModel,
      attempts: attempt,
      validation: {
        deterministic_passed: true,
        semantic_passed: true,
        violations: [],
      },
    };
  }

  return fallback(input, "validation_failed", activeProvider.model, activeProvider.validatorModel, maxAttempts, deterministicPassed, semanticPassed, latestViolations);
}
