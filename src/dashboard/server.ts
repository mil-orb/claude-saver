/**
 * Claude-Saver Dashboard Server
 * Lightweight HTTP server serving the metrics dashboard on localhost:37888.
 * Reads ~/.claude-saver/metrics.jsonl and config.json for live data.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const PORT = parseInt(process.env['CLAUDE_SAVER_DASHBOARD_PORT'] ?? '37888', 10);
const HOST = '127.0.0.1';

function getDataDir(): string {
  return path.join(os.homedir(), '.claude-saver');
}

function loadMetricsData(): unknown[] {
  try {
    const metricsPath = path.join(getDataDir(), 'metrics.jsonl');
    if (!fs.existsSync(metricsPath)) return [];
    const content = fs.readFileSync(metricsPath, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter(e => e !== null);
  } catch {
    return [];
  }
}

function loadConfig(): Record<string, unknown> {
  try {
    const configPath = path.join(getDataDir(), 'config.json');
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

function estimateOverhead(tokensUsed: number): number {
  return 80 + Math.ceil(tokensUsed * 1.3);
}

interface SummaryData {
  total_tasks: number;
  local_tasks: number;
  total_local_tokens: number;
  total_cloud_overhead: number;
  net_tokens_saved: number;
  gross_cost: number;
  overhead_cost: number;
  net_cost: number;
  sessions: number;
  tools: Record<string, number>;
  timeline: Array<{ date: string; tokens: number; overhead: number; tasks: number }>;
  recent: Array<{ timestamp: string; tool: string; model: string; tokens: number; overhead: number; duration_ms: number }>;
  models: Record<string, number>;
}

function detectModelCostRate(): number | null {
  const modelId = (process.env['CLAUDE_MODEL'] ?? process.env['ANTHROPIC_MODEL'] ?? '').toLowerCase();
  if (modelId.includes('opus')) return 25;
  if (modelId.includes('sonnet')) return 15;
  if (modelId.includes('haiku')) return 5;
  return null;
}

function computeDashboardData(): SummaryData {
  const entries = loadMetricsData();
  const config = loadConfig();
  const configRate = (config as { welcome?: { cost_per_million_tokens?: number } })?.welcome?.cost_per_million_tokens ?? 8;
  const costRate = detectModelCostRate() ?? configRate;

  let totalLocalTokens = 0;
  let totalOverhead = 0;
  let completionCount = 0;
  const sessions = new Set<string>();
  const tools: Record<string, number> = {};
  const models: Record<string, number> = {};
  const dailyMap = new Map<string, { tokens: number; overhead: number; tasks: number }>();
  const recent: SummaryData['recent'] = [];

  for (const entry of entries as Array<Record<string, unknown>>) {
    if (typeof entry.session_id === 'string') sessions.add(entry.session_id);

    if (entry.type === 'completion' && typeof entry.tokens_used === 'number') {
      const tokens = entry.tokens_used as number;
      const overhead = (typeof entry.cloud_overhead_tokens === 'number')
        ? entry.cloud_overhead_tokens as number
        : estimateOverhead(tokens);

      totalLocalTokens += tokens;
      totalOverhead += overhead;
      completionCount++;

      const tool = (entry.tool as string) ?? 'unknown';
      tools[tool] = (tools[tool] ?? 0) + 1;

      const model = (entry.model as string) ?? 'unknown';
      models[model] = (models[model] ?? 0) + 1;

      // Daily aggregation
      const ts = entry.timestamp as string;
      const day = ts?.slice(0, 10) ?? 'unknown';
      const existing = dailyMap.get(day) ?? { tokens: 0, overhead: 0, tasks: 0 };
      existing.tokens += tokens;
      existing.overhead += overhead;
      existing.tasks++;
      dailyMap.set(day, existing);

      // Recent entries (keep last 50)
      recent.push({
        timestamp: ts,
        tool,
        model,
        tokens,
        overhead,
        duration_ms: (entry.duration_ms as number) ?? 0,
      });
    }
  }

  const grossCost = (totalLocalTokens / 1_000_000) * costRate;
  const overheadCost = (totalOverhead / 1_000_000) * (costRate / 5);
  const netCost = grossCost - overheadCost;

  // Sort timeline by date
  const timeline = Array.from(dailyMap.entries())
    .map(([date, data]) => ({ date, ...data }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Keep only last 50 recent, reverse for newest-first
  const recentSlice = recent.slice(-50).reverse();

  return {
    total_tasks: entries.length,
    local_tasks: completionCount,
    total_local_tokens: totalLocalTokens,
    total_cloud_overhead: totalOverhead,
    net_tokens_saved: totalLocalTokens - totalOverhead,
    gross_cost: Math.round(grossCost * 100) / 100,
    overhead_cost: Math.round(overheadCost * 100) / 100,
    net_cost: Math.round(netCost * 100) / 100,
    sessions: sessions.size,
    tools,
    timeline,
    recent: recentSlice,
    models,
  };
}

// Inline the HTML dashboard — it gets bundled into the CJS file
function getDashboardHTML(): string {
  const htmlPath = path.join(__dirname, 'dashboard.html');
  if (fs.existsSync(htmlPath)) {
    return fs.readFileSync(htmlPath, 'utf-8');
  }
  // Fallback: check relative to script location
  const altPath = path.join(path.dirname(process.argv[1] ?? '.'), 'dashboard.html');
  if (fs.existsSync(altPath)) {
    return fs.readFileSync(altPath, 'utf-8');
  }
  return '<html><body><h1>Dashboard HTML not found</h1></body></html>';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  // Restrict CORS to localhost only — prevent cross-origin data exfiltration
  res.setHeader('Access-Control-Allow-Origin', `http://127.0.0.1:${PORT}`);
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');

  if (url.pathname === '/api/data') {
    const data = computeDashboardData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  if (url.pathname === '/api/config') {
    const config = loadConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/dashboard') {
    const html = getDashboardHTML();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set CLAUDE_SAVER_DASHBOARD_PORT to use a different port.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`Claude-Saver Dashboard: http://${HOST}:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
