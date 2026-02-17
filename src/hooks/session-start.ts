/**
 * SessionStart hook — checks Ollama health, outputs additionalContext JSON.
 * MUST: exit 0 always, output valid JSON or nothing, never block.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface HealthResult {
  healthy: boolean;
  models: string[];
  url: string;
  error?: string;
  latency_ms?: number;
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
    const configPath = path.join(os.homedir(), '.claudesaver', 'config.json');
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
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
    const metricsPath = path.join(os.homedir(), '.claudesaver', 'metrics.jsonl');
    if (!fs.existsSync(metricsPath)) return { total_local_tokens: 0, local_tasks: 0, estimated_cost_saved: 0 };

    const content = fs.readFileSync(metricsPath, 'utf-8');
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

async function checkHealth(baseUrl: string, timeoutMs: number): Promise<HealthResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    const latency = Date.now() - start;

    if (!response.ok) {
      return { healthy: false, models: [], url: baseUrl, error: `HTTP ${response.status}`, latency_ms: latency };
    }

    const data = await response.json() as { models?: Array<{ name: string }> };
    const models = (data.models ?? []).map(m => m.name);
    return { healthy: true, models, url: baseUrl, latency_ms: latency };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    return { healthy: false, models: [], url: baseUrl, error: msg };
  }
}

const LEVEL_NAMES: Record<number, string> = {
  0: 'Off', 1: 'Conservative', 2: 'Balanced',
  3: 'Aggressive', 4: 'Max Local', 5: 'Offline',
};

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

/**
 * Returns level-specific behavioral instructions that tell Claude
 * WHEN and HOW to delegate tasks to local models.
 *
 * This is the core behavioral trigger — without these instructions,
 * Claude has no reason to delegate and will handle everything directly.
 */
function getDelegationInstructions(level: number): string | null {
  switch (level) {
    case 0:
      return null; // Manual only — no automatic delegation
    case 1:
      return [
        'DELEGATION ACTIVE — delegate only trivial tasks to save API tokens:',
        '- Filesystem metadata (tree, stat, find, git status) → claudesaver_fs',
        '- Docstrings for individual functions → claudesaver_complete',
        '- Commit message drafts → claudesaver_complete',
        'Handle everything else directly. Escalate immediately if local output seems wrong.',
      ].join('\n');
    case 2:
      return [
        'DELEGATION ACTIVE — delegate routine coding tasks to local models to save API tokens:',
        '- Filesystem queries (tree, stat, find, git status/log) → claudesaver_fs',
        '- Docstrings, comments, commit messages, format conversions → claudesaver_complete',
        '- Boilerplate, scaffolding, code with clear specs → claudesaver_generate_code',
        '- File summaries and bug scanning → claudesaver_analyze_file',
        'Handle directly: architecture decisions, debugging, security review, complex reasoning, anything the user asks for YOUR opinion on.',
      ].join('\n');
    case 3:
      return [
        'DELEGATION ACTIVE — aggressively delegate to local models. Most coding tasks should go local:',
        '- Filesystem queries → claudesaver_fs',
        '- All code generation, documentation, tests, refactoring → claudesaver_complete or claudesaver_generate_code',
        '- File analysis and review → claudesaver_analyze_file',
        '- Batch operations → claudesaver_batch',
        'Handle directly only: architecture decisions, complex multi-file debugging, security-critical review.',
      ].join('\n');
    case 4:
      return [
        'DELEGATION ACTIVE — try ALL tasks locally first:',
        '- Use claudesaver_complete as your primary tool for all coding tasks.',
        '- Use claudesaver_fs for all filesystem queries.',
        '- Use claudesaver_analyze_file for file review.',
        '- Use claudesaver_generate_code for code generation.',
        'Only handle directly if local output is poor quality, or the task requires broad codebase reasoning that cannot be provided via context.',
      ].join('\n');
    case 5:
      return [
        'DELEGATION ACTIVE — OFFLINE MODE. Route ALL tasks to local models:',
        '- claudesaver_complete for all prompts. claudesaver_fs for filesystem.',
        '- claudesaver_generate_code for code. claudesaver_analyze_file for analysis.',
        '- If the local model fails or produces poor output, report the failure to the user rather than handling it directly.',
      ].join('\n');
    default:
      return null;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const health = await checkHealth(config.ollama.base_url, config.ollama.health_timeout_ms);

  if (!health.healthy) {
    console.error(`[ClaudeSaver] Ollama not available: ${health.error}`);
    process.exit(0);
  }

  const lines: string[] = [];

  // Header with connection status
  const levelName = LEVEL_NAMES[config.delegation_level] ?? 'Unknown';
  if (config.welcome.show_level) {
    lines.push(`[ClaudeSaver] Ollama connected (${health.latency_ms}ms) — Level ${config.delegation_level} (${levelName})`);
  } else {
    lines.push(`[ClaudeSaver] Ollama connected (${health.latency_ms}ms)`);
  }

  // Savings display
  if (config.welcome.show_savings) {
    const savings = loadSavings(config.welcome.cost_per_million_tokens);
    if (savings.local_tasks > 0) {
      lines.push(`Savings: ${formatTokens(savings.total_local_tokens)} tokens locally across ${savings.local_tasks} tasks — ~$${savings.estimated_cost_saved} saved`);
    } else {
      lines.push(`Savings: No local completions yet — start delegating to save tokens!`);
    }
  }

  // Models display
  if (config.welcome.show_models) {
    const modelList = health.models.slice(0, 5).join(', ');
    const moreCount = health.models.length > 5 ? ` (+${health.models.length - 5} more)` : '';
    lines.push(`Models: ${modelList}${moreCount} | Default: ${config.ollama.default_model}`);
  }

  // Delegation instructions — the behavioral trigger
  const instructions = getDelegationInstructions(config.delegation_level);
  if (instructions) {
    lines.push(instructions);
  }

  const context = lines.join('\n');
  const output = JSON.stringify({ additionalContext: context });
  process.stdout.write(output);
}

main().then(() => process.exit(0)).catch(() => process.exit(0));
