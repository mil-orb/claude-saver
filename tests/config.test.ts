import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

// Mock fs before importing the module under test
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import * as fs from 'fs';
import { loadConfig, saveConfig, ensureConfigDir, resolvePath } from '../src/mcp-server/config.js';

const homedir = os.homedir();
const configDir = path.join(homedir, '.claude-saver');
const configPath = path.join(configDir, 'config.json');

beforeEach(() => {
  vi.resetAllMocks();
});

describe('loadConfig', () => {
  it('returns default config when no config file exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const config = loadConfig();

    expect(config.delegation_level).toBe(2);
    expect(config.ollama.base_url).toBe('http://localhost:11434');
    expect(config.ollama.default_model).toBe('slekrem/gpt-oss-claude-code-32k:latest');
    expect(config.ollama.fallback_model).toBeNull();
    expect(config.ollama.timeout_ms).toBe(120000);
    expect(config.ollama.health_timeout_ms).toBe(3000);
    expect(config.routing.use_local_triage).toBe(true);
    expect(config.routing.use_historical_learning).toBe(false);
    expect(config.routing.enable_decomposition).toBe(false);
    expect(config.routing.triage_model).toBeNull();
    expect(config.specialist_models).toEqual({});
    expect(config.metrics.enabled).toBe(true);
    expect(config.metrics.log_path).toBe('~/.claude-saver/metrics.jsonl');
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

    // User override
    expect(config.delegation_level).toBe(4);
    // Defaults preserved
    expect(config.ollama.base_url).toBe('http://localhost:11434');
    expect(config.ollama.default_model).toBe('slekrem/gpt-oss-claude-code-32k:latest');
    expect(config.routing.use_local_triage).toBe(true);
    expect(config.metrics.enabled).toBe(true);
    expect(config.welcome.show_savings).toBe(true);
  });

  it('deep merges nested objects — user overrides one ollama field, others come from defaults', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      ollama: { base_url: 'http://custom:1234' },
    }));

    const config = loadConfig();

    // User override
    expect(config.ollama.base_url).toBe('http://custom:1234');
    // Defaults preserved within same nested object
    expect(config.ollama.default_model).toBe('slekrem/gpt-oss-claude-code-32k:latest');
    expect(config.ollama.fallback_model).toBeNull();
    expect(config.ollama.timeout_ms).toBe(120000);
    expect(config.ollama.health_timeout_ms).toBe(3000);
  });

  it('protects against prototype pollution — __proto__, constructor, prototype keys are ignored', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      __proto__: { polluted: true },
      constructor: { polluted: true },
      prototype: { polluted: true },
      delegation_level: 3,
    }));

    const config = loadConfig();

    // The safe key should be applied
    expect(config.delegation_level).toBe(3);
    // Prototype pollution should NOT have occurred
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(config, '__proto__')).toBe(false);
    expect((config as any).constructor).toBe(Object); // normal constructor, not overridden
    expect((config as any).prototype).toBeUndefined();
  });

  it('returns defaults without throwing when config file contains invalid JSON', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('{ this is not valid json !!!');

    const config = loadConfig();

    // Should gracefully fall back to defaults
    expect(config.delegation_level).toBe(2);
    expect(config.ollama.base_url).toBe('http://localhost:11434');
    expect(config.welcome.show_savings).toBe(true);
  });

  it('deep merges welcome config — user overrides one field, others come from defaults', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      welcome: { show_savings: false },
    }));

    const config = loadConfig();

    // User override
    expect(config.welcome.show_savings).toBe(false);
    // Defaults preserved within same nested object
    expect(config.welcome.show_models).toBe(true);
    expect(config.welcome.show_level).toBe(true);
    expect(config.welcome.cost_per_million_tokens).toBe(8);
  });
});

describe('resolvePath', () => {
  it('expands ~ to home directory', () => {
    const result = resolvePath('~/foo');
    expect(result).toBe(path.join(homedir, 'foo'));
  });

  it('expands ~ with nested path', () => {
    const result = resolvePath('~/.claude-saver/metrics.jsonl');
    expect(result).toBe(path.join(homedir, '.claude-saver', 'metrics.jsonl'));
  });

  it('leaves absolute paths unchanged', () => {
    const result = resolvePath('/absolute/path');
    expect(result).toBe('/absolute/path');
  });
});

describe('ensureConfigDir', () => {
  it('creates directory when it does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    ensureConfigDir();

    expect(fs.mkdirSync).toHaveBeenCalledWith(configDir, { recursive: true });
  });

  it('does not create directory when it already exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    ensureConfigDir();

    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });
});

describe('saveConfig', () => {
  it('writes config as formatted JSON to the config path', () => {
    // existsSync is called by ensureConfigDir
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const config = loadConfig();
    saveConfig(config);

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      configPath,
      expect.any(String),
      'utf-8'
    );

    // Verify the written content is valid JSON matching the config
    const writtenJson = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const parsed = JSON.parse(writtenJson);
    expect(parsed.delegation_level).toBe(config.delegation_level);
    expect(parsed.ollama.base_url).toBe(config.ollama.base_url);
  });
});
