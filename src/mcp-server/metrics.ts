import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, resolvePath } from './config.js';

export interface MetricsEntry {
  type?: 'subagent' | 'completion';
  timestamp: string;
  agent: string;
  duration_ms: number;
  tools_used: string[];
  session_id: string;
}

export type QualityStatus = 'accepted' | 'retried_accepted' | 'escalated';

export interface CompletionEntry {
  type: 'completion';
  timestamp: string;
  tokens_used: number;
  model: string;
  duration_ms: number;
  tool: string;
  session_id: string;
  /** Estimated cloud tokens consumed by the tool-call wrapper overhead */
  cloud_overhead_tokens?: number;
  /** Actual output token count from Ollama */
  output_tokens?: number;
  /** Light pass quality gate outcome */
  quality_status?: QualityStatus;
  /** Number of attempts before acceptance/escalation */
  attempt_count?: number;
}

export type AnyMetricsEntry = MetricsEntry | CompletionEntry;

export interface MetricsSummary {
  total_tasks: number;
  local_tasks: number;
  cloud_tasks: number;
  total_duration_ms: number;
  total_local_tokens: number;
  total_cloud_overhead_tokens: number;
  net_tokens_saved: number;
  gross_cost_saved: number;
  overhead_cost: number;
  net_cost_saved: number;
  sessions: number;
  tools_frequency: Record<string, number>;
}

function getMetricsPath(): string {
  const config = loadConfig();
  return resolvePath(config.metrics.log_path);
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

/**
 * Estimate the cloud API overhead tokens for a delegation round-trip.
 *
 * When Claude delegates via a tool call, the overhead is:
 * - Tool call output: ~80 tokens (the JSON tool invocation Claude generates)
 * - Tool result input: roughly response_chars / 4 (the MCP response Claude reads back)
 *
 * This is the MARGINAL cost — the extra tokens beyond what Claude would
 * have used answering directly. System prompt and conversation history
 * exist regardless of delegation.
 */
export function estimateCloudOverhead(responseTokens: number): number {
  const TOOL_CALL_OUTPUT = 80; // Fixed: Claude's tool invocation JSON
  const RESULT_INPUT = Math.ceil(responseTokens * 1.3); // MCP wraps response in JSON + metadata
  return TOOL_CALL_OUTPUT + RESULT_INPUT;
}

export function logCompletion(entry: {
  tokens_used: number;
  model: string;
  duration_ms: number;
  tool: string;
}): void {
  try {
    const config = loadConfig();
    if (!config.metrics.enabled) return;

    const metricsPath = getMetricsPath();
    ensureDir(metricsPath);
    const overhead = estimateCloudOverhead(entry.tokens_used);
    const record: CompletionEntry = {
      type: 'completion',
      timestamp: new Date().toISOString(),
      tokens_used: entry.tokens_used,
      model: entry.model,
      duration_ms: entry.duration_ms,
      tool: entry.tool,
      session_id: process.env['CLAUDE_SESSION_ID'] ?? 'unknown',
      cloud_overhead_tokens: overhead,
    };
    fs.appendFileSync(metricsPath, JSON.stringify(record) + '\n', 'utf-8');
  } catch {
    // Fire-and-forget
  }
}

/**
 * Detect the Claude model output token price from environment variables.
 * Haiku=$5/M, Sonnet=$15/M, Opus=$25/M output tokens.
 */
function detectModelCostRate(): number | null {
  const modelId = (process.env['CLAUDE_MODEL'] ?? process.env['ANTHROPIC_MODEL'] ?? '').toLowerCase();
  if (modelId.includes('opus')) return 25;
  if (modelId.includes('sonnet')) return 15;
  if (modelId.includes('haiku')) return 5;
  return null;
}

export function computeSummary(entries?: AnyMetricsEntry[], costPerMillionTokens?: number): MetricsSummary {
  const config = loadConfig();
  const metrics = entries ?? loadMetrics();
  // Priority: explicit param > detected model > config value
  const costRate = costPerMillionTokens ?? detectModelCostRate() ?? config.welcome.cost_per_million_tokens;
  const sessions = new Set(metrics.map(m => m.session_id));
  const toolsFreq: Record<string, number> = {};

  let totalDuration = 0;
  let totalLocalTokens = 0;
  let totalCloudOverhead = 0;
  let completionCount = 0;

  for (const entry of metrics) {
    totalDuration += entry.duration_ms;

    if ('type' in entry && entry.type === 'completion') {
      const comp = entry as CompletionEntry;
      totalLocalTokens += comp.tokens_used;
      // Use recorded overhead if available, otherwise estimate from tokens_used
      totalCloudOverhead += comp.cloud_overhead_tokens ?? estimateCloudOverhead(comp.tokens_used);
      completionCount++;
      toolsFreq[comp.tool] = (toolsFreq[comp.tool] ?? 0) + 1;
    } else if ('tools_used' in entry) {
      const sub = entry as MetricsEntry;
      for (const tool of sub.tools_used) {
        toolsFreq[tool] = (toolsFreq[tool] ?? 0) + 1;
      }
    }
  }

  // Gross savings: tokens that ran locally instead of through cloud API output
  // Cloud output costs ~5x input, so local tokens would have cost costRate as output
  const grossCostSaved = (totalLocalTokens / 1_000_000) * costRate;
  // Overhead cost: tool-call wrapper tokens at blended input rate (~costRate / 5)
  // Overhead is mostly input tokens (reading tool results), which cost ~1/5 of output
  const overheadCost = (totalCloudOverhead / 1_000_000) * (costRate / 5);
  const netCostSaved = grossCostSaved - overheadCost;
  const netTokensSaved = totalLocalTokens - totalCloudOverhead;

  return {
    total_tasks: metrics.length,
    local_tasks: completionCount,
    cloud_tasks: 0,
    total_duration_ms: totalDuration,
    total_local_tokens: totalLocalTokens,
    total_cloud_overhead_tokens: totalCloudOverhead,
    net_tokens_saved: netTokensSaved,
    gross_cost_saved: Math.round(grossCostSaved * 100) / 100,
    overhead_cost: Math.round(overheadCost * 100) / 100,
    net_cost_saved: Math.round(netCostSaved * 100) / 100,
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
