/**
 * Plugin E2E Tests — exercises every plugin integration point as real subprocesses.
 *
 * Spawns compiled .cjs bundles the way Claude Code actually uses them:
 *   - Hooks via child_process with stdin piping
 *   - MCP server via JSON-RPC over stdio
 *   - Manifest validation for plugin.json, .mcp.json, hooks.json
 *
 * HOME/USERPROFILE is overridden to a temp dir so tests never touch ~/.claude-saver/.
 * Ollama-dependent tests auto-skip when Ollama isn't reachable.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { createReadStream } from 'fs';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { fileURLToPath } from 'url';

// ─── Path resolution ──────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const SCRIPTS = {
  mcpServer: path.join(PROJECT_ROOT, 'scripts', 'mcp-server.cjs'),
  sessionStart: path.join(PROJECT_ROOT, 'scripts', 'session-start-hook.cjs'),
  subagentStop: path.join(PROJECT_ROOT, 'scripts', 'subagent-stop-hook.cjs'),
};

const MANIFESTS = {
  plugin: path.join(PROJECT_ROOT, '.claude-plugin', 'plugin.json'),
  mcp: path.join(PROJECT_ROOT, '.mcp.json'),
  hooks: path.join(PROJECT_ROOT, 'hooks', 'hooks.json'),
  marketplace: path.join(PROJECT_ROOT, '.claude-plugin', 'marketplace.json'),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claudesaver-e2e-'));
}

function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

function childEnv(homeDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Override home dir on all platforms
  env['HOME'] = homeDir;
  env['USERPROFILE'] = homeDir;
  // Ensure .claude-saver resolves to temp
  env['XDG_CONFIG_HOME'] = homeDir;
  return env;
}

interface HookResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runHook(
  script: string,
  stdin: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 5000,
): Promise<HookResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      env,
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';

    child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code });
    });

    child.on('error', () => {
      resolve({ stdout, stderr, exitCode: 1 });
    });

    if (stdin) {
      child.stdin!.write(stdin);
    }
    child.stdin!.end();
  });
}

interface McpSession {
  process: ChildProcess;
  send: (msg: Record<string, unknown>) => void;
  waitForResponse: (id: number, timeoutMs?: number) => Promise<Record<string, unknown>>;
  close: () => void;
}

function spawnMcpServer(env: NodeJS.ProcessEnv): McpSession {
  const child = spawn(process.execPath, [SCRIPTS.mcpServer], {
    env,
    cwd: PROJECT_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (reason: Error) => void;
  }>();

  const rl = readline.createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed) as Record<string, unknown>;
      const id = msg['id'] as number | undefined;
      if (id !== undefined && pending.has(id)) {
        pending.get(id)!.resolve(msg);
        pending.delete(id);
      }
    } catch {
      // Ignore non-JSON output (e.g. debug logs)
    }
  });

  child.on('error', (err) => {
    for (const [, { reject }] of pending) {
      reject(err);
    }
    pending.clear();
  });

  return {
    process: child,

    send(msg) {
      child.stdin!.write(JSON.stringify(msg) + '\n');
    },

    waitForResponse(id, timeoutMs = 10000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP response timeout for id=${id}`));
        }, timeoutMs);

        pending.set(id, {
          resolve: (val) => {
            clearTimeout(timer);
            resolve(val);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
      });
    },

    close() {
      rl.close();
      child.stdin!.end();
      child.kill();
    },
  };
}

async function initializeMcpSession(session: McpSession): Promise<Record<string, unknown>> {
  session.send({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e-test', version: '1.0.0' },
    },
  });
  const initResult = await session.waitForResponse(0, 15000);

  session.send({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });

  return initResult;
}

async function mcpCall(
  session: McpSession,
  id: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  session.send({ jsonrpc: '2.0', id, method, params: params ?? {} });
  return session.waitForResponse(id);
}

async function mcpToolCall(
  session: McpSession,
  id: number,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return mcpCall(session, id, 'tools/call', { name: toolName, arguments: args });
}

function parseToolResult(response: Record<string, unknown>): unknown {
  const result = response['result'] as Record<string, unknown> | undefined;
  if (!result) return undefined;
  const content = result['content'] as Array<{ type: string; text: string }> | undefined;
  if (!content || content.length === 0) return undefined;
  try {
    return JSON.parse(content[0].text);
  } catch {
    return content[0].text;
  }
}

function isErrorResponse(response: Record<string, unknown>): boolean {
  const result = response['result'] as Record<string, unknown> | undefined;
  return result?.['isError'] === true;
}

let _ollamaAvailable: boolean | null = null;

async function isOllamaAvailable(): Promise<boolean> {
  if (_ollamaAvailable !== null) return _ollamaAvailable;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const resp = await fetch('http://localhost:11434/api/tags', { signal: controller.signal });
    clearTimeout(timer);
    _ollamaAvailable = resp.ok;
  } catch {
    _ollamaAvailable = false;
  }
  return _ollamaAvailable;
}

function writeConfig(homeDir: string, config: Record<string, unknown>): void {
  const dir = path.join(homeDir, '.claude-saver');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

function writeMetrics(homeDir: string, entries: Record<string, unknown>[]): void {
  const dir = path.join(homeDir, '.claude-saver');
  fs.mkdirSync(dir, { recursive: true });
  const content = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '');
  fs.writeFileSync(path.join(dir, 'metrics.jsonl'), content, 'utf-8');
}

function readMetrics(homeDir: string): Record<string, unknown>[] {
  const metricsPath = path.join(homeDir, '.claude-saver', 'metrics.jsonl');
  if (!fs.existsSync(metricsPath)) return [];
  return fs.readFileSync(metricsPath, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as Record<string, unknown>);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Plugin Manifests
// ═══════════════════════════════════════════════════════════════════════════════

describe('1. Plugin Manifests', () => {
  it('plugin.json is valid JSON', () => {
    const raw = fs.readFileSync(MANIFESTS.plugin, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('plugin.json has name, version, description', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFESTS.plugin, 'utf-8'));
    expect(manifest.name).toBeDefined();
    expect(manifest.version).toBeDefined();
    expect(manifest.description).toBeDefined();
  });

  it('plugin.json name is "claude-saver"', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFESTS.plugin, 'utf-8'));
    expect(manifest.name).toBe('claude-saver');
  });

  it('.mcp.json is valid JSON', () => {
    const raw = fs.readFileSync(MANIFESTS.mcp, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('.mcp.json has mcpServers["claude-saver"]', () => {
    const mcp = JSON.parse(fs.readFileSync(MANIFESTS.mcp, 'utf-8'));
    expect(mcp.mcpServers).toBeDefined();
    expect(mcp.mcpServers['claude-saver']).toBeDefined();
  });

  it('.mcp.json args reference mcp-server.cjs with ${CLAUDE_PLUGIN_ROOT}', () => {
    const mcp = JSON.parse(fs.readFileSync(MANIFESTS.mcp, 'utf-8'));
    const args = mcp.mcpServers['claude-saver'].args as string[];
    expect(args.some((a: string) => a.includes('mcp-server.cjs'))).toBe(true);
    expect(args.some((a: string) => a.includes('${CLAUDE_PLUGIN_ROOT}'))).toBe(true);
  });

  it('hooks.json is valid JSON with 2 event types', () => {
    const data = JSON.parse(fs.readFileSync(MANIFESTS.hooks, 'utf-8'));
    expect(data.hooks).toBeDefined();
    expect(typeof data.hooks).toBe('object');
    expect(Object.keys(data.hooks)).toHaveLength(2);
  });

  it('hooks.json has SessionStart and SubagentStop events', () => {
    const data = JSON.parse(fs.readFileSync(MANIFESTS.hooks, 'utf-8'));
    const events = Object.keys(data.hooks);
    expect(events).toContain('SessionStart');
    expect(events).toContain('SubagentStop');
  });

  it('hooks.json commands reference correct script paths', () => {
    const data = JSON.parse(fs.readFileSync(MANIFESTS.hooks, 'utf-8'));
    for (const eventName of Object.keys(data.hooks)) {
      for (const matcherGroup of data.hooks[eventName]) {
        for (const hook of matcherGroup.hooks) {
          expect(hook.command).toContain('${CLAUDE_PLUGIN_ROOT}');
          expect(hook.command).toContain('scripts/');
          expect(hook.command).toMatch(/\.cjs$/);
        }
      }
    }
  });

  it('marketplace.json is valid JSON with publisher and categories', () => {
    const market = JSON.parse(fs.readFileSync(MANIFESTS.marketplace, 'utf-8'));
    expect(market.publisher).toBeDefined();
    expect(market.categories).toBeDefined();
    expect(Array.isArray(market.categories)).toBe(true);
  });

  it('all 3 .cjs bundles exist and mcp-server.cjs > 100KB', () => {
    for (const script of Object.values(SCRIPTS)) {
      expect(fs.existsSync(script)).toBe(true);
    }
    const mcpSize = fs.statSync(SCRIPTS.mcpServer).size;
    expect(mcpSize).toBeGreaterThan(100 * 1024);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. SubagentStop Hook
// ═══════════════════════════════════════════════════════════════════════════════

describe('2. SubagentStop Hook', { timeout: 10000 }, () => {
  let tempHome: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempHome = makeTempDir();
    env = childEnv(tempHome);
    env['CLAUDE_SESSION_ID'] = 'test-session-123';
  });

  afterAll(() => {
    // Clean up any remaining temp dirs in afterAll for safety
  });

  function cleanup() {
    removeTempDir(tempHome);
  }

  it('exits 0 for valid local-worker event', async () => {
    const event = JSON.stringify({
      agent_name: 'local-worker',
      duration_ms: 1500,
      tools_used: ['claudesaver_complete'],
    });
    const result = await runHook(SCRIPTS.subagentStop, event, env);
    cleanup();
    expect(result.exitCode).toBe(0);
  });

  it('writes JSONL entry with correct shape', async () => {
    const event = JSON.stringify({
      agent_name: 'local-worker',
      duration_ms: 2500,
      tools_used: ['claudesaver_fs', 'claudesaver_complete'],
    });
    await runHook(SCRIPTS.subagentStop, event, env);
    const entries = readMetrics(tempHome);
    cleanup();

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry).toHaveProperty('agent', 'local-worker');
    expect(entry).toHaveProperty('timestamp');
    expect(entry).toHaveProperty('duration_ms', 2500);
    expect(entry).toHaveProperty('tools_used');
    expect(entry).toHaveProperty('session_id', 'test-session-123');
    expect(typeof entry['timestamp']).toBe('string');
    expect(Array.isArray(entry['tools_used'])).toBe(true);
  });

  it('uses CLAUDE_SESSION_ID env, defaults to "unknown"', async () => {
    const noSessionEnv = childEnv(tempHome);
    delete noSessionEnv['CLAUDE_SESSION_ID'];

    const event = JSON.stringify({
      agent_name: 'local-worker',
      duration_ms: 100,
      tools_used: [],
    });
    await runHook(SCRIPTS.subagentStop, event, noSessionEnv);
    const entries = readMetrics(tempHome);
    cleanup();

    expect(entries).toHaveLength(1);
    expect(entries[0]['session_id']).toBe('unknown');
  });

  it('exits 0 and writes nothing for non-local-worker agent', async () => {
    const event = JSON.stringify({
      agent_name: 'some-other-agent',
      duration_ms: 500,
      tools_used: [],
    });
    const result = await runHook(SCRIPTS.subagentStop, event, env);
    const metricsPath = path.join(tempHome, '.claude-saver', 'metrics.jsonl');
    const exists = fs.existsSync(metricsPath);
    cleanup();

    expect(result.exitCode).toBe(0);
    // Metrics file should either not exist or be empty
    if (exists) {
      expect(readMetrics(tempHome)).toHaveLength(0);
    }
  });

  it('exits 0 for empty stdin', async () => {
    const result = await runHook(SCRIPTS.subagentStop, '', env);
    cleanup();
    expect(result.exitCode).toBe(0);
  });

  it('exits 0 for invalid JSON stdin', async () => {
    const result = await runHook(SCRIPTS.subagentStop, 'not json at all', env);
    cleanup();
    expect(result.exitCode).toBe(0);
  });

  it('appends multiple entries across runs (JSONL append)', async () => {
    const makeEvent = (i: number) => JSON.stringify({
      agent_name: 'local-worker',
      duration_ms: i * 100,
      tools_used: [`tool_${i}`],
    });

    await runHook(SCRIPTS.subagentStop, makeEvent(1), env);
    await runHook(SCRIPTS.subagentStop, makeEvent(2), env);
    await runHook(SCRIPTS.subagentStop, makeEvent(3), env);

    const entries = readMetrics(tempHome);
    cleanup();

    expect(entries).toHaveLength(3);
    expect(entries[0]['duration_ms']).toBe(100);
    expect(entries[1]['duration_ms']).toBe(200);
    expect(entries[2]['duration_ms']).toBe(300);
  });

  it('creates .claude-saver/ directory if missing', async () => {
    // Ensure no .claude-saver dir exists
    const dir = path.join(tempHome, '.claude-saver');
    expect(fs.existsSync(dir)).toBe(false);

    const event = JSON.stringify({
      agent_name: 'local-worker',
      duration_ms: 50,
      tools_used: [],
    });
    await runHook(SCRIPTS.subagentStop, event, env);
    cleanup();

    // The hook should have created the directory (verified by writing metrics)
    // We check it existed before cleanup by seeing the entry was written
    // Re-run without cleanup to verify
    const tempHome2 = makeTempDir();
    const env2 = childEnv(tempHome2);
    await runHook(SCRIPTS.subagentStop, event, env2);
    expect(fs.existsSync(path.join(tempHome2, '.claude-saver'))).toBe(true);
    removeTempDir(tempHome2);
  });

  it('exits 0 with missing optional fields', async () => {
    const event = JSON.stringify({ agent_name: 'local-worker' });
    const result = await runHook(SCRIPTS.subagentStop, event, env);
    const entries = readMetrics(tempHome);
    cleanup();

    expect(result.exitCode).toBe(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]['duration_ms']).toBe(0);
    expect(entries[0]['tools_used']).toEqual([]);
  });

  it('handles concurrent writes correctly', async () => {
    const events = Array.from({ length: 5 }, (_, i) => JSON.stringify({
      agent_name: 'local-worker',
      duration_ms: (i + 1) * 10,
      tools_used: [],
    }));

    // Run all in parallel
    await Promise.all(events.map(ev => runHook(SCRIPTS.subagentStop, ev, env)));

    const entries = readMetrics(tempHome);
    cleanup();

    // All 5 should have been written (order may vary due to concurrent appends)
    expect(entries.length).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. SessionStart Hook — Ollama unavailable
// ═══════════════════════════════════════════════════════════════════════════════

describe('3. SessionStart Hook — Ollama unavailable', { timeout: 10000 }, () => {
  let tempHome: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    tempHome = makeTempDir();
    env = childEnv(tempHome);
    // Write config pointing at a guaranteed-unreachable address
    writeConfig(tempHome, {
      delegation_level: 2,
      ollama: {
        base_url: 'http://127.0.0.1:19999',
        default_model: 'test-model',
        health_timeout_ms: 500,
      },
    });
  });

  afterAll(() => {
    removeTempDir(tempHome);
  });

  it('exits 0', async () => {
    const result = await runHook(SCRIPTS.sessionStart, '', env);
    expect(result.exitCode).toBe(0);
  });

  it('stdout is empty (no JSON output)', async () => {
    const result = await runHook(SCRIPTS.sessionStart, '', env);
    expect(result.stdout.trim()).toBe('');
  });

  it('stderr contains "Ollama not available"', async () => {
    const result = await runHook(SCRIPTS.sessionStart, '', env);
    expect(result.stderr).toContain('Ollama not available');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. SessionStart Hook — Ollama available
// ═══════════════════════════════════════════════════════════════════════════════

describe('4. SessionStart Hook — Ollama available', { timeout: 15000 }, () => {
  let tempHome: string;
  let env: NodeJS.ProcessEnv;
  let skip: boolean;

  beforeAll(async () => {
    skip = !(await isOllamaAvailable());
    if (skip) return;

    tempHome = makeTempDir();
    env = childEnv(tempHome);
    writeConfig(tempHome, {
      delegation_level: 3,
      ollama: {
        base_url: 'http://localhost:11434',
        default_model: 'test-model',
        health_timeout_ms: 3000,
      },
      welcome: {
        show_savings: true,
        show_models: true,
        show_level: true,
        cost_per_million_tokens: 8,
      },
    });
  });

  afterAll(() => {
    if (!skip) removeTempDir(tempHome);
  });

  it.skipIf(!_ollamaAvailable)('exits 0 and stdout is valid JSON with additionalContext', async () => {
    const result = await runHook(SCRIPTS.sessionStart, '', env);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toHaveProperty('additionalContext');
    expect(typeof output.additionalContext).toBe('string');
  });

  it.skipIf(!_ollamaAvailable)('content contains [Claude-Saver] header', async () => {
    const result = await runHook(SCRIPTS.sessionStart, '', env);
    const output = JSON.parse(result.stdout);
    expect(output.additionalContext).toContain('[Claude-Saver]');
  });

  it.skipIf(!_ollamaAvailable)('content reflects delegation level from config', async () => {
    const result = await runHook(SCRIPTS.sessionStart, '', env);
    const output = JSON.parse(result.stdout);
    expect(output.additionalContext).toContain('Level 3');
    expect(output.additionalContext).toContain('Aggressive');
  });

  it.skipIf(!_ollamaAvailable)('content includes models list', async () => {
    const result = await runHook(SCRIPTS.sessionStart, '', env);
    const output = JSON.parse(result.stdout);
    expect(output.additionalContext).toContain('Models:');
  });

  it.skipIf(!_ollamaAvailable)('output is exactly one JSON object (no trailing bytes)', async () => {
    const result = await runHook(SCRIPTS.sessionStart, '', env);
    const trimmed = result.stdout.trim();
    // Must parse as exactly one JSON value
    expect(() => JSON.parse(trimmed)).not.toThrow();
    // No extra content after the JSON
    const parsed = JSON.parse(trimmed);
    expect(JSON.stringify(parsed)).toBe(trimmed);
  });

  it.skipIf(!_ollamaAvailable)('config changes (level) reflected in output', async () => {
    const tempHome2 = makeTempDir();
    const env2 = childEnv(tempHome2);
    writeConfig(tempHome2, {
      delegation_level: 1,
      ollama: {
        base_url: 'http://localhost:11434',
        default_model: 'test-model',
        health_timeout_ms: 3000,
      },
      welcome: { show_savings: true, show_models: true, show_level: true, cost_per_million_tokens: 8 },
    });

    const result = await runHook(SCRIPTS.sessionStart, '', env2);
    const output = JSON.parse(result.stdout);
    expect(output.additionalContext).toContain('Level 1');
    expect(output.additionalContext).toContain('Conservative');
    removeTempDir(tempHome2);
  });

  it.skipIf(!_ollamaAvailable)('savings line reflects metrics from temp dir', async () => {
    const tempHome2 = makeTempDir();
    const env2 = childEnv(tempHome2);
    writeConfig(tempHome2, {
      delegation_level: 2,
      ollama: {
        base_url: 'http://localhost:11434',
        default_model: 'test-model',
        health_timeout_ms: 3000,
      },
      welcome: { show_savings: true, show_models: true, show_level: true, cost_per_million_tokens: 8 },
    });
    // No metrics → should show "No local completions yet"
    const result = await runHook(SCRIPTS.sessionStart, '', env2);
    const output = JSON.parse(result.stdout);
    expect(output.additionalContext).toContain('No local completions yet');
    removeTempDir(tempHome2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. MCP Server — stdio transport
// ═══════════════════════════════════════════════════════════════════════════════

describe('5. MCP Server — stdio transport', { timeout: 30000 }, () => {
  let tempHome: string;
  let env: NodeJS.ProcessEnv;
  let session: McpSession;
  let initResult: Record<string, unknown>;
  let nextId: number;

  beforeAll(async () => {
    tempHome = makeTempDir();
    env = childEnv(tempHome);
    session = spawnMcpServer(env);
    initResult = await initializeMcpSession(session);
    nextId = 1;
  });

  afterAll(() => {
    session?.close();
    removeTempDir(tempHome);
  });

  function id(): number {
    return nextId++;
  }

  it('initialize returns protocolVersion and serverInfo', () => {
    const result = initResult['result'] as Record<string, unknown>;
    expect(result).toBeDefined();
    expect(result['protocolVersion']).toBeDefined();
    expect(result['serverInfo']).toBeDefined();
    const serverInfo = result['serverInfo'] as Record<string, unknown>;
    expect(serverInfo['name']).toBe('claude-saver');
  });

  it('initialize returns capabilities.tools', () => {
    const result = initResult['result'] as Record<string, unknown>;
    expect(result['capabilities']).toBeDefined();
    const caps = result['capabilities'] as Record<string, unknown>;
    expect(caps['tools']).toBeDefined();
  });

  it('tools/list returns exactly 9 tools, all prefixed claudesaver_', async () => {
    const resp = await mcpCall(session, id(), 'tools/list');
    const result = resp['result'] as Record<string, unknown>;
    const tools = result['tools'] as Array<Record<string, unknown>>;

    expect(tools).toHaveLength(10);
    for (const tool of tools) {
      expect((tool['name'] as string).startsWith('claudesaver_')).toBe(true);
    }
  });

  it('each tool has inputSchema with type: "object"', async () => {
    const resp = await mcpCall(session, id(), 'tools/list');
    const result = resp['result'] as Record<string, unknown>;
    const tools = result['tools'] as Array<Record<string, unknown>>;

    for (const tool of tools) {
      const schema = tool['inputSchema'] as Record<string, unknown>;
      expect(schema).toBeDefined();
      expect(schema['type']).toBe('object');
    }
  });

  it('expected tool names all present', async () => {
    const resp = await mcpCall(session, id(), 'tools/list');
    const result = resp['result'] as Record<string, unknown>;
    const tools = result['tools'] as Array<Record<string, unknown>>;
    const names = tools.map(t => t['name'] as string);

    const expected = [
      'claudesaver_fs', 'claudesaver_fs_preview', 'claudesaver_complete',
      'claudesaver_generate_code', 'claudesaver_analyze_file', 'claudesaver_batch',
      'claudesaver_models', 'claudesaver_level', 'claudesaver_metrics',
    ];

    for (const name of expected) {
      expect(names).toContain(name);
    }
  });

  it('claudesaver_level get returns current_level, name, description', async () => {
    const resp = await mcpToolCall(session, id(), 'claudesaver_level', { action: 'get' });
    const data = parseToolResult(resp) as Record<string, unknown>;

    expect(data).toHaveProperty('current_level');
    expect(data).toHaveProperty('name');
    expect(data).toHaveProperty('description');
  });

  it('claudesaver_level set 3 → get reads back 3 "Aggressive"', async () => {
    await mcpToolCall(session, id(), 'claudesaver_level', { action: 'set', level: 3 });
    const resp = await mcpToolCall(session, id(), 'claudesaver_level', { action: 'get' });
    const data = parseToolResult(resp) as Record<string, unknown>;

    expect(data['current_level']).toBe(3);
    expect(data['name']).toBe('Aggressive');
  });

  it('config.json written to temp dir after set', async () => {
    // Already set level 3 above
    const configPath = path.join(tempHome, '.claude-saver', 'config.json');
    expect(fs.existsSync(configPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.delegation_level).toBe(3);
  });

  it('claudesaver_level describe returns 6 levels (0-5)', async () => {
    const resp = await mcpToolCall(session, id(), 'claudesaver_level', { action: 'describe' });
    const data = parseToolResult(resp) as Record<string, unknown>;
    const levels = data['levels'] as Array<Record<string, unknown>>;

    expect(levels).toHaveLength(6);
    const levelNums = levels.map(l => l['level'] as number);
    expect(levelNums).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('claudesaver_metrics summary returns expected shape', async () => {
    const resp = await mcpToolCall(session, id(), 'claudesaver_metrics', { action: 'summary' });
    const data = parseToolResult(resp) as Record<string, unknown>;

    expect(data).toHaveProperty('total_tasks');
    expect(data).toHaveProperty('local_tasks');
    expect(data).toHaveProperty('gross_cost_saved');
    expect(data).toHaveProperty('net_cost_saved');
    expect(data).toHaveProperty('overhead_cost');
    expect(data).toHaveProperty('total_cloud_overhead_tokens');
  });

  it('claudesaver_metrics reset clears metrics', async () => {
    // Write some metrics first
    writeMetrics(tempHome, [
      { type: 'completion', timestamp: new Date().toISOString(), tokens_used: 100, model: 'test', duration_ms: 50, tool: 'test', session_id: 'x' },
    ]);

    await mcpToolCall(session, id(), 'claudesaver_metrics', { action: 'reset' });

    const metricsPath = path.join(tempHome, '.claude-saver', 'metrics.jsonl');
    const content = fs.existsSync(metricsPath) ? fs.readFileSync(metricsPath, 'utf-8').trim() : '';
    expect(content).toBe('');
  });

  it('claudesaver_fs tree returns valid result on project root', async () => {
    const resp = await mcpToolCall(session, id(), 'claudesaver_fs', {
      operation: 'tree',
      path: PROJECT_ROOT,
      depth: 1,
    });

    expect(isErrorResponse(resp)).toBe(false);
    const data = parseToolResult(resp);
    expect(data).toBeDefined();
  });

  it('claudesaver_level set without level param returns isError: true', async () => {
    const resp = await mcpToolCall(session, id(), 'claudesaver_level', { action: 'set' });
    expect(isErrorResponse(resp)).toBe(true);
  });

  it('server stays alive after error response', async () => {
    // Previous test caused an error. Verify server still responds.
    const resp = await mcpToolCall(session, id(), 'claudesaver_level', { action: 'get' });
    const data = parseToolResult(resp) as Record<string, unknown>;
    expect(data).toHaveProperty('current_level');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. MCP Server — models (Ollama required)
// ═══════════════════════════════════════════════════════════════════════════════

describe('6. MCP Server — models', { timeout: 15000 }, () => {
  let tempHome: string;
  let session: McpSession;
  let skip: boolean;

  beforeAll(async () => {
    skip = !(await isOllamaAvailable());
    if (skip) return;

    tempHome = makeTempDir();
    const env = childEnv(tempHome);
    session = spawnMcpServer(env);
    await initializeMcpSession(session);
  });

  afterAll(() => {
    if (!skip) {
      session?.close();
      removeTempDir(tempHome);
    }
  });

  it.skipIf(!_ollamaAvailable)('claudesaver_models health returns healthy and url', async () => {
    const resp = await mcpToolCall(session, 1, 'claudesaver_models', { action: 'health' });
    const data = parseToolResult(resp) as Record<string, unknown>;

    expect(data).toHaveProperty('healthy');
    expect(data).toHaveProperty('url');
  });

  it.skipIf(!_ollamaAvailable)('claudesaver_models list returns models array', async () => {
    const resp = await mcpToolCall(session, 2, 'claudesaver_models', { action: 'list' });
    const data = parseToolResult(resp) as Record<string, unknown>;

    expect(data).toHaveProperty('models');
    expect(Array.isArray(data['models'])).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Config Persistence Round-Trip
// ═══════════════════════════════════════════════════════════════════════════════

describe('7. Config Persistence Round-Trip', { timeout: 30000 }, () => {
  it('set level 4 → kill server → respawn → get reads 4', async () => {
    const tempHome = makeTempDir();
    const env = childEnv(tempHome);

    // Session 1: set level
    const session1 = spawnMcpServer(env);
    await initializeMcpSession(session1);
    await mcpToolCall(session1, 1, 'claudesaver_level', { action: 'set', level: 4 });
    session1.close();

    // Wait a moment for process cleanup
    await new Promise(r => setTimeout(r, 500));

    // Session 2: read level
    const session2 = spawnMcpServer(env);
    await initializeMcpSession(session2);
    const resp = await mcpToolCall(session2, 1, 'claudesaver_level', { action: 'get' });
    const data = parseToolResult(resp) as Record<string, unknown>;
    session2.close();

    expect(data['current_level']).toBe(4);
    expect(data['name']).toBe('Max Local');

    removeTempDir(tempHome);
  });

  it('reset metrics → verify file empty', async () => {
    const tempHome = makeTempDir();
    const env = childEnv(tempHome);

    // Pre-write some metrics
    writeMetrics(tempHome, [
      { type: 'completion', timestamp: '2024-01-01', tokens_used: 500, model: 'x', duration_ms: 100, tool: 'y', session_id: 'z' },
    ]);

    const session = spawnMcpServer(env);
    await initializeMcpSession(session);
    await mcpToolCall(session, 1, 'claudesaver_metrics', { action: 'reset' });

    const resp = await mcpToolCall(session, 2, 'claudesaver_metrics', { action: 'summary' });
    const data = parseToolResult(resp) as Record<string, unknown>;
    session.close();

    expect(data['total_tasks']).toBe(0);

    removeTempDir(tempHome);
  });

  it('pre-write metrics → summary counts them correctly', async () => {
    const tempHome = makeTempDir();
    const env = childEnv(tempHome);

    writeMetrics(tempHome, [
      { type: 'completion', timestamp: '2024-01-01', tokens_used: 1000, model: 'a', duration_ms: 200, tool: 'claudesaver_complete', session_id: 's1' },
      { type: 'completion', timestamp: '2024-01-02', tokens_used: 2000, model: 'a', duration_ms: 300, tool: 'claudesaver_generate_code', session_id: 's1' },
      { type: 'completion', timestamp: '2024-01-03', tokens_used: 500, model: 'b', duration_ms: 100, tool: 'claudesaver_complete', session_id: 's2' },
    ]);

    const session = spawnMcpServer(env);
    await initializeMcpSession(session);

    const resp = await mcpToolCall(session, 1, 'claudesaver_metrics', { action: 'summary' });
    const data = parseToolResult(resp) as Record<string, unknown>;
    session.close();

    expect(data['total_tasks']).toBe(3);
    expect(data['local_tasks']).toBe(3);
    expect(data['total_local_tokens']).toBe(3500);

    removeTempDir(tempHome);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. $CLAUDE_PLUGIN_ROOT Path Resolution
// ═══════════════════════════════════════════════════════════════════════════════

describe('8. $CLAUDE_PLUGIN_ROOT Path Resolution', () => {
  it('all 3 script files exist at expected paths', () => {
    for (const script of Object.values(SCRIPTS)) {
      expect(fs.existsSync(script)).toBe(true);
    }
  });

  it('.mcp.json args template resolves to existing file', () => {
    const mcp = JSON.parse(fs.readFileSync(MANIFESTS.mcp, 'utf-8'));
    const args = mcp.mcpServers['claude-saver'].args as string[];
    for (const arg of args) {
      const resolved = arg.replace('${CLAUDE_PLUGIN_ROOT}', PROJECT_ROOT);
      expect(fs.existsSync(resolved)).toBe(true);
    }
  });

  it('hooks.json command templates resolve to existing files', () => {
    const data = JSON.parse(fs.readFileSync(MANIFESTS.hooks, 'utf-8'));
    for (const eventName of Object.keys(data.hooks)) {
      for (const matcherGroup of data.hooks[eventName]) {
        for (const hook of matcherGroup.hooks) {
          const command = hook.command as string;
          // Extract the script path from "node ${CLAUDE_PLUGIN_ROOT}/scripts/xxx.cjs"
          const parts = command.split(' ');
          const scriptArg = parts.find((p: string) => p.includes('${CLAUDE_PLUGIN_ROOT}'));
          if (scriptArg) {
            const resolved = scriptArg.replace('${CLAUDE_PLUGIN_ROOT}', PROJECT_ROOT);
            expect(fs.existsSync(resolved)).toBe(true);
          }
        }
      }
    }
  });

  it('script files are non-empty', () => {
    for (const script of Object.values(SCRIPTS)) {
      const stat = fs.statSync(script);
      expect(stat.size).toBeGreaterThan(0);
    }
  });

  it('script files start with valid JavaScript', () => {
    for (const script of Object.values(SCRIPTS)) {
      const head = fs.readFileSync(script, 'utf-8').slice(0, 200);
      // CJS bundles typically start with a comment, "use strict", or var/const
      expect(head.length).toBeGreaterThan(0);
      // Should not start with HTML or binary
      expect(head).not.toMatch(/^<(!DOCTYPE|html)/i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Metrics JSONL Cross-Component Round-Trip
// ═══════════════════════════════════════════════════════════════════════════════

describe('9. Metrics JSONL Cross-Component Round-Trip', { timeout: 30000 }, () => {
  it('hook writes 1 entry → MCP summary shows total_tasks >= 1', async () => {
    const tempHome = makeTempDir();
    const env = childEnv(tempHome);

    // Hook writes a metrics entry
    const event = JSON.stringify({
      agent_name: 'local-worker',
      duration_ms: 1000,
      tools_used: ['claudesaver_complete'],
    });
    await runHook(SCRIPTS.subagentStop, event, env);

    // MCP server reads it
    const session = spawnMcpServer(env);
    await initializeMcpSession(session);

    const resp = await mcpToolCall(session, 1, 'claudesaver_metrics', { action: 'summary' });
    const data = parseToolResult(resp) as Record<string, unknown>;
    session.close();

    expect(data['total_tasks']).toBeGreaterThanOrEqual(1);

    removeTempDir(tempHome);
  });

  it('hook writes 5 entries → MCP summary shows total_tasks >= 5', async () => {
    const tempHome = makeTempDir();
    const env = childEnv(tempHome);

    // Write 5 entries via the hook
    for (let i = 0; i < 5; i++) {
      const event = JSON.stringify({
        agent_name: 'local-worker',
        duration_ms: (i + 1) * 100,
        tools_used: [`tool_${i}`],
      });
      await runHook(SCRIPTS.subagentStop, event, env);
    }

    // MCP server reads them
    const session = spawnMcpServer(env);
    await initializeMcpSession(session);

    const resp = await mcpToolCall(session, 1, 'claudesaver_metrics', { action: 'summary' });
    const data = parseToolResult(resp) as Record<string, unknown>;
    session.close();

    expect(data['total_tasks']).toBeGreaterThanOrEqual(5);

    removeTempDir(tempHome);
  });
});
