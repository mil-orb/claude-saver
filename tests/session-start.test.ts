import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

// Mock fs before importing anything that uses it
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: vi.fn(() => actual.homedir()),
  };
});

import * as fs from 'fs';

const homedir = os.homedir();
const configPath = path.join(homedir, '.claude-saver', 'config.json');
const metricsPath = path.join(homedir, '.claude-saver', 'metrics.jsonl');

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Since session-start.ts is a standalone script with no exports, we
// re-implement the pure functions here for testing. These contain no I/O
// and their logic is self-contained — the I/O-dependent functions use
// mocked fs via the same reimplemented code that mirrors the source.
// ---------------------------------------------------------------------------

// -- Pure functions copied from src/hooks/session-start.ts -----------------

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

const LEVEL_NAMES: Record<number, string> = {
  0: 'Off', 1: 'Conservative', 2: 'Balanced',
  3: 'Aggressive', 4: 'Max Local', 5: 'Offline',
};

function getDelegationInstructions(level: number): string | null {
  switch (level) {
    case 0:
      return null;
    case 1:
      return [
        'DELEGATION L1: Trivial tasks only → local Ollama.',
        'claudesaver_fs → fs metadata | claudesaver_complete → docstrings, commit messages',
        'Escalate immediately if local output seems wrong.',
      ].join('\n');
    case 2:
      return [
        'DELEGATION L2: Routine coding tasks → local Ollama.',
        'claudesaver_fs → fs queries | claudesaver_complete → docs, comments, commits, format conversions | claudesaver_generate_code → boilerplate, scaffolding, clear-spec code | claudesaver_analyze_file → summaries, bug scanning',
        'Cloud: architecture decisions, debugging, security review, complex reasoning, opinion requests.',
      ].join('\n');
    case 3:
      return [
        'DELEGATION L3: Most coding tasks → local. Delegate aggressively.',
        'claudesaver_fs → fs | claudesaver_complete or claudesaver_generate_code → all codegen, docs, tests, refactoring | claudesaver_analyze_file → analysis, review | claudesaver_batch → parallel ops',
        'Cloud only: architecture decisions, complex multi-file debugging, security-critical review.',
      ].join('\n');
    case 4:
      return [
        'DELEGATION L4: Try ALL tasks locally first.',
        'claudesaver_complete → primary tool for all coding | claudesaver_fs → fs queries | claudesaver_analyze_file → file review | claudesaver_generate_code → code generation',
        'Cloud only if local output is poor or task needs broad codebase reasoning.',
      ].join('\n');
    case 5:
      return [
        'DELEGATION L5 — OFFLINE MODE. ALL tasks → local models.',
        'claudesaver_complete → prompts | claudesaver_fs → fs | claudesaver_generate_code → code | claudesaver_analyze_file → analysis',
        'On failure: report the failure to user. Do not handle directly.',
      ].join('\n');
    default:
      return null;
  }
}

interface Config {
  delegation_level: number;
  ollama: {
    base_url: string;
    default_model: string;
    health_timeout_ms: number;
  };
  welcome: {
    show_savings: boolean;
    show_models: boolean;
    show_level: boolean;
    cost_per_million_tokens: number;
  };
}

interface SavingsInfo {
  total_local_tokens: number;
  local_tasks: number;
  estimated_cost_saved: number;
}

function loadConfig(): Config {
  const defaults: Config = {
    delegation_level: 2,
    ollama: {
      base_url: 'http://localhost:11434',
      default_model: 'slekrem/gpt-oss-claude-code-32k:latest',
      health_timeout_ms: 3000,
    },
    welcome: {
      show_savings: true,
      show_models: true,
      show_level: true,
      cost_per_million_tokens: 8,
    },
  };

  try {
    const cfgPath = path.join(os.homedir(), '.claude-saver', 'config.json');
    if (fs.existsSync(cfgPath)) {
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8') as string);
      return {
        delegation_level: raw.delegation_level ?? defaults.delegation_level,
        ollama: { ...defaults.ollama, ...raw.ollama },
        welcome: { ...defaults.welcome, ...raw.welcome },
      };
    }
  } catch {
    // Fall through to defaults
  }
  return defaults;
}

