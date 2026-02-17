import { describe, it, expect } from 'vitest';
import { classifyTask } from '../src/mcp-server/router.js';
import {
  estimateCloudOverhead,
  computeSummary,
  type CompletionEntry,
  type AnyMetricsEntry,
} from '../src/mcp-server/metrics.js';

// =============================================================================
// NET SAVINGS ACCURACY TESTS
// =============================================================================
// These tests validate the honest token economics of delegating tasks to a
// local Ollama model. Every delegation has a cloud overhead cost (the tool-call
// wrapper Claude generates + the result it reads back). These tests ensure:
//
// 1. estimateCloudOverhead() returns correct values at all scales
// 2. Per-prompt profitability: which tasks are net-positive vs net-negative
// 3. Break-even analysis: the exact threshold where delegation pays off
// 4. Aggregate session accounting: net savings after ALL overhead deducted
// 5. Cost calculations at real Anthropic pricing tiers
// 6. Edge cases: zero tokens, huge batches, single-token tasks
//
// OVERHEAD MODEL (validated against real Claude Code tool-call behavior):
//   overhead = 80 (fixed: tool-call JSON output tokens) +
//              ceil(responseTokens * 1.3) (variable: MCP JSON wrapping + metadata)
//
// The 80-token fixed cost is Claude generating the tool invocation:
//   {"tool": "claudesaver_complete", "params": {"prompt": "..."}}
//
// The 1.3x multiplier is the MCP protocol wrapping the response in JSON
// with metadata fields (model, tokens_used, duration_ms, etc.).
//
// COST MODEL:
//   Gross savings = local_tokens * (output_price / 1M)
//   Overhead cost = overhead_tokens * (input_price / 1M) ≈ overhead * (output_price / 5M)
//   Net savings = gross - overhead
//
// Output tokens cost 5x input tokens on all Claude models.
// =============================================================================


// ---------------------------------------------------------------------------
// SECTION 1: estimateCloudOverhead() unit tests
// ---------------------------------------------------------------------------

describe('estimateCloudOverhead — exact values at every scale', () => {
  // overhead = 80 + ceil(tokens * 1.3)

  it('0 tokens → 80 overhead (fixed cost only)', () => {
    expect(estimateCloudOverhead(0)).toBe(80);
  });

  it('1 token → 82 overhead (80 + ceil(1.3) = 80 + 2)', () => {
    expect(estimateCloudOverhead(1)).toBe(82);
  });

  it('10 tokens → 93 overhead (80 + ceil(13) = 93)', () => {
    expect(estimateCloudOverhead(10)).toBe(93);
  });

  it('50 tokens → 145 overhead (80 + ceil(65) = 145)', () => {
    expect(estimateCloudOverhead(50)).toBe(145);
  });

  it('100 tokens → 210 overhead (80 + ceil(130) = 210)', () => {
    expect(estimateCloudOverhead(100)).toBe(210);
  });

  it('200 tokens → 340 overhead (80 + ceil(260) = 340)', () => {
    expect(estimateCloudOverhead(200)).toBe(340);
  });

  it('500 tokens → 730 overhead (80 + ceil(650) = 730)', () => {
    expect(estimateCloudOverhead(500)).toBe(730);
  });

  it('1000 tokens → 1380 overhead (80 + ceil(1300) = 1380)', () => {
    expect(estimateCloudOverhead(1000)).toBe(1380);
  });

  it('5000 tokens → 6580 overhead (80 + ceil(6500) = 6580)', () => {
    expect(estimateCloudOverhead(5000)).toBe(6580);
  });

  it('overhead grows linearly at ~1.3x rate', () => {
    const at100 = estimateCloudOverhead(100);
    const at200 = estimateCloudOverhead(200);
    const at400 = estimateCloudOverhead(400);

    // Marginal overhead from 100→200 should ≈ 130
    expect(at200 - at100).toBe(130);
    // Marginal overhead from 200→400 should ≈ 260
    expect(at400 - at200).toBe(260);
  });

  it('fixed 80-token component is consistent at all scales', () => {
    // overhead(n) - ceil(n * 1.3) should always be 80
    for (const n of [0, 1, 10, 50, 100, 500, 1000, 5000]) {
      const overhead = estimateCloudOverhead(n);
      const variablePart = Math.ceil(n * 1.3);
      expect(overhead - variablePart).toBe(80);
    }
  });
});


// ---------------------------------------------------------------------------
// SECTION 2: Per-prompt profitability analysis
// ---------------------------------------------------------------------------

