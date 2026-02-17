import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs before importing the module under test
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import * as fs from 'fs';
import {
  loadMetrics,
  computeSummary,
  type CompletionEntry,
  type MetricsEntry,
  type AnyMetricsEntry,
} from '../src/mcp-server/metrics.js';

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Helper to build completion entries
// ---------------------------------------------------------------------------
function makeCompletion(overrides: Partial<CompletionEntry> = {}): CompletionEntry {
  return {
    type: 'completion',
    timestamp: new Date().toISOString(),
    tokens_used: 1000,
    model: 'test-model',
    duration_ms: 500,
    tool: 'read_file',
    session_id: 'session-1',
    ...overrides,
  };
}

function makeSubagent(overrides: Partial<MetricsEntry> = {}): MetricsEntry {
  return {
    type: 'subagent',
    timestamp: new Date().toISOString(),
    agent: 'test-agent',
    duration_ms: 300,
    tools_used: ['bash'],
    session_id: 'session-1',
    ...overrides,
  };
}

// ===========================================================================
// computeSummary — pass entries directly, no fs mocking needed
// ===========================================================================
describe('computeSummary', () => {
  it('returns zeros for empty array', () => {
    const summary = computeSummary([]);

    expect(summary.total_tasks).toBe(0);
    expect(summary.local_tasks).toBe(0);
    expect(summary.cloud_tasks).toBe(0);
    expect(summary.total_duration_ms).toBe(0);
    expect(summary.total_local_tokens).toBe(0);
    expect(summary.estimated_cost_saved).toBe(0);
    expect(summary.sessions).toBe(0);
    expect(summary.tools_frequency).toEqual({});
  });

  it('correctly sums tokens, duration, and task count for completion entries', () => {
    const entries: AnyMetricsEntry[] = [
      makeCompletion({ tokens_used: 500, duration_ms: 100 }),
      makeCompletion({ tokens_used: 1500, duration_ms: 200 }),
      makeCompletion({ tokens_used: 3000, duration_ms: 300 }),
    ];

    const summary = computeSummary(entries);

    expect(summary.total_tasks).toBe(3);
    expect(summary.local_tasks).toBe(3);
    expect(summary.total_local_tokens).toBe(5000);
    expect(summary.total_duration_ms).toBe(600);
  });

  it('calculates cost correctly: 100,000 tokens at $8/M = $0.80', () => {
    const entries: AnyMetricsEntry[] = [
      makeCompletion({ tokens_used: 100_000 }),
    ];

    const summary = computeSummary(entries);

    expect(summary.estimated_cost_saved).toBe(0.8);
  });

  it('calculates cost correctly: 1,000,000 tokens at $8/M = $8.00', () => {
    const entries: AnyMetricsEntry[] = [
      makeCompletion({ tokens_used: 1_000_000 }),
    ];

    const summary = computeSummary(entries);

    expect(summary.estimated_cost_saved).toBe(8);
  });

  it('calculates cost with custom rate: 100,000 tokens at $15/M = $1.50', () => {
    const entries: AnyMetricsEntry[] = [
      makeCompletion({ tokens_used: 100_000 }),
    ];

    const summary = computeSummary(entries, 15);

    expect(summary.estimated_cost_saved).toBe(1.5);
  });

  it('handles mixed entry types — only completions count for token totals', () => {
    const entries: AnyMetricsEntry[] = [
      makeCompletion({ tokens_used: 2000, duration_ms: 100 }),
      makeSubagent({ duration_ms: 200 }),
      makeCompletion({ tokens_used: 3000, duration_ms: 150 }),
      makeSubagent({ duration_ms: 250 }),
    ];

    const summary = computeSummary(entries);

    expect(summary.total_tasks).toBe(4);
    expect(summary.local_tasks).toBe(2);
    expect(summary.total_local_tokens).toBe(5000);
    // Duration includes all entry types
    expect(summary.total_duration_ms).toBe(700);
  });

  it('counts unique sessions correctly', () => {
    const entries: AnyMetricsEntry[] = [
      makeCompletion({ session_id: 'aaa' }),
      makeCompletion({ session_id: 'bbb' }),
      makeCompletion({ session_id: 'ccc' }),
      makeCompletion({ session_id: 'aaa' }),
      makeCompletion({ session_id: 'bbb' }),
    ];

    const summary = computeSummary(entries);

    expect(summary.sessions).toBe(3);
  });

  it('tracks tool usage frequency for completions', () => {
    const entries: AnyMetricsEntry[] = [
      makeCompletion({ tool: 'read_file' }),
      makeCompletion({ tool: 'read_file' }),
      makeCompletion({ tool: 'write_file' }),
      makeCompletion({ tool: 'bash' }),
      makeCompletion({ tool: 'bash' }),
      makeCompletion({ tool: 'bash' }),
    ];

    const summary = computeSummary(entries);

    expect(summary.tools_frequency).toEqual({
      read_file: 2,
      write_file: 1,
      bash: 3,
    });
  });

  it('tracks tool usage frequency for subagent entries via tools_used array', () => {
    const entries: AnyMetricsEntry[] = [
      makeSubagent({ tools_used: ['bash', 'read_file'] }),
      makeSubagent({ tools_used: ['bash'] }),
    ];

    const summary = computeSummary(entries);

    expect(summary.tools_frequency).toEqual({
      bash: 2,
      read_file: 1,
    });
  });

  it('handles entries with NaN duration_ms gracefully', () => {
    const entries: AnyMetricsEntry[] = [
      makeCompletion({ tokens_used: 1000, duration_ms: 100 }),
      makeCompletion({ tokens_used: 2000, duration_ms: NaN }),
      makeCompletion({ tokens_used: 500, duration_ms: 200 }),
    ];

    // Should not throw
    const summary = computeSummary(entries);

    // total_duration_ms will be NaN due to NaN addition — verify it does not throw
    expect(summary.total_tasks).toBe(3);
    expect(summary.local_tasks).toBe(3);
    expect(summary.total_local_tokens).toBe(3500);
  });
});