function loadSavings(costPerMillionTokens: number): SavingsInfo {
  try {
    const mPath = path.join(os.homedir(), '.claude-saver', 'metrics.jsonl');
    if (!fs.existsSync(mPath)) return { total_local_tokens: 0, local_tasks: 0, estimated_cost_saved: 0 };

    const content = fs.readFileSync(mPath, 'utf-8') as string;
    let totalTokens = 0;
    let taskCount = 0;

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'completion' && typeof entry.tokens_used === 'number') {
          totalTokens += entry.tokens_used;
          taskCount++;
        }
      } catch {
        // Skip invalid lines
      }
    }

    const costSaved = (totalTokens / 1_000_000) * costPerMillionTokens;
    return {
      total_local_tokens: totalTokens,
      local_tasks: taskCount,
      estimated_cost_saved: Math.round(costSaved * 100) / 100,
    };
  } catch {
    return { total_local_tokens: 0, local_tasks: 0, estimated_cost_saved: 0 };
  }
}

// -- Welcome message assembly (mirrors main() logic) ----------------------

interface HealthResult {
  healthy: boolean;
  models: string[];
  url: string;
  latency_ms?: number;
}

function assembleWelcomeMessage(config: Config, health: HealthResult): string {
  const lines: string[] = [];

  const levelName = LEVEL_NAMES[config.delegation_level] ?? 'Unknown';
  if (config.welcome.show_level) {
    lines.push(`[Claude-Saver] Ollama connected (${health.latency_ms}ms) — Level ${config.delegation_level} (${levelName})`);
  } else {
    lines.push(`[Claude-Saver] Ollama connected (${health.latency_ms}ms)`);
  }

  if (config.welcome.show_savings) {
    const savings = loadSavings(config.welcome.cost_per_million_tokens);
    if (savings.local_tasks > 0) {
      lines.push(`Savings: ${formatTokens(savings.total_local_tokens)} tokens locally across ${savings.local_tasks} tasks — ~$${savings.estimated_cost_saved} saved`);
    } else {
      lines.push(`Savings: No local completions yet — start delegating to save tokens!`);
    }
  }

  if (config.welcome.show_models) {
    const modelList = health.models.slice(0, 5).join(', ');
    const moreCount = health.models.length > 5 ? ` (+${health.models.length - 5} more)` : '';
    lines.push(`Models: ${modelList}${moreCount} | Default: ${config.ollama.default_model}`);
  }

  const instructions = getDelegationInstructions(config.delegation_level);
  if (instructions) {
    lines.push(instructions);
  }

  return lines.join('\n');
}


// ===========================================================================
//  Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------
describe('formatTokens', () => {
  it('returns "0" for zero tokens', () => {
    expect(formatTokens(0)).toBe('0');
  });

  it('returns raw string for values below 1000', () => {
    expect(formatTokens(500)).toBe('500');
  });

  it('returns raw string for 999', () => {
    expect(formatTokens(999)).toBe('999');
  });

  it('formats exactly 1000 as "1.0K"', () => {
    expect(formatTokens(1000)).toBe('1.0K');
  });

  it('formats 1500 as "1.5K"', () => {
    expect(formatTokens(1500)).toBe('1.5K');
  });

  it('formats 999999 as "1000.0K" (just under 1M threshold)', () => {
    expect(formatTokens(999_999)).toBe('1000.0K');
  });

  it('formats exactly 1000000 as "1.0M"', () => {
    expect(formatTokens(1_000_000)).toBe('1.0M');
  });

  it('formats 2500000 as "2.5M"', () => {
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });

  it('formats large values like 10M correctly', () => {
    expect(formatTokens(10_000_000)).toBe('10.0M');
  });
});

