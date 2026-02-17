#!/usr/bin/env node
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

// src/cli.ts
var fs3 = __toESM(require("fs"), 1);
var path2 = __toESM(require("path"), 1);
var readline = __toESM(require("readline"), 1);

// src/mcp-server/config.ts
var fs = __toESM(require("fs"), 1);
var path = __toESM(require("path"), 1);
var os = __toESM(require("os"), 1);
var DEFAULT_CONFIG = {
  delegation_level: 2,
  ollama: {
    base_url: "http://localhost:11434",
    default_model: "slekrem/gpt-oss-claude-code-32k:latest",
    fallback_model: null,
    timeout_ms: 12e4,
    health_timeout_ms: 3e3
  },
  routing: {
    use_local_triage: true,
    use_historical_learning: false,
    enable_decomposition: false,
    triage_model: null,
    learner_min_records: 50
  },
  specialist_models: {},
  metrics: {
    enabled: true,
    log_path: "~/.claude-saver/metrics.jsonl"
  },
  welcome: {
    show_savings: true,
    show_models: true,
    show_level: true,
    cost_per_million_tokens: 8
  }
};
function getConfigDir() {
  return path.join(os.homedir(), ".claude-saver");
}
function getConfigPath() {
  return path.join(getConfigDir(), "config.json");
}
function resolvePath(p) {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}
function ensureConfigDir() {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
function loadConfig() {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      const userConfig = JSON.parse(raw);
      return deepMerge(DEFAULT_CONFIG, userConfig);
    }
  } catch {
  }
  return { ...DEFAULT_CONFIG };
}
function saveConfig(config) {
  ensureConfigDir();
  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}
