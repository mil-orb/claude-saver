#!/usr/bin/env node
/**
 * Claude-Saver status line script.
 * Reads ~/.claude-saver/config.json and displays delegation status.
 *
 * Configure in ~/.claude/settings.json:
 *   "statusLine": { "type": "command", "command": "node /path/to/statusline.cjs" }
 *
 * Or configure via: /claudesaver:settings
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

try {
  const configPath = path.join(os.homedir(), '.claude-saver', 'config.json');
  let level = 2;
  let model = 'unknown';

  // Also check the plugin's default config for fallback model
  const defaultConfigPaths = [
    configPath,
    path.join(__dirname, '..', 'config', 'default-routing-rules.json'),
  ];

  for (const p of defaultConfigPaths) {
    try {
      if (fs.existsSync(p)) {
        const config = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (config.delegation_level !== undefined) level = config.delegation_level;
        if (config.ollama?.default_model) model = config.ollama.default_model;
      }
    } catch { /* skip */ }
  }

  // User config overrides defaults
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (config.delegation_level !== undefined) level = config.delegation_level;
    if (config.ollama?.default_model) model = config.ollama.default_model;
  }

  // Shorten model name for display (e.g., "slekrem/gpt-oss-claude-code-32k:latest" → "gpt-oss-claude-code-32k")
  let shortModel = model;
  if (shortModel.includes('/')) shortModel = shortModel.split('/').pop();
  if (shortModel.includes(':')) shortModel = shortModel.split(':')[0];

  const LEVEL_NAMES = {
    0: 'Off', 1: 'Conservative', 2: 'Balanced',
    3: 'Aggressive', 4: 'Max Local', 5: 'Offline',
  };

  const name = LEVEL_NAMES[level] || 'Unknown';

  if (level === 5) {
    process.stdout.write(`Claude-Saver LOCAL MODE | ${shortModel}`);
  } else if (level === 0) {
    process.stdout.write(`Claude-Saver Off`);
  } else {
    process.stdout.write(`Claude-Saver L${level} (${name}) | ${shortModel}`);
  }
} catch {
  process.stdout.write('Claude-Saver');
}
