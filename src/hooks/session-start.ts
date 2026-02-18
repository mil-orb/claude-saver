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
  gross_cost_saved: number;
  net_cost_saved: number;
  overhead_cost: number;
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
    const configPath = path.join(os.homedir(), '.claude-saver', 'config.json');
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
    const metricsPath = path.join(os.homedir(), '.claude-saver', 'metrics.jsonl');
    if (!fs.existsSync(metricsPath)) return { total_local_tokens: 0, local_tasks: 0, gross_cost_saved: 0, net_cost_saved: 0, overhead_cost: 0 };

    const content = fs.readFileSync(metricsPath, 'utf-8');
    let totalTokens = 0;
    let totalOverhead = 0;
    let taskCount = 0;

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if ((entry.type === 'completion' || entry.type === 'delegation') && typeof entry.tokens_used === 'number') {
          totalTokens += entry.tokens_used;
          // Use recorded overhead or estimate: ~80 + tokens * 1.3
          totalOverhead += entry.cloud_overhead_tokens ?? (80 + Math.ceil(entry.tokens_used * 1.3));
          taskCount++;
        }
      } catch {
        // Skip invalid lines
      }
    }

    const grossCost = (totalTokens / 1_000_000) * costPerMillionTokens;
    const overheadCost = (totalOverhead / 1_000_000) * (costPerMillionTokens / 5);
    const netCost = grossCost - overheadCost;
    return {
      total_local_tokens: totalTokens,
      local_tasks: taskCount,
      gross_cost_saved: Math.round(grossCost * 100) / 100,
      overhead_cost: Math.round(overheadCost * 100) / 100,
      net_cost_saved: Math.round(netCost * 100) / 100,
    };
  } catch {
    return { total_local_tokens: 0, local_tasks: 0, gross_cost_saved: 0, net_cost_saved: 0, overhead_cost: 0 };
  }
}

interface OllamaModelInfo {
  name: string;
  size: number;
}

async function checkHealth(baseUrl: string, timeoutMs: number): Promise<HealthResult & { modelDetails?: OllamaModelInfo[] }> {
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

    const data = await response.json() as { models?: OllamaModelInfo[] };
    const modelDetails = data.models ?? [];
    const models = modelDetails.map(m => m.name);
    return { healthy: true, models, url: baseUrl, latency_ms: latency, modelDetails };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    return { healthy: false, models: [], url: baseUrl, error: msg };
  }
}

/**
 * Auto-detect the best available model.
 * If configured default_model is installed, use it. Otherwise pick the largest model.
 */
