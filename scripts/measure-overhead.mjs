#!/usr/bin/env node
/**
 * Measures the token overhead that ClaudeSaver injects into every session.
 *
 * The SessionStart hook outputs additionalContext that becomes part of Claude's
 * system prompt. This context is re-sent on EVERY API turn for the rest of the
 * session, so every token here is multiplied by the number of turns.
 *
 * Token estimation: blended heuristic (40% word-based × 1.3, 60% char-based / 3.5)
 */

// ── Token counting (same heuristic as measure-tokens.mjs) ──────

function countTokens(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  const w = Math.ceil(words * 1.3);
  const c = Math.ceil(text.length / 3.5);
  return Math.ceil(w * 0.4 + c * 0.6);
}

// ── Reproduce the delegation instructions from session-start.ts ──

const LEVEL_NAMES = {
  0: 'Off', 1: 'Conservative', 2: 'Balanced',
  3: 'Aggressive', 4: 'Max Local', 5: 'Offline',
};

// ── OLD instructions (before compression) ──

function getOldDelegationInstructions(level) {
  switch (level) {
    case 0: return null;
    case 1: return [
      'DELEGATION ACTIVE — delegate only trivial tasks to save API tokens:',
      '- Filesystem metadata (tree, stat, find, git status) → claudesaver_fs',
      '- Docstrings for individual functions → claudesaver_complete',
      '- Commit message drafts → claudesaver_complete',
      'Handle everything else directly. Escalate immediately if local output seems wrong.',
    ].join('\n');
    case 2: return [
      'DELEGATION ACTIVE — delegate routine coding tasks to local models to save API tokens:',
      '- Filesystem queries (tree, stat, find, git status/log) → claudesaver_fs',
      '- Docstrings, comments, commit messages, format conversions → claudesaver_complete',
      '- Boilerplate, scaffolding, code with clear specs → claudesaver_generate_code',
      '- File summaries and bug scanning → claudesaver_analyze_file',
      'Handle directly: architecture decisions, debugging, security review, complex reasoning, anything the user asks for YOUR opinion on.',
    ].join('\n');
    case 3: return [
      'DELEGATION ACTIVE — aggressively delegate to local models. Most coding tasks should go local:',
      '- Filesystem queries → claudesaver_fs',
      '- All code generation, documentation, tests, refactoring → claudesaver_complete or claudesaver_generate_code',
      '- File analysis and review → claudesaver_analyze_file',
      '- Batch operations → claudesaver_batch',
      'Handle directly only: architecture decisions, complex multi-file debugging, security-critical review.',
    ].join('\n');
    case 4: return [
      'DELEGATION ACTIVE — try ALL tasks locally first:',
      '- Use claudesaver_complete as your primary tool for all coding tasks.',
      '- Use claudesaver_fs for all filesystem queries.',
      '- Use claudesaver_analyze_file for file review.',
      '- Use claudesaver_generate_code for code generation.',
      'Only handle directly if local output is poor quality, or the task requires broad codebase reasoning that cannot be provided via context.',
    ].join('\n');
    case 5: return [
      'DELEGATION ACTIVE — OFFLINE MODE. Route ALL tasks to local models:',
      '- claudesaver_complete for all prompts. claudesaver_fs for filesystem.',
      '- claudesaver_generate_code for code. claudesaver_analyze_file for analysis.',
      '- If the local model fails or produces poor output, report the failure to the user rather than handling it directly.',
    ].join('\n');
    default: return null;
  }
}

// ── NEW compressed instructions ──

function getDelegationInstructions(level) {
  switch (level) {
    case 0: return null;
    case 1: return [
      'DELEGATION L1: Trivial tasks only → local Ollama.',
      'claudesaver_fs → fs metadata | claudesaver_complete → docstrings, commit messages',
      'Escalate immediately if local output seems wrong.',
    ].join('\n');
    case 2: return [
      'DELEGATION L2: Routine coding tasks → local Ollama.',
      'claudesaver_fs → fs queries | claudesaver_complete → docs, comments, commits, format conversions | claudesaver_generate_code → boilerplate, scaffolding, clear-spec code | claudesaver_analyze_file → summaries, bug scanning',
      'Cloud: architecture decisions, debugging, security review, complex reasoning, opinion requests.',
    ].join('\n');
    case 3: return [
      'DELEGATION L3: Most coding tasks → local. Delegate aggressively.',
      'claudesaver_fs → fs | claudesaver_complete or claudesaver_generate_code → all codegen, docs, tests, refactoring | claudesaver_analyze_file → analysis, review | claudesaver_batch → parallel ops',
      'Cloud only: architecture decisions, complex multi-file debugging, security-critical review.',
    ].join('\n');
    case 4: return [
      'DELEGATION L4: Try ALL tasks locally first.',
      'claudesaver_complete → primary tool for all coding | claudesaver_fs → fs queries | claudesaver_analyze_file → file review | claudesaver_generate_code → code generation',
      'Cloud only if local output is poor or task needs broad codebase reasoning.',
    ].join('\n');
    case 5: return [
      'DELEGATION L5 — OFFLINE MODE. ALL tasks → local models.',
      'claudesaver_complete → prompts | claudesaver_fs → fs | claudesaver_generate_code → code | claudesaver_analyze_file → analysis',
      'On failure: report the failure to user. Do not handle directly.',
    ].join('\n');
    default: return null;
  }
}

