import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig } from './config.js';

export interface HistoricalRecord {
  task_fingerprint: string;
  task_type: string;
  level_used: number;
  outcome: 'success' | 'escalated' | 'user_rejected' | 'unknown';
  quality_signal?: number;
  timestamp: string;
}

export interface LearnerRecommendation {
  adjusted_level?: number;
  confidence_adjustment: number;
  reason: string;
  sample_size: number;
}

function getHistoryPath(): string {
  return path.join(os.homedir(), '.claudesaver', 'history.jsonl');
}

export function fingerprint(taskDescription: string): string {
  // Normalize: lowercase, remove extra whitespace, sort words
  const words = taskDescription
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .sort();

  // Simple hash
  let hash = 0;
  const str = words.join(' ');
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit int
  }
  return Math.abs(hash).toString(36);
}

export function recordDecision(record: HistoricalRecord): void {
  try {
    const historyPath = getHistoryPath();
    const dir = path.dirname(historyPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(historyPath, JSON.stringify(record) + '\n', 'utf-8');
  } catch {
    // Fire-and-forget
  }
}

export function loadHistory(): HistoricalRecord[] {
  try {
    const historyPath = getHistoryPath();
    if (!fs.existsSync(historyPath)) return [];

    const content = fs.readFileSync(historyPath, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try { return JSON.parse(line) as HistoricalRecord; }
        catch { return null; }
      })
      .filter((r): r is HistoricalRecord => r !== null);
  } catch {
    return [];
  }
}

export function getRecommendation(
  taskType: string,
  proposedLevel: number
): LearnerRecommendation {
  const config = loadConfig();
  if (!config.routing.use_historical_learning) {
    return { confidence_adjustment: 0, reason: 'Historical learning disabled', sample_size: 0 };
  }

  const minRecords = config.routing.learner_min_records;
  const history = loadHistory();
  if (history.length < minRecords) {
    return { confidence_adjustment: 0, reason: `Insufficient data (${history.length}/${minRecords} records)`, sample_size: history.length };
  }

  // Filter to matching task type
  const relevant = history.filter(r => r.task_type === taskType);
  if (relevant.length < 10) {
    return { confidence_adjustment: 0, reason: `Insufficient data for task type "${taskType}"`, sample_size: relevant.length };
  }

  // Compute success rate at the proposed level
  const atLevel = relevant.filter(r => r.level_used === proposedLevel);
  if (atLevel.length < 5) {
    return { confidence_adjustment: 0, reason: `Insufficient data at level ${proposedLevel}`, sample_size: atLevel.length };
  }

  const successCount = atLevel.filter(r => r.outcome === 'success').length;
  const successRate = successCount / atLevel.length;

  // Logistic adjustment: high success → boost confidence, low success → reduce
  const adjustment = (successRate - 0.5) * 0.4; // Range: -0.2 to +0.2

  let adjustedLevel: number | undefined;
  if (successRate > 0.85 && proposedLevel > 1) {
    // Very successful — could potentially use a smaller model
    adjustedLevel = proposedLevel - 1;
  } else if (successRate < 0.5 && proposedLevel < 5) {
    // Poor success — recommend higher level
    adjustedLevel = proposedLevel + 1;
  }

  return {
    adjusted_level: adjustedLevel,
    confidence_adjustment: adjustment,
    reason: `${taskType} at level ${proposedLevel}: ${(successRate * 100).toFixed(0)}% success (${atLevel.length} samples)`,
    sample_size: atLevel.length,
  };
}
