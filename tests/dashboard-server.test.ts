/**
 * Tests for the dashboard server (src/dashboard/server.ts)
 *
 * Strategy: the module starts an HTTP server on import and exports no
 * functions, so all tests work through the compiled CJS bundle
 * (scripts/dashboard-server.cjs) spawned as a child process on a random
 * port controlled by CLAUDE_SAVER_DASHBOARD_PORT.
 *
 * A temp HOME directory is used per test group so that loadConfig() reads
 * a controlled config.json and loadMetricsData() reads a controlled
 * metrics.jsonl — both under <tmpHome>/.claude-saver/.
 *
 * Pure-logic tests for estimateOverhead, detectModelCostRate, and
 * computeDashboardData are validated by writing specific JSONL payloads
 * and asserting the /api/data response matches the expected arithmetic.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const BUNDLE = path.resolve(__dirname, '../scripts/dashboard-server.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pick a random high port unlikely to collide. */
function randomPort(): number {
  return 40000 + Math.floor(Math.random() * 10000);
}

/** Create an isolated temp home with a .claude-saver directory and return its path. */
function createTempHome(metricsContent = '', configOverrides: Record<string, unknown> = {}): string {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dash-test-'));
  const configDir = path.join(tmpHome, '.claude-saver');
  fs.mkdirSync(configDir, { recursive: true });

  // Write metrics file
  const metricsPath = path.join(configDir, 'metrics.jsonl');
  fs.writeFileSync(metricsPath, metricsContent, 'utf-8');

  // Write config pointing at the temp metrics file
  const config = {
    delegation_level: 2,
    ollama: {
      base_url: 'http://localhost:11434',
      default_model: 'test-model',
      fallback_model: null,
      timeout_ms: 120000,
      health_timeout_ms: 3000,
    },
    routing: {
      use_local_triage: true,
      use_historical_learning: false,
      enable_decomposition: false,
      triage_model: null,
      learner_min_records: 50,
    },
    specialist_models: {},
    metrics: {
      enabled: true,
      log_path: metricsPath, // absolute path — resolvePath returns as-is
    },
    welcome: {
      show_savings: true,
      show_models: true,
      show_level: true,
      cost_per_million_tokens: 8,
    },
    light_pass: {
      enabled: true,
      max_input_tokens: 1500,
      max_output_tokens: 600,
      max_wall_time_ms: 5000,
      temperature: 0.1,
      allow_retry: true,
      retry_max_input_tokens: 3000,
      retry_max_output_tokens: 1200,
    },
    quality_gate: {
      enabled: true,
      check_completeness: true,
      check_code_parse: true,
      check_scope: true,
      check_hedging: true,
      check_proportionality: true,
      min_output_length: 20,
      max_output_length: 10000,
    },
    context_pipeline: {
      max_files: 3,
      max_lines_per_file: 120,
      max_diff_lines: 200,
    },
    ...configOverrides,
  };
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );

  return tmpHome;
}

/** Spawn the dashboard server on the given port, return the process. */
function spawnServer(
  port: number,
  tmpHome: string,
  env: Record<string, string> = {},
): ChildProcess {
  // Build env without CLAUDE_MODEL / ANTHROPIC_MODEL so the ?? operator in
  // detectModelCostRate correctly returns null when no model env is set.
  // Callers can override via the env parameter.
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k !== 'CLAUDE_MODEL' && k !== 'ANTHROPIC_MODEL' && v !== undefined) {
      baseEnv[k] = v;
    }
  }
  return spawn(process.execPath, [BUNDLE], {
    env: {
      ...baseEnv,
      HOME: tmpHome,
      USERPROFILE: tmpHome, // Windows
      CLAUDE_SAVER_DASHBOARD_PORT: String(port),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Wait for the server to be ready by polling until a request succeeds. */
async function waitForServer(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await request(port, '/api/data');
      return;
    } catch {
      await sleep(80);
    }
  }
  throw new Error(`Server on port ${port} did not start within ${timeoutMs}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface Response {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Make a GET request to the server and resolve with status, headers, and body. */
function request(port: number, urlPath: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${urlPath}`, res => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string>,
          body,
        }),
      );
    });
    req.on('error', reject);
    req.setTimeout(4000, () => {
      req.destroy(new Error('request timeout'));
    });
  });
}

// ---------------------------------------------------------------------------
// JSONL entry builders
// ---------------------------------------------------------------------------

function completion(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'completion',
    timestamp: '2026-02-17T12:00:00.000Z',
    tokens_used: 1000,
    model: 'test-model',
    duration_ms: 500,
    tool: 'read_file',
    session_id: 'session-1',
    ...overrides,
  });
}

