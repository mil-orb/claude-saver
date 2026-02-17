import { matchPatterns, type CostOfWrong } from './patterns.js';
import { extractSignals, computeComplexityScore, scoreToLevel } from './signals.js';
import { triageWithLocalModel } from './triage.js';
import { loadConfig } from './config.js';
import { getRecommendation } from './learner.js';

export type RouteDecision = 'no_llm' | 'local' | 'cloud';
export type EscalationPolicy = 'none' | 'immediate' | 'standard' | 'tolerant' | 'minimal' | 'never';

export interface RoutingDecision {
  route: RouteDecision;
  delegation_level: 0 | 1 | 2 | 3 | 4 | 5;
  task_complexity: number;
  confidence: number;
  reason: string;
  classification_layer: 'level_gate' | 1 | 2 | 3;
  suggested_model?: string;
  specialist_key?: string;
  cost_of_wrong?: CostOfWrong;
  escalation_policy: EscalationPolicy;
}

export interface LevelConfig {
  ceiling: number;
  escalation: EscalationPolicy;
  skipClassification: boolean;
  tryLocalFirst: boolean;
}

export const LEVEL_CONFIGS: Record<number, LevelConfig> = {
  0: { ceiling: -1, escalation: 'none', skipClassification: true, tryLocalFirst: false },
  1: { ceiling: 2, escalation: 'immediate', skipClassification: false, tryLocalFirst: false },
  2: { ceiling: 3, escalation: 'standard', skipClassification: false, tryLocalFirst: false },
  3: { ceiling: 5, escalation: 'tolerant', skipClassification: false, tryLocalFirst: true },
  4: { ceiling: 6, escalation: 'minimal', skipClassification: false, tryLocalFirst: true },
  5: { ceiling: 6, escalation: 'never', skipClassification: true, tryLocalFirst: true },
};

// Model capability ladder — maps task complexity level to minimum model size
const MODEL_LADDER: Record<number, string> = {
  0: 'none',        // No LLM needed
  1: '1b-3b',       // Micro: docstrings, commits, formatting
  2: '7b-8b',       // Small: test scaffolds, format conversion
  3: '12b-32b',     // Medium: CRUD, utility functions
  4: '32b-70b',     // Large: complex code gen
  5: 'cloud-sonnet', // Cloud Sonnet
  6: 'cloud-opus',  // Cloud Opus
};

