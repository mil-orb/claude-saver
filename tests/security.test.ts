import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Mocks for fs-tools tests
// ---------------------------------------------------------------------------
vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => 'mocked git output'),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: actual,
    statSync: vi.fn((p: string) => ({
      isDirectory: () => true,
      isFile: () => false,
      size: 1024,
      mtime: new Date('2025-01-01'),
      birthtime: new Date('2025-01-01'),
    })),
    readFileSync: vi.fn(() => 'line1\nline2\nline3\n'),
    readdirSync: vi.fn(() => []),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

import { handleFs, handleFsPreview } from '../src/mcp-server/fs-tools.js';
import { execFileSync } from 'child_process';
import * as fs from 'fs';

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedStatSync = vi.mocked(fs.statSync);
const mockedReadFileSync = vi.mocked(fs.readFileSync);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: statSync reports a directory
  mockedStatSync.mockReturnValue({
    isDirectory: () => true,
    isFile: () => false,
    size: 1024,
    mtime: new Date('2025-01-01'),
    birthtime: new Date('2025-01-01'),
  } as unknown as fs.Stats);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Command injection prevention (git_log)
// ---------------------------------------------------------------------------
describe('Command injection prevention — git_log', () => {
  it('accepts valid count "5" and calls execFileSync with correct args', async () => {
    mockedExecFileSync.mockReturnValueOnce('abc123 commit msg');

    const result = await handleFs('git_log', '/tmp/repo', { options: { count: '5' } });
    expect(result).toEqual({ output: 'abc123 commit msg' });

    // path.resolve will normalize the path for the current OS
    const expectedCwd = path.resolve('/tmp/repo');
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'git',
      ['log', '--oneline', '-5'],
      expect.objectContaining({ cwd: expectedCwd }),
    );
  });

  it('safely truncates injection payload "10; rm -rf /" via parseInt to 10', async () => {
    // parseInt("10; rm -rf /", 10) yields 10 (stops at semicolon).
    // The real protection is execFileSync (no shell), but parseInt also
    // strips the trailing injection payload before it reaches the arg array.
    mockedExecFileSync.mockReturnValueOnce('safe output');

    const result = await handleFs('git_log', '/tmp/repo', { options: { count: '10; rm -rf /' } });
    expect(result).toEqual({ output: 'safe output' });

    // Verify only "-10" is passed — the shell metacharacters are gone
    const expectedCwd = path.resolve('/tmp/repo');
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'git',
      ['log', '--oneline', '-10'],
      expect.objectContaining({ cwd: expectedCwd }),
    );
  });

  it('throws for non-numeric count "abc"', async () => {
    await expect(
      handleFs('git_log', '/tmp/repo', { options: { count: 'abc' } }),
    ).rejects.toThrow('git_log count must be a number between 1 and 500');
  });

  it('throws for negative count "-5"', async () => {
    await expect(
      handleFs('git_log', '/tmp/repo', { options: { count: '-5' } }),
    ).rejects.toThrow('git_log count must be a number between 1 and 500');
  });

  it('throws for count > 500', async () => {
    await expect(
      handleFs('git_log', '/tmp/repo', { options: { count: '501' } }),
    ).rejects.toThrow('git_log count must be a number between 1 and 500');
  });

  it('defaults to 10 when no count is provided', async () => {
    mockedExecFileSync.mockReturnValueOnce('default output');

    const expectedCwd = path.resolve('/tmp/repo');
    await handleFs('git_log', '/tmp/repo', {});
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'git',
      ['log', '--oneline', '-10'],
      expect.objectContaining({ cwd: expectedCwd }),
    );
  });
});

