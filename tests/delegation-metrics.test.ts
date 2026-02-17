import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock fs before importing the module under test
// ---------------------------------------------------------------------------
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock config — controls metrics enabled flag and path resolution
// ---------------------------------------------------------------------------
vi.mock('../src/mcp-server/config.js', () => ({
  loadConfig: vi.fn(() => ({
    metrics: { enabled: true, log_path: '~/.claude-saver/metrics.jsonl' },
  })),
  resolvePath: vi.fn((p: string) => p.replace('~', '/tmp/test-home')),
}));

import * as fs from 'fs';
import { loadConfig, resolvePath } from '../src/mcp-server/config.js';
import {
  logDelegation,
  loadDelegationEntries,
  computeDelegationSummary,
  type DelegationEntry,
} from '../src/mcp-server/delegation-metrics.js';

// ---------------------------------------------------------------------------
// Expected metrics file path produced by the mocked resolvePath
// ---------------------------------------------------------------------------
const EXPECTED_METRICS_PATH = '/tmp/test-home/.claude-saver/metrics.jsonl';

// ---------------------------------------------------------------------------
// Helper — build a fully populated DelegationEntry
// ---------------------------------------------------------------------------
function makeEntry(overrides: Partial<DelegationEntry> = {}): DelegationEntry {
  return {
    type: 'delegation',
    timestamp: '2026-02-17T12:00:00.000Z',
    tool: 'claudesaver_complete',
    quality_status: 'accepted',
    attempt_count: 1,
    tokens_used: 200,
    output_tokens: 150,
    duration_ms: 1000,
    model: 'test-model',
    resolved_locally: true,
    session_id: 'test-session',
    ...overrides,
  };
}

/** Parse what was written to appendFileSync at callIndex and return the object. */
function getAppendedRecord(callIndex = 0): DelegationEntry {
  const calls = vi.mocked(fs.appendFileSync).mock.calls;
  expect(calls.length).toBeGreaterThan(callIndex);
  const raw = calls[callIndex][1] as string;
  return JSON.parse(raw.trimEnd()) as DelegationEntry;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.resetAllMocks();

  // Restore default mock implementations after resetAllMocks clears them
  vi.mocked(loadConfig).mockReturnValue({
    metrics: { enabled: true, log_path: '~/.claude-saver/metrics.jsonl' },
  } as ReturnType<typeof loadConfig>);

  vi.mocked(resolvePath).mockImplementation((p: string) =>
    p.replace('~', '/tmp/test-home'),
  );

  // Default: directory exists so ensureDir skips mkdirSync
  vi.mocked(fs.existsSync).mockReturnValue(true);

  delete process.env['CLAUDE_SESSION_ID'];
});

// ===========================================================================
// computeDelegationSummary — empty entries
// ===========================================================================
describe('computeDelegationSummary with empty entries', () => {
  it('returns all-zero numeric fields for an empty array', () => {
    const summary = computeDelegationSummary([]);

    expect(summary.total_delegations).toBe(0);
    expect(summary.resolved_locally).toBe(0);
    expect(summary.escalated).toBe(0);
    expect(summary.resolution_rate).toBe(0);
    expect(summary.retry_rate).toBe(0);
    expect(summary.avg_attempts).toBe(0);
    expect(summary.total_local_tokens).toBe(0);
    expect(summary.avg_duration_ms).toBe(0);
  });

  it('returns zeroed quality_breakdown for an empty array', () => {
    const summary = computeDelegationSummary([]);

    expect(summary.quality_breakdown).toEqual({
      accepted: 0,
      retried_accepted: 0,
      escalated: 0,
    });
  });
});

// ===========================================================================
// computeDelegationSummary — mixed entries
// ===========================================================================
describe('computeDelegationSummary with mixed entries', () => {
  // Build a fixed dataset used across most tests in this group:
  //   4 entries total:
  //     - 3 resolved locally (2 accepted, 1 retried_accepted)
  //     - 1 escalated (not resolved locally)
  //     - 2 entries have attempt_count > 1
  const entries: DelegationEntry[] = [
    makeEntry({ resolved_locally: true,  quality_status: 'accepted',         attempt_count: 1, tokens_used: 100, duration_ms: 500  }),
    makeEntry({ resolved_locally: true,  quality_status: 'accepted',         attempt_count: 2, tokens_used: 200, duration_ms: 1000 }),
    makeEntry({ resolved_locally: true,  quality_status: 'retried_accepted', attempt_count: 3, tokens_used: 300, duration_ms: 1500 }),
    makeEntry({ resolved_locally: false, quality_status: 'escalated',        attempt_count: 2, tokens_used: 400, duration_ms: 2000 }),
  ];

  it('reports correct total_delegations count', () => {
    const summary = computeDelegationSummary(entries);
    expect(summary.total_delegations).toBe(4);
  });

  it('reports correct resolved_locally and escalated counts', () => {
    const summary = computeDelegationSummary(entries);
    expect(summary.resolved_locally).toBe(3);
    expect(summary.escalated).toBe(1);
  });

  it('calculates resolution_rate as resolved / total', () => {
    const summary = computeDelegationSummary(entries);
    // 3 resolved out of 4 = 0.75
    expect(summary.resolution_rate).toBeCloseTo(0.75, 10);
  });

  it('calculates retry_rate as entries with attempt_count > 1 divided by total', () => {
    const summary = computeDelegationSummary(entries);
    // 3 entries have attempt_count > 1 (2, 3, 2) out of 4 = 0.75
    expect(summary.retry_rate).toBeCloseTo(0.75, 10);
  });

  it('calculates avg_attempts correctly', () => {
    const summary = computeDelegationSummary(entries);
    // totalAttempts = 1 + 2 + 3 + 2 = 8; 8 / 4 = 2.0
    expect(summary.avg_attempts).toBeCloseTo(2.0, 10);
  });

  it('populates quality_breakdown with counts for each status', () => {
    const summary = computeDelegationSummary(entries);
    expect(summary.quality_breakdown).toEqual({
      accepted: 2,
      retried_accepted: 1,
      escalated: 1,
    });
  });

  it('sums total_local_tokens across all entries', () => {
    const summary = computeDelegationSummary(entries);
    // 100 + 200 + 300 + 400 = 1000
    expect(summary.total_local_tokens).toBe(1000);
  });

  it('computes avg_duration_ms as mean of all duration_ms values', () => {
    const summary = computeDelegationSummary(entries);
    // (500 + 1000 + 1500 + 2000) / 4 = 5000 / 4 = 1250
    expect(summary.avg_duration_ms).toBeCloseTo(1250, 10);
  });
});