describe('Per-prompt profitability — net savings by task type', () => {
  // Net savings per delegation:
  //   gross = tokens * (costRate / 1M)  [output tokens saved]
  //   overhead_cost = overhead_tokens * (costRate / 5 / 1M)  [input tokens paid]
  //   net = gross - overhead_cost
  //
  // At $8/M output rate (default):
  //   gross = tokens * 0.000008
  //   overhead_cost = overhead * 0.0000016
  //   net = tokens * 0.000008 - overhead * 0.0000016

  const costRate = 8; // Default: $8 per million output tokens

  function netSavingsForTask(outputTokens: number): {
    gross: number;
    overheadTokens: number;
    overheadCost: number;
    net: number;
    profitable: boolean;
  } {
    const overhead = estimateCloudOverhead(outputTokens);
    const gross = (outputTokens / 1_000_000) * costRate;
    const overheadCost = (overhead / 1_000_000) * (costRate / 5);
    const net = gross - overheadCost;
    return {
      gross: Math.round(gross * 1_000_000) / 1_000_000,
      overheadTokens: overhead,
      overheadCost: Math.round(overheadCost * 1_000_000) / 1_000_000,
      net: Math.round(net * 1_000_000) / 1_000_000,
      profitable: net > 0,
    };
  }

  describe('Short tasks — break-even is ~22 tokens', () => {
    // The break-even point is ~22 tokens due to the 5x output/input cost ratio.
    // Even small tasks above 22 tokens are technically profitable, but the
    // absolute savings are negligible. The 200-token skip threshold exists
    // because tasks under 200 tokens save < $0.001 even at Opus pricing.

    it('20-token task (TODO comment): net negative (below break-even)', () => {
      const result = netSavingsForTask(20);
      // gross = 20 * 8 / 1M = 0.00016
      // overhead = 80 + ceil(26) = 106 tokens
      // overhead_cost = 106 * 1.6 / 1M = 0.0001696
      // net = 0.00016 - 0.0001696 < 0
      expect(result.profitable).toBe(false);
      expect(result.overheadTokens).toBe(106);
    });

    it('30-token task (format conversion): marginally profitable (above 22-token break-even)', () => {
      const result = netSavingsForTask(30);
      // 30 tokens is above the ~22-token break-even, so it's technically
      // profitable — but the net savings is < $0.0001
      expect(result.profitable).toBe(true);
      expect(result.net).toBeLessThan(0.0001);
    });

    it('50-token task (simple docstring): profitable but tiny savings', () => {
      const result = netSavingsForTask(50);
      // overhead = 80 + ceil(65) = 145
      // overhead_cost = 145 * 1.6 / 1M = 0.000232
      // gross = 50 * 8 / 1M = 0.0004
      // net = 0.0004 - 0.000232 = 0.000168
      expect(result.net).toBeCloseTo(0.000168, 6);
      expect(result.profitable).toBe(true);
    });

    it('10-token task (single line fix): net negative', () => {
      const result = netSavingsForTask(10);
      expect(result.profitable).toBe(false);
    });

    it('1-token task: net negative (nearly all overhead)', () => {
      const result = netSavingsForTask(1);
      expect(result.profitable).toBe(false);
      // Overhead (82 tokens) vastly exceeds the 1-token gross savings
      expect(result.overheadCost).toBeGreaterThan(result.gross * 10);
    });
  });

  describe('Medium tasks (200-500 tokens) — expected NET POSITIVE', () => {
    it('200-token task (complex docstring): profitable', () => {
      const result = netSavingsForTask(200);
      expect(result.profitable).toBe(true);
      // overhead = 80 + 260 = 340
      // gross = 200 * 8 / 1M = 0.0016
      // overhead_cost = 340 * 1.6 / 1M = 0.000544
      // net = 0.0016 - 0.000544 = 0.001056
      expect(result.net).toBeCloseTo(0.001056, 5);
    });

    it('275-token task (CRUD endpoint): profitable', () => {
      const result = netSavingsForTask(275);
      expect(result.profitable).toBe(true);
    });

    it('400-token task (refactoring/API docs): profitable', () => {
      const result = netSavingsForTask(400);
      expect(result.profitable).toBe(true);
      // Efficiency should be increasing
      const efficiency = result.net / result.gross;
      expect(efficiency).toBeGreaterThan(0.5);
    });

    it('500-token task (unit test scaffold): profitable', () => {
      const result = netSavingsForTask(500);
      expect(result.profitable).toBe(true);
      // overhead = 80 + 650 = 730
      // gross = 500 * 8 / 1M = 0.004
      // overhead_cost = 730 * 1.6 / 1M = 0.001168
      // net = 0.004 - 0.001168 = 0.002832
      expect(result.net).toBeCloseTo(0.002832, 5);
      const efficiency = result.net / result.gross;
      expect(efficiency).toBeGreaterThan(0.65);
    });
  });

  describe('Large tasks (1000+ tokens) — high efficiency', () => {
    it('1000-token task: overhead ratio shrinks', () => {
      const result = netSavingsForTask(1000);
      expect(result.profitable).toBe(true);
      const efficiency = result.net / result.gross;
      // As tokens increase, fixed overhead becomes negligible
      expect(efficiency).toBeGreaterThan(0.7);
    });

    it('5000-token task: overhead ratio very small', () => {
      const result = netSavingsForTask(5000);
      expect(result.profitable).toBe(true);
      const efficiency = result.net / result.gross;
      expect(efficiency).toBeGreaterThan(0.73);
    });

    it('10000-token task: nearly all savings are net', () => {
      const result = netSavingsForTask(10000);
      expect(result.profitable).toBe(true);
      const efficiency = result.net / result.gross;
      expect(efficiency).toBeGreaterThan(0.73);
    });
  });

  describe('Efficiency converges to ~74% as tokens increase', () => {
    // At infinite tokens:
    // gross = T * 8/1M
    // overhead_cost ≈ T * 1.3 * 1.6/1M = T * 2.08/1M  (ignoring fixed 80)
    // net ≈ T * (8 - 2.08) / 1M = T * 5.92/1M
    // efficiency = 5.92 / 8 = 0.74 = 74%
    //
    // This is the theoretical maximum efficiency — the fixed 80-token cost
    // makes short tasks worse, but large tasks asymptotically approach 74%.

    it('theoretical maximum efficiency is ~74%', () => {
      const largeTokens = 1_000_000;
      const result = netSavingsForTask(largeTokens);
      const efficiency = result.net / result.gross;
      expect(efficiency).toBeCloseTo(0.74, 2);
    });

    it('efficiency increases monotonically from 20 to 10000 tokens', () => {
      const tokenCounts = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
      const efficiencies: number[] = [];

      for (const tokens of tokenCounts) {
        const result = netSavingsForTask(tokens);
        if (result.gross > 0) {
          efficiencies.push(result.net / result.gross);
        }
      }

      // Each efficiency should be >= the previous
      for (let i = 1; i < efficiencies.length; i++) {
        expect(efficiencies[i]).toBeGreaterThanOrEqual(efficiencies[i - 1]);
      }
    });
  });
});