// ---------------------------------------------------------------------------
// getDelegationInstructions
// ---------------------------------------------------------------------------
describe('getDelegationInstructions', () => {
  it('returns null for level 0 (Off)', () => {
    expect(getDelegationInstructions(0)).toBeNull();
  });

  it('returns null for negative levels', () => {
    expect(getDelegationInstructions(-1)).toBeNull();
  });

  it('returns null for levels above 5', () => {
    expect(getDelegationInstructions(6)).toBeNull();
    expect(getDelegationInstructions(99)).toBeNull();
  });

  describe('level 1 — Conservative', () => {
    it('contains "DELEGATION" marker', () => {
      const result = getDelegationInstructions(1)!;
      expect(result).toContain('DELEGATION');
    });

    it('mentions trivial tasks', () => {
      const result = getDelegationInstructions(1)!;
      expect(result).toContain('Trivial tasks');
    });

    it('lists claudesaver_fs and claudesaver_complete tools', () => {
      const result = getDelegationInstructions(1)!;
      expect(result).toContain('claudesaver_fs');
      expect(result).toContain('claudesaver_complete');
    });

    it('instructs to escalate immediately on bad output', () => {
      const result = getDelegationInstructions(1)!;
      expect(result).toContain('Escalate immediately');
    });
  });

  describe('level 2 — Balanced', () => {
    it('mentions routine coding tasks', () => {
      const result = getDelegationInstructions(2)!;
      expect(result.toLowerCase()).toContain('routine coding tasks');
    });

    it('lists claudesaver_generate_code and claudesaver_analyze_file', () => {
      const result = getDelegationInstructions(2)!;
      expect(result).toContain('claudesaver_generate_code');
      expect(result).toContain('claudesaver_analyze_file');
    });

    it('reserves architecture decisions for direct handling', () => {
      const result = getDelegationInstructions(2)!;
      expect(result).toContain('architecture decisions');
    });
  });

  describe('level 3 — Aggressive', () => {
    it('instructs to aggressively delegate', () => {
      const result = getDelegationInstructions(3)!;
      expect(result.toLowerCase()).toContain('delegate aggressively');
    });

    it('includes claudesaver_batch for batch operations', () => {
      const result = getDelegationInstructions(3)!;
      expect(result).toContain('claudesaver_batch');
    });
  });

  describe('level 4 — Max Local', () => {
    it('instructs to try ALL tasks locally first', () => {
      const result = getDelegationInstructions(4)!;
      expect(result).toContain('ALL tasks locally');
    });

    it('makes claudesaver_complete the primary tool', () => {
      const result = getDelegationInstructions(4)!;
      expect(result).toContain('primary tool');
    });
  });

  describe('level 5 — Offline', () => {
    it('declares OFFLINE MODE', () => {
      const result = getDelegationInstructions(5)!;
      expect(result).toContain('OFFLINE MODE');
    });

    it('instructs to report failure rather than handle directly', () => {
      const result = getDelegationInstructions(5)!;
      expect(result).toContain('report the failure');
    });
  });

  it('all non-null levels have substantial content', () => {
    const lengths = [1, 2, 3, 4, 5].map(l => getDelegationInstructions(l)!.length);
    for (const len of lengths) {
      expect(len).toBeGreaterThan(100);
    }
  });
});

// ---------------------------------------------------------------------------
// loadSavings (uses mocked fs)
// ---------------------------------------------------------------------------
describe('loadSavings', () => {
  it('returns zeros when metrics file does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = loadSavings(8);

    expect(result).toEqual({ total_local_tokens: 0, local_tasks: 0, estimated_cost_saved: 0 });
  });

  it('returns zeros for an empty file', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('');

    const result = loadSavings(8);

    expect(result).toEqual({ total_local_tokens: 0, local_tasks: 0, estimated_cost_saved: 0 });
  });

  it('counts completion entries and sums tokens', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      [
        JSON.stringify({ type: 'completion', tokens_used: 500 }),
        JSON.stringify({ type: 'completion', tokens_used: 300 }),
      ].join('\n')
    );

    const result = loadSavings(8);

    expect(result.total_local_tokens).toBe(800);
    expect(result.local_tasks).toBe(2);
  });

  it('calculates cost correctly: 1000 tokens at $8/M = $0.01', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ type: 'completion', tokens_used: 1000 })
    );

    const result = loadSavings(8);

    expect(result.estimated_cost_saved).toBe(0.01);
  });

  it('calculates cost correctly: 1_000_000 tokens at $8/M = $8.00', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ type: 'completion', tokens_used: 1_000_000 })
    );

    const result = loadSavings(8);

    expect(result.estimated_cost_saved).toBe(8);
  });

  it('skips invalid JSON lines without crashing', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      [
        JSON.stringify({ type: 'completion', tokens_used: 400 }),
        'this is not valid json {{{',
        JSON.stringify({ type: 'completion', tokens_used: 600 }),
      ].join('\n')
    );

    const result = loadSavings(8);

    expect(result.total_local_tokens).toBe(1000);
    expect(result.local_tasks).toBe(2);
  });

  it('ignores entries that are not type "completion"', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      [
        JSON.stringify({ type: 'completion', tokens_used: 200 }),
        JSON.stringify({ type: 'subagent', tokens_used: 5000 }),
        JSON.stringify({ type: 'health_check', latency_ms: 42 }),
      ].join('\n')
    );

    const result = loadSavings(8);

    expect(result.total_local_tokens).toBe(200);
    expect(result.local_tasks).toBe(1);
  });

  it('ignores completion entries where tokens_used is not a number', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      [
        JSON.stringify({ type: 'completion', tokens_used: 'lots' }),
        JSON.stringify({ type: 'completion', tokens_used: 100 }),
      ].join('\n')
    );

    const result = loadSavings(8);

    expect(result.total_local_tokens).toBe(100);
    expect(result.local_tasks).toBe(1);
  });

  it('skips blank lines in the JSONL content', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      [
        JSON.stringify({ type: 'completion', tokens_used: 100 }),
        '',
        '   ',
        JSON.stringify({ type: 'completion', tokens_used: 200 }),
        '',
      ].join('\n')
    );

    const result = loadSavings(8);

    expect(result.total_local_tokens).toBe(300);
    expect(result.local_tasks).toBe(2);
  });

  it('uses the provided cost rate rather than a hardcoded one', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ type: 'completion', tokens_used: 1_000_000 })
    );

    const resultAt15 = loadSavings(15);
    expect(resultAt15.estimated_cost_saved).toBe(15);

    const resultAt3 = loadSavings(3);
    expect(resultAt3.estimated_cost_saved).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// loadConfig (uses mocked fs)
