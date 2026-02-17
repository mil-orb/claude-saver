"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/hooks/session-start.ts
var fs = __toESM(require("fs"), 1);
var path = __toESM(require("path"), 1);
var os = __toESM(require("os"), 1);
function loadConfig() {
  const defaults = {
    delegation_level: 2,
    ollama: {
      base_url: "http://localhost:11434",
      default_model: "slekrem/gpt-oss-claude-code-32k:latest",
      health_timeout_ms: 3e3
    },
    welcome: {
      show_savings: true,
      show_models: true,
      show_level: true,
      cost_per_million_tokens: 8
    }
  };
  try {
    const configPath = path.join(os.homedir(), ".claudesaver", "config.json");
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return {
        delegation_level: raw.delegation_level ?? defaults.delegation_level,
        ollama: { ...defaults.ollama, ...raw.ollama },
        welcome: { ...defaults.welcome, ...raw.welcome }
      };
    }
  } catch {
  }
  return defaults;
}
function loadSavings(costPerMillionTokens) {
  try {
    const metricsPath = path.join(os.homedir(), ".claudesaver", "metrics.jsonl");
    if (!fs.existsSync(metricsPath)) return { total_local_tokens: 0, local_tasks: 0, estimated_cost_saved: 0 };
    const content = fs.readFileSync(metricsPath, "utf-8");
    let totalTokens = 0;
    let taskCount = 0;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "completion" && typeof entry.tokens_used === "number") {
          totalTokens += entry.tokens_used;
          taskCount++;
        }
      } catch {
      }
    }
    const costSaved = totalTokens / 1e6 * costPerMillionTokens;
    return {
      total_local_tokens: totalTokens,
      local_tasks: taskCount,
      estimated_cost_saved: Math.round(costSaved * 100) / 100
    };
  } catch {
    return { total_local_tokens: 0, local_tasks: 0, estimated_cost_saved: 0 };
  }
}
async function checkHealth(baseUrl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    const latency = Date.now() - start;
    if (!response.ok) {
      return { healthy: false, models: [], url: baseUrl, error: `HTTP ${response.status}`, latency_ms: latency };
    }
    const data = await response.json();
    const models = (data.models ?? []).map((m) => m.name);
    return { healthy: true, models, url: baseUrl, latency_ms: latency };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    return { healthy: false, models: [], url: baseUrl, error: msg };
  }
}
var LEVEL_NAMES = {
  0: "Off",
  1: "Conservative",
  2: "Balanced",
  3: "Aggressive",
  4: "Max Local",
  5: "Offline"
};
function formatTokens(tokens) {
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M`;
  if (tokens >= 1e3) return `${(tokens / 1e3).toFixed(1)}K`;
  return String(tokens);
}
function getDelegationInstructions(level) {
  switch (level) {
    case 0:
      return null;
    // Manual only — no automatic delegation
    case 1:
      return [
        "DELEGATION ACTIVE \u2014 delegate only trivial tasks to save API tokens:",
        "- Filesystem metadata (tree, stat, find, git status) \u2192 claudesaver_fs",
        "- Docstrings for individual functions \u2192 claudesaver_complete",
        "- Commit message drafts \u2192 claudesaver_complete",
        "Handle everything else directly. Escalate immediately if local output seems wrong."
      ].join("\n");
    case 2:
      return [
        "DELEGATION ACTIVE \u2014 delegate routine coding tasks to local models to save API tokens:",
        "- Filesystem queries (tree, stat, find, git status/log) \u2192 claudesaver_fs",
        "- Docstrings, comments, commit messages, format conversions \u2192 claudesaver_complete",
        "- Boilerplate, scaffolding, code with clear specs \u2192 claudesaver_generate_code",
        "- File summaries and bug scanning \u2192 claudesaver_analyze_file",
        "Handle directly: architecture decisions, debugging, security review, complex reasoning, anything the user asks for YOUR opinion on."
      ].join("\n");
    case 3:
      return [
        "DELEGATION ACTIVE \u2014 aggressively delegate to local models. Most coding tasks should go local:",
        "- Filesystem queries \u2192 claudesaver_fs",
        "- All code generation, documentation, tests, refactoring \u2192 claudesaver_complete or claudesaver_generate_code",
        "- File analysis and review \u2192 claudesaver_analyze_file",
        "- Batch operations \u2192 claudesaver_batch",
        "Handle directly only: architecture decisions, complex multi-file debugging, security-critical review."
      ].join("\n");
    case 4:
      return [
        "DELEGATION ACTIVE \u2014 try ALL tasks locally first:",
        "- Use claudesaver_complete as your primary tool for all coding tasks.",
        "- Use claudesaver_fs for all filesystem queries.",
        "- Use claudesaver_analyze_file for file review.",
        "- Use claudesaver_generate_code for code generation.",
        "Only handle directly if local output is poor quality, or the task requires broad codebase reasoning that cannot be provided via context."
      ].join("\n");
    case 5:
      return [
        "DELEGATION ACTIVE \u2014 OFFLINE MODE. Route ALL tasks to local models:",
        "- claudesaver_complete for all prompts. claudesaver_fs for filesystem.",
        "- claudesaver_generate_code for code. claudesaver_analyze_file for analysis.",
        "- If the local model fails or produces poor output, report the failure to the user rather than handling it directly."
      ].join("\n");
    default:
      return null;
  }
}
async function main() {
  const config = loadConfig();
  const health = await checkHealth(config.ollama.base_url, config.ollama.health_timeout_ms);
  if (!health.healthy) {
    console.error(`[ClaudeSaver] Ollama not available: ${health.error}`);
    process.exit(0);
  }
  const lines = [];
  const levelName = LEVEL_NAMES[config.delegation_level] ?? "Unknown";
  if (config.welcome.show_level) {
    lines.push(`[ClaudeSaver] Ollama connected (${health.latency_ms}ms) \u2014 Level ${config.delegation_level} (${levelName})`);
  } else {
    lines.push(`[ClaudeSaver] Ollama connected (${health.latency_ms}ms)`);
  }
  if (config.welcome.show_savings) {
    const savings = loadSavings(config.welcome.cost_per_million_tokens);
    if (savings.local_tasks > 0) {
      lines.push(`Savings: ${formatTokens(savings.total_local_tokens)} tokens locally across ${savings.local_tasks} tasks \u2014 ~$${savings.estimated_cost_saved} saved`);
    } else {
      lines.push(`Savings: No local completions yet \u2014 start delegating to save tokens!`);
    }
  }
  if (config.welcome.show_models) {
    const modelList = health.models.slice(0, 5).join(", ");
    const moreCount = health.models.length > 5 ? ` (+${health.models.length - 5} more)` : "";
    lines.push(`Models: ${modelList}${moreCount} | Default: ${config.ollama.default_model}`);
  }
  const instructions = getDelegationInstructions(config.delegation_level);
  if (instructions) {
    lines.push(instructions);
  }
  const context = lines.join("\n");
  const output = JSON.stringify({ additionalContext: context });
  process.stdout.write(output);
}
main().then(() => process.exit(0)).catch(() => process.exit(0));