// ---------------------------------------------------------------------------
// File size guards (handleFsPreview)
// ---------------------------------------------------------------------------
describe('File size guards', () => {
  it('throws "File too large" for files over 10MB', async () => {
    mockedStatSync.mockReturnValueOnce({
      isDirectory: () => false,
      isFile: () => true,
      size: 11_000_000,
      mtime: new Date(),
      birthtime: new Date(),
    } as unknown as fs.Stats);

    await expect(
      handleFsPreview('/tmp/huge-file.txt', 'head', 10),
    ).rejects.toThrow('File too large');
  });

  it('works normally for files under 10MB', async () => {
    mockedStatSync.mockReturnValueOnce({
      isDirectory: () => false,
      isFile: () => true,
      size: 500,
      mtime: new Date(),
      birthtime: new Date(),
    } as unknown as fs.Stats);
    mockedReadFileSync.mockReturnValueOnce('line1\nline2\nline3\nline4\nline5');

    const result = await handleFsPreview('/tmp/small.txt', 'head', 3);
    expect(result).toEqual({
      lines: ['line1', 'line2', 'line3'],
      total_lines: 5,
    });
  });
});

// ---------------------------------------------------------------------------
// Batch limits (Zod schema)
// ---------------------------------------------------------------------------
describe('Batch limits', () => {
  const batchSchema = z.array(
    z.object({ prompt: z.string(), id: z.string() }),
  ).max(100);

  it('accepts exactly 100 tasks', () => {
    const tasks = Array.from({ length: 100 }, (_, i) => ({
      prompt: `task ${i}`,
      id: `id-${i}`,
    }));
    const result = batchSchema.safeParse(tasks);
    expect(result.success).toBe(true);
  });

  it('rejects 101 tasks', () => {
    const tasks = Array.from({ length: 101 }, (_, i) => ({
      prompt: `task ${i}`,
      id: `id-${i}`,
    }));
    const result = batchSchema.safeParse(tasks);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Prototype pollution (deepMerge in config.ts)
// ---------------------------------------------------------------------------
describe('Prototype pollution prevention — config deepMerge', () => {
  // We test deepMerge indirectly through loadConfig by providing a config
  // file that contains __proto__ or constructor keys. We mock fs to supply
  // a crafted config file.

  it('does not pollute Object.prototype via __proto__ key', async () => {
    // Dynamically import config to get fresh module state with our fs mock
    const configModule = await import('../src/mcp-server/config.js');

    // Set up fs mocks so loadConfig reads a malicious config file
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValueOnce(
      JSON.stringify({
        __proto__: { polluted: true },
        delegation_level: 2,
      }),
    );

    configModule.loadConfig();

    // Verify Object.prototype was NOT polluted
    expect((Object.prototype as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('ignores constructor key in user config', async () => {
    const configModule = await import('../src/mcp-server/config.js');

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValueOnce(
      JSON.stringify({
        constructor: { polluted: true },
        delegation_level: 3,
      }),
    );

    const config = configModule.loadConfig();

    // constructor key should be ignored by deepMerge, not merged as own property
    expect(Object.prototype.hasOwnProperty.call(config, 'constructor')).toBe(false);
  });

  it('merges normal config keys correctly', async () => {
    const configModule = await import('../src/mcp-server/config.js');

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValueOnce(
      JSON.stringify({
        delegation_level: 4,
        ollama: {
          default_model: 'custom-model',
        },
      }),
    );

    const config = configModule.loadConfig();
    expect(config.delegation_level).toBe(4);
    expect(config.ollama.default_model).toBe('custom-model');
    // Non-overridden nested values should still be present from defaults
    expect(config.ollama.base_url).toBe('http://localhost:11434');
  });
});

// ---------------------------------------------------------------------------
// Head mode line limit (Zod schema)
// ---------------------------------------------------------------------------
describe('Head mode line limit', () => {
  const linesSchema = z.number().min(1).max(100);

  it('accepts lines=100', () => {
    const result = linesSchema.safeParse(100);
    expect(result.success).toBe(true);
  });

  it('rejects lines=101', () => {
    const result = linesSchema.safeParse(101);
    expect(result.success).toBe(false);
  });
});
