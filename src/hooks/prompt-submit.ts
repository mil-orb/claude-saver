#!/usr/bin/env node
/**
 * UserPromptSubmit hook — intercepts user prompts and handles local commands.
 *
 * Detects prefixes like "cs ask", "ask local", etc. and runs them through
 * a local Claude Code instance pointed at Ollama (zero API tokens).
 *
 * For non-matching prompts, exits silently with no output.
 * MUST: exit 0 always, output valid JSON or nothing, never block.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

interface Config {
  delegation_level: number;
  ollama: {
    base_url: string;
    default_model: string;
    health_timeout_ms: number;
  };
}

function loadConfig(): Config {
  const defaults: Config = {
    delegation_level: 2,
    ollama: {
      base_url: 'http://localhost:11434',
      default_model: 'slekrem/gpt-oss-claude-code-32k:latest',
      health_timeout_ms: 3000,
    },
  };

  try {
    const configPath = path.join(os.homedir(), '.claude-saver', 'config.json');
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return {
        delegation_level: raw.delegation_level ?? defaults.delegation_level,
        ollama: { ...defaults.ollama, ...raw.ollama },
      };
    }
  } catch {
    // Fall through to defaults
  }
  return defaults;
}

function matchCommand(prompt: string): { command: string; args: string } | null {
  const trimmed = prompt.trim();
  const lower = trimmed.toLowerCase();

  if (lower.startsWith('cs ask ') || lower.startsWith('ask local ') || lower.startsWith('/claudesaver:ask ')) {
    // Extract everything after the prefix
    for (const prefix of ['cs ask ', 'ask local ', '/claudesaver:ask ']) {
      if (lower.startsWith(prefix)) {
        return { command: 'ask', args: trimmed.slice(prefix.length).trim() };
      }
    }
  }

  if (lower === 'cs status' || lower === '/claudesaver:status') {
    return { command: 'status', args: '' };
  }

  if (lower === 'cs reset') {
    return { command: 'reset', args: '' };
  }

  return null;
}

function runLocalClaude(prompt: string, config: Config): string {
  try {
    const result = execFileSync('claude', ['-p', prompt], {
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: config.ollama.base_url,
        ANTHROPIC_MODEL: config.ollama.default_model,
        // Prevent nested session detection
        CLAUDECODE: '',
      },
      timeout: 120000,
      maxBuffer: 1024 * 1024, // 1MB
      encoding: 'utf-8',
    });
    return result.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[Local model error: ${msg}]`;
  }
}

function runStatus(config: Config): string {
  try {
    const configDir = path.join(os.homedir(), '.claude-saver');
    const metricsPath = path.join(configDir, 'metrics.jsonl');

    // Check Ollama health
    let ollamaStatus = 'unknown';
    try {
      execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '2',
        `${config.ollama.base_url}/api/tags`], { encoding: 'utf-8', timeout: 5000 });
      ollamaStatus = 'connected';
    } catch {
      ollamaStatus = 'not available';
    }

    // Read metrics
    let totalLocal = 0;
    let delegations = 0;
    if (fs.existsSync(metricsPath)) {
      const lines = fs.readFileSync(metricsPath, 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          totalLocal += entry.tokens_local ?? entry.local_tokens ?? 0;
          delegations++;
        } catch { /* skip bad lines */ }
      }
    }

    return [
      `Ollama: ${ollamaStatus}`,
      `Model: ${config.ollama.default_model}`,
      `Delegation level: ${config.delegation_level}`,
      `Total delegations: ${delegations}`,
      `Total local tokens: ${totalLocal.toLocaleString()}`,
    ].join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[Status error: ${msg}]`;
  }
}

function runReset(): string {
  try {
    const metricsPath = path.join(os.homedir(), '.claude-saver', 'metrics.jsonl');
    if (fs.existsSync(metricsPath)) {
      fs.writeFileSync(metricsPath, '', 'utf-8');
      return 'Metrics history cleared.';
    }
    return 'No metrics file found — nothing to reset.';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[Reset error: ${msg}]`;
  }
}

async function readStdin(): Promise<string> {
  // Read stdin with a short timeout — if nothing comes, return empty
  return new Promise((resolve) => {
    let input = '';
    const timer = setTimeout(() => {
      process.stdin.removeAllListeners();
      resolve(input);
    }, 500);

    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => {
      input += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(input);
    });
    process.stdin.resume();
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();

  // Try to extract the user's prompt from stdin
  let userPrompt = '';
  if (raw) {
    try {
      const event = JSON.parse(raw);
      // The prompt might be in various fields depending on hook spec
      userPrompt = event.prompt ?? event.message ?? event.content ?? event.user_message ?? '';
    } catch {
      // If not JSON, use raw input
      userPrompt = raw.trim();
    }
  }

  // If we couldn't get the prompt, log diagnostics and exit silently
  if (!userPrompt) {
    // Log what we received for debugging
    const logDir = path.join(os.homedir(), '.claude-saver');
    try {
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(
        path.join(logDir, 'hook-debug.log'),
        `[${new Date().toISOString()}] UserPromptSubmit stdin: ${JSON.stringify(raw).slice(0, 500)}\n`,
        'utf-8'
      );
    } catch {
      // Ignore
    }
    process.exit(0);
  }

  const match = matchCommand(userPrompt);
  if (!match) {
    // Not a claude-saver command — exit silently
    process.exit(0);
  }

  const config = loadConfig();

  let result: string;
  switch (match.command) {
    case 'ask': {
      if (!match.args) {
        result = 'Usage: cs ask "your question here"';
      } else {
        result = runLocalClaude(match.args, config);
      }
      break;
    }
    case 'status': {
      result = runStatus(config);
      break;
    }
    case 'reset': {
      result = runReset();
      break;
    }
    default:
      process.exit(0);
  }

  // Return the result as additionalContext so Claude just relays it
  const context = [
    `[Claude-Saver Local] The user's command was handled locally via Ollama.`,
    `Command: ${match.command}`,
    `Result:\n${result}`,
    `\nJust relay this result to the user. Do not re-answer the question or make additional API calls.`,
  ].join('\n');

  const output = JSON.stringify({ additionalContext: context });
  process.stdout.write(output);
}

main().then(() => process.exit(0)).catch(() => process.exit(0));