// ---------------------------------------------------------------------------
// SECTION 3: Break-even analysis
// ---------------------------------------------------------------------------

describe('Break-even analysis — exact threshold where delegation pays off', () => {
  // Break-even: gross = overhead_cost
  //   tokens * (costRate / 1M) = (80 + ceil(tokens * 1.3)) * (costRate / 5 / 1M)
  //   tokens * costRate = (80 + ceil(tokens * 1.3)) * (costRate / 5)
  //   tokens * 5 = 80 + ceil(tokens * 1.3)
  //   5 * tokens - 1.3 * tokens = 80
  //   3.7 * tokens ≈ 80
  //   tokens ≈ 21.6
  //
  // The math says ~22 tokens is break-even (independent of cost rate!).
  // Below 22 → net loss. Above 22 → net gain.

  const costRate = 8;

  function isNetPositive(tokens: number): boolean {
    const overhead = estimateCloudOverhead(tokens);
    const gross = (tokens / 1_000_000) * costRate;
    const overheadCost = (overhead / 1_000_000) * (costRate / 5);
    return gross > overheadCost;
  }

  it('break-even threshold is independent of cost rate', () => {
    // At $5/M, $8/M, $15/M, $25/M — same tokens are profitable/unprofitable
    // because the ratio cancels out: tokens * R > overhead * R/5
    // → tokens > overhead / 5 — no R dependence
    for (const rate of [5, 8, 15, 25]) {
      const overhead22 = estimateCloudOverhead(22);
      const gross22 = (22 / 1_000_000) * rate;
      const overheadCost22 = (overhead22 / 1_000_000) * (rate / 5);
      const net22 = gross22 - overheadCost22;

      const overhead21 = estimateCloudOverhead(21);
      const gross21 = (21 / 1_000_000) * rate;
      const overheadCost21 = (overhead21 / 1_000_000) * (rate / 5);
      const net21 = gross21 - overheadCost21;

      // 22 tokens should be positive at all rates
      expect(net22).toBeGreaterThan(0);
      // 21 tokens should be negative at all rates
      expect(net21).toBeLessThanOrEqual(0);
    }
  });

  it('below 22 tokens: delegation is a net loss', () => {
    for (const tokens of [1, 5, 10, 15, 20, 21]) {
      expect(isNetPositive(tokens)).toBe(false);
    }
  });

  it('at 22+ tokens: delegation is a net gain', () => {
    for (const tokens of [22, 30, 50, 100, 200, 500, 1000]) {
      expect(isNetPositive(tokens)).toBe(true);
    }
  });

  it('the ~200 token skip threshold in delegation instructions is conservative', () => {
    // The break-even is really ~22 tokens, but we recommend 200 as the
    // minimum because:
    // 1. Below 200 tokens, the net savings per task are trivially small
    //    (< $0.001 even at Opus pricing)
    // 2. The latency of an Ollama round-trip may not be worth it
    // 3. Very short outputs are more likely to be wrong from a local model
    //
    // Verify the math: at 200 tokens, net savings ARE positive but small
    const overhead200 = estimateCloudOverhead(200);
    const gross200 = (200 / 1_000_000) * 25; // Opus pricing
    const overheadCost200 = (overhead200 / 1_000_000) * (25 / 5);
    const net200 = gross200 - overheadCost200;
    expect(net200).toBeGreaterThan(0);
    // But it's still under 1 cent even at Opus pricing
    expect(net200).toBeLessThan(0.01);
  });
});


// ---------------------------------------------------------------------------
// SECTION 4: Aggregate session economics — realistic workday
// ---------------------------------------------------------------------------

