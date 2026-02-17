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

// src/hooks/subagent-stop.ts
var fs = __toESM(require("fs"), 1);
var path = __toESM(require("path"), 1);
var os = __toESM(require("os"), 1);
function getMetricsPath() {
  return path.join(os.homedir(), ".claudesaver", "metrics.jsonl");
}
function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  if (!input.trim()) {
    process.exit(0);
  }
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    process.exit(0);
  }
  if (!event) {
    process.exit(0);
  }
  if (event.agent_name !== "local-worker") {
    process.exit(0);
  }
  const entry = {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    agent: event.agent_name,
    duration_ms: event.duration_ms ?? 0,
    tools_used: event.tools_used ?? [],
    session_id: process.env["CLAUDE_SESSION_ID"] ?? "unknown"
  };
  try {
    const metricsPath = getMetricsPath();
    ensureDir(metricsPath);
    fs.appendFileSync(metricsPath, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
  }
}
main().then(() => process.exit(0)).catch(() => process.exit(0));
