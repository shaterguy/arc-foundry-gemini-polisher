export const PROTECTED_MANIFEST_SOURCE = "arc-foundry-final-lock" as const;

export const VIOLATION_CATEGORIES = [
  "event",
  "scene_order",
  "setting",
  "character_intent",
  "relationship",
  "dialogue_meaning",
  "emotion_intensity",
  "pov",
  "tense",
  "proper_noun",
  "number",
  "date",
  "fact",
  "foreshadowing",
  "addition",
  "deletion",
] as const;

export type ViolationCategory = (typeof VIOLATION_CATEGORIES)[number];

export interface ProtectedManifest {
  source: typeof PROTECTED_MANIFEST_SOURCE;
  terms: string[];
}

export interface PolishInput {
  locked_text: string;
  before_context?: string;
  after_context?: string;
  style_rules?: string;
  protected_manifest: ProtectedManifest;
  unit_id?: string;
}

export interface EditableBlock {
  block_id: string;
  source_text: string;
}

export interface PolishedBlock {
  block_id: string;
  polished_text: string;
}

export interface SemanticViolation {
  category: ViolationCategory;
  explanation: string;
}

export interface SemanticValidation {
  preserved: boolean;
  violations: SemanticViolation[];
  summary: string;
}

export interface ValidationSummary {
  deterministic_passed: boolean;
  semantic_passed: boolean;
  violations: string[];
}

export interface PolishResult {
  status: "accepted" | "fallback_original";
  reason: "accepted" | "validation_failed" | "provider_failure" | "configuration_failure";
  final_text: string;
  lock_sha256: string;
  model: string;
  validator_model: string;
  attempts: number;
  validation: ValidationSummary;
}