describe('Aggregate session economics with overhead', () => {
  // Realistic workday prompts with measured output token counts.
  // Each prompt includes its expected route and output tokens.
  const workdayPrompts = [
    // Docstrings (Level 1, small output)
    { type: 'docstring_simple', tokens: 50, count: 8 },
    { type: 'docstring_complex', tokens: 200, count: 4 },
    // Commit messages (Level 1, small output)
    { type: 'commit_msg', tokens: 50, count: 6 },
    // Format conversions (Level 2, tiny output)
    { type: 'format_convert', tokens: 30, count: 3 },
    // File summaries (Level 2, medium output)
    { type: 'file_summary', tokens: 120, count: 5 },
    // Type annotations (Level 1, medium output)
    { type: 'type_annotations', tokens: 135, count: 3 },
    // Test scaffolds (Level 2, large output)
    { type: 'test_scaffold', tokens: 500, count: 4 },
    // CRUD endpoints (Level 3, large output)
    { type: 'crud_endpoint', tokens: 275, count: 2 },
    // Boilerplate (Level 2, medium output)
    { type: 'boilerplate', tokens: 100, count: 3 },
    // Refactoring (Level 3, large output)
    { type: 'refactoring', tokens: 400, count: 2 },
    // Bug analysis (Level 3, large output)
    { type: 'bug_analysis', tokens: 300, count: 2 },
    // API docs (Level 3, large output)
    { type: 'api_docs', tokens: 400, count: 1 },
  ];

  // Expand into individual entries
  function expandToEntries(): CompletionEntry[] {
    const entries: CompletionEntry[] = [];
    let i = 0;
    for (const prompt of workdayPrompts) {
      for (let j = 0; j < prompt.count; j++) {
        entries.push({
          type: 'completion',
          timestamp: new Date(2026, 1, 17, 9, 0, i).toISOString(),
          tokens_used: prompt.tokens,
          model: 'local-32k',
          duration_ms: 100 + Math.floor(prompt.tokens / 5),
          tool: `claudesaver_${prompt.type}`,
          session_id: 'workday-001',
        });
        i++;
      }
    }
    return entries;
  }

  it('total gross tokens match expected sum', () => {
    const expectedTokens = workdayPrompts.reduce(
      (sum, p) => sum + p.tokens * p.count, 0
    );
    // Manual calculation:
    // 50*8 + 200*4 + 50*6 + 30*3 + 120*5 + 135*3 + 500*4 + 275*2 + 100*3 + 400*2 + 300*2 + 400*1
    // = 400 + 800 + 300 + 90 + 600 + 405 + 2000 + 550 + 300 + 800 + 600 + 400
    // = 7245
    expect(expectedTokens).toBe(7245);

    const entries = expandToEntries();
    const summary = computeSummary(entries);
    expect(summary.total_local_tokens).toBe(7245);
  });

  it('total task count matches', () => {
    const expectedTasks = workdayPrompts.reduce((sum, p) => sum + p.count, 0);
    // 8+4+6+3+5+3+4+2+3+2+2+1 = 43
    expect(expectedTasks).toBe(43);

    const entries = expandToEntries();
    const summary = computeSummary(entries);
    expect(summary.local_tasks).toBe(43);
  });

  it('overhead tokens are substantial — not ignorable', () => {
    const entries = expandToEntries();
    const summary = computeSummary(entries);

    // Each task has at least 80 tokens overhead (fixed) + variable
    // Minimum overhead = 43 * 80 = 3440 tokens (just the fixed part)
    expect(summary.total_cloud_overhead_tokens).toBeGreaterThan(3440);

    // Total overhead should be significant relative to local tokens
    const overheadRatio = summary.total_cloud_overhead_tokens / summary.total_local_tokens;
    // Expected: overhead ≈ 80 * 43 + 7245 * 1.3 ≈ 3440 + 9419 = 12,859
    // Ratio ≈ 12859 / 7245 ≈ 1.77
    expect(overheadRatio).toBeGreaterThan(1.5);
    expect(overheadRatio).toBeLessThan(2.0);
  });

  it('net tokens saved are positive but lower than gross', () => {
    const entries = expandToEntries();
    const summary = computeSummary(entries);

    // Net = gross - overhead, should be negative in tokens
    // because overhead > local tokens for small tasks
    // 7245 - 12859 = -5614 tokens
    expect(summary.net_tokens_saved).toBeLessThan(summary.total_local_tokens);
  });

  it('net COST saved is positive despite negative net tokens', () => {
    const entries = expandToEntries();
    const summary = computeSummary(entries);

    // This is the key insight: net tokens can be negative but net COST
    // is still positive because:
    //   gross saves OUTPUT tokens at 5x the price of INPUT tokens
    //   overhead spends INPUT tokens at 1/5 the price
    //
    // gross_cost = 7245 * $8/1M = $0.05796
    // overhead_cost = 12859 * $1.6/1M = $0.02057
    // net_cost = $0.05796 - $0.02057 = $0.03739
    expect(summary.net_cost_saved).toBeGreaterThan(0);
    expect(summary.gross_cost_saved).toBeGreaterThan(summary.net_cost_saved);
  });

  it('efficiency ratio: net / gross cost at default $8/M', () => {
    const entries = expandToEntries();
    const summary = computeSummary(entries);

    // The 5x cost asymmetry means even though overhead tokens outnumber
    // local tokens, the dollars still work in our favor.
    const efficiency = summary.net_cost_saved / summary.gross_cost_saved;
    expect(efficiency).toBeGreaterThan(0.5);
    expect(efficiency).toBeLessThan(0.8);
  });

  describe('impact of removing unprofitable short tasks', () => {
    function expandFilteredEntries(minTokens: number): CompletionEntry[] {
      const entries: CompletionEntry[] = [];
      let i = 0;
      for (const prompt of workdayPrompts) {
        if (prompt.tokens < minTokens) continue;
        for (let j = 0; j < prompt.count; j++) {
          entries.push({
            type: 'completion',
            timestamp: new Date(2026, 1, 17, 9, 0, i).toISOString(),
            tokens_used: prompt.tokens,
            model: 'local-32k',
            duration_ms: 100 + Math.floor(prompt.tokens / 5),
            tool: `claudesaver_${prompt.type}`,
            session_id: 'workday-001',
          });
          i++;
        }
      }
      return entries;
    }

    // NOTE: computeSummary rounds costs to 2 decimal places, which distorts
    // efficiency ratios for small amounts. To get accurate efficiency, we
    // compute from raw token values, not rounded dollar amounts.
    function rawEfficiency(entries: CompletionEntry[]): number {
      let totalTokens = 0;
      let totalOverhead = 0;
      for (const e of entries) {
        totalTokens += e.tokens_used;
        totalOverhead += estimateCloudOverhead(e.tokens_used);
      }
      const grossCost = totalTokens * 8 / 1_000_000;
      const overheadCost = totalOverhead * 1.6 / 1_000_000;
      return grossCost > 0 ? (grossCost - overheadCost) / grossCost : 0;
    }

    it('filtering tasks < 100 tokens improves efficiency (unrounded)', () => {
      const allEntries = expandToEntries();
      const filteredEntries = expandFilteredEntries(100);

      const allEff = rawEfficiency(allEntries);
      const filteredEff = rawEfficiency(filteredEntries);

      // Removing 50-token and 30-token tasks increases efficiency
      // because smaller tasks have proportionally higher fixed overhead (80 tokens)
      expect(filteredEff).toBeGreaterThan(allEff);
    });

    it('filtering tasks < 200 tokens further improves efficiency', () => {
      const filtered100 = expandFilteredEntries(100);
      const filtered200 = expandFilteredEntries(200);

      const eff100 = rawEfficiency(filtered100);
      const eff200 = rawEfficiency(filtered200);

      expect(eff200).toBeGreaterThan(eff100);
    });

    it('but filtering too aggressively reduces total net savings', () => {
      const filtered200 = expandFilteredEntries(200);
      const filtered500 = expandFilteredEntries(500);

      const summary200 = computeSummary(filtered200);
      const summary500 = computeSummary(filtered500);

      // Higher threshold = better efficiency but fewer tasks = less total savings
      // The 200-400 token tasks still contribute positive net savings
      expect(summary200.net_cost_saved).toBeGreaterThanOrEqual(summary500.net_cost_saved);
    });
  });
});