// ===========================================================================
// loadMetrics — requires fs mocking
// ===========================================================================
describe('loadMetrics', () => {
  it('returns empty array when metrics file does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const entries = loadMetrics();

    expect(entries).toEqual([]);
  });

  it('parses valid JSONL lines', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const line1 = JSON.stringify(makeCompletion({ tokens_used: 100, tool: 'bash' }));
    const line2 = JSON.stringify(makeCompletion({ tokens_used: 200, tool: 'read_file' }));
    vi.mocked(fs.readFileSync).mockReturnValue(`${line1}\n${line2}\n`);

    const entries = loadMetrics();

    expect(entries).toHaveLength(2);
    expect((entries[0] as CompletionEntry).tokens_used).toBe(100);
    expect((entries[0] as CompletionEntry).tool).toBe('bash');
    expect((entries[1] as CompletionEntry).tokens_used).toBe(200);
    expect((entries[1] as CompletionEntry).tool).toBe('read_file');
  });

  it('returns empty array for empty file', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('');

    const entries = loadMetrics();

    expect(entries).toEqual([]);
  });

  it('skips invalid JSON lines and returns only valid entries', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const validLine = JSON.stringify(makeCompletion({ tokens_used: 500 }));
    const content = [
      validLine,
      '{ broken json !!!',
      '',
      'not json at all',
      JSON.stringify(makeCompletion({ tokens_used: 700 })),
    ].join('\n');
    vi.mocked(fs.readFileSync).mockReturnValue(content);

    const entries = loadMetrics();

    expect(entries).toHaveLength(2);
    expect((entries[0] as CompletionEntry).tokens_used).toBe(500);
    expect((entries[1] as CompletionEntry).tokens_used).toBe(700);
  });
});
