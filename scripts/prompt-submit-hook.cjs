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

// src/hooks/prompt-submit.ts
var fs = __toESM(require("fs"), 1);
var path = __toESM(require("path"), 1);
var os = __toESM(require("os"), 1);
var import_child_process = require("child_process");
function loadConfig() {
  const defaults = {
    delegation_level: 2,
    ollama: {
      base_url: "http://localhost:11434",
      default_model: "slekrem/gpt-oss-claude-code-32k:latest",
      health_timeout_ms: 3e3
    }
  };
  try {
    const configPath = path.join(os.homedir(), ".claude-saver", "config.json");
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return {
        delegation_level: raw.delegation_level ?? defaults.delegation_level,
        ollama: { ...defaults.ollama, ...raw.ollama }
      };
    }
  } catch {
  }
  return defaults;
}
function matchCommand(prompt) {
  const trimmed = prompt.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("cs ask ") || lower.startsWith("ask local ") || lower.startsWith("/claudesaver:ask ")) {
    for (const prefix of ["cs ask ", "ask local ", "/claudesaver:ask "]) {
      if (lower.startsWith(prefix)) {
        return { command: "ask", args: trimmed.slice(prefix.length).trim() };
      }
    }
  }
  if (lower === "cs status" || lower === "/claudesaver:status") {
    return { command: "status", args: "" };
  }
  if (lower === "cs reset") {
    return { command: "reset", args: "" };
  }
  return null;
}
function runLocalClaude(prompt, config) {
  try {
    const result = (0, import_child_process.execFileSync)("claude", ["-p", prompt], {
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: config.ollama.base_url,
        ANTHROPIC_MODEL: config.ollama.default_model,
        // Prevent nested session detection
        CLAUDECODE: ""
      },
      timeout: 12e4,
      maxBuffer: 1024 * 1024,
      // 1MB
      encoding: "utf-8"
    });
    return result.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[Local model error: ${msg}]`;
  }
}
function runStatus(config) {
  try {
    const configDir = path.join(os.homedir(), ".claude-saver");
    const metricsPath = path.join(configDir, "metrics.jsonl");
    let ollamaStatus = "unknown";
    try {
      (0, import_child_process.execFileSync)("curl", [
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--max-time",
        "2",
        `${config.ollama.base_url}/api/tags`
      ], { encoding: "utf-8", timeout: 5e3 });
      ollamaStatus = "connected";
    } catch {
      ollamaStatus = "not available";
    }
    let totalLocal = 0;
    let delegations = 0;
    if (fs.existsSync(metricsPath)) {
      const lines = fs.readFileSync(metricsPath, "utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          totalLocal += entry.tokens_local ?? entry.local_tokens ?? 0;
          delegations++;
        } catch {
        }
      }
    }
    return [
      `Ollama: ${ollamaStatus}`,
      `Model: ${config.ollama.default_model}`,
      `Delegation level: ${config.delegation_level}`,
      `Total delegations: ${delegations}`,
      `Total local tokens: ${totalLocal.toLocaleString()}`
    ].join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[Status error: ${msg}]`;
  }
}
function runReset() {
  try {
    const metricsPath = path.join(os.homedir(), ".claude-saver", "metrics.jsonl");
    if (fs.existsSync(metricsPath)) {
      fs.writeFileSync(metricsPath, "", "utf-8");
      return "Metrics history cleared.";
    }
    return "No metrics file found \u2014 nothing to reset.";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[Reset error: ${msg}]`;
  }
}
async function readStdin() {
  return new Promise((resolve) => {
    let input = "";
    const timer = setTimeout(() => {
      process.stdin.removeAllListeners();
      resolve(input);
    }, 500);
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(input);
    });
    process.stdin.resume();
  });
}
async function main() {
  const raw = await readStdin();
  let userPrompt = "";
  if (raw) {
    try {
      const event = JSON.parse(raw);
      userPrompt = event.prompt ?? event.message ?? event.content ?? event.user_message ?? "";
    } catch {
      userPrompt = raw.trim();
    }
  }
  if (!userPrompt) {
    const logDir = path.join(os.homedir(), ".claude-saver");
    try {
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(
        path.join(logDir, "hook-debug.log"),
        `[${(/* @__PURE__ */ new Date()).toISOString()}] UserPromptSubmit stdin: ${JSON.stringify(raw).slice(0, 500)}
`,
        "utf-8"
      );
    } catch {
    }
    process.exit(0);
  }
  const match = matchCommand(userPrompt);
  if (!match) {
    process.exit(0);
  }
  const config = loadConfig();
  let result;
  switch (match.command) {
    case "ask": {
      if (!match.args) {
        result = 'Usage: cs ask "your question here"';
      } else {
        result = runLocalClaude(match.args, config);
      }
      break;
    }
    case "status": {
      result = runStatus(config);
      break;
    }
    case "reset": {
      result = runReset();
      break;
    }
    default:
      process.exit(0);
  }
  const context = [
    `[Claude-Saver Local] The user's command was handled locally via Ollama.`,
    `Command: ${match.command}`,
    `Result:
${result}`,
    `
Just relay this result to the user. Do not re-answer the question or make additional API calls.`
  ].join("\n");
  const output = JSON.stringify({ additionalContext: context });
  process.stdout.write(output);
}
main().then(() => process.exit(0)).catch(() => process.exit(0));