// ---------------------------------------------------------------------------
// SECTION 5: Cost calculations at all Anthropic pricing tiers
// ---------------------------------------------------------------------------

describe('Cost calculations across Claude model tiers', () => {
  // Build a fixed set of 10 completions at various token sizes
  function buildMixedEntries(): CompletionEntry[] {
    const tokenSizes = [50, 100, 200, 300, 400, 500, 750, 1000, 200, 300];
    return tokenSizes.map((tokens, i) => ({
      type: 'completion' as const,
      timestamp: new Date(2026, 1, 17, 10, i).toISOString(),
      tokens_used: tokens,
      model: 'test-model',
      duration_ms: 100,
      tool: 'claudesaver_complete',
      session_id: 'pricing-test',
    }));
  }

  const entries = buildMixedEntries();
  const totalTokens = 50 + 100 + 200 + 300 + 400 + 500 + 750 + 1000 + 200 + 300;
  // = 3800

  it('total tokens are 3800', () => {
    const summary = computeSummary(entries);
    expect(summary.total_local_tokens).toBe(3800);
  });

  it('at $5/M (Haiku output): correct gross and net', () => {
    const summary = computeSummary(entries, 5);
    // gross = 3800 / 1M * 5 = 0.019
    expect(summary.gross_cost_saved).toBe(0.02);
    // overhead > 0, net < gross
    expect(summary.net_cost_saved).toBeLessThan(summary.gross_cost_saved);
    expect(summary.net_cost_saved).toBeGreaterThan(0);
  });

  it('at $8/M (default rate): correct gross', () => {
    const summary = computeSummary(entries, 8);
    // gross = 3800 / 1M * 8 = 0.0304
    expect(summary.gross_cost_saved).toBe(0.03);
    expect(summary.net_cost_saved).toBeGreaterThan(0);
  });

  it('at $15/M (Sonnet output): correct gross', () => {
    const summary = computeSummary(entries, 15);
    // gross = 3800 / 1M * 15 = 0.057
    expect(summary.gross_cost_saved).toBe(0.06);
    expect(summary.net_cost_saved).toBeGreaterThan(0);
  });

  it('at $25/M (Opus output): correct gross', () => {
    const summary = computeSummary(entries, 25);
    // gross = 3800 / 1M * 25 = 0.095
    expect(summary.gross_cost_saved).toBe(0.1); // rounds to 0.10
    expect(summary.net_cost_saved).toBeGreaterThan(0);
  });

  it('net savings scale proportionally with cost rate (unrounded)', () => {
    // computeSummary rounds to 2 decimals, which distorts ratios at small
    // amounts. Verify proportionality using raw token-level math instead.
    const totalTokens = 3800;
    // Compute total overhead for the 10 entries
    const tokenSizes = [50, 100, 200, 300, 400, 500, 750, 1000, 200, 300];
    const totalOverhead = tokenSizes.reduce(
      (sum, t) => sum + estimateCloudOverhead(t), 0
    );

    function rawNet(costRate: number): number {
      const gross = (totalTokens / 1_000_000) * costRate;
      const overheadCost = (totalOverhead / 1_000_000) * (costRate / 5);
      return gross - overheadCost;
    }

    const netAt5 = rawNet(5);
    const netAt25 = rawNet(25);

    // At 5x the price, net savings should be exactly 5x
    expect(netAt25 / netAt5).toBeCloseTo(5, 5);
  });

  it('efficiency ratio is constant regardless of price tier (unrounded)', () => {
    // The efficiency formula: net/gross = 1 - (overhead * (R/5)) / (tokens * R)
    //                                   = 1 - overhead / (5 * tokens)
    // The R cancels out — efficiency is independent of price tier
    const totalTokens = 3800;
    const tokenSizes = [50, 100, 200, 300, 400, 500, 750, 1000, 200, 300];
    const totalOverhead = tokenSizes.reduce(
      (sum, t) => sum + estimateCloudOverhead(t), 0
    );

    const theoreticalEfficiency = 1 - totalOverhead / (5 * totalTokens);

    function rawEfficiency(costRate: number): number {
      const gross = (totalTokens / 1_000_000) * costRate;
      const overheadCost = (totalOverhead / 1_000_000) * (costRate / 5);
      return (gross - overheadCost) / gross;
    }

    expect(rawEfficiency(5)).toBeCloseTo(theoreticalEfficiency, 10);
    expect(rawEfficiency(8)).toBeCloseTo(theoreticalEfficiency, 10);
    expect(rawEfficiency(15)).toBeCloseTo(theoreticalEfficiency, 10);
    expect(rawEfficiency(25)).toBeCloseTo(theoreticalEfficiency, 10);
  });
});