function assembleWelcomeMessage(level, models, latency, savings) {
  const lines = [];
  const levelName = LEVEL_NAMES[level] ?? 'Unknown';
  lines.push(`[ClaudeSaver] Ollama connected (${latency}ms) — Level ${level} (${levelName})`);

  if (savings.local_tasks > 0) {
    lines.push(`Savings: ${savings.total_local_tokens} tokens locally across ${savings.local_tasks} tasks — ~$${savings.estimated_cost_saved} saved`);
  } else {
    lines.push(`Savings: No local completions yet — start delegating to save tokens!`);
  }

  const modelList = models.slice(0, 5).join(', ');
  lines.push(`Models: ${modelList} | Default: qwen3:8b`);

  const instructions = getDelegationInstructions(level);
  if (instructions) lines.push(instructions);

  return lines.join('\n');
}

// ── Measure ────────────────────────────────────────────────────

console.log('');
console.log('='.repeat(100));
console.log('  CLAUDESAVER TOKEN OVERHEAD ANALYSIS');
console.log('  Every token here is paid on EVERY API turn for the entire session.');
console.log('='.repeat(100));
console.log('');

// Typical scenario
const typicalModels = ['qwen3:8b', 'devstral:24b', 'qwen3:1.7b'];
const typicalLatency = 42;
const freshSavings = { total_local_tokens: 0, local_tasks: 0, estimated_cost_saved: 0 };
const existingSavings = { total_local_tokens: 150000, local_tasks: 45, estimated_cost_saved: 1.20 };

console.log('SECTION 1: Delegation Instructions (per level)');
console.log('-'.repeat(80));
console.log('');

const instrResults = [];

for (let level = 0; level <= 5; level++) {
  const instr = getDelegationInstructions(level);
  const text = instr ?? '(none)';
  const chars = instr ? instr.length : 0;
  const tokens = instr ? countTokens(instr) : 0;
  const lines = instr ? instr.split('\n').length : 0;

  instrResults.push({ level, name: LEVEL_NAMES[level], chars, tokens, lines, text: instr });

  console.log(`  Level ${level} (${LEVEL_NAMES[level]})`);
  console.log(`    Lines: ${lines}  |  Chars: ${chars}  |  Tokens: ~${tokens}`);
  if (instr) {
    for (const line of instr.split('\n')) {
      console.log(`    > ${line}`);
    }
  } else {
    console.log(`    > (no delegation instructions)`);
  }
  console.log('');
}

console.log('');
console.log('SECTION 2: Full Welcome Message (header + savings + models + instructions)');
console.log('-'.repeat(80));
console.log('');

for (let level = 0; level <= 5; level++) {
  const msg = assembleWelcomeMessage(level, typicalModels, typicalLatency, freshSavings);
  const tokens = countTokens(msg);
  const chars = msg.length;

  console.log(`  Level ${level} (${LEVEL_NAMES[level]})`);
  console.log(`    Chars: ${chars}  |  Tokens: ~${tokens}`);
  console.log('');
}

console.log('');
console.log('SECTION 3: Component Breakdown (Level 2 — default)');
console.log('-'.repeat(80));
console.log('');

const headerLine = `[ClaudeSaver] Ollama connected (42ms) — Level 2 (Balanced)`;
const savingsLine = `Savings: No local completions yet — start delegating to save tokens!`;
const modelsLine = `Models: qwen3:8b, devstral:24b, qwen3:1.7b | Default: qwen3:8b`;
const instrLevel2 = getDelegationInstructions(2);
const fullMsg = assembleWelcomeMessage(2, typicalModels, typicalLatency, freshSavings);

const components = [
  { name: 'Header line', text: headerLine },
  { name: 'Savings line', text: savingsLine },
  { name: 'Models line', text: modelsLine },
  { name: 'Delegation instructions', text: instrLevel2 },
  { name: 'FULL MESSAGE', text: fullMsg },
];

let totalTokens = 0;
for (const comp of components) {
  const tokens = countTokens(comp.text);
  if (comp.name !== 'FULL MESSAGE') totalTokens += tokens;
  console.log(`  ${comp.name.padEnd(25)} ${String(comp.text.length).padStart(5)} chars  ~${String(tokens).padStart(4)} tokens`);
}
console.log(`  ${'(sum of parts)'.padEnd(25)} ${'-'.padStart(5)}        ~${String(totalTokens).padStart(4)} tokens`);

console.log('');
console.log('');
console.log('SECTION 4: Session Cost Impact (Level 2)');
console.log('-'.repeat(80));
console.log('');

const level2Tokens = countTokens(fullMsg);

// Opus pricing
const INPUT_COST = 15; // $/M input tokens

