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

// src/dashboard/server.ts
var http = __toESM(require("http"), 1);
var fs2 = __toESM(require("fs"), 1);
var path2 = __toESM(require("path"), 1);

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
  },
  light_pass: {
    enabled: true,
    max_input_tokens: 1500,
    max_output_tokens: 600,
    max_wall_time_ms: 5e3,
    temperature: 0.1,
    allow_retry: true,
    retry_max_input_tokens: 3e3,
    retry_max_output_tokens: 1200
  },
  quality_gate: {
    enabled: true,
    check_completeness: true,
    check_code_parse: true,
    check_scope: true,
    check_hedging: true,
    check_proportionality: true,
    min_output_length: 20,
    max_output_length: 1e4
  },
  context_pipeline: {
    max_files: 3,
    max_lines_per_file: 120,
    max_diff_lines: 200
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

// src/dashboard/server.ts
var PORT = parseInt(process.env["CLAUDE_SAVER_DASHBOARD_PORT"] ?? "37888", 10);
var HOST = "127.0.0.1";
function loadMetricsData() {
  try {
    const config = loadConfig();
    const metricsPath = resolvePath(config.metrics.log_path);
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
function loadConfigRaw() {
  try {
    return loadConfig();
  } catch {
    return {};
  }
}
function estimateOverhead(tokensUsed) {
  return 80 + Math.ceil(tokensUsed * 1.3);
}
function detectModelCostRate() {
  const modelId = (process.env["CLAUDE_MODEL"] ?? process.env["ANTHROPIC_MODEL"] ?? "").toLowerCase();
  if (modelId.includes("opus")) return 25;
  if (modelId.includes("sonnet")) return 15;
  if (modelId.includes("haiku")) return 5;
  return null;
}
function computeDashboardData() {
  const entries = loadMetricsData();
  const config = loadConfig();
  const configRate = config.welcome.cost_per_million_tokens;
  const costRate = detectModelCostRate() ?? configRate;
  let totalLocalTokens = 0;
  let totalOverhead = 0;
  let taskCount = 0;
  const sessions = /* @__PURE__ */ new Set();
  const tools = {};
  const models = {};
  const dailyMap = /* @__PURE__ */ new Map();
  const recent = [];
  let delAccepted = 0;
  let delRetried = 0;
  let delEscalated = 0;
  let delTotalAttempts = 0;
  let delTotalTokens = 0;
  for (const entry of entries) {
    if (typeof entry.session_id === "string") sessions.add(entry.session_id);
    const entryType = entry.type;
    const isCompletion = entryType === "completion";
    const isDelegation = entryType === "delegation";
    if ((isCompletion || isDelegation) && typeof entry.tokens_used === "number") {
      const tokens = entry.tokens_used;
      const overhead = typeof entry.cloud_overhead_tokens === "number" ? entry.cloud_overhead_tokens : estimateOverhead(tokens);
      totalLocalTokens += tokens;
      totalOverhead += overhead;
      taskCount++;
      const tool = entry.tool ?? "unknown";
      tools[tool] = (tools[tool] ?? 0) + 1;
      const model = entry.model ?? "unknown";
      models[model] = (models[model] ?? 0) + 1;
      const ts = entry.timestamp;
      const day = ts?.slice(0, 10) ?? "unknown";
      const existing = dailyMap.get(day) ?? { tokens: 0, overhead: 0, tasks: 0 };
      existing.tokens += tokens;
      existing.overhead += overhead;
      existing.tasks++;
      dailyMap.set(day, existing);
      recent.push({
        timestamp: ts,
        tool,
        model,
        tokens,
        overhead,
        duration_ms: entry.duration_ms ?? 0,
        quality_status: isDelegation ? entry.quality_status : void 0,
        attempt_count: isDelegation ? entry.attempt_count : void 0
      });
      if (isDelegation) {
        const qs = entry.quality_status;
        if (qs === "accepted") delAccepted++;
        else if (qs === "retried_accepted") delRetried++;
        else if (qs === "escalated") delEscalated++;
        delTotalAttempts += entry.attempt_count ?? 1;
        delTotalTokens += tokens;
      }
    }
  }
  const grossCost = totalLocalTokens / 1e6 * costRate;
  const overheadCost = totalOverhead / 1e6 * (costRate / 5);
  const netCost = grossCost - overheadCost;
  const timeline = Array.from(dailyMap.entries()).map(([date, data]) => ({ date, ...data })).sort((a, b) => a.date.localeCompare(b.date));
  const recentSlice = recent.slice(-50).reverse();
  const delTotal = delAccepted + delRetried + delEscalated;
  return {
    total_tasks: entries.length,
    local_tasks: taskCount,
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
    delegation: {
      total: delTotal,
      accepted: delAccepted,
      retried_accepted: delRetried,
      escalated: delEscalated,
      resolution_rate: delTotal > 0 ? (delAccepted + delRetried) / delTotal : 0,
      retry_rate: delTotal > 0 ? (delRetried + delEscalated) / delTotal : 0,
      avg_attempts: delTotal > 0 ? delTotalAttempts / delTotal : 0,
      total_delegation_tokens: delTotalTokens
    }
  };
}
function getDashboardHTML() {
  const htmlPath = path2.join(__dirname, "dashboard.html");
  if (fs2.existsSync(htmlPath)) {
    return fs2.readFileSync(htmlPath, "utf-8");
  }
  const altPath = path2.join(path2.dirname(process.argv[1] ?? "."), "dashboard.html");
  if (fs2.existsSync(altPath)) {
    return fs2.readFileSync(altPath, "utf-8");
  }
  return "<html><body><h1>Dashboard HTML not found</h1></body></html>";
}
var server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  res.setHeader("Access-Control-Allow-Origin", `http://127.0.0.1:${PORT}`);
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  if (url.pathname === "/api/data") {
    const data = computeDashboardData();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
    return;
  }
  if (url.pathname === "/api/config") {
    const config = loadConfigRaw();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(config));
    return;
  }
  if (url.pathname === "/" || url.pathname === "/dashboard") {
    const html = getDashboardHTML();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Set CLAUDE_SAVER_DASHBOARD_PORT to use a different port.`);
    process.exit(1);
  }
  throw err;
});
server.listen(PORT, HOST, () => {
  console.log(`Claude-Saver Dashboard: http://${HOST}:${PORT}`);
});
process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});