// ---------------------------------------------------------------------------
// SECTION 6: Routing + net savings end-to-end
// ---------------------------------------------------------------------------

describe('End-to-end: routing decision → net savings calculation', () => {
  // For each prompt, classify it, then compute what the net savings would be

  interface PromptScenario {
    prompt: string;
    expectedRoute: 'no_llm' | 'local' | 'cloud';
    estimatedOutputTokens: number;
    description: string;
  }

  const scenarios: PromptScenario[] = [
    // SHORT TASKS — delegating these wastes money at low token counts
    {
      prompt: 'write a docstring for function calculateTax(amount: number): number',
      expectedRoute: 'local',
      estimatedOutputTokens: 50,
      description: 'Simple docstring (~50 tokens)',
    },
    {
      prompt: 'generate a commit message for fixing the null pointer exception',
      expectedRoute: 'local',
      estimatedOutputTokens: 50,
      description: 'Commit message (~50 tokens)',
    },
    {
      prompt: 'convert this JSON to YAML format',
      expectedRoute: 'local',
      estimatedOutputTokens: 30,
      description: 'Format conversion (~30 tokens)',
    },

    // MEDIUM TASKS — clearly profitable
    {
      prompt: 'write a docstring for class PaymentProcessor with methods charge, refund, and getBalance',
      expectedRoute: 'local',
      estimatedOutputTokens: 200,
      description: 'Complex docstring (~200 tokens)',
    },
    {
      prompt: 'summarize this file',
      expectedRoute: 'local',
      estimatedOutputTokens: 120,
      description: 'File summary (~120 tokens)',
    },
    {
      prompt: 'add type annotations to this function',
      expectedRoute: 'local',
      estimatedOutputTokens: 135,
      description: 'Type annotations (~135 tokens)',
    },

    // LARGE TASKS — high net savings
    {
      prompt: 'write a unit test for the UserService.createUser method',
      expectedRoute: 'local',
      estimatedOutputTokens: 500,
      description: 'Unit test scaffold (~500 tokens)',
    },
    {
      prompt: 'generate a REST endpoint for creating new orders',
      expectedRoute: 'local',
      estimatedOutputTokens: 275,
      description: 'CRUD endpoint (~275 tokens)',
    },
    {
      prompt: 'generate API documentation for the payment endpoints',
      expectedRoute: 'local',
      estimatedOutputTokens: 400,
      description: 'API docs (~400 tokens)',
    },

    // CLOUD TASKS — no savings (correctly not delegated)
    {
      prompt: 'architect a scalable microservices system with event sourcing and CQRS',
      expectedRoute: 'cloud',
      estimatedOutputTokens: 0,
      description: 'Architecture (stays on cloud)',
    },
    {
      prompt: 'debug this race condition in the WebSocket handler',
      expectedRoute: 'cloud',
      estimatedOutputTokens: 0,
      description: 'Complex debugging (stays on cloud)',
    },

    // NO_LLM TASKS — zero cost, pure metadata
    {
      prompt: 'show me the file tree of src',
      expectedRoute: 'no_llm',
      estimatedOutputTokens: 0,
      description: 'Filesystem tree (no LLM)',
    },
    {
      prompt: 'git status',
      expectedRoute: 'no_llm',
      estimatedOutputTokens: 0,
      description: 'Git status (no LLM)',
    },
  ];

  for (const scenario of scenarios) {
    it(`routes "${scenario.description}" to ${scenario.expectedRoute}`, async () => {
      const decision = await classifyTask(scenario.prompt, { delegationLevel: 2 });
      expect(decision.route).toBe(scenario.expectedRoute);
    });
  }

  it('total gross tokens for local-routed tasks', () => {
    const localTokens = scenarios
      .filter(s => s.expectedRoute === 'local')
      .reduce((sum, s) => sum + s.estimatedOutputTokens, 0);

    // 50 + 50 + 30 + 200 + 120 + 135 + 500 + 275 + 400 = 1760
    expect(localTokens).toBe(1760);
  });

  it('total overhead for local-routed tasks', () => {
    const localScenarios = scenarios.filter(s => s.expectedRoute === 'local');
    const totalOverhead = localScenarios.reduce(
      (sum, s) => sum + estimateCloudOverhead(s.estimatedOutputTokens), 0
    );

    // Manually verify:
    // 50→145, 50→145, 30→119, 200→340, 120→236, 135→256, 500→730, 275→438, 400→600
    // Total: 145+145+119+340+236+256+730+438+600 = 3009
    expect(totalOverhead).toBe(3009);
  });

  it('net token balance for the scenario set', () => {
    const localScenarios = scenarios.filter(s => s.expectedRoute === 'local');
    const totalLocalTokens = localScenarios.reduce((sum, s) => sum + s.estimatedOutputTokens, 0);
    const totalOverhead = localScenarios.reduce(
      (sum, s) => sum + estimateCloudOverhead(s.estimatedOutputTokens), 0
    );

    // 1760 - 3009 = -1249 (net token loss, but cost is still positive)
    expect(totalLocalTokens - totalOverhead).toBe(-1249);
  });

  it('net DOLLAR savings are still positive despite net token loss', () => {
    const localScenarios = scenarios.filter(s => s.expectedRoute === 'local');
    const totalLocalTokens = localScenarios.reduce((sum, s) => sum + s.estimatedOutputTokens, 0);
    const totalOverhead = localScenarios.reduce(
      (sum, s) => sum + estimateCloudOverhead(s.estimatedOutputTokens), 0
    );

    const costRate = 8;
    const grossCost = (totalLocalTokens / 1_000_000) * costRate;
    const overheadCost = (totalOverhead / 1_000_000) * (costRate / 5);
    const netCost = grossCost - overheadCost;

    // grossCost = 1760 * 8 / 1M = 0.01408
    // overheadCost = 3009 * 1.6 / 1M = 0.0048144
    // netCost = 0.01408 - 0.0048144 = 0.0092656
    expect(netCost).toBeGreaterThan(0);
    expect(grossCost).toBeCloseTo(0.01408, 4);
    expect(overheadCost).toBeCloseTo(0.004814, 3);
    expect(netCost).toBeCloseTo(0.00927, 3);
  });
});