// ===========================================================================
// logDelegation
// ===========================================================================
describe('logDelegation', () => {
  it('appends a valid JSON line followed by a newline to the metrics file', () => {
    logDelegation({
      tool: 'claudesaver_complete',
      quality_status: 'accepted',
      attempt_count: 1,
      tokens_used: 300,
      output_tokens: 250,
      duration_ms: 800,
      model: 'test-model',
      resolved_locally: true,
    });

    expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
    const [filePath, data, encoding] = vi.mocked(fs.appendFileSync).mock.calls[0];
    expect(filePath).toBe(EXPECTED_METRICS_PATH);
    expect(encoding).toBe('utf-8');

    const raw = data as string;
    expect(raw.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(raw.trimEnd())).not.toThrow();
  });

  it('writes a record with type equal to "delegation"', () => {
    logDelegation({
      tool: 'claudesaver_complete',
      quality_status: 'accepted',
      attempt_count: 1,
      tokens_used: 150,
      output_tokens: 100,
      duration_ms: 500,
      model: 'test-model',
      resolved_locally: true,
    });

    const record = getAppendedRecord();
    expect(record.type).toBe('delegation');
  });

  it('propagates all input fields verbatim into the written record', () => {
    logDelegation({
      tool: 'my_tool',
      quality_status: 'retried_accepted',
      attempt_count: 3,
      tokens_used: 999,
      output_tokens: 777,
      duration_ms: 4200,
      model: 'custom-model',
      resolved_locally: false,
    });

    const record = getAppendedRecord();
    expect(record.tool).toBe('my_tool');
    expect(record.quality_status).toBe('retried_accepted');
    expect(record.attempt_count).toBe(3);
    expect(record.tokens_used).toBe(999);
    expect(record.output_tokens).toBe(777);
    expect(record.duration_ms).toBe(4200);
    expect(record.model).toBe('custom-model');
    expect(record.resolved_locally).toBe(false);
  });

  it('skips writing when metrics.enabled is false', () => {
    vi.mocked(loadConfig).mockReturnValue({
      metrics: { enabled: false, log_path: '~/.claude-saver/metrics.jsonl' },
    } as ReturnType<typeof loadConfig>);

    logDelegation({
      tool: 'claudesaver_complete',
      quality_status: 'accepted',
      attempt_count: 1,
      tokens_used: 100,
      output_tokens: 80,
      duration_ms: 200,
      model: 'test-model',
      resolved_locally: true,
    });

    expect(fs.appendFileSync).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// loadDelegationEntries
// ===========================================================================
describe('loadDelegationEntries', () => {
  it('returns an empty array when the metrics file does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const entries = loadDelegationEntries();

    expect(entries).toEqual([]);
  });

  it('returns an empty array for an empty file', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('');

    const entries = loadDelegationEntries();

    expect(entries).toEqual([]);
  });

  it('filters out non-delegation entries and returns only type="delegation" records', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const delegationLine = JSON.stringify(makeEntry({ tokens_used: 500 }));
    const otherLine = JSON.stringify({ type: 'completion', timestamp: '2026-02-17T12:00:00.000Z', tokens_used: 999, model: 'x', duration_ms: 100, tool: 'bash', session_id: 's1' });
    vi.mocked(fs.readFileSync).mockReturnValue(`${delegationLine}\n${otherLine}\n`);

    const entries = loadDelegationEntries();

    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('delegation');
    expect(entries[0].tokens_used).toBe(500);
  });

  it('skips malformed JSON lines and returns only valid delegation entries', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const validLine = JSON.stringify(makeEntry({ tokens_used: 123 }));
    const content = [
      validLine,
      '{ broken json !!!',
      '',
      'not json at all',
      JSON.stringify(makeEntry({ tokens_used: 456 })),
    ].join('\n');
    vi.mocked(fs.readFileSync).mockReturnValue(content);

    const entries = loadDelegationEntries();

    expect(entries).toHaveLength(2);
    expect(entries[0].tokens_used).toBe(123);
    expect(entries[1].tokens_used).toBe(456);
  });
});