var DANGEROUS_KEYS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    if (source[key] !== null && typeof source[key] === "object" && !Array.isArray(source[key]) && typeof target[key] === "object" && target[key] !== null && !Array.isArray(target[key])) {
      result[key] = deepMerge(
        target[key],
        source[key]
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// src/mcp-server/metrics.ts
var fs2 = __toESM(require("fs"), 1);
function getMetricsPath() {
  const config = loadConfig();
  return resolvePath(config.metrics.log_path);
}
function loadMetrics() {
  try {
    const metricsPath = getMetricsPath();
    if (!fs2.existsSync(metricsPath)) return [];
    const content = fs2.readFileSync(metricsPath, "utf-8");
    return content.split("\n").filter((line) => line.trim()).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter((e) => e !== null);
  } catch {
    return [];
  }
}
function estimateCloudOverhead(responseTokens) {
  const TOOL_CALL_OUTPUT = 80;
  const RESULT_INPUT = Math.ceil(responseTokens * 1.3);
  return TOOL_CALL_OUTPUT + RESULT_INPUT;
}
function detectModelCostRate() {
  const modelId = (process.env["CLAUDE_MODEL"] ?? process.env["ANTHROPIC_MODEL"] ?? "").toLowerCase();
  if (modelId.includes("opus")) return 25;
  if (modelId.includes("sonnet")) return 15;
  if (modelId.includes("haiku")) return 5;
  return null;
}
function computeSummary(entries, costPerMillionTokens) {
  const config = loadConfig();
  const metrics = entries ?? loadMetrics();
  const costRate = costPerMillionTokens ?? detectModelCostRate() ?? config.welcome.cost_per_million_tokens;
  const sessions = new Set(metrics.map((m) => m.session_id));
  const toolsFreq = {};
  let totalDuration = 0;
  let totalLocalTokens = 0;
  let totalCloudOverhead = 0;
  let completionCount = 0;
  for (const entry of metrics) {
    totalDuration += entry.duration_ms;
    if ("type" in entry && entry.type === "completion") {
      const comp = entry;
      totalLocalTokens += comp.tokens_used;
      totalCloudOverhead += comp.cloud_overhead_tokens ?? estimateCloudOverhead(comp.tokens_used);
      completionCount++;
      toolsFreq[comp.tool] = (toolsFreq[comp.tool] ?? 0) + 1;
    } else if ("tools_used" in entry) {
      const sub = entry;
      for (const tool of sub.tools_used) {
        toolsFreq[tool] = (toolsFreq[tool] ?? 0) + 1;
      }
    }
  }
  const grossCostSaved = totalLocalTokens / 1e6 * costRate;
  const overheadCost = totalCloudOverhead / 1e6 * (costRate / 5);
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
    tools_frequency: toolsFreq
  };
}
function resetMetrics() {
  try {
    const metricsPath = getMetricsPath();
    if (fs2.existsSync(metricsPath)) {
      fs2.writeFileSync(metricsPath, "", "utf-8");
    }
  } catch {
  }
}

// src/cli.ts
var LEVEL_NAMES = {
  0: "Off",
  1: "Conservative",
  2: "Balanced",
  3: "Aggressive",
  4: "Max Local",
  5: "Offline"
};
var LEVEL_DESCRIPTIONS = {
  0: "Nothing auto-routed \u2014 manual MCP tool calls only",
  1: "Docstrings, commit messages, formatting",
  2: "Above + boilerplate, scaffolding, summaries, simple codegen",
  3: "Above + most code generation, tests, refactoring",
  4: "Everything attempted locally first, escalate on poor quality",
  5: "All tasks local \u2014 no cloud fallback"
};
function isValidModelName(name) {
  return /^[a-zA-Z0-9._:/-]+$/.test(name) && name.length > 0 && name.length <= 256;
}
function formatTokens(tokens) {
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M`;
  if (tokens >= 1e3) return `${(tokens / 1e3).toFixed(1)}K`;
  return String(tokens);
}
function createRL() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}
function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
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
      return { healthy: false, models: [], latency_ms: latency, error: `HTTP ${response.status}` };
    }
    const data = await response.json();
    const models = (data.models ?? []).map((m) => m.name);
    return { healthy: true, models, latency_ms: latency };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    return { healthy: false, models: [], latency_ms: Date.now() - start, error: msg };
  }
}
async function cmdStatus() {
  const config = loadConfig();
  const health = await checkHealth(config.ollama.base_url, config.ollama.health_timeout_ms);
  const summary = computeSummary();
  const level = config.delegation_level;
  const levelName = LEVEL_NAMES[level] ?? "Unknown";
  console.log("");
  console.log("Claude-Saver Status");
  console.log("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
  if (health.healthy) {
    console.log(`Connection:  Connected (${health.latency_ms}ms) \u2014 ${config.ollama.base_url}`);
  } else {
    console.log(`Connection:  Disconnected \u2014 ${health.error}`);
  }
  console.log(`Level:       ${level} (${levelName})`);
  console.log(`Model:       ${config.ollama.default_model}`);
  if (health.healthy) {
    const modelList = health.models.slice(0, 5).join(", ");
    const more = health.models.length > 5 ? ` (+${health.models.length - 5} more)` : "";
    console.log(`Models:      ${health.models.length} available \u2014 ${modelList}${more}`);
  }
  console.log("");
  console.log("Savings");
  console.log(`  Tasks:     ${summary.total_tasks} total, ${summary.local_tasks} local`);
  console.log(`  Tokens:    ${formatTokens(summary.total_local_tokens)} processed locally`);
  console.log(`  Gross:     ~$${summary.gross_cost_saved}`);
  console.log(`  Overhead:  -$${summary.overhead_cost} (tool-call wrapper cost)`);
  console.log(`  Net saved: ~$${summary.net_cost_saved}`);
  console.log("");
}
async function cmdSettings() {
  const rl = createRL();
  let running = true;
  while (running) {
    const config = loadConfig();
    const health = await checkHealth(config.ollama.base_url, config.ollama.health_timeout_ms);
    const summary = computeSummary();
    const level = config.delegation_level;
    const levelName = LEVEL_NAMES[level] ?? "Unknown";
    console.log("");
    console.log("Claude-Saver Settings");
    console.log("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    if (health.healthy) {
      console.log(`Connection:  Connected (${health.latency_ms}ms) \u2014 ${config.ollama.base_url}`);
    } else {
      console.log(`Connection:  Disconnected \u2014 ${health.error}`);
    }
    console.log(`Level:       ${level} (${levelName})`);
    console.log(`Model:       ${config.ollama.default_model}`);
    console.log(`Metrics:     ${config.metrics.enabled ? "Enabled" : "Disabled"}`);
    console.log("");
    console.log(`Savings:     ${formatTokens(summary.total_local_tokens)} tokens, ${summary.local_tasks} tasks, net ~$${summary.net_cost_saved}`);
    console.log("");
    console.log("Options:");
    console.log("  1. Change delegation level");
    console.log("  2. Change default model");
    console.log("  3. Toggle metrics logging");
    console.log("  4. Reset savings history");
    console.log("  5. View all levels");
    console.log("  6. Done");
    console.log("");
    const choice = await ask(rl, "Choose [1-6]: ");
    switch (choice) {
      case "1": {
        console.log("");
        for (let i = 0; i <= 5; i++) {
          const marker = i === level ? " (current)" : "";
          console.log(`  ${i}. ${LEVEL_NAMES[i]} \u2014 ${LEVEL_DESCRIPTIONS[i]}${marker}`);
        }
        console.log("");
        const newLevel = await ask(rl, "New level [0-5]: ");
        const n = parseInt(newLevel, 10);
        if (n >= 0 && n <= 5) {
          config.delegation_level = n;
          saveConfig(config);
          console.log(`
Level set to ${n} (${LEVEL_NAMES[n]})`);
        } else {
          console.log("\nInvalid level, no change.");
        }
        break;
      }
      case "2": {
        if (health.healthy && health.models.length > 0) {
          console.log("");
          health.models.forEach((m, i) => {
            const marker = m === config.ollama.default_model ? " (current)" : "";
            console.log(`  ${i + 1}. ${m}${marker}`);
          });
          console.log("");
          const modelChoice = await ask(rl, `Choose [1-${health.models.length}] or type model name: `);
          const idx = parseInt(modelChoice, 10);
          let newModel;
          if (idx >= 1 && idx <= health.models.length) {
            newModel = health.models[idx - 1];
          } else {
            newModel = modelChoice;
          }
          if (newModel && isValidModelName(newModel)) {
            config.ollama.default_model = newModel;
            saveConfig(config);
            console.log(`
Default model set to ${newModel}`);
          } else if (newModel) {
            console.log("\nInvalid model name.");
          }
        } else {
          console.log("\nOllama not connected. Cannot list models.");
          const manual = await ask(rl, "Enter model name manually (or press Enter to skip): ");
          if (manual && isValidModelName(manual)) {
            config.ollama.default_model = manual;
            saveConfig(config);
            console.log(`
Default model set to ${manual}`);
          } else if (manual) {
            console.log("\nInvalid model name.");
          }
        }
        break;
      }
      case "3": {
        config.metrics.enabled = !config.metrics.enabled;
        saveConfig(config);
        console.log(`
Metrics ${config.metrics.enabled ? "enabled" : "disabled"}.`);
        break;
      }
      case "4": {
        const confirm = await ask(rl, "Reset all savings history? [y/N]: ");
        if (confirm.toLowerCase() === "y") {
          resetMetrics();
          console.log("\nMetrics reset.");
        } else {
          console.log("\nCancelled.");
        }
        break;
      }
      case "5": {
        console.log("");
        for (let i = 0; i <= 5; i++) {
          const marker = i === level ? " \u2190 current" : "";
          console.log(`  Level ${i}: ${LEVEL_NAMES[i]}${marker}`);
          console.log(`           ${LEVEL_DESCRIPTIONS[i]}`);
        }
        break;
      }
      case "6":
        running = false;
        break;
      default:
        console.log("Invalid choice.");
    }
  }
  rl.close();
  console.log("Settings saved.\n");
}
async function cmdDashboard() {
  const { execFile, spawn } = await import("child_process");
  const scriptPath = path2.join(__dirname, "dashboard-server.cjs");
  if (!fs3.existsSync(scriptPath)) {
    console.error("Dashboard server not found at", scriptPath);
    process.exit(1);
  }
  const rawPort = process.env["CLAUDE_SAVER_DASHBOARD_PORT"] ?? "37888";
  const port = parseInt(rawPort, 10);
  if (isNaN(port) || port < 1024 || port > 65535) {
    console.error("Invalid CLAUDE_SAVER_DASHBOARD_PORT \u2014 must be 1024-65535");
    process.exit(1);
  }
  const child = spawn("node", [scriptPath], { stdio: "inherit", env: { ...process.env } });
  setTimeout(() => {
    const url = `http://127.0.0.1:${port}`;
    const platform = process.platform;
    if (platform === "win32") execFile("cmd", ["/c", "start", url]);
    else if (platform === "darwin") execFile("open", [url]);
    else execFile("xdg-open", [url]);
    console.log(`Dashboard running at ${url} \u2014 press Ctrl+C to stop.`);
  }, 500);
  child.on("error", (err) => {
    console.error("Failed to start dashboard:", err.message);
    process.exit(1);
  });
}
async function cmdAsk(prompt) {
  if (!prompt) {
    console.error('Usage: claudesaver ask "your prompt here"');
    process.exit(1);
  }
  if (prompt.length > 5e4) {
    console.error("Prompt too long (max 50,000 characters).");
    process.exit(1);
  }
  const config = loadConfig();
  const model = config.ollama.default_model;
  const start = Date.now();
  try {
    const response = await fetch(`${config.ollama.base_url}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false
      })
    });
    if (!response.ok) {
      console.error(`Ollama error: HTTP ${response.status}`);
      process.exit(1);
    }
    const data = await response.json();
    const duration = Date.now() - start;
    const tokens = data.eval_count ?? 0;
    let output = data.response ?? "";
    output = output.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
    console.log(output);
    console.log(`
[Local: ${model} | ${tokens} tokens | ${duration}ms]`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to reach Ollama: ${msg}`);
    console.error("Make sure Ollama is running: ollama serve");
    process.exit(1);
  }
}
async function cmdReset() {
  resetMetrics();
  console.log("Metrics history cleared.");
}
async function main() {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase();
  switch (command) {
    case "status":
      await cmdStatus();
      break;
    case "settings":
      await cmdSettings();
      break;
    case "dashboard":
      await cmdDashboard();
      break;
    case "ask":
      await cmdAsk(args.slice(1).join(" "));
      break;
    case "reset":
      await cmdReset();
      break;
    case void 0:
    case "":
      await cmdSettings();
      break;
    case "help":
    case "--help":
    case "-h":
      console.log("");
      console.log("Claude-Saver CLI \u2014 zero-token local management");
      console.log("");
      console.log("Usage:");
      console.log("  claudesaver                    Interactive settings menu");
      console.log("  claudesaver status             Quick status check");
      console.log("  claudesaver settings           Interactive settings menu");
      console.log("  claudesaver dashboard          Open web dashboard");
      console.log('  claudesaver ask "prompt"       Send prompt to local Ollama model');
      console.log("  claudesaver reset              Clear metrics history");
      console.log("");
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "claudesaver help" for usage.');
      process.exit(1);
  }
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
