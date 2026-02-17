import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock fs and os before importing the module under test
// ---------------------------------------------------------------------------
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: vi.fn(() => '/mock-home'),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  logCompletion,
  resetMetrics,
  loadMetrics,
  type CompletionEntry,
} from '../src/mcp-server/metrics.js';

// ---------------------------------------------------------------------------
// Constants — use path.join so the expected value matches the platform separator
// ---------------------------------------------------------------------------
const EXPECTED_METRICS_PATH = path.join(
  '/mock-home',
  '.claudesaver',
  'metrics.jsonl',
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function defaultEntry() {
  return {
    tokens_used: 1500,
    model: 'llama3',
    duration_ms: 320,
    tool: 'read_file',
  };
}

/** Parse what was passed to appendFileSync and return the JSON object. */
function getAppendedRecord(callIndex = 0): CompletionEntry {
  const calls = vi.mocked(fs.appendFileSync).mock.calls;
  expect(calls.length).toBeGreaterThan(callIndex);
  const raw = calls[callIndex][1] as string;
  return JSON.parse(raw.trimEnd()) as CompletionEntry;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.resetAllMocks();
  // Default: directory already exists so ensureDir skips mkdirSync
  vi.mocked(fs.existsSync).mockReturnValue(true);
  // Clean env
  delete process.env['CLAUDE_SESSION_ID'];
});

afterEach(() => {
  delete process.env['CLAUDE_SESSION_ID'];
});

