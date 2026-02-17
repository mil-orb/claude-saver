import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface MetricsEntry {
  type?: 'subagent' | 'completion';
  timestamp: string;
  agent: string;
  duration_ms: number;
  tools_used: string[];
  session_id: string;
}

export interface CompletionEntry {
  type: 'completion';
  timestamp: string;
  tokens_used: number;
  model: string;
  duration_ms: number;
  tool: string;
  session_id: string;
}

export type AnyMetricsEntry = MetricsEntry | CompletionEntry;

export interface MetricsSummary {
  total_tasks: number;
  local_tasks: number;
  cloud_tasks: number;
  total_duration_ms: number;
  total_local_tokens: number;
  estimated_cost_saved: number;
  sessions: number;
  tools_frequency: Record<string, number>;
}

function getMetricsPath(): string {
  return path.join(os.homedir(), '.claudesaver', 'metrics.jsonl');
}

export function loadMetrics(): AnyMetricsEntry[] {
  try {
    const metricsPath = getMetricsPath();
    if (!fs.existsSync(metricsPath)) return [];

    const content = fs.readFileSync(metricsPath, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try { return JSON.parse(line) as AnyMetricsEntry; }
        catch { return null; }
      })
      .filter((e): e is AnyMetricsEntry => e !== null);
  } catch {
    return [];
  }
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function logCompletion(entry: {
  tokens_used: number;
  model: string;
  duration_ms: number;
  tool: string;
}): void {
  try {
    const metricsPath = getMetricsPath();
    ensureDir(metricsPath);
    const record: CompletionEntry = {
      type: 'completion',
      timestamp: new Date().toISOString(),
      tokens_used: entry.tokens_used,
      model: entry.model,
      duration_ms: entry.duration_ms,
      tool: entry.tool,
      session_id: process.env['CLAUDE_SESSION_ID'] ?? 'unknown',
    };
    fs.appendFileSync(metricsPath, JSON.stringify(record) + '\n', 'utf-8');
  } catch {
    // Fire-and-forget
  }
}

export function computeSummary(entries?: AnyMetricsEntry[], costPerMillionTokens?: number): MetricsSummary {
  const metrics = entries ?? loadMetrics();
  const costRate = costPerMillionTokens ?? 8;
  const sessions = new Set(metrics.map(m => m.session_id));
  const toolsFreq: Record<string, number> = {};

  let totalDuration = 0;
  let totalLocalTokens = 0;
  let completionCount = 0;

  for (const entry of metrics) {
    totalDuration += entry.duration_ms;

    if ('type' in entry && entry.type === 'completion') {
      const comp = entry as CompletionEntry;
      totalLocalTokens += comp.tokens_used;
      completionCount++;
      toolsFreq[comp.tool] = (toolsFreq[comp.tool] ?? 0) + 1;
    } else if ('tools_used' in entry) {
      const sub = entry as MetricsEntry;
      for (const tool of sub.tools_used) {
        toolsFreq[tool] = (toolsFreq[tool] ?? 0) + 1;
      }
    }
  }

  // Estimated cost saved: tokens that ran locally instead of through cloud API
  const estimatedCostSaved = (totalLocalTokens / 1_000_000) * costRate;

  return {
    total_tasks: metrics.length,
    local_tasks: completionCount,
    cloud_tasks: 0,
    total_duration_ms: totalDuration,
    total_local_tokens: totalLocalTokens,
    estimated_cost_saved: Math.round(estimatedCostSaved * 100) / 100,
    sessions: sessions.size,
    tools_frequency: toolsFreq,
  };
}

export function resetMetrics(): void {
  try {
    const metricsPath = getMetricsPath();
    if (fs.existsSync(metricsPath)) {
      fs.writeFileSync(metricsPath, '', 'utf-8');
    }
  } catch {
    // Ignore
  }
}