const turnsPerSession = [10, 25, 50, 100, 200];

console.log('  Turns/Session  |  Extra Input Tokens  |  Extra Cost (Opus $15/M)  |  Monthly (22 days)');
console.log('  ' + '-'.repeat(90));

for (const turns of turnsPerSession) {
  const extraTokens = level2Tokens * turns;
  const extraCost = (extraTokens / 1_000_000) * INPUT_COST;
  const monthly = extraCost * 22; // 22 work days
  console.log(`  ${String(turns).padStart(14)}  |  ${String(extraTokens).padStart(19)}  |  $${extraCost.toFixed(4).padStart(23)}  |  $${monthly.toFixed(2).padStart(14)}`);
}

console.log('');
console.log('');
console.log('SECTION 5: All Levels — Monthly Overhead Cost');
console.log('-'.repeat(80));
console.log('  (Assumes 50 turns/session, 1 session/day, 22 days/month, Opus at $15/M input)');
console.log('');

for (let level = 0; level <= 5; level++) {
  const msg = assembleWelcomeMessage(level, typicalModels, typicalLatency, freshSavings);
  const tokens = countTokens(msg);
  const monthlyTokens = tokens * 50 * 22;
  const monthlyCost = (monthlyTokens / 1_000_000) * INPUT_COST;

  console.log(`  Level ${level} (${LEVEL_NAMES[level].padEnd(12)})  ~${String(tokens).padStart(4)} tokens/turn × 50 turns × 22 days = ${String(monthlyTokens).padStart(8)} tokens → $${monthlyCost.toFixed(2)}/month`);
}

console.log('');
console.log('');
console.log('SECTION 6: Delegation Instructions as % of Total ClaudeSaver Overhead');
console.log('-'.repeat(80));
console.log('');

for (let level = 0; level <= 5; level++) {
  const msg = assembleWelcomeMessage(level, typicalModels, typicalLatency, freshSavings);
  const totalTok = countTokens(msg);
  const instrTok = instrResults[level].tokens;
  const pct = totalTok > 0 ? ((instrTok / totalTok) * 100).toFixed(0) : 0;
  console.log(`  Level ${level}: ${String(instrTok).padStart(3)} instruction tokens / ${String(totalTok).padStart(3)} total = ${String(pct).padStart(2)}% instructions`);
}

console.log('');
console.log('');
console.log('='.repeat(100));
console.log('  BEFORE vs AFTER COMPRESSION');
console.log('='.repeat(100));
console.log('');

console.log('  Level  |  Before (tokens)  |  After (tokens)  |  Saved  |  Reduction');
console.log('  ' + '-'.repeat(75));

let totalBefore = 0;
let totalAfter = 0;

for (let level = 0; level <= 5; level++) {
  const oldInstr = getOldDelegationInstructions(level);
  const newInstr = getDelegationInstructions(level);
  const oldTok = oldInstr ? countTokens(oldInstr) : 0;
  const newTok = newInstr ? countTokens(newInstr) : 0;
  const saved = oldTok - newTok;
  const pct = oldTok > 0 ? ((saved / oldTok) * 100).toFixed(0) : '0';

  totalBefore += oldTok;
  totalAfter += newTok;

  console.log(`  L${level} ${LEVEL_NAMES[level].padEnd(12)}  |  ${String(oldTok).padStart(15)}  |  ${String(newTok).padStart(14)}  |  ${String(saved).padStart(5)}  |  ${String(pct).padStart(4)}%`);
}

const totalSaved = totalBefore - totalAfter;
const totalPct = totalBefore > 0 ? ((totalSaved / totalBefore) * 100).toFixed(0) : '0';
console.log('  ' + '-'.repeat(75));
console.log(`  ${'TOTAL'.padEnd(15)}  |  ${String(totalBefore).padStart(15)}  |  ${String(totalAfter).padStart(14)}  |  ${String(totalSaved).padStart(5)}  |  ${String(totalPct).padStart(4)}%`);

console.log('');
console.log('');
console.log('  SESSION COST IMPACT (Level 2 — default, 50 turns/session, Opus $15/M input):');
console.log('');

const oldL2 = getOldDelegationInstructions(2);
const newL2 = getDelegationInstructions(2);
const oldL2Tok = countTokens(oldL2);
const newL2Tok = countTokens(newL2);
const savedL2Tok = oldL2Tok - newL2Tok;

const savedPerSession = savedL2Tok * 50;
const savedCostPerSession = (savedPerSession / 1_000_000) * INPUT_COST;
const savedMonthly = savedCostPerSession * 22;

console.log(`    Before: ~${oldL2Tok} instruction tokens/turn`);
console.log(`    After:  ~${newL2Tok} instruction tokens/turn`);
console.log(`    Saved:  ~${savedL2Tok} tokens/turn × 50 turns = ${savedPerSession} tokens/session`);
console.log(`    Cost:   $${savedCostPerSession.toFixed(4)}/session → $${savedMonthly.toFixed(2)}/month saved`);
console.log('');