function resolveModel(configured: string, modelDetails: OllamaModelInfo[]): { model: string; autoDetected: boolean } {
  if (modelDetails.length === 0) {
    return { model: configured, autoDetected: false };
  }

  const configuredBase = configured.replace(/:latest$/, '');
  const found = modelDetails.find(m =>
    m.name === configured || m.name.replace(/:latest$/, '') === configuredBase
  );
  if (found) {
    return { model: found.name, autoDetected: false };
  }

  // Pick the largest installed model
  const sorted = [...modelDetails].sort((a, b) => b.size - a.size);
  return { model: sorted[0].name, autoDetected: true };
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
 * Detect the Claude model in use and return the correct output token price.
 * Falls back to the user's configured cost_per_million_tokens if detection fails.
 *
 * Output pricing (Anthropic, Feb 2026):
 *   Haiku 4.5:  $5/M output tokens
 *   Sonnet 4.5: $15/M output tokens
 *   Opus 4.6:   $25/M output tokens
 */
function detectModelCostRate(configRate: number): { rate: number; model_tier: string } {
  // Claude Code sets CLAUDE_MODEL or the model shows up in process env
  const modelId = (process.env['CLAUDE_MODEL'] ?? process.env['ANTHROPIC_MODEL'] ?? '').toLowerCase();

  if (modelId.includes('opus')) {
    return { rate: 25, model_tier: 'Opus' };
  }
  if (modelId.includes('sonnet')) {
    return { rate: 15, model_tier: 'Sonnet' };
  }
  if (modelId.includes('haiku')) {
    return { rate: 5, model_tier: 'Haiku' };
  }

  // No model detected — use config value
  return { rate: configRate, model_tier: `$${configRate}/M` };
}

/**
 * Returns level-specific behavioral instructions that tell Claude
 * WHEN and HOW to delegate tasks to local models.
 *
 * This is the core behavioral trigger — without these instructions,
 * Claude has no reason to delegate and will handle everything directly.
 */
function getDelegationInstructions(level: number): string | null {
  // Compressed format: Claude already has tool schemas from MCP registration.
  // These instructions only need to say WHEN to use each tool and WHAT stays cloud.
  // Every token here is repeated on every API turn for the entire session.
  switch (level) {
    case 0:
      return null; // Manual only — no automatic delegation
    case 1:
      return [
        'DELEGATION L1: Trivial tasks only → local Ollama.',
        'claudesaver_fs → fs metadata | claudesaver_complete → docstrings, commit messages, boilerplate (200+ token output expected)',
        'SKIP delegation for short Q&A, yes/no, or <200 token answers — answer directly.',
        'Escalate immediately if local output seems wrong.',
      ].join('\n');
    case 2:
      return [
        'DELEGATION L2: Routine coding tasks → local Ollama.',
        'claudesaver_fs → fs queries | claudesaver_complete → docs, comments, commits, format conversions | claudesaver_generate_code → boilerplate, scaffolding, clear-spec code | claudesaver_analyze_file → summaries, bug scanning',
        'SKIP delegation for short Q&A or tasks with <200 token expected output — the tool-call overhead costs more than it saves.',
        'Cloud: architecture decisions, debugging, security review, complex reasoning.',
      ].join('\n');
    case 3:
      return [
        'DELEGATION L3: Most coding tasks → local. Delegate aggressively.',
        'claudesaver_fs → fs | claudesaver_complete or claudesaver_generate_code → all codegen, docs, tests, refactoring | claudesaver_analyze_file → analysis, review | claudesaver_batch → parallel ops',
        'SKIP: short Q&A (<200 token output) — answer directly to avoid overhead.',
        'Cloud only: architecture decisions, complex multi-file debugging, security-critical review.',
      ].join('\n');
    case 4:
      return [
        'DELEGATION L4: Try ALL tasks locally first.',
        'claudesaver_complete → primary tool for all coding | claudesaver_fs → fs queries | claudesaver_analyze_file → file review | claudesaver_generate_code → code generation',
        'SKIP: trivial Q&A (<100 token answers) — direct answer is cheaper.',
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

/**
 * Warm up the default model by sending a keep-alive request to Ollama.
 * This loads the model into VRAM so the first real completion doesn't cold-start.
 * Fire-and-forget — never blocks the hook or delays session start.
 */
function warmUpModel(baseUrl: string, model: string): void {
  // Use the /api/generate endpoint with keep_alive to load the model
  // without generating any tokens (empty prompt, num_predict: 0)
  fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: '10m' }),
  }).catch(() => {
    // Fire-and-forget — model warm-up is best-effort
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const health = await checkHealth(config.ollama.base_url, config.ollama.health_timeout_ms);

  if (!health.healthy) {
    console.error(`[Claude-Saver] Ollama not available: ${health.error}`);
    process.exit(0);
  }

  // Auto-detect the best available model
  const { model: activeModel, autoDetected } = resolveModel(config.ollama.default_model, health.modelDetails ?? []);

  // Warm up the resolved model immediately after health check passes.
  // This loads it into VRAM so the first claudesaver_complete call is fast.
  warmUpModel(config.ollama.base_url, activeModel);

  const lines: string[] = [];

  // Header with connection status
  const levelName = LEVEL_NAMES[config.delegation_level] ?? 'Unknown';
  if (config.welcome.show_level) {
    lines.push(`[Claude-Saver] Ollama connected (${health.latency_ms}ms) — Level ${config.delegation_level} (${levelName})`);
  } else {
    lines.push(`[Claude-Saver] Ollama connected (${health.latency_ms}ms)`);
  }

  // Savings display — show honest net savings after overhead, using model-aware pricing
  if (config.welcome.show_savings) {
    const { rate, model_tier } = detectModelCostRate(config.welcome.cost_per_million_tokens);
    const savings = loadSavings(rate);
    if (savings.local_tasks > 0) {
      const netSign = savings.net_cost_saved >= 0 ? '' : '-';
      lines.push(`Savings: ${formatTokens(savings.total_local_tokens)} local tokens across ${savings.local_tasks} tasks — net ~${netSign}$${Math.abs(savings.net_cost_saved)} saved at ${model_tier} rates (after $${savings.overhead_cost} overhead)`);
    } else {
      lines.push(`Savings: No local completions yet — delegate 200+ token tasks to save (${model_tier} output: $${rate}/M).`);
    }
  }

  // Models display
  if (config.welcome.show_models) {
    const modelList = health.models.slice(0, 5).join(', ');
    const moreCount = health.models.length > 5 ? ` (+${health.models.length - 5} more)` : '';
    const modelLabel = autoDetected ? `Auto-detected: ${activeModel}` : `Default: ${activeModel}`;
    lines.push(`Models: ${modelList}${moreCount} | ${modelLabel}`);
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