// ---------------------------------------------------------------------------
describe('loadConfig', () => {
  it('returns default config when no config file exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const config = loadConfig();

    expect(config.delegation_level).toBe(2);
    expect(config.ollama.base_url).toBe('http://localhost:11434');
    expect(config.ollama.default_model).toBe('slekrem/gpt-oss-claude-code-32k:latest');
    expect(config.ollama.health_timeout_ms).toBe(3000);
    expect(config.welcome.show_savings).toBe(true);
    expect(config.welcome.show_models).toBe(true);
    expect(config.welcome.show_level).toBe(true);
    expect(config.welcome.cost_per_million_tokens).toBe(8);
  });

  it('merges partial user config with defaults', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      delegation_level: 4,
    }));

    const config = loadConfig();

    expect(config.delegation_level).toBe(4);
    // Defaults preserved
    expect(config.ollama.base_url).toBe('http://localhost:11434');
    expect(config.welcome.show_savings).toBe(true);
  });

  it('deep merges ollama settings — user overrides one field, rest from defaults', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      ollama: { base_url: 'http://custom:9999' },
    }));

    const config = loadConfig();

    expect(config.ollama.base_url).toBe('http://custom:9999');
    expect(config.ollama.default_model).toBe('slekrem/gpt-oss-claude-code-32k:latest');
    expect(config.ollama.health_timeout_ms).toBe(3000);
  });

  it('deep merges welcome settings — user overrides one field, rest from defaults', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      welcome: { show_savings: false },
    }));

    const config = loadConfig();

    expect(config.welcome.show_savings).toBe(false);
    expect(config.welcome.show_models).toBe(true);
    expect(config.welcome.show_level).toBe(true);
    expect(config.welcome.cost_per_million_tokens).toBe(8);
  });

  it('returns defaults without throwing when config file contains invalid JSON', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('NOT VALID JSON {{{{');

    const config = loadConfig();

    expect(config.delegation_level).toBe(2);
    expect(config.ollama.base_url).toBe('http://localhost:11434');
  });

  it('returns defaults when readFileSync throws', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('EACCES'); });

    const config = loadConfig();

    expect(config.delegation_level).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Welcome message assembly