// ===========================================================================
// logCompletion
// ===========================================================================
describe('logCompletion', () => {
  // -----------------------------------------------------------------------
  // 1. Creates directory if it doesn't exist
  // -----------------------------------------------------------------------
  it('creates directory with recursive: true when it does not exist', () => {
    // First existsSync call is for ensureDir (directory check) -> false
    vi.mocked(fs.existsSync).mockReturnValue(false);

    logCompletion(defaultEntry());

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('.claudesaver'),
      { recursive: true },
    );
  });

  // -----------------------------------------------------------------------
  // 2. Appends valid JSONL to metrics file
  // -----------------------------------------------------------------------
  it('appends valid JSONL to the metrics file', () => {
    logCompletion(defaultEntry());

    expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
    const [filePath, data, encoding] = vi.mocked(fs.appendFileSync).mock.calls[0];
    expect(filePath).toBe(EXPECTED_METRICS_PATH);
    expect(encoding).toBe('utf-8');

    // The data should be parseable JSON followed by a newline
    const raw = data as string;
    expect(() => JSON.parse(raw.trimEnd())).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // 3. Written record has type: 'completion'
  // -----------------------------------------------------------------------
  it('sets type to "completion" on the written record', () => {
    logCompletion(defaultEntry());

    const record = getAppendedRecord();
    expect(record.type).toBe('completion');
  });

  // -----------------------------------------------------------------------
  // 4. Written record has ISO timestamp
  // -----------------------------------------------------------------------
  it('includes a valid ISO 8601 timestamp', () => {
    const before = new Date().toISOString();
    logCompletion(defaultEntry());
    const after = new Date().toISOString();

    const record = getAppendedRecord();
    expect(record.timestamp).toBeDefined();
    // Validate ISO format: parseable and within the before/after window
    const ts = new Date(record.timestamp);
    expect(ts.toISOString()).toBe(record.timestamp);
    expect(ts.getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    expect(ts.getTime()).toBeLessThanOrEqual(new Date(after).getTime());
  });

  // -----------------------------------------------------------------------
  // 5. Written record has correct tokens_used, model, duration_ms, tool
  // -----------------------------------------------------------------------
  it('writes correct tokens_used, model, duration_ms, and tool', () => {
    const entry = {
      tokens_used: 4200,
      model: 'codellama:13b',
      duration_ms: 1580,
      tool: 'bash',
    };

    logCompletion(entry);

    const record = getAppendedRecord();
    expect(record.tokens_used).toBe(4200);
    expect(record.model).toBe('codellama:13b');
    expect(record.duration_ms).toBe(1580);
    expect(record.tool).toBe('bash');
  });

  // -----------------------------------------------------------------------
  // 6. Uses CLAUDE_SESSION_ID from env, defaults to 'unknown'
  // -----------------------------------------------------------------------
  it('reads session_id from CLAUDE_SESSION_ID environment variable', () => {
    process.env['CLAUDE_SESSION_ID'] = 'session-abc-123';

    logCompletion(defaultEntry());

    const record = getAppendedRecord();
    expect(record.session_id).toBe('session-abc-123');
  });

  it('defaults session_id to "unknown" when CLAUDE_SESSION_ID is not set', () => {
    delete process.env['CLAUDE_SESSION_ID'];

    logCompletion(defaultEntry());

    const record = getAppendedRecord();
    expect(record.session_id).toBe('unknown');
  });

  // -----------------------------------------------------------------------
  // 7. Appends newline after each record
  // -----------------------------------------------------------------------
  it('appends a trailing newline after the JSON record', () => {
    logCompletion(defaultEntry());

    const raw = vi.mocked(fs.appendFileSync).mock.calls[0][1] as string;
    expect(raw.endsWith('\n')).toBe(true);
    // Exactly one newline at the end
    expect(raw).toMatch(/[^\n]\n$/);
  });

  // -----------------------------------------------------------------------
  // 8. Multiple calls append multiple lines
  // -----------------------------------------------------------------------
  it('appends one line per call across multiple invocations', () => {
    logCompletion({ tokens_used: 100, model: 'a', duration_ms: 10, tool: 'x' });
    logCompletion({ tokens_used: 200, model: 'b', duration_ms: 20, tool: 'y' });
    logCompletion({ tokens_used: 300, model: 'c', duration_ms: 30, tool: 'z' });

    expect(fs.appendFileSync).toHaveBeenCalledTimes(3);

    const r0 = getAppendedRecord(0);
    const r1 = getAppendedRecord(1);
    const r2 = getAppendedRecord(2);

    expect(r0.tokens_used).toBe(100);
    expect(r1.tokens_used).toBe(200);
    expect(r2.tokens_used).toBe(300);

    expect(r0.model).toBe('a');
    expect(r1.model).toBe('b');
    expect(r2.model).toBe('c');
  });

  // -----------------------------------------------------------------------
  // 9. Silently ignores write errors (fire-and-forget)
  // -----------------------------------------------------------------------
  it('does not throw when appendFileSync throws an error', () => {
    vi.mocked(fs.appendFileSync).mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => logCompletion(defaultEntry())).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // 10. Doesn't throw when mkdirSync throws
  // -----------------------------------------------------------------------
  it('does not throw when mkdirSync throws an error', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockImplementation(() => {
      throw new Error('permission denied');
    });

    expect(() => logCompletion(defaultEntry())).not.toThrow();
  });
});

// ===========================================================================
// resetMetrics
// ===========================================================================
describe('resetMetrics', () => {
  // -----------------------------------------------------------------------
  // 1. Writes empty string to existing metrics file
  // -----------------------------------------------------------------------
  it('writes empty string to the metrics file when it exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    resetMetrics();

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      EXPECTED_METRICS_PATH,
      '',
      'utf-8',
    );
  });

  // -----------------------------------------------------------------------
  // 2. Does nothing when file doesn't exist
  // -----------------------------------------------------------------------
  it('does not write when the metrics file does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    resetMetrics();

    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 3. Silently ignores errors
  // -----------------------------------------------------------------------
  it('does not throw when writeFileSync throws an error', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw new Error('read-only filesystem');
    });

    expect(() => resetMetrics()).not.toThrow();
  });

  it('does not throw when existsSync throws an error', () => {
    vi.mocked(fs.existsSync).mockImplementation(() => {
      throw new Error('stat failed');
    });

    expect(() => resetMetrics()).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // 4. After reset, file exists but is empty
  // -----------------------------------------------------------------------
  it('results in an empty file (verified via the write call argument)', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    resetMetrics();

    const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1];
    expect(writtenContent).toBe('');
  });
});