export async function classifyTask(
  taskDescription: string,
  options?: { delegationLevel?: number }
): Promise<RoutingDecision> {
  const config = loadConfig();
  const level = options?.delegationLevel ?? config.delegation_level;
  const levelConfig = LEVEL_CONFIGS[level] ?? LEVEL_CONFIGS[2];

  // ── LEVEL GATE ──
  if (level === 0) {
    return {
      route: 'cloud',
      delegation_level: 0,
      task_complexity: 0,
      confidence: 1.0,
      reason: 'Level 0 (Off) — manual delegation only',
      classification_layer: 'level_gate',
      escalation_policy: 'none',
    };
  }

  if (level === 5) {
    return {
      route: 'local',
      delegation_level: 5,
      task_complexity: 0,
      confidence: 1.0,
      reason: 'Level 5 (Offline) — all tasks routed local',
      classification_layer: 'level_gate',
      escalation_policy: 'never',
    };
  }

  // ── LAYER 1: Static Pattern Matching ──
  const patternResult = matchPatterns(taskDescription);

  if (patternResult.matched) {
    const rule = patternResult.rule;

    // Check if task complexity exceeds level ceiling
    if (rule.level > levelConfig.ceiling) {
      return {
        route: 'cloud',
        delegation_level: level as 0 | 1 | 2 | 3 | 4 | 5,
        task_complexity: rule.level,
        confidence: patternResult.confidence,
        reason: `Pattern matched "${patternResult.matchedPattern}" (Level ${rule.level}) exceeds ceiling (${levelConfig.ceiling})`,
        classification_layer: 1,
        cost_of_wrong: rule.cost_of_wrong,
        specialist_key: rule.category,
        escalation_policy: levelConfig.escalation,
      };
    }

    // Route based on pattern
    const route: RouteDecision = rule.route === 'cloud_recommended' ? 'cloud' : rule.route;
    return {
      route,
      delegation_level: level as 0 | 1 | 2 | 3 | 4 | 5,
      task_complexity: rule.level,
      confidence: patternResult.confidence,
      reason: `Pattern matched "${patternResult.matchedPattern}" → ${route}`,
      classification_layer: 1,
      suggested_model: MODEL_LADDER[rule.level],
      cost_of_wrong: rule.cost_of_wrong,
      specialist_key: rule.category,
      escalation_policy: levelConfig.escalation,
    };
  }

  // ── LAYER 2: Signal Extraction ──
  const signals = extractSignals(taskDescription);
  const score = computeComplexityScore(signals);
  const complexityLevel = scoreToLevel(score);

  // Ambiguous zone — try Layer 3 if enabled
  if (score >= 0.50 && score <= 0.65 && config.routing.use_local_triage) {
    // ── LAYER 3: Local Model Triage ──
    const triageResult = await triageWithLocalModel(taskDescription);
    const triageLevel = triageResult.level;

    if (triageLevel > levelConfig.ceiling) {
      return {
        route: 'cloud',
        delegation_level: level as 0 | 1 | 2 | 3 | 4 | 5,
        task_complexity: triageLevel,
        confidence: triageResult.confidence,
        reason: `Triage classified as Level ${triageLevel}, exceeds ceiling (${levelConfig.ceiling})`,
        classification_layer: 3,
        cost_of_wrong: signals.cost_of_wrong,
        escalation_policy: levelConfig.escalation,
      };
    }

    return {
      route: triageLevel === 0 ? 'no_llm' : 'local',
      delegation_level: level as 0 | 1 | 2 | 3 | 4 | 5,
      task_complexity: triageLevel,
      confidence: triageResult.confidence,
      reason: `Triage classified as Level ${triageLevel} → local`,
      classification_layer: 3,
      suggested_model: MODEL_LADDER[triageLevel],
      cost_of_wrong: signals.cost_of_wrong,
      escalation_policy: levelConfig.escalation,
    };
  }

  // ── LAYER 5: Historical Learning ──
  // Apply learner adjustment to the proposed level from Layer 2.
  // The learner checks success rates for this task type at the proposed level
  // and may suggest a different level or adjust confidence.
  // Use output_type as task type key since pattern-based specialist_key isn't available at Layer 2.
  const taskType = signals.output_type;
  const recommendation = getRecommendation(taskType, complexityLevel);

  const effectiveLevel = recommendation.adjusted_level ?? complexityLevel;
  const effectiveConfidence = Math.min(1, Math.max(0.1, 0.6 + recommendation.confidence_adjustment));

  // Apply ceiling check with potentially adjusted level
  if (effectiveLevel > levelConfig.ceiling) {
    return {
      route: 'cloud',
      delegation_level: level as 0 | 1 | 2 | 3 | 4 | 5,
      task_complexity: effectiveLevel,
      confidence: effectiveConfidence,
      reason: recommendation.sample_size > 0
        ? `Heuristic score ${score.toFixed(2)} → Level ${complexityLevel}, adjusted to ${effectiveLevel} by learner (${recommendation.reason}), exceeds ceiling (${levelConfig.ceiling})`
        : `Heuristic score ${score.toFixed(2)} → Level ${complexityLevel}, exceeds ceiling (${levelConfig.ceiling})`,
      classification_layer: 2,
      cost_of_wrong: signals.cost_of_wrong,
      escalation_policy: levelConfig.escalation,
    };
  }

  return {
    route: effectiveLevel === 0 ? 'no_llm' : 'local',
    delegation_level: level as 0 | 1 | 2 | 3 | 4 | 5,
    task_complexity: effectiveLevel,
    confidence: effectiveConfidence,
    reason: recommendation.sample_size > 0
      ? `Heuristic score ${score.toFixed(2)} → Level ${complexityLevel}, adjusted to ${effectiveLevel} by learner (${recommendation.reason}) → local`
      : `Heuristic score ${score.toFixed(2)} → Level ${complexityLevel} → local`,
    classification_layer: 2,
    suggested_model: MODEL_LADDER[effectiveLevel],
    cost_of_wrong: signals.cost_of_wrong,
    escalation_policy: levelConfig.escalation,
  };
}