// ---------------------------------------------------------------------------
describe('assembleWelcomeMessage', () => {
  const defaultHealth: HealthResult = {
    healthy: true,
    models: ['model-a', 'model-b', 'model-c'],
    url: 'http://localhost:11434',
    latency_ms: 42,
  };

  function makeConfig(overrides: Partial<Config> & { welcome?: Partial<Config['welcome']> } = {}): Config {
    return {
      delegation_level: overrides.delegation_level ?? 2,
      ollama: {
        base_url: 'http://localhost:11434',
        default_model: 'test-model:latest',
        health_timeout_ms: 3000,
        ...overrides.ollama,
      },
      welcome: {
        show_savings: true,
        show_models: true,
        show_level: true,
        cost_per_million_tokens: 8,
        ...overrides.welcome,
      },
    };
  }

  it('includes level number and name when show_level is true', () => {
    // No metrics file needed for level display
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const config = makeConfig({ delegation_level: 3, welcome: { show_level: true } });
    const msg = assembleWelcomeMessage(config, defaultHealth);

    expect(msg).toContain('Level 3 (Aggressive)');
  });

  it('omits level info when show_level is false', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const config = makeConfig({ delegation_level: 3, welcome: { show_level: false } });
    const msg = assembleWelcomeMessage(config, defaultHealth);

    expect(msg).not.toContain('Level 3');
    expect(msg).not.toContain('Aggressive');
    expect(msg).toContain('[Claude-Saver] Ollama connected (42ms)');
  });

  it('shows "start delegating" message when show_savings is true but no tasks exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false); // no metrics file

    const config = makeConfig({ welcome: { show_savings: true } });
    const msg = assembleWelcomeMessage(config, defaultHealth);

    expect(msg).toContain('start delegating to save tokens');
  });

  it('shows formatted savings when tasks exist', () => {
    // First call: config file does not exist; second call: metrics file exists
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      [
        JSON.stringify({ type: 'completion', tokens_used: 50000 }),
        JSON.stringify({ type: 'completion', tokens_used: 50000 }),
      ].join('\n')
    );

    const config = makeConfig({ welcome: { show_savings: true } });
    const msg = assembleWelcomeMessage(config, defaultHealth);

    expect(msg).toContain('100.0K tokens locally');
    expect(msg).toContain('2 tasks');
    expect(msg).toContain('$0.8 saved');
  });

  it('omits savings line entirely when show_savings is false', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const config = makeConfig({ welcome: { show_savings: false } });
    const msg = assembleWelcomeMessage(config, defaultHealth);

    expect(msg).not.toContain('Savings');
  });

  it('lists models when show_models is true', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const config = makeConfig({ welcome: { show_models: true } });
    const msg = assembleWelcomeMessage(config, defaultHealth);

    expect(msg).toContain('model-a, model-b, model-c');
    expect(msg).toContain('Default: test-model:latest');
  });

  it('truncates model list and shows "+N more" when more than 5 models', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const manyModels: HealthResult = {
      ...defaultHealth,
      models: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'],
    };

    const config = makeConfig({ welcome: { show_models: true } });
    const msg = assembleWelcomeMessage(config, manyModels);

    expect(msg).toContain('m1, m2, m3, m4, m5');
    expect(msg).toContain('(+3 more)');
    expect(msg).not.toContain('m6');
  });

  it('shows no "+N more" when exactly 5 models', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const fiveModels: HealthResult = {
      ...defaultHealth,
      models: ['m1', 'm2', 'm3', 'm4', 'm5'],
    };

    const config = makeConfig({ welcome: { show_models: true } });
    const msg = assembleWelcomeMessage(config, fiveModels);

    expect(msg).toContain('m1, m2, m3, m4, m5');
    expect(msg).not.toContain('more');
  });

  it('omits model list when show_models is false', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const config = makeConfig({ welcome: { show_models: false } });
    const msg = assembleWelcomeMessage(config, defaultHealth);

    expect(msg).not.toContain('Models:');
  });

  it('includes delegation instructions for non-zero levels', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const config = makeConfig({ delegation_level: 2 });
    const msg = assembleWelcomeMessage(config, defaultHealth);

    expect(msg).toContain('DELEGATION');
    expect(msg.toLowerCase()).toContain('routine coding tasks');
  });

  it('does not include delegation instructions for level 0', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const config = makeConfig({ delegation_level: 0 });
    const msg = assembleWelcomeMessage(config, defaultHealth);

    expect(msg).not.toContain('DELEGATION');
  });

  it('uses "Unknown" as level name for unrecognized levels', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const config = makeConfig({ delegation_level: 99, welcome: { show_level: true } });
    const msg = assembleWelcomeMessage(config, defaultHealth);

    expect(msg).toContain('Level 99 (Unknown)');
  });

  it('includes latency in the header', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const slowHealth: HealthResult = { ...defaultHealth, latency_ms: 1500 };
    const config = makeConfig();
    const msg = assembleWelcomeMessage(config, slowHealth);

    expect(msg).toContain('(1500ms)');
  });
});

// ---------------------------------------------------------------------------
// LEVEL_NAMES mapping
// ---------------------------------------------------------------------------
describe('LEVEL_NAMES', () => {
  it('maps all six levels correctly', () => {
    expect(LEVEL_NAMES[0]).toBe('Off');
    expect(LEVEL_NAMES[1]).toBe('Conservative');
    expect(LEVEL_NAMES[2]).toBe('Balanced');
    expect(LEVEL_NAMES[3]).toBe('Aggressive');
    expect(LEVEL_NAMES[4]).toBe('Max Local');
    expect(LEVEL_NAMES[5]).toBe('Offline');
  });

  it('returns undefined for unmapped levels', () => {
    expect(LEVEL_NAMES[-1]).toBeUndefined();
    expect(LEVEL_NAMES[6]).toBeUndefined();
  });
});
