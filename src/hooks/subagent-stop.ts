/**
 * SubagentStop hook — logs metrics when local-worker subagent completes.
 * MUST: exit 0 always, fire-and-forget, never block.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface SubagentStopEvent {
  agent_name?: string;
  duration_ms?: number;
  tools_used?: string[];
  [key: string]: unknown;
}

interface MetricsEntry {
  timestamp: string;
  agent: string;
  duration_ms: number;
  tools_used: string[];
  session_id: string;
}

function getMetricsPath(): string {
  return path.join(os.homedir(), '.claudesaver', 'metrics.jsonl');
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function main(): Promise<void> {
  // Read stdin for event data
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  if (!input.trim()) {
    process.exit(0);
  }

  let event: SubagentStopEvent | undefined;
  try {
    event = JSON.parse(input) as SubagentStopEvent;
  } catch {
    // Not valid JSON — skip
    process.exit(0);
  }

  if (!event) {
    process.exit(0);
  }

  // Only log metrics for local-worker agent
  if (event.agent_name !== 'local-worker') {
    process.exit(0);
  }

  const entry: MetricsEntry = {
    timestamp: new Date().toISOString(),
    agent: event.agent_name,
    duration_ms: event.duration_ms ?? 0,
    tools_used: event.tools_used ?? [],
    session_id: process.env['CLAUDE_SESSION_ID'] ?? 'unknown',
  };

  try {
    const metricsPath = getMetricsPath();
    ensureDir(metricsPath);
    fs.appendFileSync(metricsPath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Fire-and-forget — never fail
  }
}

main().then(() => process.exit(0)).catch(() => process.exit(0));
