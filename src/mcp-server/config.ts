import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ClaudeSaverConfig {
  delegation_level: 0 | 1 | 2 | 3 | 4 | 5;
  _previous_level?: number; // Used by local mode toggle to remember the level to restore
  ollama: {
    base_url: string;
    default_model: string;
    fallback_model: string | null;
    timeout_ms: number;
    health_timeout_ms: number;
  };
  routing: {
    use_local_triage: boolean;
    use_historical_learning: boolean;
    enable_decomposition: boolean;
    triage_model: string | null;
    learner_min_records: number;
  };
  specialist_models: Record<string, string>;
  metrics: {
    enabled: boolean;
    log_path: string;
  };
  welcome: {
    show_savings: boolean;
    show_models: boolean;
    show_level: boolean;
    cost_per_million_tokens: number;
  };
}

const DEFAULT_CONFIG: ClaudeSaverConfig = {
  delegation_level: 2,
  ollama: {
    base_url: 'http://localhost:11434',
    default_model: 'slekrem/gpt-oss-claude-code-32k:latest',
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
    log_path: '~/.claudesaver/metrics.jsonl',
  },
  welcome: {
    show_savings: true,
    show_models: true,
    show_level: true,
    cost_per_million_tokens: 8,
  },
};

function getConfigDir(): string {
  return path.join(os.homedir(), '.claudesaver');
}

function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function resolvePath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

export function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadConfig(): ClaudeSaverConfig {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const userConfig = JSON.parse(raw);
      return deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, userConfig) as unknown as ClaudeSaverConfig;
    }
  } catch {
    // Never throw — fall back to defaults
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: ClaudeSaverConfig): void {
  ensureConfigDir();
  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    if (
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      typeof target[key] === 'object' &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
