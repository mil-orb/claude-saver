import { describe, it, expect } from 'vitest';
import {
  estimateOutputTokens,
  shouldUseLightBudget,
  type OutputEstimate,
} from '../src/mcp-server/output-estimator.js';
import type { AnyMetricsEntry, CompletionEntry } from '../src/mcp-server/metrics.js';

// ---------------------------------------------------------------------------
// Helper to build CompletionEntry fixtures
// ---------------------------------------------------------------------------
function makeEntry(
  tool: string,
  tokens_used: number,
  output_tokens?: number
): CompletionEntry {
  return {
    type: 'completion',
    timestamp: new Date().toISOString(),
    tokens_used,
    model: 'test-model',
    duration_ms: 250,
    tool,
    session_id: 'test-session',
    ...(output_tokens !== undefined ? { output_tokens } : {}),
  };
}

function makeEntries(
  tool: string,
  tokenValues: number[],
  useOutputTokens = false
): AnyMetricsEntry[] {
  return tokenValues.map(v =>
    useOutputTokens ? makeEntry(tool, v * 2, v) : makeEntry(tool, v)
  );
}

// ---------------------------------------------------------------------------
// 1. Heuristic fallback
// ---------------------------------------------------------------------------
describe('estimateOutputTokens — heuristic fallback', () => {
  it('claudesaver_complete level 1 → 150 * 1.25 = 188', () => {
    const result = estimateOutputTokens('claudesaver_complete', 1, []);
    expect(result.estimated_tokens).toBe(Math.ceil(150 * 1.25));
    expect(result.source).toBe('heuristic');
  });

  it('claudesaver_complete level 3 → 500 * 1.25 = 625', () => {
    const result = estimateOutputTokens('claudesaver_complete', 3, []);
    expect(result.estimated_tokens).toBe(Math.ceil(500 * 1.25));
    expect(result.source).toBe('heuristic');
  });

  it('claudesaver_complete level 6 → 2000 * 1.25 = 2500', () => {
    const result = estimateOutputTokens('claudesaver_complete', 6, []);
    expect(result.estimated_tokens).toBe(Math.ceil(2000 * 1.25));
    expect(result.source).toBe('heuristic');
  });

  it('claudesaver_generate_code level 4 → 1000 * 1.25 = 1250', () => {
    const result = estimateOutputTokens('claudesaver_generate_code', 4, []);
    expect(result.estimated_tokens).toBe(Math.ceil(1000 * 1.25));
    expect(result.source).toBe('heuristic');
  });

  it('claudesaver_analyze_file level 2 → 350 * 1.25 = 438', () => {
    const result = estimateOutputTokens('claudesaver_analyze_file', 2, []);
    expect(result.estimated_tokens).toBe(Math.ceil(350 * 1.25));
    expect(result.source).toBe('heuristic');
  });

  it('unknown tool falls back to claudesaver_complete baselines', () => {
    const unknown = estimateOutputTokens('unknown_tool_xyz', 3, []);
    const fallback = estimateOutputTokens('claudesaver_complete', 3, []);
    expect(unknown.estimated_tokens).toBe(fallback.estimated_tokens);
    expect(unknown.source).toBe('heuristic');
  });

  it('level 0 is clamped to 1 — uses level-1 baseline', () => {
    const clamped = estimateOutputTokens('claudesaver_complete', 0, []);
    const level1 = estimateOutputTokens('claudesaver_complete', 1, []);
    expect(clamped.estimated_tokens).toBe(level1.estimated_tokens);
  });

  it('level 7 is clamped to 6 — uses level-6 baseline', () => {
    const clamped = estimateOutputTokens('claudesaver_complete', 7, []);
    const level6 = estimateOutputTokens('claudesaver_complete', 6, []);
    expect(clamped.estimated_tokens).toBe(level6.estimated_tokens);
  });
});

