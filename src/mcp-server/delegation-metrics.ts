import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, resolvePath } from './config.js';
import type { QualityStatus } from './metrics.js';

export interface DelegationEntry {
  type: 'delegation';
  timestamp: string;
  tool: string;
  quality_status: QualityStatus;
  attempt_count: number;
  tokens_used: number;
  output_tokens: number;
  duration_ms: number;
  model: string;
  resolved_locally: boolean;
  session_id: string;
}

export interface DelegationSummary {
  total_delegations: number;
  resolved_locally: number;
  escalated: number;
  resolution_rate: number;
  retry_rate: number;
  avg_attempts: number;
  quality_breakdown: Record<QualityStatus, number>;
  total_local_tokens: number;
  avg_duration_ms: number;
}

function getMetricsPath(): string {
  const config = loadConfig();
  return resolvePath(config.metrics.log_path);
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function logDelegation(entry: {
  tool: string;
  quality_status: QualityStatus;
  attempt_count: number;
  tokens_used: number;
  output_tokens: number;
  duration_ms: number;
  model: string;
  resolved_locally: boolean;
}): void {
  try {
    const config = loadConfig();
    if (!config.metrics.enabled) return;

    const metricsPath = getMetricsPath();
    ensureDir(metricsPath);

    const record: DelegationEntry = {
      type: 'delegation',
      timestamp: new Date().toISOString(),
      tool: entry.tool,
      quality_status: entry.quality_status,
      attempt_count: entry.attempt_count,
      tokens_used: entry.tokens_used,
      output_tokens: entry.output_tokens,
      duration_ms: entry.duration_ms,
      model: entry.model,
      resolved_locally: entry.resolved_locally,
      session_id: process.env['CLAUDE_SESSION_ID'] ?? 'unknown',
    };

    fs.appendFileSync(metricsPath, JSON.stringify(record) + '\n', 'utf-8');
  } catch {
    // Fire-and-forget
  }
}

export function loadDelegationEntries(): DelegationEntry[] {
  try {
    const metricsPath = getMetricsPath();
    if (!fs.existsSync(metricsPath)) return [];

    const content = fs.readFileSync(metricsPath, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter((e): e is DelegationEntry => e !== null && e.type === 'delegation');
  } catch {
    return [];
  }
}

export function computeDelegationSummary(entries?: DelegationEntry[]): DelegationSummary {
  const delegations = entries ?? loadDelegationEntries();

  if (delegations.length === 0) {
    return {
      total_delegations: 0,
      resolved_locally: 0,
      escalated: 0,
      resolution_rate: 0,
      retry_rate: 0,
      avg_attempts: 0,
      quality_breakdown: { accepted: 0, retried_accepted: 0, escalated: 0 },
      total_local_tokens: 0,
      avg_duration_ms: 0,
    };
  }

  const resolved = delegations.filter(d => d.resolved_locally).length;
  const escalated = delegations.filter(d => !d.resolved_locally).length;
  const retried = delegations.filter(d => d.attempt_count > 1).length;
  const totalAttempts = delegations.reduce((sum, d) => sum + d.attempt_count, 0);
  const totalTokens = delegations.reduce((sum, d) => sum + d.tokens_used, 0);
  const totalDuration = delegations.reduce((sum, d) => sum + d.duration_ms, 0);

  const qualityBreakdown: Record<QualityStatus, number> = {
    accepted: 0,
    retried_accepted: 0,
    escalated: 0,
  };
  for (const d of delegations) {
    qualityBreakdown[d.quality_status] = (qualityBreakdown[d.quality_status] ?? 0) + 1;
  }

  return {
    total_delegations: delegations.length,
    resolved_locally: resolved,
    escalated,
    resolution_rate: resolved / delegations.length,
    retry_rate: retried / delegations.length,
    avg_attempts: totalAttempts / delegations.length,
    quality_breakdown: qualityBreakdown,
    total_local_tokens: totalTokens,
    avg_duration_ms: totalDuration / delegations.length,
  };
}