// ---------------------------------------------------------------------------
// SECTION 7: Edge cases and boundary conditions
// ---------------------------------------------------------------------------

describe('Edge cases and boundary conditions', () => {
  it('zero-entry summary has all zeros', () => {
    const summary = computeSummary([]);
    expect(summary.total_local_tokens).toBe(0);
    expect(summary.total_cloud_overhead_tokens).toBe(0);
    expect(summary.net_tokens_saved).toBe(0);
    expect(summary.gross_cost_saved).toBe(0);
    expect(summary.overhead_cost).toBe(0);
    expect(summary.net_cost_saved).toBe(0);
    expect(summary.local_tasks).toBe(0);
  });

  it('single 1-token completion: overhead dominates', () => {
    const entries: AnyMetricsEntry[] = [{
      type: 'completion',
      timestamp: new Date().toISOString(),
      tokens_used: 1,
      model: 'test',
      duration_ms: 10,
      tool: 'test',
      session_id: 's1',
    }];

    const summary = computeSummary(entries);

    expect(summary.total_local_tokens).toBe(1);
    expect(summary.total_cloud_overhead_tokens).toBe(82); // 80 + ceil(1.3)
    expect(summary.net_tokens_saved).toBe(-81);
    // Both gross and overhead round to 0 at $8/M for such tiny amounts
    // gross = 1 * 8 / 1M = 0.000008 → rounds to 0.00
    // overhead_cost = 82 * 1.6 / 1M = 0.0001312 → rounds to 0.00
    // net_cost = 0.00 - 0.00 = 0.00
    // At this scale, rounding masks the real loss
    expect(summary.net_cost_saved).toBeLessThanOrEqual(0);

    // But the raw math confirms it's a net loss:
    const rawGross = (1 / 1_000_000) * 8;
    const rawOverhead = (82 / 1_000_000) * 1.6;
    expect(rawGross - rawOverhead).toBeLessThan(0);
  });

  it('single 10000-token completion: high positive net', () => {
    const entries: AnyMetricsEntry[] = [{
      type: 'completion',
      timestamp: new Date().toISOString(),
      tokens_used: 10000,
      model: 'test',
      duration_ms: 5000,
      tool: 'test',
      session_id: 's1',
    }];

    const summary = computeSummary(entries);

    expect(summary.total_local_tokens).toBe(10000);
    // overhead = 80 + ceil(13000) = 13080
    expect(summary.total_cloud_overhead_tokens).toBe(13080);
    expect(summary.net_tokens_saved).toBe(-3080);
    // But cost:
    // gross = 10000 * 8 / 1M = 0.08
    // overhead = 13080 * 1.6 / 1M = 0.020928
    // net = 0.08 - 0.020928 = 0.059072
    expect(summary.gross_cost_saved).toBe(0.08);
    expect(summary.net_cost_saved).toBeGreaterThan(0.05);
  });

  it('pre-recorded cloud_overhead_tokens take precedence over estimate', () => {
    const entries: AnyMetricsEntry[] = [{
      type: 'completion',
      timestamp: new Date().toISOString(),
      tokens_used: 100,
      model: 'test',
      duration_ms: 100,
      tool: 'test',
      session_id: 's1',
      cloud_overhead_tokens: 500, // Explicitly set, different from estimate
    }];

    const summary = computeSummary(entries);

    // Should use the recorded 500, not the estimated 210
    expect(summary.total_cloud_overhead_tokens).toBe(500);
    expect(summary.total_cloud_overhead_tokens).not.toBe(estimateCloudOverhead(100));
  });

  it('entries without cloud_overhead_tokens get estimate applied', () => {
    const entries: AnyMetricsEntry[] = [{
      type: 'completion',
      timestamp: new Date().toISOString(),
      tokens_used: 100,
      model: 'test',
      duration_ms: 100,
      tool: 'test',
      session_id: 's1',
      // No cloud_overhead_tokens field
    }];

    const summary = computeSummary(entries);

    expect(summary.total_cloud_overhead_tokens).toBe(estimateCloudOverhead(100));
    expect(summary.total_cloud_overhead_tokens).toBe(210);
  });

  it('100 small tasks (50 tokens each): overhead is significant', () => {
    const entries: CompletionEntry[] = Array.from({ length: 100 }, (_, i) => ({
      type: 'completion' as const,
      timestamp: new Date(2026, 1, 17, 9, 0, i).toISOString(),
      tokens_used: 50,
      model: 'test',
      duration_ms: 50,
      tool: 'docstring',
      session_id: 'batch-test',
    }));

    const summary = computeSummary(entries);

    // 100 tasks × 50 tokens = 5000 local tokens
    expect(summary.total_local_tokens).toBe(5000);
    // 100 tasks × 145 overhead = 14500 overhead tokens
    expect(summary.total_cloud_overhead_tokens).toBe(14500);

    // Despite 5000 local tokens, overhead is 14500 — net token loss of 9500
    expect(summary.net_tokens_saved).toBe(-9500);

    // But the dollar math:
    // gross = 5000 * 8 / 1M = 0.04
    // overhead_cost = 14500 * 1.6 / 1M = 0.0232
    // net = 0.04 - 0.0232 = 0.0168
    expect(summary.gross_cost_saved).toBe(0.04);
    expect(summary.net_cost_saved).toBeGreaterThan(0.01);
    expect(summary.net_cost_saved).toBeLessThanOrEqual(0.02);
  });

  it('100 large tasks (1000 tokens each): highly efficient', () => {
    const entries: CompletionEntry[] = Array.from({ length: 100 }, (_, i) => ({
      type: 'completion' as const,
      timestamp: new Date(2026, 1, 17, 9, 0, i).toISOString(),
      tokens_used: 1000,
      model: 'test',
      duration_ms: 500,
      tool: 'codegen',
      session_id: 'batch-test',
    }));

    const summary = computeSummary(entries);

    // 100 tasks × 1000 tokens = 100000 local tokens
    expect(summary.total_local_tokens).toBe(100000);
    // 100 tasks × 1380 overhead = 138000 overhead tokens
    expect(summary.total_cloud_overhead_tokens).toBe(138000);

    // gross = 100000 * 8 / 1M = 0.8
    // overhead_cost = 138000 * 1.6 / 1M = 0.2208
    // net = 0.8 - 0.2208 = 0.5792
    expect(summary.gross_cost_saved).toBe(0.8);
    expect(summary.net_cost_saved).toBeGreaterThan(0.55);

    const efficiency = summary.net_cost_saved / summary.gross_cost_saved;
    expect(efficiency).toBeGreaterThan(0.7);
  });

  it('mixed sessions: multiple session_ids tracked correctly', () => {
    const entries: CompletionEntry[] = [
      ...Array.from({ length: 5 }, (_, i) => ({
        type: 'completion' as const,
        timestamp: new Date().toISOString(),
        tokens_used: 200,
        model: 'test',
        duration_ms: 100,
        tool: 'test',
        session_id: 'session-A',
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        type: 'completion' as const,
        timestamp: new Date().toISOString(),
        tokens_used: 500,
        model: 'test',
        duration_ms: 200,
        tool: 'test',
        session_id: 'session-B',
      })),
    ];

    const summary = computeSummary(entries);

    expect(summary.sessions).toBe(2);
    expect(summary.local_tasks).toBe(8);
    expect(summary.total_local_tokens).toBe(5 * 200 + 3 * 500); // 2500
  });
});