// ===========================================================================
// Integration: logCompletion + loadMetrics round-trip
// ===========================================================================
describe('logCompletion + loadMetrics round-trip', () => {
  // -----------------------------------------------------------------------
  // For round-trip tests we simulate the filesystem with a buffer that
  // accumulates appendFileSync writes and feeds them back via readFileSync.
  // -----------------------------------------------------------------------

  let fileBuffer: string;

  beforeEach(() => {
    fileBuffer = '';
    vi.resetAllMocks();

    // existsSync: directory exists, file exists after first write
    vi.mocked(fs.existsSync).mockImplementation(() => true);

    // appendFileSync accumulates into our buffer
    vi.mocked(fs.appendFileSync).mockImplementation(
      (_path: fs.PathOrFileDescriptor, data: string | Uint8Array) => {
        fileBuffer += data as string;
      },
    );

    // readFileSync returns current buffer contents
    vi.mocked(fs.readFileSync).mockImplementation(() => fileBuffer);

    // writeFileSync (used by resetMetrics) clears the buffer
    vi.mocked(fs.writeFileSync).mockImplementation(
      (_path: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView) => {
        fileBuffer = data as string;
      },
    );
  });

  // -----------------------------------------------------------------------
  // 1. logCompletion writes data that loadMetrics can read back
  // -----------------------------------------------------------------------
  it('logCompletion writes data that loadMetrics reads back correctly', () => {
    logCompletion({
      tokens_used: 2500,
      model: 'mistral:7b',
      duration_ms: 450,
      tool: 'write_file',
    });

    const entries = loadMetrics();

    expect(entries).toHaveLength(1);
    const entry = entries[0] as CompletionEntry;
    expect(entry.type).toBe('completion');
    expect(entry.tokens_used).toBe(2500);
    expect(entry.model).toBe('mistral:7b');
    expect(entry.duration_ms).toBe(450);
    expect(entry.tool).toBe('write_file');
  });

  // -----------------------------------------------------------------------
  // 2. Multiple logCompletion calls produce loadMetrics array
  // -----------------------------------------------------------------------
  it('multiple logCompletion calls produce a matching loadMetrics array', () => {
    logCompletion({ tokens_used: 100, model: 'a', duration_ms: 10, tool: 'bash' });
    logCompletion({ tokens_used: 200, model: 'b', duration_ms: 20, tool: 'read_file' });
    logCompletion({ tokens_used: 300, model: 'c', duration_ms: 30, tool: 'write_file' });

    const entries = loadMetrics();

    expect(entries).toHaveLength(3);
    expect((entries[0] as CompletionEntry).tokens_used).toBe(100);
    expect((entries[1] as CompletionEntry).tokens_used).toBe(200);
    expect((entries[2] as CompletionEntry).tokens_used).toBe(300);
    expect((entries[0] as CompletionEntry).model).toBe('a');
    expect((entries[1] as CompletionEntry).model).toBe('b');
    expect((entries[2] as CompletionEntry).model).toBe('c');
  });

  // -----------------------------------------------------------------------
  // 3. resetMetrics clears what logCompletion wrote
  // -----------------------------------------------------------------------
  it('resetMetrics clears all entries written by logCompletion', () => {
    logCompletion({ tokens_used: 500, model: 'x', duration_ms: 50, tool: 'bash' });
    logCompletion({ tokens_used: 600, model: 'y', duration_ms: 60, tool: 'bash' });

    // Verify data is present
    expect(loadMetrics()).toHaveLength(2);

    // Reset
    resetMetrics();

    // Verify data is cleared
    const afterReset = loadMetrics();
    expect(afterReset).toHaveLength(0);
  });
});