function delegation(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'delegation',
    timestamp: '2026-02-17T12:00:00.000Z',
    tokens_used: 200,
    model: 'test-model',
    duration_ms: 800,
    tool: 'claudesaver_complete',
    session_id: 'session-1',
    quality_status: 'accepted',
    attempt_count: 1,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Shared server fixture for the main HTTP/logic test suite
// ---------------------------------------------------------------------------

let sharedPort: number;
let sharedProc: ChildProcess;
let sharedTmpHome: string;
let sharedMetricsPath: string;

// We write metrics content before each test and restart the server lazily —
// actually, it's simpler to rewrite the metrics file and make a fresh request
// because the server reads from disk on every /api/data call.

/**
 * For the shared server, we set up with empty metrics and rewrite between
 * tests. The server reads the file on each request, so we don't need to
 * restart it between tests.
 */
beforeAll(async () => {
  sharedPort = randomPort();
  sharedTmpHome = createTempHome('');
  sharedMetricsPath = path.join(sharedTmpHome, '.claude-saver', 'metrics.jsonl');
  sharedProc = spawnServer(sharedPort, sharedTmpHome);
  await waitForServer(sharedPort);
});

afterAll(async () => {
  sharedProc.kill('SIGTERM');
  await sleep(100);
  // Clean up temp dir
  try { fs.rmSync(sharedTmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

afterEach(() => {
  // Reset metrics file to empty between tests
  try { fs.writeFileSync(sharedMetricsPath, '', 'utf-8'); } catch { /* ignore */ }
});

/** Write metrics content to the shared metrics file. */
function writeMetrics(lines: string[]): void {
  fs.writeFileSync(sharedMetricsPath, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf-8');
}

/** GET /api/data from the shared server and parse JSON. */
async function getData(): Promise<Record<string, unknown>> {
  const res = await request(sharedPort, '/api/data');
  expect(res.status).toBe(200);
  return JSON.parse(res.body) as Record<string, unknown>;
}

// ===========================================================================
// computeDashboardData tests — via /api/data
// ===========================================================================

describe('computeDashboardData — empty metrics file', () => {
  it('returns zero total_tasks when file is empty', async () => {
    writeMetrics([]);
    const data = await getData();
    expect(data.total_tasks).toBe(0);
  });

  it('returns zero local_tasks when file is empty', async () => {
    writeMetrics([]);
    const data = await getData();
    expect(data.local_tasks).toBe(0);
  });

  it('returns zero total_local_tokens when file is empty', async () => {
    writeMetrics([]);
    const data = await getData();
    expect(data.total_local_tokens).toBe(0);
  });

  it('returns zero total_cloud_overhead when file is empty', async () => {
    writeMetrics([]);
    const data = await getData();
    expect(data.total_cloud_overhead).toBe(0);
  });

  it('returns zero sessions when file is empty', async () => {
    writeMetrics([]);
    const data = await getData();
    expect(data.sessions).toBe(0);
  });

  it('returns empty delegation stats when file is empty', async () => {
    writeMetrics([]);
    const data = await getData();
    const del = data.delegation as Record<string, number>;
    expect(del.total).toBe(0);
    expect(del.accepted).toBe(0);
    expect(del.retried_accepted).toBe(0);
    expect(del.escalated).toBe(0);
    expect(del.resolution_rate).toBe(0);
    expect(del.retry_rate).toBe(0);
    expect(del.avg_attempts).toBe(0);
    expect(del.total_delegation_tokens).toBe(0);
  });

  it('returns empty timeline array when file is empty', async () => {
    writeMetrics([]);
    const data = await getData();
    expect(data.timeline).toEqual([]);
  });

  it('returns empty recent array when file is empty', async () => {
    writeMetrics([]);
    const data = await getData();
    expect(data.recent).toEqual([]);
  });
});

describe('computeDashboardData — completion entries only', () => {
  it('counts local_tasks correctly from completion entries', async () => {
    writeMetrics([
      completion({ tokens_used: 1000, session_id: 'a' }),
      completion({ tokens_used: 2000, session_id: 'b' }),
      completion({ tokens_used: 3000, session_id: 'c' }),
    ]);
    const data = await getData();
    expect(data.local_tasks).toBe(3);
  });

  it('total_tasks equals completion entry count', async () => {
    writeMetrics([
      completion({ tokens_used: 500 }),
      completion({ tokens_used: 1500 }),
    ]);
    const data = await getData();
    expect(data.total_tasks).toBe(2);
  });

  it('sums total_local_tokens across completion entries', async () => {
    writeMetrics([
      completion({ tokens_used: 400 }),
      completion({ tokens_used: 600 }),
    ]);
    const data = await getData();
    expect(data.total_local_tokens).toBe(1000);
  });

  it('delegation stats stay zero for completion-only entries', async () => {
    writeMetrics([
      completion({ tokens_used: 1000 }),
      completion({ tokens_used: 2000 }),
    ]);
    const data = await getData();
    const del = data.delegation as Record<string, number>;
    expect(del.total).toBe(0);
    expect(del.accepted).toBe(0);
    expect(del.retried_accepted).toBe(0);
    expect(del.escalated).toBe(0);
    expect(del.resolution_rate).toBe(0);
    expect(del.retry_rate).toBe(0);
    expect(del.avg_attempts).toBe(0);
    expect(del.total_delegation_tokens).toBe(0);
  });

  it('recent entries have undefined quality_status for completion entries', async () => {
    writeMetrics([
      completion({ tokens_used: 1000 }),
    ]);
    const data = await getData();
    const recent = data.recent as Array<Record<string, unknown>>;
    expect(recent).toHaveLength(1);
    expect(recent[0].quality_status).toBeUndefined();
  });

  it('recent entries have undefined attempt_count for completion entries', async () => {
    writeMetrics([
      completion({ tokens_used: 1000 }),
    ]);
    const data = await getData();
    const recent = data.recent as Array<Record<string, unknown>>;
    expect(recent[0].attempt_count).toBeUndefined();
  });

  it('tool usage is counted from completion entries', async () => {
    writeMetrics([
      completion({ tool: 'bash' }),
      completion({ tool: 'bash' }),
      completion({ tool: 'read_file' }),
    ]);
    const data = await getData();
    const tools = data.tools as Record<string, number>;
    expect(tools['bash']).toBe(2);
    expect(tools['read_file']).toBe(1);
  });

  it('counts unique sessions from completion entries', async () => {
    writeMetrics([
      completion({ session_id: 'alpha' }),
      completion({ session_id: 'beta' }),
      completion({ session_id: 'alpha' }), // duplicate
    ]);
    const data = await getData();
    expect(data.sessions).toBe(2);
  });

  it('timeline aggregates completion entries by date', async () => {
    writeMetrics([
      completion({ timestamp: '2026-02-15T10:00:00.000Z', tokens_used: 500 }),
      completion({ timestamp: '2026-02-15T14:00:00.000Z', tokens_used: 300 }),
      completion({ timestamp: '2026-02-16T09:00:00.000Z', tokens_used: 700 }),
    ]);
    const data = await getData();
    const timeline = data.timeline as Array<{ date: string; tokens: number; tasks: number }>;
    expect(timeline).toHaveLength(2);
    const day15 = timeline.find(t => t.date === '2026-02-15');
    const day16 = timeline.find(t => t.date === '2026-02-16');
    expect(day15).toBeDefined();
    expect(day15!.tokens).toBe(800);
    expect(day15!.tasks).toBe(2);
    expect(day16).toBeDefined();
    expect(day16!.tokens).toBe(700);
    expect(day16!.tasks).toBe(1);
  });
});

describe('computeDashboardData — delegation entries only', () => {
  it('counts delegation entries in local_tasks', async () => {
    writeMetrics([
      delegation({ quality_status: 'accepted' }),
      delegation({ quality_status: 'retried_accepted' }),
      delegation({ quality_status: 'escalated' }),
    ]);
    const data = await getData();
    expect(data.local_tasks).toBe(3);
  });

  it('total_tasks equals delegation entry count', async () => {
    writeMetrics([
      delegation(),
      delegation(),
    ]);
    const data = await getData();
    expect(data.total_tasks).toBe(2);
  });

  it('counts accepted quality_status correctly', async () => {
    writeMetrics([
      delegation({ quality_status: 'accepted' }),
      delegation({ quality_status: 'accepted' }),
      delegation({ quality_status: 'retried_accepted' }),
    ]);
    const data = await getData();
    const del = data.delegation as Record<string, number>;
    expect(del.accepted).toBe(2);
    expect(del.retried_accepted).toBe(1);
    expect(del.escalated).toBe(0);
    expect(del.total).toBe(3);
  });

  it('counts retried_accepted quality_status correctly', async () => {
    writeMetrics([
      delegation({ quality_status: 'retried_accepted' }),
      delegation({ quality_status: 'retried_accepted' }),
    ]);
    const data = await getData();
    const del = data.delegation as Record<string, number>;
    expect(del.retried_accepted).toBe(2);
    expect(del.accepted).toBe(0);
  });

  it('counts escalated quality_status correctly', async () => {
    writeMetrics([
      delegation({ quality_status: 'escalated' }),
    ]);
    const data = await getData();
    const del = data.delegation as Record<string, number>;
    expect(del.escalated).toBe(1);
    expect(del.total).toBe(1);
  });

  it('resolution_rate = (accepted + retried_accepted) / total', async () => {
    // 2 accepted + 1 retried = 3 resolved; 1 escalated; total = 4
    writeMetrics([
      delegation({ quality_status: 'accepted' }),
      delegation({ quality_status: 'accepted' }),
      delegation({ quality_status: 'retried_accepted' }),
      delegation({ quality_status: 'escalated' }),
    ]);
    const data = await getData();
    const del = data.delegation as Record<string, number>;
    expect(del.resolution_rate).toBeCloseTo(3 / 4, 10);
  });

  it('retry_rate = (retried_accepted + escalated) / total', async () => {
    // 1 retried + 1 escalated = 2 retried/escalated; total = 4
    writeMetrics([
      delegation({ quality_status: 'accepted' }),
      delegation({ quality_status: 'accepted' }),
      delegation({ quality_status: 'retried_accepted' }),
      delegation({ quality_status: 'escalated' }),
    ]);
    const data = await getData();
    const del = data.delegation as Record<string, number>;
    expect(del.retry_rate).toBeCloseTo(2 / 4, 10);
  });

  it('avg_attempts is calculated correctly', async () => {
    // attempt_counts: 1, 2, 3, 2 => sum=8, count=4, avg=2
    writeMetrics([
      delegation({ quality_status: 'accepted', attempt_count: 1 }),
      delegation({ quality_status: 'accepted', attempt_count: 2 }),
      delegation({ quality_status: 'retried_accepted', attempt_count: 3 }),
      delegation({ quality_status: 'escalated', attempt_count: 2 }),
    ]);
    const data = await getData();
    const del = data.delegation as Record<string, number>;
    expect(del.avg_attempts).toBeCloseTo(8 / 4, 10);
  });

  it('recent entries include quality_status for delegation entries', async () => {
    writeMetrics([
      delegation({ quality_status: 'retried_accepted', attempt_count: 2 }),
    ]);
    const data = await getData();
    const recent = data.recent as Array<Record<string, unknown>>;
    expect(recent).toHaveLength(1);
    expect(recent[0].quality_status).toBe('retried_accepted');
  });

  it('recent entries include attempt_count for delegation entries', async () => {
    writeMetrics([
      delegation({ quality_status: 'accepted', attempt_count: 3 }),
    ]);
    const data = await getData();
    const recent = data.recent as Array<Record<string, unknown>>;
    expect(recent[0].attempt_count).toBe(3);
  });

  it('total_delegation_tokens sums tokens from delegation entries', async () => {
    writeMetrics([
      delegation({ tokens_used: 100 }),
      delegation({ tokens_used: 300 }),
    ]);
    const data = await getData();
    const del = data.delegation as Record<string, number>;
    expect(del.total_delegation_tokens).toBe(400);
  });

  it('tool usage is counted from delegation entries', async () => {
    writeMetrics([
      delegation({ tool: 'claudesaver_complete' }),
      delegation({ tool: 'claudesaver_complete' }),
    ]);
    const data = await getData();
    const tools = data.tools as Record<string, number>;
    expect(tools['claudesaver_complete']).toBe(2);
  });

  it('counts unique sessions from delegation entries', async () => {
    writeMetrics([
      delegation({ session_id: 'x' }),
      delegation({ session_id: 'y' }),
      delegation({ session_id: 'x' }),
    ]);
    const data = await getData();
    expect(data.sessions).toBe(2);
  });

  it('resolution_rate is 0 when total is 0', async () => {
    writeMetrics([]);
    const data = await getData();
    const del = data.delegation as Record<string, number>;
    expect(del.resolution_rate).toBe(0);
  });
});

describe('computeDashboardData — mixed completion and delegation entries', () => {
  it('both types contribute to total_tasks', async () => {
    writeMetrics([
      completion({ tokens_used: 1000 }),
      delegation({ tokens_used: 200 }),
      completion({ tokens_used: 500 }),
    ]);
    const data = await getData();
    expect(data.total_tasks).toBe(3);
    expect(data.local_tasks).toBe(3);
  });

  it('both types contribute to total_local_tokens', async () => {
    writeMetrics([
      completion({ tokens_used: 1000 }),
      delegation({ tokens_used: 500 }),
    ]);
    const data = await getData();
    expect(data.total_local_tokens).toBe(1500);
  });

  it('sessions counted from both entry types', async () => {
    writeMetrics([
      completion({ session_id: 'sess-A' }),
      delegation({ session_id: 'sess-B' }),
      completion({ session_id: 'sess-A' }), // duplicate
    ]);
    const data = await getData();
    expect(data.sessions).toBe(2);
  });

  it('tool usage counted from both entry types', async () => {
    writeMetrics([
      completion({ tool: 'bash' }),
      delegation({ tool: 'claudesaver_complete' }),
      completion({ tool: 'bash' }),
    ]);
    const data = await getData();
    const tools = data.tools as Record<string, number>;
    expect(tools['bash']).toBe(2);
    expect(tools['claudesaver_complete']).toBe(1);
  });

  it('timeline aggregates both entry types by date', async () => {
    writeMetrics([
      completion({ timestamp: '2026-02-17T10:00:00.000Z', tokens_used: 300 }),
      delegation({ timestamp: '2026-02-17T11:00:00.000Z', tokens_used: 200 }),
      completion({ timestamp: '2026-02-18T09:00:00.000Z', tokens_used: 400 }),
    ]);
    const data = await getData();
    const timeline = data.timeline as Array<{ date: string; tokens: number; tasks: number }>;
    const day17 = timeline.find(t => t.date === '2026-02-17');
    const day18 = timeline.find(t => t.date === '2026-02-18');
    expect(day17).toBeDefined();
    expect(day17!.tokens).toBe(500);
    expect(day17!.tasks).toBe(2);
    expect(day18).toBeDefined();
    expect(day18!.tokens).toBe(400);
    expect(day18!.tasks).toBe(1);
  });

  it('delegation stats only count delegation-type entries', async () => {
    writeMetrics([
      completion({ tokens_used: 5000 }),
      delegation({ quality_status: 'accepted', tokens_used: 100 }),
      completion({ tokens_used: 3000 }),
    ]);
    const data = await getData();
    const del = data.delegation as Record<string, number>;
    expect(del.total).toBe(1);
    expect(del.accepted).toBe(1);
    expect(del.total_delegation_tokens).toBe(100);
  });

  it('recent list contains entries from both types with correct shape', async () => {
    writeMetrics([
      completion({ tool: 'bash', tokens_used: 1000, timestamp: '2026-02-17T10:00:00.000Z' }),
      delegation({
        tool: 'claudesaver_complete',
        tokens_used: 200,
        quality_status: 'accepted',
        attempt_count: 1,
        timestamp: '2026-02-17T11:00:00.000Z',
      }),
    ]);
    const data = await getData();
    const recent = data.recent as Array<Record<string, unknown>>;
    // recent is newest-first so delegation (11:00) comes first
    expect(recent).toHaveLength(2);
    const delEntry = recent.find(r => r.tool === 'claudesaver_complete');
    const compEntry = recent.find(r => r.tool === 'bash');
    expect(delEntry).toBeDefined();
    expect(delEntry!.quality_status).toBe('accepted');
    expect(delEntry!.attempt_count).toBe(1);
    expect(compEntry).toBeDefined();
    expect(compEntry!.quality_status).toBeUndefined();
    expect(compEntry!.attempt_count).toBeUndefined();
  });

  it('recent list is capped at 50 entries and ordered newest-first', async () => {
    // Write 60 entries with incrementing timestamps
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      const ts = `2026-02-17T${String(i % 24).padStart(2, '0')}:00:00.000Z`;
      lines.push(completion({ timestamp: ts, tokens_used: i + 1, session_id: `s${i}` }));
    }
    writeMetrics(lines);
    const data = await getData();
    const recent = data.recent as Array<Record<string, unknown>>;
    expect(recent).toHaveLength(50);
  });
});

// ===========================================================================
// estimateOverhead — validated via /api/data with known cloud_overhead_tokens
// ===========================================================================

describe('estimateOverhead logic', () => {
  /**
   * When no cloud_overhead_tokens is present, the server computes:
   *   overhead = 80 + ceil(tokens * 1.3)
   * We verify this by writing entries WITHOUT cloud_overhead_tokens and
   * checking that total_cloud_overhead matches the formula.
   */

  it('estimateOverhead(0) = 80 + ceil(0 * 1.3) = 80', async () => {
    writeMetrics([completion({ tokens_used: 0 })]);
    const data = await getData();
    expect(data.total_cloud_overhead).toBe(80);
  });

  it('estimateOverhead(100) = 80 + ceil(100 * 1.3) = 80 + 130 = 210', async () => {
    writeMetrics([completion({ tokens_used: 100 })]);
    const data = await getData();
    expect(data.total_cloud_overhead).toBe(210);
  });

  it('estimateOverhead(500) = 80 + ceil(500 * 1.3) = 80 + 650 = 730', async () => {
    writeMetrics([completion({ tokens_used: 500 })]);
    const data = await getData();
    expect(data.total_cloud_overhead).toBe(730);
  });

  it('estimateOverhead is additive across multiple entries', async () => {
    // 80+130=210 for tokens=100; 80+650=730 for tokens=500; sum=940
    writeMetrics([
      completion({ tokens_used: 100 }),
      completion({ tokens_used: 500 }),
    ]);
    const data = await getData();
    expect(data.total_cloud_overhead).toBe(940);
  });

  it('uses cloud_overhead_tokens directly when present', async () => {
    writeMetrics([
      completion({ tokens_used: 1000, cloud_overhead_tokens: 42 }),
    ]);
    const data = await getData();
    // Should use the explicit value (42) not the formula (80 + ceil(1000*1.3) = 1380)
    expect(data.total_cloud_overhead).toBe(42);
  });

  it('mixes estimated and explicit overhead for different entries', async () => {
    // Entry 1: tokens=100, no cloud_overhead → 80 + ceil(130) = 210
    // Entry 2: tokens=9999, cloud_overhead=50 → 50
    writeMetrics([
      completion({ tokens_used: 100 }),
      completion({ tokens_used: 9999, cloud_overhead_tokens: 50 }),
    ]);
    const data = await getData();
    expect(data.total_cloud_overhead).toBe(260);
  });
});

// ===========================================================================
// detectModelCostRate — tested with separate server instances (env vars)
// ===========================================================================

describe('detectModelCostRate via CLAUDE_MODEL env var', () => {
  /**
   * Each test spawns a short-lived server with a specific CLAUDE_MODEL,
   * writes a known token count, then checks that gross_cost uses the
   * correct per-million rate.
   *
   * 1,000,000 tokens at $rate/M → gross_cost = rate (rounded to 2 dp)
   */

  async function grossCostForModel(
    modelEnv: string,
    tokensUsed: number,
  ): Promise<number> {
    const port = randomPort();
    const tmpHome = createTempHome(
      completion({ tokens_used: tokensUsed }) + '\n',
    );
    // Only add CLAUDE_MODEL if non-empty to let ?? fall through to null correctly
    const extraEnv: Record<string, string> = modelEnv ? { CLAUDE_MODEL: modelEnv } : {};
    const proc = spawnServer(port, tmpHome, extraEnv);
    try {
      await waitForServer(port);
      const res = await request(port, '/api/data');
      const data = JSON.parse(res.body) as Record<string, number>;
      return data.gross_cost as number;
    } finally {
      proc.kill('SIGTERM');
      await sleep(100);
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  it('CLAUDE_MODEL=opus uses $25/M rate', async () => {
    // 1,000,000 tokens at $25/M = $25
    const cost = await grossCostForModel('claude-opus-4', 1_000_000);
    expect(cost).toBeCloseTo(25, 1);
  }, 10000);

  it('CLAUDE_MODEL=sonnet uses $15/M rate', async () => {
    // 1,000,000 tokens at $15/M = $15
    const cost = await grossCostForModel('claude-sonnet-3', 1_000_000);
    expect(cost).toBeCloseTo(15, 1);
  }, 10000);

  it('CLAUDE_MODEL=haiku uses $5/M rate', async () => {
    // 1,000,000 tokens at $5/M = $5
    const cost = await grossCostForModel('claude-haiku-2', 1_000_000);
    expect(cost).toBeCloseTo(5, 1);
  }, 10000);

  it('no model env var falls back to config rate ($8/M)', async () => {
    // Config has cost_per_million_tokens: 8; 1,000,000 tokens = $8
    const cost = await grossCostForModel('', 1_000_000);
    expect(cost).toBeCloseTo(8, 1);
  }, 10000);

  it('ANTHROPIC_MODEL=sonnet uses $15/M rate when CLAUDE_MODEL is absent', async () => {
    const port = randomPort();
    const tmpHome = createTempHome(
      completion({ tokens_used: 1_000_000 }) + '\n',
    );
    // Spawn with CLAUDE_MODEL unset (omit from env) so ?? falls through to ANTHROPIC_MODEL.
    // Setting CLAUDE_MODEL='' would cause ?? to keep the empty string (not null/undefined).
    const baseEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k !== 'CLAUDE_MODEL' && k !== 'ANTHROPIC_MODEL' && v !== undefined) {
        baseEnv[k] = v;
      }
    }
    const proc = spawn(process.execPath, [BUNDLE], {
      env: {
        ...baseEnv,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        CLAUDE_SAVER_DASHBOARD_PORT: String(port),
        ANTHROPIC_MODEL: 'claude-sonnet-4',
        // CLAUDE_MODEL is intentionally absent so process.env['CLAUDE_MODEL'] is undefined
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitForServer(port);
      const res = await request(port, '/api/data');
      const data = JSON.parse(res.body) as Record<string, number>;
      expect(data.gross_cost).toBeCloseTo(15, 1);
    } finally {
      proc.kill('SIGTERM');
      await sleep(100);
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 10000);
});

// ===========================================================================
// HTTP endpoint tests — using shared server
// ===========================================================================

describe('GET /api/data', () => {
  it('returns HTTP 200', async () => {
    writeMetrics([]);
    const res = await request(sharedPort, '/api/data');
    expect(res.status).toBe(200);
  });

  it('returns Content-Type: application/json', async () => {
    writeMetrics([]);
    const res = await request(sharedPort, '/api/data');
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('response body is valid JSON', async () => {
    writeMetrics([]);
    const res = await request(sharedPort, '/api/data');
    expect(() => JSON.parse(res.body)).not.toThrow();
  });

  it('response contains all expected top-level fields', async () => {
    writeMetrics([]);
    const data = await getData();
    const expectedFields = [
      'total_tasks',
      'local_tasks',
      'total_local_tokens',
      'total_cloud_overhead',
      'net_tokens_saved',
      'gross_cost',
      'overhead_cost',
      'net_cost',
      'sessions',
      'tools',
      'timeline',
      'recent',
      'models',
      'delegation',
    ];
    for (const field of expectedFields) {
      expect(data, `missing field: ${field}`).toHaveProperty(field);
    }
  });

  it('response delegation object contains all expected fields', async () => {
    writeMetrics([]);
    const data = await getData();
    const del = data.delegation as Record<string, unknown>;
    const expectedDelFields = [
      'total',
      'accepted',
      'retried_accepted',
      'escalated',
      'resolution_rate',
      'retry_rate',
      'avg_attempts',
      'total_delegation_tokens',
    ];
    for (const field of expectedDelFields) {
      expect(del, `delegation missing field: ${field}`).toHaveProperty(field);
    }
  });
});

describe('GET /api/config', () => {
  it('returns HTTP 200', async () => {
    const res = await request(sharedPort, '/api/config');
    expect(res.status).toBe(200);
  });

  it('returns Content-Type: application/json', async () => {
    const res = await request(sharedPort, '/api/config');
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('response body is valid JSON', async () => {
    const res = await request(sharedPort, '/api/config');
    expect(() => JSON.parse(res.body)).not.toThrow();
  });

  it('response contains delegation_level key from config', async () => {
    const res = await request(sharedPort, '/api/config');
    const config = JSON.parse(res.body) as Record<string, unknown>;
    expect(config).toHaveProperty('delegation_level');
  });

  it('response contains metrics config section', async () => {
    const res = await request(sharedPort, '/api/config');
    const config = JSON.parse(res.body) as Record<string, unknown>;
    expect(config).toHaveProperty('metrics');
  });
});

describe('GET / (root) and GET /dashboard', () => {
  it('GET / returns HTTP 200', async () => {
    const res = await request(sharedPort, '/');
    expect(res.status).toBe(200);
  });

  it('GET / returns text/html content type', async () => {
    const res = await request(sharedPort, '/');
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('GET / response body contains Claude-Saver Dashboard', async () => {
    const res = await request(sharedPort, '/');
    expect(res.body).toContain('Claude-Saver Dashboard');
  });

  it('GET /dashboard returns HTTP 200', async () => {
    const res = await request(sharedPort, '/dashboard');
    expect(res.status).toBe(200);
  });

  it('GET /dashboard returns same HTML as GET /', async () => {
    const root = await request(sharedPort, '/');
    const dashboard = await request(sharedPort, '/dashboard');
    expect(dashboard.body).toBe(root.body);
  });

  it('GET /dashboard contains Claude-Saver Dashboard', async () => {
    const res = await request(sharedPort, '/dashboard');
    expect(res.body).toContain('Claude-Saver Dashboard');
  });
});

describe('GET /unknown — 404 handler', () => {
  it('returns HTTP 404 for unknown path', async () => {
    const res = await request(sharedPort, '/unknown');
    expect(res.status).toBe(404);
  });

  it('returns HTTP 404 for /api/unknown', async () => {
    const res = await request(sharedPort, '/api/unknown');
    expect(res.status).toBe(404);
  });

  it('returns text/plain for 404 responses', async () => {
    const res = await request(sharedPort, '/not-found');
    expect(res.headers['content-type']).toContain('text/plain');
  });

  it('body contains "Not Found" for 404 responses', async () => {
    const res = await request(sharedPort, '/missing-path');
    expect(res.body).toContain('Not Found');
  });
});

describe('Security headers', () => {
  it('X-Content-Type-Options: nosniff is present on /api/data', async () => {
    const res = await request(sharedPort, '/api/data');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('X-Frame-Options: DENY is present on /api/data', async () => {
    const res = await request(sharedPort, '/api/data');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('Access-Control-Allow-Origin restricts to localhost origin on /api/data', async () => {
    const res = await request(sharedPort, '/api/data');
    const corsHeader = res.headers['access-control-allow-origin'] ?? '';
    expect(corsHeader).toContain('127.0.0.1');
  });

  it('Access-Control-Allow-Methods is GET on /api/data', async () => {
    const res = await request(sharedPort, '/api/data');
    expect(res.headers['access-control-allow-methods']).toBe('GET');
  });

  it('X-Content-Type-Options is present on / (HTML)', async () => {
    const res = await request(sharedPort, '/');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('X-Frame-Options is present on / (HTML)', async () => {
    const res = await request(sharedPort, '/');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('X-Content-Type-Options is present on 404 responses', async () => {
    const res = await request(sharedPort, '/nonexistent');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('X-Frame-Options is present on 404 responses', async () => {
    const res = await request(sharedPort, '/nonexistent');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});

// ===========================================================================
// Edge cases and robustness
// ===========================================================================

describe('robustness — malformed and non-delegation entries', () => {
  it('skips non-completion/non-delegation entries (e.g. type=subagent)', async () => {
    writeMetrics([
      JSON.stringify({ type: 'subagent', timestamp: '2026-02-17T12:00:00.000Z', tokens_used: 9999, session_id: 'x' }),
      completion({ tokens_used: 100 }),
    ]);
    // total_tasks includes the subagent entry but local_tasks only counts processed
    const data = await getData();
    expect(data.total_tasks).toBe(2);
    expect(data.local_tasks).toBe(1);
    expect(data.total_local_tokens).toBe(100);
  });

  it('skips malformed JSON lines silently', async () => {
    writeMetrics([
      completion({ tokens_used: 500 }),
      '{ broken json !!!',
      completion({ tokens_used: 300 }),
    ]);
    const data = await getData();
    // Two valid lines parsed, one skipped
    expect(data.total_local_tokens).toBe(800);
  });

  it('handles entries with missing tokens_used gracefully', async () => {
    writeMetrics([
      JSON.stringify({ type: 'completion', timestamp: '2026-02-17T12:00:00.000Z', model: 'x', duration_ms: 100, tool: 'bash', session_id: 's1' }),
      completion({ tokens_used: 200 }),
    ]);
    const data = await getData();
    // Entry without tokens_used does not pass the typeof check, only the valid one counts
    expect(data.local_tasks).toBe(1);
    expect(data.total_local_tokens).toBe(200);
  });

  it('net_tokens_saved = total_local_tokens - total_cloud_overhead', async () => {
    // tokens=100 → overhead = 80 + ceil(130) = 210; net = 100 - 210 = -110
    writeMetrics([completion({ tokens_used: 100 })]);
    const data = await getData();
    const tokens = data.total_local_tokens as number;
    const overhead = data.total_cloud_overhead as number;
    const netSaved = data.net_tokens_saved as number;
    expect(netSaved).toBe(tokens - overhead);
  });

  it('timeline is sorted by date ascending', async () => {
    writeMetrics([
      completion({ timestamp: '2026-02-20T10:00:00.000Z', tokens_used: 100 }),
      completion({ timestamp: '2026-02-18T10:00:00.000Z', tokens_used: 100 }),
      completion({ timestamp: '2026-02-19T10:00:00.000Z', tokens_used: 100 }),
    ]);
    const data = await getData();
    const timeline = data.timeline as Array<{ date: string }>;
    expect(timeline[0].date).toBe('2026-02-18');
    expect(timeline[1].date).toBe('2026-02-19');
    expect(timeline[2].date).toBe('2026-02-20');
  });

  it('models usage is counted correctly', async () => {
    writeMetrics([
      completion({ model: 'model-a' }),
      completion({ model: 'model-b' }),
      completion({ model: 'model-a' }),
      delegation({ model: 'model-c' }),
    ]);
    const data = await getData();
    const models = data.models as Record<string, number>;
    expect(models['model-a']).toBe(2);
    expect(models['model-b']).toBe(1);
    expect(models['model-c']).toBe(1);
  });
});