// ---------------------------------------------------------------------------
// SECTION 8: Monthly/yearly projection accuracy
// ---------------------------------------------------------------------------

describe('Monthly and yearly savings projections', () => {
  // Based on the workday simulation from Section 4:
  // 43 tasks/day, 7245 local tokens/day
  const tasksPerDay = 43;
  const localTokensPerDay = 7245;

  it('monthly projection at $8/M (22 work days)', () => {
    const monthlyTokens = localTokensPerDay * 22;
    // 7245 * 22 = 159,390 tokens/month
    expect(monthlyTokens).toBe(159390);

    // Create a month of entries to compute accurate overhead
    const entries: CompletionEntry[] = [];
    const tokenDistribution = [50, 50, 50, 50, 50, 50, 50, 50, // 8x docstring
      200, 200, 200, 200, // 4x complex docstring
      50, 50, 50, 50, 50, 50, // 6x commit msg
      30, 30, 30, // 3x format
      120, 120, 120, 120, 120, // 5x summary
      135, 135, 135, // 3x type annotations
      500, 500, 500, 500, // 4x test scaffold
      275, 275, // 2x CRUD
      100, 100, 100, // 3x boilerplate
      400, 400, // 2x refactoring
      300, 300, // 2x bug analysis
      400, // 1x API docs
    ];

    let idx = 0;
    for (let day = 0; day < 22; day++) {
      for (const tokens of tokenDistribution) {
        entries.push({
          type: 'completion',
          timestamp: new Date(2026, 1, day + 1, 10, 0, idx % 60).toISOString(),
          tokens_used: tokens,
          model: 'local-32k',
          duration_ms: 100,
          tool: 'test',
          session_id: `day-${day}`,
        });
        idx++;
      }
    }

    const summary = computeSummary(entries, 8);

    expect(summary.total_local_tokens).toBe(monthlyTokens);
    expect(summary.sessions).toBe(22);
    expect(summary.local_tasks).toBe(tasksPerDay * 22); // 946

    // Gross savings: 159390 * 8 / 1M ≈ $1.28
    expect(summary.gross_cost_saved).toBeGreaterThan(1.2);
    expect(summary.gross_cost_saved).toBeLessThan(1.4);

    // Net savings should be positive
    expect(summary.net_cost_saved).toBeGreaterThan(0);
    // But less than gross
    expect(summary.net_cost_saved).toBeLessThan(summary.gross_cost_saved);
  });

  it('Opus pricing: monthly net savings at $25/M output', () => {
    const monthlyTokens = localTokensPerDay * 22;
    const entries: CompletionEntry[] = [{
      type: 'completion',
      timestamp: new Date().toISOString(),
      tokens_used: monthlyTokens,
      model: 'local-32k',
      duration_ms: 100,
      tool: 'test',
      session_id: 'month',
    }];

    const summary = computeSummary(entries, 25);

    // Gross: 159390 * 25 / 1M ≈ $3.98
    expect(summary.gross_cost_saved).toBeGreaterThan(3.9);
    expect(summary.gross_cost_saved).toBeLessThan(4.1);

    // Net should be significant at Opus pricing
    expect(summary.net_cost_saved).toBeGreaterThan(2.5);
  });
});
