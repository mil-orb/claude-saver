import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import { loadConfig, saveConfig } from './config.js';
import { checkHealth, ollamaChat } from './health.js';
import { handleFs, handleFsPreview } from './fs-tools.js';
import { classifyTask } from './router.js';
import { computeSummary, resetMetrics, logCompletion } from './metrics.js';

const server = new McpServer({
  name: 'claudesaver',
  version: '0.1.0',
});

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function err(msg: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true as const };
}

// ═══════════════════════════════════════════════════════════════
// TIER 0: Pure local filesystem ops (NO LLM, zero tokens)
// ═══════════════════════════════════════════════════════════════

server.tool(
  'claudesaver_fs',
  'Safe filesystem queries — returns metadata only, never file contents. Operations: tree, list, find, stat, count_lines, git_status, git_log, git_diff_names',
  {
    operation: z.enum([
      'tree', 'list', 'find', 'stat', 'count_lines',
      'git_status', 'git_log', 'git_diff_names',
    ]).describe('Filesystem operation to perform'),
    path: z.string().describe('Target path'),
    pattern: z.string().optional().describe('Glob/regex for find operations'),
    depth: z.number().optional().describe('Max depth for tree/find (default 3)'),
    options: z.record(z.string()).optional().describe('Operation-specific flags'),
  },
  async ({ operation, path: targetPath, pattern, depth, options }) => {
    try {
      const result = await handleFs(operation, targetPath, { pattern, depth, options });
      return ok(result);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

server.tool(
  'claudesaver_fs_preview',
  'Safe file preview — returns ONLY structure (function/class names, imports, exports, signatures), never sensitive content',
  {
    file_path: z.string().describe('File to preview'),
    mode: z.enum(['structure', 'head', 'imports', 'exports', 'signatures']).describe('Preview mode'),
    lines: z.number().min(1).max(100).optional().describe('For head mode, default 10, max 100'),
  },
  async ({ file_path, mode, lines }) => {
    try {
      const result = await handleFsPreview(file_path, mode, lines);
      return ok(result);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// TIER 1: Local LLM tasks (Ollama, zero cloud egress)
// ═══════════════════════════════════════════════════════════════

server.tool(
  'claudesaver_complete',
  'Send a prompt to a local Ollama model for completion. Includes routing metadata showing classification decision. Use for tasks that don\'t need cloud-tier intelligence.',
  {
    prompt: z.string().describe('The task/question to send to the local model'),
    model: z.string().optional().describe('Override model (default from config)'),
    system_prompt: z.string().optional().describe('Optional system context'),
    temperature: z.number().optional().describe('Default 0.3 for code tasks'),
    max_tokens: z.number().optional().describe('Default 4096'),
  },
  async ({ prompt, model, system_prompt, temperature, max_tokens }) => {
    try {
      // Classify the task via router
      const routing = await classifyTask(prompt);

      const result = await ollamaChat(prompt, {
        model,
        system_prompt,
        temperature,
        max_tokens,
      });
      logCompletion({ tokens_used: result.tokens_used, model: result.model, duration_ms: result.duration_ms, tool: 'claudesaver_complete' });
      const response: Record<string, unknown> = {
        response: result.response,
        model: result.model,
        tokens_used: result.tokens_used,
        duration_ms: result.duration_ms,
        routing: {
          route: routing.route,
          task_complexity: routing.task_complexity,
          confidence: routing.confidence,
          reason: routing.reason,
          classification_layer: routing.classification_layer,
        },
      };
      if (result.thinking) {
        response.thinking = result.thinking;
      }
      if (result.done_reason && result.done_reason !== 'stop') {
        response.done_reason = result.done_reason;
      }
      return ok(response);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

server.tool(
  'claudesaver_generate_code',
  'Generate code using a local Ollama model. Provides a structured code generation prompt template for better results.',
  {
    description: z.string().describe('What code to generate'),
    language: z.string().describe('Target programming language'),
    context: z.string().optional().describe('Surrounding code or file context'),
    model: z.string().optional().describe('Override model'),
  },
  async ({ description, language, context, model }) => {
    try {
      const systemPrompt = `You are an expert ${language} developer. Generate clean, idiomatic ${language} code. Output ONLY the code, no explanations.`;
      let prompt = `Generate ${language} code:\n${description}`;
      if (context) {
        prompt += `\n\nContext (surrounding code):\n${context}`;
      }

      const result = await ollamaChat(prompt, {
        model,
        system_prompt: systemPrompt,
        temperature: 0.3,
      });

      logCompletion({ tokens_used: result.tokens_used, model: result.model, duration_ms: result.duration_ms, tool: 'claudesaver_generate_code' });
      const resp: Record<string, unknown> = {
        code: result.response,
        language,
        model: result.model,
        tokens_used: result.tokens_used,
        duration_ms: result.duration_ms,
      };
      if (result.thinking) resp.thinking = result.thinking;
      return ok(resp);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

server.tool(
  'claudesaver_analyze_file',
  'Read a file and analyze it using a local Ollama model. The file contents stay local — never sent to the cloud API.',
  {
    file_path: z.string().describe('Path to the file to analyze'),
    task: z.enum(['summarize', 'find_bugs', 'explain', 'refactor']).describe('Analysis task'),
    model: z.string().optional().describe('Override model'),
  },
  async ({ file_path, task, model }) => {
    try {
      const fileStat = fs.statSync(file_path);
      if (fileStat.size > 10_000_000) {
        return err(`File too large: ${(fileStat.size / 1_000_000).toFixed(1)}MB (max 10MB)`);
      }
      const content = fs.readFileSync(file_path, 'utf-8');

      const taskPrompts: Record<string, string> = {
        summarize: 'Provide a concise summary of what this code does, its key functions, and its purpose.',
        find_bugs: 'Review this code for bugs, potential issues, and improvements. List each issue clearly.',
        explain: 'Explain this code in detail. What does each section do? What are the key design decisions?',
        refactor: 'Suggest refactoring improvements for this code. Focus on readability, maintainability, and best practices.',
      };

      const prompt = `${taskPrompts[task]}\n\nFile: ${file_path}\n\n\`\`\`\n${content}\n\`\`\``;

      const result = await ollamaChat(prompt, {
        model,
        system_prompt: 'You are an expert code reviewer. Be specific and actionable.',
        temperature: 0.3,
      });

      logCompletion({ tokens_used: result.tokens_used, model: result.model, duration_ms: result.duration_ms, tool: 'claudesaver_analyze_file' });
      const resp: Record<string, unknown> = {
        analysis: result.response,
        task,
        file_path,
        model: result.model,
        tokens_used: result.tokens_used,
        duration_ms: result.duration_ms,
      };
      if (result.thinking) resp.thinking = result.thinking;
      return ok(resp);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

server.tool(
  'claudesaver_batch',
  'Run multiple prompts against a local Ollama model in parallel. Useful for batch operations like documenting many functions.',
  {
    tasks: z.array(z.object({
      prompt: z.string(),
      id: z.string(),
    })).max(100).describe('Array of {prompt, id} objects (max 100)'),
    model: z.string().optional().describe('Override model'),
    concurrency: z.number().min(1).max(10).optional().describe('Max parallel requests (default 2, max 10)'),
  },
  async ({ tasks, model, concurrency }) => {
    try {
      const maxConcurrency = concurrency ?? 2;
      const results: Array<{ id: string; response: string; tokens_used: number; duration_ms: number }> = [];

      // Process in batches
      for (let i = 0; i < tasks.length; i += maxConcurrency) {
        const batch = tasks.slice(i, i + maxConcurrency);
        const batchResults = await Promise.all(
          batch.map(async (task) => {
            try {
              const result = await ollamaChat(task.prompt, { model, temperature: 0.3 });
              return { id: task.id, response: result.response, tokens_used: result.tokens_used, duration_ms: result.duration_ms };
            } catch (e) {
              return { id: task.id, response: `Error: ${e instanceof Error ? e.message : String(e)}`, tokens_used: 0, duration_ms: 0 };
            }
          })
        );
        results.push(...batchResults);
      }

      const totalTokens = results.reduce((sum, r) => sum + r.tokens_used, 0);
      const totalDuration = results.reduce((sum, r) => sum + r.duration_ms, 0);

      if (totalTokens > 0) {
        logCompletion({ tokens_used: totalTokens, model: 'batch', duration_ms: totalDuration, tool: 'claudesaver_batch' });
      }

      return ok({
        results,
        summary: {
          total_tasks: tasks.length,
          total_tokens: totalTokens,
          total_duration_ms: totalDuration,
        },
      });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// Management tools
// ═══════════════════════════════════════════════════════════════

server.tool(
  'claudesaver_models',
  'List available Ollama models and check health status',
  {
    action: z.enum(['list', 'health']).describe('"list" shows available models, "health" checks connectivity'),
    model: z.string().optional().describe('Model name for specific queries'),
  },
  async ({ action }) => {
    try {
      const health = await checkHealth();
      if (action === 'health') {
        return ok(health);
      }
      const config = loadConfig();
      return ok({
        models: health.models,
        default_model: config.ollama.default_model,
        healthy: health.healthy,
        url: health.url,
      });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

const LEVEL_NAMES: Record<number, string> = {
  0: 'Off', 1: 'Conservative', 2: 'Balanced',
  3: 'Aggressive', 4: 'Max Local', 5: 'Offline',
};

const LEVEL_DESCRIPTIONS: Record<number, string> = {
  0: 'Nothing auto-routed. Manual delegation only via MCP tools.',
  1: 'Only trivial tasks (Level ≤2) go local. Immediate escalation on any issue.',
  2: 'Simple-to-moderate tasks (Level ≤3) go local. Standard escalation. ~40-60% savings.',
  3: 'Most tasks (Level ≤4) go local. Tolerant escalation. ~60-80% savings.',
  4: 'All tasks attempted locally first. Minimal escalation. ~80-95% savings.',
  5: 'Offline mode. All tasks local, no cloud fallback. ~95-100% savings.',
};

server.tool(
  'claudesaver_level',
  'Get or set the delegation level (0-5). Controls how aggressively tasks are routed to local models.',
  {
    action: z.enum(['get', 'set', 'describe']).describe('"get" current level, "set" change level, "describe" explain all levels'),
    level: z.number().min(0).max(5).optional().describe('Target level for "set" action'),
  },
  async ({ action, level }) => {
    try {
      const config = loadConfig();

      if (action === 'describe') {
        const levels = Object.entries(LEVEL_NAMES).map(([num, name]) => ({
          level: Number(num),
          name,
          description: LEVEL_DESCRIPTIONS[Number(num)],
          current: Number(num) === config.delegation_level,
        }));
        return ok({ levels });
      }

      if (action === 'set') {
        if (level === undefined) {
          return err('level is required for set action');
        }
        config.delegation_level = level as 0 | 1 | 2 | 3 | 4 | 5;
        saveConfig(config);
      }

      return ok({
        current_level: config.delegation_level,
        name: LEVEL_NAMES[config.delegation_level],
        description: LEVEL_DESCRIPTIONS[config.delegation_level],
      });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

server.tool(
  'claudesaver_metrics',
  'View token savings metrics and routing statistics.',
  {
    action: z.enum(['summary', 'reset', 'session']).describe('"summary" shows cumulative stats, "reset" clears history, "session" shows current session'),
  },
  async ({ action }) => {
    try {
      if (action === 'reset') {
        resetMetrics();
        return ok({ message: 'Metrics reset successfully' });
      }

      const summary = computeSummary();
      return ok(summary);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// Start server
// ═══════════════════════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error('ClaudeSaver MCP server failed to start:', e);
  process.exit(1);
});
