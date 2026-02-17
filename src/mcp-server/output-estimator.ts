import { loadMetrics, type CompletionEntry, type AnyMetricsEntry } from './metrics.js';

// Heuristic baselines: expected output tokens per tool × complexity level
// Format: tool → { complexityLevel → baselineTokens }
const BASELINES: Record<string, Record<number, number>> = {
  claudesaver_complete: {
    1: 150,
    2: 300,
    3: 500,
    4: 800,
    5: 1200,
    6: 2000,
  },
  claudesaver_generate_code: {
    1: 200,
    2: 400,
    3: 700,
    4: 1000,
    5: 1500,
    6: 2500,
  },
  claudesaver_analyze_file: {
    1: 200,
    2: 350,
    3: 600,
    4: 900,
    5: 1300,
    6: 2000,
  },
};

const BUFFER_RATIO = 0.25;
const MIN_HISTORY_ENTRIES = 3;

export interface OutputEstimate {
  estimated_tokens: number;
  source: 'historical' | 'heuristic';
  confidence: number;
  sample_size: number;
}

export function estimateOutputTokens(
  tool: string,
  complexityLevel: number,
  metrics?: AnyMetricsEntry[]
): OutputEstimate {
  // Try historical average first
  const entries = metrics ?? loadMetrics();
  const relevantEntries = entries.filter(
    (e): e is CompletionEntry =>
      e.type === 'completion' &&
      (e as CompletionEntry).tool === tool
  );

  if (relevantEntries.length >= MIN_HISTORY_ENTRIES) {
    const tokenValues = relevantEntries
      .map(e => e.output_tokens ?? e.tokens_used)
      .filter(t => t > 0);

    if (tokenValues.length >= MIN_HISTORY_ENTRIES) {
      const avg = tokenValues.reduce((sum, t) => sum + t, 0) / tokenValues.length;
      const withBuffer = Math.ceil(avg * (1 + BUFFER_RATIO));

      return {
        estimated_tokens: withBuffer,
        source: 'historical',
        confidence: Math.min(0.9, 0.5 + tokenValues.length * 0.05),
        sample_size: tokenValues.length,
      };
    }
  }

  // Fall back to heuristic baselines
  const toolBaselines = BASELINES[tool] ?? BASELINES['claudesaver_complete'];
  const clampedLevel = Math.max(1, Math.min(6, complexityLevel));
  const baseline = toolBaselines[clampedLevel] ?? 300;
  const withBuffer = Math.ceil(baseline * (1 + BUFFER_RATIO));

  return {
    estimated_tokens: withBuffer,
    source: 'heuristic',
    confidence: 0.4,
    sample_size: 0,
  };
}

export function shouldUseLightBudget(estimate: OutputEstimate, lightMaxTokens: number): boolean {
  return estimate.estimated_tokens <= lightMaxTokens;
}
