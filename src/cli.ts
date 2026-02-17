#!/usr/bin/env node
/**
 * Claude-Saver CLI — zero-token local management.
 * Run directly in your terminal, no Claude API calls.
 *
 * Usage:
 *   node scripts/cli.cjs                 # interactive menu
 *   node scripts/cli.cjs settings        # interactive settings
 *   node scripts/cli.cjs status          # quick status check
 *   node scripts/cli.cjs dashboard       # open web dashboard
 *   node scripts/cli.cjs ask "prompt"    # send prompt to Ollama
 *   node scripts/cli.cjs reset           # clear metrics history
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { loadConfig, saveConfig, resolvePath, type ClaudeSaverConfig } from './mcp-server/config.js';
import { loadMetrics, computeSummary, resetMetrics } from './mcp-server/metrics.js';

const LEVEL_NAMES: Record<number, string> = {
  0: 'Off',
  1: 'Conservative',
  2: 'Balanced',
  3: 'Aggressive',
  4: 'Max Local',
  5: 'Offline',
};

const LEVEL_DESCRIPTIONS: Record<number, string> = {
  0: 'Nothing auto-routed — manual MCP tool calls only',
  1: 'Docstrings, commit messages, formatting',
  2: 'Above + boilerplate, scaffolding, summaries, simple codegen',
  3: 'Above + most code generation, tests, refactoring',
  4: 'Everything attempted locally first, escalate on poor quality',
  5: 'All tasks local — no cloud fallback',
};

function isValidModelName(name: string): boolean {
  return /^[a-zA-Z0-9._:/-]+$/.test(name) && name.length > 0 && name.length <= 256;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

function createRL(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function checkHealth(baseUrl: string, timeoutMs: number): Promise<{
  healthy: boolean;
  models: string[];
  latency_ms: number;
  error?: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    const latency = Date.now() - start;

    if (!response.ok) {
      return { healthy: false, models: [], latency_ms: latency, error: `HTTP ${response.status}` };
    }

    const data = await response.json() as { models?: Array<{ name: string }> };
    const models = (data.models ?? []).map((m: { name: string }) => m.name);
    return { healthy: true, models, latency_ms: latency };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    return { healthy: false, models: [], latency_ms: Date.now() - start, error: msg };
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function cmdStatus(): Promise<void> {
  const config = loadConfig();
  const health = await checkHealth(config.ollama.base_url, config.ollama.health_timeout_ms);
  const summary = computeSummary();

  const level = config.delegation_level;
  const levelName = LEVEL_NAMES[level] ?? 'Unknown';

  console.log('');
  console.log('Claude-Saver Status');
  console.log('───────────────────');

  if (health.healthy) {
    console.log(`Connection:  Connected (${health.latency_ms}ms) — ${config.ollama.base_url}`);
  } else {
    console.log(`Connection:  Disconnected — ${health.error}`);
  }

  console.log(`Level:       ${level} (${levelName})`);
  console.log(`Model:       ${config.ollama.default_model}`);

  if (health.healthy) {
    const modelList = health.models.slice(0, 5).join(', ');
    const more = health.models.length > 5 ? ` (+${health.models.length - 5} more)` : '';
    console.log(`Models:      ${health.models.length} available — ${modelList}${more}`);
  }

  console.log('');
  console.log('Savings');
  console.log(`  Tasks:     ${summary.total_tasks} total, ${summary.local_tasks} local`);
  console.log(`  Tokens:    ${formatTokens(summary.total_local_tokens)} processed locally`);
  console.log(`  Gross:     ~$${summary.gross_cost_saved}`);
  console.log(`  Overhead:  -$${summary.overhead_cost} (tool-call wrapper cost)`);
  console.log(`  Net saved: ~$${summary.net_cost_saved}`);
  console.log('');
}

async function cmdSettings(): Promise<void> {
  const rl = createRL();

  let running = true;
  while (running) {
    const config = loadConfig();
    const health = await checkHealth(config.ollama.base_url, config.ollama.health_timeout_ms);
    const summary = computeSummary();
    const level = config.delegation_level;
    const levelName = LEVEL_NAMES[level] ?? 'Unknown';

    console.log('');
    console.log('Claude-Saver Settings');
    console.log('─────────────────────');

    if (health.healthy) {
      console.log(`Connection:  Connected (${health.latency_ms}ms) — ${config.ollama.base_url}`);
    } else {
      console.log(`Connection:  Disconnected — ${health.error}`);
    }

    console.log(`Level:       ${level} (${levelName})`);
    console.log(`Model:       ${config.ollama.default_model}`);
    console.log(`Metrics:     ${config.metrics.enabled ? 'Enabled' : 'Disabled'}`);
    console.log('');
    console.log(`Savings:     ${formatTokens(summary.total_local_tokens)} tokens, ${summary.local_tasks} tasks, net ~$${summary.net_cost_saved}`);
    console.log('');
    console.log('Options:');
    console.log('  1. Change delegation level');
    console.log('  2. Change default model');
    console.log('  3. Toggle metrics logging');
    console.log('  4. Reset savings history');
    console.log('  5. View all levels');
    console.log('  6. Done');
    console.log('');

    const choice = await ask(rl, 'Choose [1-6]: ');

    switch (choice) {
      case '1': {
        console.log('');
        for (let i = 0; i <= 5; i++) {
          const marker = i === level ? ' (current)' : '';
          console.log(`  ${i}. ${LEVEL_NAMES[i]} — ${LEVEL_DESCRIPTIONS[i]}${marker}`);
        }
        console.log('');
        const newLevel = await ask(rl, 'New level [0-5]: ');
        const n = parseInt(newLevel, 10);
        if (n >= 0 && n <= 5) {
          config.delegation_level = n as ClaudeSaverConfig['delegation_level'];
          saveConfig(config);
          console.log(`\nLevel set to ${n} (${LEVEL_NAMES[n]})`);
        } else {
          console.log('\nInvalid level, no change.');
        }
        break;
      }

      case '2': {
        if (health.healthy && health.models.length > 0) {
          console.log('');
          health.models.forEach((m, i) => {
            const marker = m === config.ollama.default_model ? ' (current)' : '';
            console.log(`  ${i + 1}. ${m}${marker}`);
          });
          console.log('');
          const modelChoice = await ask(rl, `Choose [1-${health.models.length}] or type model name: `);
          const idx = parseInt(modelChoice, 10);
          let newModel: string;
          if (idx >= 1 && idx <= health.models.length) {
            newModel = health.models[idx - 1];
          } else {
            newModel = modelChoice;
          }
          if (newModel && isValidModelName(newModel)) {
            config.ollama.default_model = newModel;
            saveConfig(config);
            console.log(`\nDefault model set to ${newModel}`);
          } else if (newModel) {
            console.log('\nInvalid model name.');
          }
        } else {
          console.log('\nOllama not connected. Cannot list models.');
          const manual = await ask(rl, 'Enter model name manually (or press Enter to skip): ');
          if (manual && isValidModelName(manual)) {
            config.ollama.default_model = manual;
            saveConfig(config);
            console.log(`\nDefault model set to ${manual}`);
          } else if (manual) {
            console.log('\nInvalid model name.');
          }
        }
        break;
      }

      case '3': {
        config.metrics.enabled = !config.metrics.enabled;
        saveConfig(config);
        console.log(`\nMetrics ${config.metrics.enabled ? 'enabled' : 'disabled'}.`);
        break;
      }

      case '4': {
        const confirm = await ask(rl, 'Reset all savings history? [y/N]: ');
        if (confirm.toLowerCase() === 'y') {
          resetMetrics();
          console.log('\nMetrics reset.');
        } else {
          console.log('\nCancelled.');
        }
        break;
      }

      case '5': {
        console.log('');
        for (let i = 0; i <= 5; i++) {
          const marker = i === level ? ' ← current' : '';
          console.log(`  Level ${i}: ${LEVEL_NAMES[i]}${marker}`);
          console.log(`           ${LEVEL_DESCRIPTIONS[i]}`);
        }
        break;
      }

      case '6':
        running = false;
        break;

      default:
        console.log('Invalid choice.');
    }
  }

  rl.close();
  console.log('Settings saved.\n');
}

async function cmdDashboard(): Promise<void> {
  const { execFile, spawn } = await import('child_process');
  const scriptPath = path.join(__dirname, 'dashboard-server.cjs');

  if (!fs.existsSync(scriptPath)) {
    console.error('Dashboard server not found at', scriptPath);
    process.exit(1);
  }

  // Validate port is numeric to prevent injection
  const rawPort = process.env['CLAUDE_SAVER_DASHBOARD_PORT'] ?? '37888';
  const port = parseInt(rawPort, 10);
  if (isNaN(port) || port < 1024 || port > 65535) {
    console.error('Invalid CLAUDE_SAVER_DASHBOARD_PORT — must be 1024-65535');
    process.exit(1);
  }

  // Start the server using spawn (no shell) for safety
  const child = spawn('node', [scriptPath], { stdio: 'inherit', env: { ...process.env } });

  // Give server time to start, then open browser using execFile (no shell)
  setTimeout(() => {
    const url = `http://127.0.0.1:${port}`;

    const platform = process.platform;
    if (platform === 'win32') execFile('cmd', ['/c', 'start', url]);
    else if (platform === 'darwin') execFile('open', [url]);
    else execFile('xdg-open', [url]);

    console.log(`Dashboard running at ${url} — press Ctrl+C to stop.`);
  }, 500);

  child.on('error', (err) => {
    console.error('Failed to start dashboard:', err.message);
    process.exit(1);
  });
}

async function cmdAsk(prompt: string): Promise<void> {
  if (!prompt) {
    console.error('Usage: claudesaver ask "your prompt here"');
    process.exit(1);
  }

  if (prompt.length > 50000) {
    console.error('Prompt too long (max 50,000 characters).');
    process.exit(1);
  }

  const config = loadConfig();
  const model = config.ollama.default_model;
  const start = Date.now();

  try {
    const response = await fetch(`${config.ollama.base_url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
      }),
    });

    if (!response.ok) {
      console.error(`Ollama error: HTTP ${response.status}`);
      process.exit(1);
    }

    const data = await response.json() as {
      response?: string;
      eval_count?: number;
      eval_duration?: number;
    };

    const duration = Date.now() - start;
    const tokens = data.eval_count ?? 0;

    // Handle thinking models — strip <think>...</think> blocks
    let output = data.response ?? '';
    output = output.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();

    console.log(output);
    console.log(`\n[Local: ${model} | ${tokens} tokens | ${duration}ms]`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to reach Ollama: ${msg}`);
    console.error('Make sure Ollama is running: ollama serve');
    process.exit(1);
  }
}

async function cmdReset(): Promise<void> {
  resetMetrics();
  console.log('Metrics history cleared.');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase();

  switch (command) {
    case 'status':
      await cmdStatus();
      break;
    case 'settings':
      await cmdSettings();
      break;
    case 'dashboard':
      await cmdDashboard();
      break;
    case 'ask':
      await cmdAsk(args.slice(1).join(' '));
      break;
    case 'reset':
      await cmdReset();
      break;
    case undefined:
    case '':
      // No argument — show interactive settings
      await cmdSettings();
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log('');
      console.log('Claude-Saver CLI — zero-token local management');
      console.log('');
      console.log('Usage:');
      console.log('  claudesaver                    Interactive settings menu');
      console.log('  claudesaver status             Quick status check');
      console.log('  claudesaver settings           Interactive settings menu');
      console.log('  claudesaver dashboard          Open web dashboard');
      console.log('  claudesaver ask "prompt"       Send prompt to local Ollama model');
      console.log('  claudesaver reset              Clear metrics history');
      console.log('');
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "claudesaver help" for usage.');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