// ---------------------------------------------------------------------------
// 2. Historical average
// ---------------------------------------------------------------------------
describe('estimateOutputTokens — historical average', () => {
  it('3 or more matching entries triggers historical source', () => {
    const entries = makeEntries('claudesaver_complete', [400, 600, 800]);
    const result = estimateOutputTokens('claudesaver_complete', 3, entries);
    expect(result.source).toBe('historical');
  });

  it('fewer than 3 entries falls back to heuristic', () => {
    const entries = makeEntries('claudesaver_complete', [400, 600]);
    const result = estimateOutputTokens('claudesaver_complete', 3, entries);
    expect(result.source).toBe('heuristic');
  });

  it('1 entry falls back to heuristic', () => {
    const entries = makeEntries('claudesaver_complete', [900]);
    const result = estimateOutputTokens('claudesaver_complete', 3, entries);
    expect(result.source).toBe('heuristic');
  });

  it('historical average uses output_tokens field when present', () => {
    // tokens_used is 2x the value; output_tokens is the real value
    const entries = makeEntries('claudesaver_complete', [200, 400, 600], true);
    const result = estimateOutputTokens('claudesaver_complete', 3, entries);
    // avg output_tokens = (200 + 400 + 600) / 3 = 400; with 25% buffer = 500
    expect(result.estimated_tokens).toBe(Math.ceil(400 * 1.25));
    expect(result.source).toBe('historical');
  });

  it('historical average uses tokens_used when output_tokens is absent', () => {
    const entries = makeEntries('claudesaver_complete', [200, 400, 600]);
    const result = estimateOutputTokens('claudesaver_complete', 3, entries);
    // avg tokens_used = 400; with 25% buffer = 500
    expect(result.estimated_tokens).toBe(Math.ceil(400 * 1.25));
    expect(result.source).toBe('historical');
  });

  it('applies 25% buffer to historical average', () => {
    const entries = makeEntries('claudesaver_complete', [100, 100, 100]);
    const result = estimateOutputTokens('claudesaver_complete', 3, entries);
    // avg = 100; 100 * 1.25 = 125
    expect(result.estimated_tokens).toBe(125);
  });

  it('only uses entries matching the requested tool', () => {
    const wrongTool = makeEntries('claudesaver_generate_code', [9999, 9999, 9999]);
    const rightTool = makeEntries('claudesaver_complete', [100, 100, 100]);
    const result = estimateOutputTokens('claudesaver_complete', 3, [
      ...wrongTool,
      ...rightTool,
    ]);
    // Should only average the claudesaver_complete entries
    expect(result.estimated_tokens).toBe(Math.ceil(100 * 1.25));
    expect(result.source).toBe('historical');
  });

  it('confidence scales with sample size — 10 entries yields higher confidence than 3', () => {
    const small = makeEntries('claudesaver_complete', [300, 300, 300]);
    const large = makeEntries(
      'claudesaver_complete',
      Array(10).fill(300)
    );
    const smallResult = estimateOutputTokens('claudesaver_complete', 3, small);
    const largeResult = estimateOutputTokens('claudesaver_complete', 3, large);
    expect(largeResult.confidence).toBeGreaterThan(smallResult.confidence);
  });
});

// ---------------------------------------------------------------------------
// 3. shouldUseLightBudget
// ---------------------------------------------------------------------------
describe('shouldUseLightBudget', () => {
  it('estimate below budget returns true', () => {
    const estimate: OutputEstimate = {
      estimated_tokens: 400,
      source: 'heuristic',
      confidence: 0.4,
      sample_size: 0,
    };
    expect(shouldUseLightBudget(estimate, 500)).toBe(true);
  });

  it('estimate above budget returns false', () => {
    const estimate: OutputEstimate = {
      estimated_tokens: 600,
      source: 'heuristic',
      confidence: 0.4,
      sample_size: 0,
    };
    expect(shouldUseLightBudget(estimate, 500)).toBe(false);
  });

  it('estimate exactly at budget returns true (boundary inclusive)', () => {
    const estimate: OutputEstimate = {
      estimated_tokens: 500,
      source: 'heuristic',
      confidence: 0.4,
      sample_size: 0,
    };
    expect(shouldUseLightBudget(estimate, 500)).toBe(true);
  });

  it('zero budget causes any positive estimate to return false', () => {
    const estimate: OutputEstimate = {
      estimated_tokens: 1,
      source: 'heuristic',
      confidence: 0.4,
      sample_size: 0,
    };
    expect(shouldUseLightBudget(estimate, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Source and confidence
// ---------------------------------------------------------------------------
describe('estimateOutputTokens — source and confidence', () => {
  it('heuristic path always returns confidence 0.4', () => {
    const result = estimateOutputTokens('claudesaver_complete', 3, []);
    expect(result.confidence).toBe(0.4);
  });

  it('heuristic path always returns sample_size 0', () => {
    const result = estimateOutputTokens('claudesaver_generate_code', 5, []);
    expect(result.sample_size).toBe(0);
  });

  it('historical path with exactly 3 entries has lower confidence than 8 entries', () => {
    const three = makeEntries('claudesaver_complete', [500, 500, 500]);
    const eight = makeEntries('claudesaver_complete', Array(8).fill(500));
    const r3 = estimateOutputTokens('claudesaver_complete', 3, three);
    const r8 = estimateOutputTokens('claudesaver_complete', 3, eight);
    expect(r3.confidence).toBeLessThan(r8.confidence);
  });

  it('historical confidence is capped at 0.9 regardless of sample size', () => {
    const many = makeEntries('claudesaver_complete', Array(100).fill(300));
    const result = estimateOutputTokens('claudesaver_complete', 3, many);
    expect(result.confidence).toBeLessThanOrEqual(0.9);
    expect(result.source).toBe('historical');
  });
});
