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
var fs = __toESM(require("fs"), 1);
var path = __toESM(require("path"), 1);
var os = __toESM(require("os"), 1);
var PORT = parseInt(process.env["CLAUDE_SAVER_DASHBOARD_PORT"] ?? "37888", 10);
var HOST = "127.0.0.1";
function getDataDir() {
  return path.join(os.homedir(), ".claude-saver");
}
function loadMetricsData() {
  try {
    const metricsPath = path.join(getDataDir(), "metrics.jsonl");
    if (!fs.existsSync(metricsPath)) return [];
    const content = fs.readFileSync(metricsPath, "utf-8");
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
function loadConfig() {
  try {
    const configPath = path.join(getDataDir(), "config.json");
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}
function estimateOverhead(tokensUsed) {
  return 80 + Math.ceil(tokensUsed * 1.3);
}
function computeDashboardData() {
  const entries = loadMetricsData();
  const config = loadConfig();
  const costRate = config?.welcome?.cost_per_million_tokens ?? 8;
  let totalLocalTokens = 0;
  let totalOverhead = 0;
  let completionCount = 0;
  const sessions = /* @__PURE__ */ new Set();
  const tools = {};
  const models = {};
  const dailyMap = /* @__PURE__ */ new Map();
  const recent = [];
  for (const entry of entries) {
    if (typeof entry.session_id === "string") sessions.add(entry.session_id);
    if (entry.type === "completion" && typeof entry.tokens_used === "number") {
      const tokens = entry.tokens_used;
      const overhead = typeof entry.cloud_overhead_tokens === "number" ? entry.cloud_overhead_tokens : estimateOverhead(tokens);
      totalLocalTokens += tokens;
      totalOverhead += overhead;
      completionCount++;
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
        duration_ms: entry.duration_ms ?? 0
      });
    }
  }
  const grossCost = totalLocalTokens / 1e6 * costRate;
  const overheadCost = totalOverhead / 1e6 * (costRate / 5);
  const netCost = grossCost - overheadCost;
  const timeline = Array.from(dailyMap.entries()).map(([date, data]) => ({ date, ...data })).sort((a, b) => a.date.localeCompare(b.date));
  const recentSlice = recent.slice(-50).reverse();
  return {
    total_tasks: entries.length,
    local_tasks: completionCount,
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
    models
  };
}
function getDashboardHTML() {
  const htmlPath = path.join(__dirname, "dashboard.html");
  if (fs.existsSync(htmlPath)) {
    return fs.readFileSync(htmlPath, "utf-8");
  }
  const altPath = path.join(path.dirname(process.argv[1] ?? "."), "dashboard.html");
  if (fs.existsSync(altPath)) {
    return fs.readFileSync(altPath, "utf-8");
  }
  return "<html><body><h1>Dashboard HTML not found</h1></body></html>";
}
var server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  if (url.pathname === "/api/data") {
    const data = computeDashboardData();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
    return;
  }
  if (url.pathname === "/api/config") {
    const config = loadConfig();
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
