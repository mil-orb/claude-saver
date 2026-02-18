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
    const configPath = path.join(os.homedir(), ".claude-saver", "config.json");
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
    const metricsPath = path.join(os.homedir(), ".claude-saver", "metrics.jsonl");
    if (!fs.existsSync(metricsPath)) return { total_local_tokens: 0, local_tasks: 0, gross_cost_saved: 0, net_cost_saved: 0, overhead_cost: 0 };
    const content = fs.readFileSync(metricsPath, "utf-8");
    let totalTokens = 0;
    let totalOverhead = 0;
    let taskCount = 0;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if ((entry.type === "completion" || entry.type === "delegation") && typeof entry.tokens_used === "number") {
          totalTokens += entry.tokens_used;
          totalOverhead += entry.cloud_overhead_tokens ?? 80 + Math.ceil(entry.tokens_used * 1.3);
          taskCount++;
        }
      } catch {
      }
    }
    const grossCost = totalTokens / 1e6 * costPerMillionTokens;
    const overheadCost = totalOverhead / 1e6 * (costPerMillionTokens / 5);
    const netCost = grossCost - overheadCost;
    return {
      total_local_tokens: totalTokens,
      local_tasks: taskCount,
      gross_cost_saved: Math.round(grossCost * 100) / 100,
      overhead_cost: Math.round(overheadCost * 100) / 100,
      net_cost_saved: Math.round(netCost * 100) / 100
    };
  } catch {
    return { total_local_tokens: 0, local_tasks: 0, gross_cost_saved: 0, net_cost_saved: 0, overhead_cost: 0 };
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
    const modelDetails = data.models ?? [];
    const models = modelDetails.map((m) => m.name);
    return { healthy: true, models, url: baseUrl, latency_ms: latency, modelDetails };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    return { healthy: false, models: [], url: baseUrl, error: msg };
  }
}
function resolveModel(configured, modelDetails) {
  if (modelDetails.length === 0) {
    return { model: configured, autoDetected: false };
  }
  const configuredBase = configured.replace(/:latest$/, "");
  const found = modelDetails.find(
    (m) => m.name === configured || m.name.replace(/:latest$/, "") === configuredBase
  );
  if (found) {
    return { model: found.name, autoDetected: false };
  }
  const sorted = [...modelDetails].sort((a, b) => b.size - a.size);
  return { model: sorted[0].name, autoDetected: true };
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
function detectModelCostRate(configRate) {
  const modelId = (process.env["CLAUDE_MODEL"] ?? process.env["ANTHROPIC_MODEL"] ?? "").toLowerCase();
  if (modelId.includes("opus")) {
    return { rate: 25, model_tier: "Opus" };
  }
  if (modelId.includes("sonnet")) {
    return { rate: 15, model_tier: "Sonnet" };
  }
  if (modelId.includes("haiku")) {
    return { rate: 5, model_tier: "Haiku" };
  }
  return { rate: configRate, model_tier: `$${configRate}/M` };
}
function getDelegationInstructions(level) {
  switch (level) {
    case 0:
      return null;
    // Manual only — no automatic delegation
    case 1:
      return [
        "DELEGATION L1: Trivial tasks only \u2192 local Ollama.",
        "claudesaver_fs \u2192 fs metadata | claudesaver_complete \u2192 docstrings, commit messages, boilerplate (200+ token output expected)",
        "SKIP delegation for short Q&A, yes/no, or <200 token answers \u2014 answer directly.",
        "Escalate immediately if local output seems wrong."
      ].join("\n");
    case 2:
      return [
        "DELEGATION L2: Routine coding tasks \u2192 local Ollama.",
        "claudesaver_fs \u2192 fs queries | claudesaver_complete \u2192 docs, comments, commits, format conversions | claudesaver_generate_code \u2192 boilerplate, scaffolding, clear-spec code | claudesaver_analyze_file \u2192 summaries, bug scanning",
        "SKIP delegation for short Q&A or tasks with <200 token expected output \u2014 the tool-call overhead costs more than it saves.",
        "Cloud: architecture decisions, debugging, security review, complex reasoning."
      ].join("\n");
    case 3:
      return [
        "DELEGATION L3: Most coding tasks \u2192 local. Delegate aggressively.",
        "claudesaver_fs \u2192 fs | claudesaver_complete or claudesaver_generate_code \u2192 all codegen, docs, tests, refactoring | claudesaver_analyze_file \u2192 analysis, review | claudesaver_batch \u2192 parallel ops",
        "SKIP: short Q&A (<200 token output) \u2014 answer directly to avoid overhead.",
        "Cloud only: architecture decisions, complex multi-file debugging, security-critical review."
      ].join("\n");
    case 4:
      return [
        "DELEGATION L4: Try ALL tasks locally first.",
        "claudesaver_complete \u2192 primary tool for all coding | claudesaver_fs \u2192 fs queries | claudesaver_analyze_file \u2192 file review | claudesaver_generate_code \u2192 code generation",
        "SKIP: trivial Q&A (<100 token answers) \u2014 direct answer is cheaper.",
        "Cloud only if local output is poor or task needs broad codebase reasoning."
      ].join("\n");
    case 5:
      return [
        "DELEGATION L5 \u2014 OFFLINE MODE. ALL tasks \u2192 local models.",
        "claudesaver_complete \u2192 prompts | claudesaver_fs \u2192 fs | claudesaver_generate_code \u2192 code | claudesaver_analyze_file \u2192 analysis",
        "On failure: report the failure to user. Do not handle directly."
      ].join("\n");
    default:
      return null;
  }
}
function warmUpModel(baseUrl, model) {
  fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, keep_alive: "10m" })
  }).catch(() => {
  });
}
async function main() {
  const config = loadConfig();
  const health = await checkHealth(config.ollama.base_url, config.ollama.health_timeout_ms);
  if (!health.healthy) {
    console.error(`[Claude-Saver] Ollama not available: ${health.error}`);
    process.exit(0);
  }
  const { model: activeModel, autoDetected } = resolveModel(config.ollama.default_model, health.modelDetails ?? []);
  warmUpModel(config.ollama.base_url, activeModel);
  const lines = [];
  const levelName = LEVEL_NAMES[config.delegation_level] ?? "Unknown";
  if (config.welcome.show_level) {
    lines.push(`[Claude-Saver] Ollama connected (${health.latency_ms}ms) \u2014 Level ${config.delegation_level} (${levelName})`);
  } else {
    lines.push(`[Claude-Saver] Ollama connected (${health.latency_ms}ms)`);
  }
  if (config.welcome.show_savings) {
    const { rate, model_tier } = detectModelCostRate(config.welcome.cost_per_million_tokens);
    const savings = loadSavings(rate);
    if (savings.local_tasks > 0) {
      const netSign = savings.net_cost_saved >= 0 ? "" : "-";
      lines.push(`Savings: ${formatTokens(savings.total_local_tokens)} local tokens across ${savings.local_tasks} tasks \u2014 net ~${netSign}$${Math.abs(savings.net_cost_saved)} saved at ${model_tier} rates (after $${savings.overhead_cost} overhead)`);
    } else {
      lines.push(`Savings: No local completions yet \u2014 delegate 200+ token tasks to save (${model_tier} output: $${rate}/M).`);
    }
  }
  if (config.welcome.show_models) {
    const modelList = health.models.slice(0, 5).join(", ");
    const moreCount = health.models.length > 5 ? ` (+${health.models.length - 5} more)` : "";
    const modelLabel = autoDetected ? `Auto-detected: ${activeModel}` : `Default: ${activeModel}`;
    lines.push(`Models: ${modelList}${moreCount} | ${modelLabel}`);
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
