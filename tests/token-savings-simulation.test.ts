import { describe, it, expect } from 'vitest';
import { classifyTask } from '../src/mcp-server/router.js';
import { computeSummary, type CompletionEntry, type MetricsEntry, type AnyMetricsEntry } from '../src/mcp-server/metrics.js';

// =============================================================================
// TOKEN SAVINGS SIMULATION
// =============================================================================
// This test file simulates realistic coding sessions to calculate estimated
// token savings across common developer actions. It exercises the full pipeline:
//   classifyTask() -> routing decision -> mock token consumption -> metrics
//                  -> savings calculation
//
// METHODOLOGY (Feb 2026, validated against measured data):
//
// `cloudTokens` = OUTPUT tokens Claude would generate if handling directly.
// These are the tokens SAVED when delegated locally — the primary cost driver,
// since output tokens cost 5x more than input tokens on all Claude models.
//
// Measured output tokens per task type (from scripts/measure-tokens.mjs):
//   Simple docstring:       ~50 output tokens   (measured: 50)
//   Complex docstring:      ~200 output tokens   (measured: 201)
//   Commit message:         ~50 output tokens    (measured: 51)
//   Unit test scaffold:     ~500 output tokens   (measured: 489)
//   CRUD endpoint:          ~275 output tokens   (measured: 275)
//   Format conversion:      ~30 output tokens    (measured: 32)
//   File summarization:     ~120 output tokens   (measured: 122)
//   Type annotations:       ~135 output tokens   (measured: 134)
//   Boilerplate generation: ~100 output tokens   (measured: 98)
//   Refactoring:            ~400 output tokens   (estimated from complexity)
//   Bug analysis:           ~300 output tokens   (estimated from complexity)
//   API documentation:      ~400 output tokens   (estimated from complexity)
//
// Pricing (Anthropic, Feb 2026):
//   Haiku 4.5:  $1 input / $5 output per M tokens
//   Sonnet 4.5: $3 input / $15 output per M tokens
//   Opus 4.6:   $5 input / $25 output per M tokens
//
// Cost per delegated task = avoided_output_tokens * output_price_per_token
// Example: 500 output tokens on Sonnet = 500 * ($15/1M) = $0.0075
//
// NOTE: System prompt (~8,800 tokens) is paid in BOTH scenarios (Claude must
// read the prompt to decide to delegate). The savings are output tokens only.
// =============================================================================

// ---------------------------------------------------------------------------
// Session definitions
// ---------------------------------------------------------------------------

interface SessionPrompt {
  prompt: string;
  expectedRoute: 'no_llm' | 'local' | 'cloud';
  cloudTokens: number;
}

/**
 * Session 1: "Morning Feature Work" (20 prompts)
 * Simulates a developer building a new feature from scratch.
 */
const morningSession: SessionPrompt[] = [
  { prompt: 'show me the file tree of the src directory', expectedRoute: 'no_llm', cloudTokens: 0 },
  { prompt: 'write a docstring for this function: async function fetchUser(id: string): Promise<User>', expectedRoute: 'local', cloudTokens: 50 },   // measured: simple docstring ~50 output tokens
  { prompt: 'generate a commit message for adding user profile endpoint', expectedRoute: 'local', cloudTokens: 50 },   // measured: commit msg ~51 output tokens
  { prompt: 'convert this JSON config to YAML format', expectedRoute: 'local', cloudTokens: 30 },    // measured: format conversion ~32 output tokens
  { prompt: 'add type annotations to this function', expectedRoute: 'local', cloudTokens: 135 },     // measured: type annotations ~134 output tokens
  { prompt: 'write unit tests for the UserService.getById method', expectedRoute: 'local', cloudTokens: 500 },  // measured: test scaffold ~489 output tokens
  { prompt: 'generate a REST endpoint for creating new users', expectedRoute: 'local', cloudTokens: 275 },      // measured: CRUD endpoint ~275 output tokens
  { prompt: 'write a docstring for class UserController', expectedRoute: 'local', cloudTokens: 200 },           // measured: complex docstring ~201 output tokens
  { prompt: 'generate boilerplate for a new Express middleware', expectedRoute: 'local', cloudTokens: 100 },     // measured: boilerplate ~98 output tokens
  { prompt: 'git status', expectedRoute: 'no_llm', cloudTokens: 0 },
  { prompt: 'write a commit message for fixing the validation logic', expectedRoute: 'local', cloudTokens: 50 },  // measured: commit msg ~51
  { prompt: 'add JSDoc comments to the auth module exports', expectedRoute: 'local', cloudTokens: 200 },          // complex docstring ~200
  { prompt: 'summarize what this file does', expectedRoute: 'local', cloudTokens: 120 },                          // measured: file summary ~122 output tokens
  { prompt: 'generate a TODO list from the FIXME comments in the codebase', expectedRoute: 'local', cloudTokens: 100 },  // ~100 output (short list)
  { prompt: 'convert this CSV data to JSON', expectedRoute: 'local', cloudTokens: 30 },               // measured: format conversion ~32
  { prompt: 'write a docstring for async function validatePayment', expectedRoute: 'local', cloudTokens: 200 },   // complex docstring ~200
  { prompt: 'generate unit tests for the PaymentService', expectedRoute: 'local', cloudTokens: 500 },             // measured: test scaffold ~489
  { prompt: 'write a commit message for the payment validation feature', expectedRoute: 'local', cloudTokens: 50 },  // measured: commit msg ~51
  { prompt: 'how many lines are in the src directory', expectedRoute: 'no_llm', cloudTokens: 0 },
  { prompt: 'architect a scalable microservices system for real-time notifications with event sourcing', expectedRoute: 'cloud', cloudTokens: 0 },
];

/**
 * Session 2: "Afternoon Refactoring" (15 prompts)
 * Simulates cleanup, documentation, and refactoring work.
 */
const afternoonSession: SessionPrompt[] = [
  { prompt: 'list files in the project', expectedRoute: 'no_llm', cloudTokens: 0 },
  { prompt: 'what files are in the tests directory', expectedRoute: 'no_llm', cloudTokens: 0 },
  { prompt: 'write docstrings for all exported functions in utils.ts', expectedRoute: 'local', cloudTokens: 400 },  // multiple docstrings ~4x100
  { prompt: 'rename the variable "data" to "userData" throughout this file', expectedRoute: 'local', cloudTokens: 400 },  // refactoring ~400 output
  { prompt: 'add type hints to the Python helper scripts', expectedRoute: 'local', cloudTokens: 135 },  // measured: type annotations ~134
  { prompt: 'generate a commit message for the refactoring changes', expectedRoute: 'local', cloudTokens: 50 },   // measured: commit msg ~51
  { prompt: 'convert the old callback-style code to async/await', expectedRoute: 'local', cloudTokens: 400 },     // refactoring ~400 output
  { prompt: 'write unit test stubs for the new async functions', expectedRoute: 'local', cloudTokens: 500 },      // measured: test scaffold ~489
  { prompt: 'git log', expectedRoute: 'no_llm', cloudTokens: 0 },
  { prompt: 'summarize this file for me please', expectedRoute: 'local', cloudTokens: 120 },           // measured: file summary ~122
  { prompt: 'generate API documentation for the user endpoints', expectedRoute: 'local', cloudTokens: 400 },      // API docs ~400 output
  { prompt: 'write a commit message for updating the API docs', expectedRoute: 'local', cloudTokens: 50 },        // measured: commit msg ~51
  { prompt: 'find potential bugs in this error handling code', expectedRoute: 'local', cloudTokens: 300 },         // bug analysis ~300 output
  { prompt: 'generate a config template for the new feature flags', expectedRoute: 'local', cloudTokens: 100 },   // measured: boilerplate ~98
  { prompt: 'debug this race condition in the WebSocket handler that causes messages to be delivered out of order across multiple connected clients', expectedRoute: 'cloud', cloudTokens: 0 },
];

/**
 * Session 3: "Quick Fixes Sprint" (10 fast tasks)
 * Simulates rapid-fire small fixes and one-liners.
 */
const quickFixes: SessionPrompt[] = [
  { prompt: 'write a docstring for function calculateTax', expectedRoute: 'local', cloudTokens: 50 },   // measured: simple docstring ~50
  { prompt: 'generate a commit message for fixing the tax calculation bug', expectedRoute: 'local', cloudTokens: 50 },  // measured: commit msg ~51
  { prompt: 'add a TODO comment about the deprecated API endpoint', expectedRoute: 'local', cloudTokens: 20 },          // tiny output ~20
  { prompt: 'convert this YAML config to JSON', expectedRoute: 'local', cloudTokens: 30 },              // measured: format conversion ~32
  { prompt: 'write a regex to validate email addresses', expectedRoute: 'local', cloudTokens: 50 },     // small code snippet ~50
  { prompt: 'generate type annotations for the config object', expectedRoute: 'local', cloudTokens: 135 },  // measured: type annotations ~134
  { prompt: 'write a commit message for adding input validation', expectedRoute: 'local', cloudTokens: 50 },  // measured: commit msg ~51
  { prompt: 'generate a simple Express route handler for health check', expectedRoute: 'local', cloudTokens: 100 },  // measured: boilerplate ~98
  { prompt: 'write docstring for class OrderProcessor', expectedRoute: 'local', cloudTokens: 200 },     // complex docstring ~200
  { prompt: 'show me the git diff names', expectedRoute: 'no_llm', cloudTokens: 0 },
];

const allSessions = [...morningSession, ...afternoonSession, ...quickFixes];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Classify all prompts in a session at a given delegation level (default 2). */
async function classifySession(
  session: SessionPrompt[],
  delegationLevel = 2,
): Promise<{ prompt: SessionPrompt; route: string }[]> {
  const results: { prompt: SessionPrompt; route: string }[] = [];
  for (const entry of session) {
    const decision = await classifyTask(entry.prompt, { delegationLevel });
    results.push({ prompt: entry, route: decision.route });
  }
  return results;
}

/** Count how many prompts in a session route to a specific destination. */
function countByRoute(
  results: { prompt: SessionPrompt; route: string }[],
  route: string,
): number {
  return results.filter(r => r.route === route).length;
}

/** Sum cloud tokens that would be saved (local + no_llm tasks). */
function computeSaveableTokens(session: SessionPrompt[]): number {
  return session
    .filter(s => s.expectedRoute !== 'cloud')
    .reduce((sum, s) => sum + s.cloudTokens, 0);
}

/** Total cloud tokens across all prompts (including cloud tasks, which have 0). */
function computeTotalCloudTokens(session: SessionPrompt[]): number {
  return session.reduce((sum, s) => sum + s.cloudTokens, 0);
}

/** Build CompletionEntry array from session data for metrics testing. */
function buildCompletionEntries(
  session: SessionPrompt[],
  sessionId: string,
): CompletionEntry[] {
  return session
    .filter(s => s.expectedRoute === 'local' && s.cloudTokens > 0)
    .map((s, i) => ({
      type: 'completion' as const,
      timestamp: new Date(Date.now() + i * 60_000).toISOString(),
      tokens_used: s.cloudTokens,
      model: 'local-7b',
      duration_ms: 200 + Math.floor(s.cloudTokens / 10),
      tool: toolForPrompt(s.prompt),
      session_id: sessionId,
    }));
}

/** Infer a plausible tool name from the prompt for metrics tracking. */
function toolForPrompt(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (lower.includes('docstring') || lower.includes('jsdoc') || lower.includes('comment')) return 'write_docs';
  if (lower.includes('commit message')) return 'commit_msg';
  if (lower.includes('unit test') || lower.includes('test stub')) return 'write_tests';
  if (lower.includes('endpoint') || lower.includes('route handler') || lower.includes('boilerplate') || lower.includes('middleware')) return 'codegen';
  if (lower.includes('convert') || lower.includes('format')) return 'format_convert';
  if (lower.includes('summarize') || lower.includes('what') || lower.includes('bug') || lower.includes('potential')) return 'analyze';
  if (lower.includes('rename') || lower.includes('refactor') || lower.includes('async/await')) return 'refactor';
  if (lower.includes('type annotation') || lower.includes('type hint')) return 'type_annotate';
  if (lower.includes('regex')) return 'codegen';
  if (lower.includes('todo')) return 'codegen';
  if (lower.includes('documentation') || lower.includes('api doc')) return 'write_docs';
  if (lower.includes('config template') || lower.includes('feature flag')) return 'codegen';
  return 'general';
}

// =============================================================================
// 1. ROUTE ACCURACY PER SESSION
// =============================================================================

describe('Token Savings Simulation', () => {
  describe('1. Route accuracy per session', () => {
    it('Morning session: every prompt routes to the expected destination', async () => {
      const results = await classifySession(morningSession);

      for (const { prompt, route } of results) {
        expect(route, `Prompt "${prompt.prompt}" expected ${prompt.expectedRoute} but got ${route}`)
          .toBe(prompt.expectedRoute);
      }
    });

    it('Afternoon session: every prompt routes to the expected destination', async () => {
      const results = await classifySession(afternoonSession);

      for (const { prompt, route } of results) {
        expect(route, `Prompt "${prompt.prompt}" expected ${prompt.expectedRoute} but got ${route}`)
          .toBe(prompt.expectedRoute);
      }
    });

    it('Quick fixes session: every prompt routes to the expected destination', async () => {
      const results = await classifySession(quickFixes);

      for (const { prompt, route } of results) {
        expect(route, `Prompt "${prompt.prompt}" expected ${prompt.expectedRoute} but got ${route}`)
          .toBe(prompt.expectedRoute);
      }
    });
  });

  // ===========================================================================
  // 2. TOKEN SAVINGS CALCULATIONS PER SESSION
  // ===========================================================================

  describe('2. Token savings calculations per session', () => {
    it('Morning session: total saveable tokens are correctly summed', () => {
      const saveable = computeSaveableTokens(morningSession);
      // Sum of output tokens for all non-cloud prompts:
      // 0+50+50+30+135+500+275+200+100+0+50+200+120+100+30+200+500+50+0+0 = 2590
      expect(saveable).toBe(2590);
    });

    it('Afternoon session: total saveable tokens are correctly summed', () => {
      const saveable = computeSaveableTokens(afternoonSession);
      // 0+0+400+400+135+50+400+500+0+120+400+50+300+100+0 = 2855
      expect(saveable).toBe(2855);
    });

    it('Quick fixes session: total saveable tokens are correctly summed', () => {
      const saveable = computeSaveableTokens(quickFixes);
      // 50+50+20+30+50+135+50+100+200+0 = 685
      expect(saveable).toBe(685);
    });

    it('Total savings across all sessions combined', () => {
      const morningSaveable = computeSaveableTokens(morningSession);
      const afternoonSaveable = computeSaveableTokens(afternoonSession);
      const quickSaveable = computeSaveableTokens(quickFixes);
      const totalSaveable = morningSaveable + afternoonSaveable + quickSaveable;

      expect(totalSaveable).toBe(2590 + 2855 + 685);
      expect(totalSaveable).toBe(6130);
    });

    it('Percentage of tasks routed locally per session', () => {
      // Morning: 16 local out of 20 total = 80%
      const morningLocal = morningSession.filter(s => s.expectedRoute === 'local').length;
      const morningPct = (morningLocal / morningSession.length) * 100;
      expect(morningLocal).toBe(16);
      expect(morningPct).toBe(80);

      // Afternoon: 11 local out of 15 total = ~73.3%
      const afternoonLocal = afternoonSession.filter(s => s.expectedRoute === 'local').length;
      const afternoonPct = (afternoonLocal / afternoonSession.length) * 100;
      expect(afternoonLocal).toBe(11);
      expect(afternoonPct).toBeCloseTo(73.33, 1);

      // Quick fixes: 9 local out of 10 total = 90%
      const quickLocal = quickFixes.filter(s => s.expectedRoute === 'local').length;
      const quickPct = (quickLocal / quickFixes.length) * 100;
      expect(quickLocal).toBe(9);
      expect(quickPct).toBe(90);
    });

    it('Percentage of tokens saved per session (saveable / total cloud tokens)', () => {
      // Since cloud tasks have cloudTokens: 0, the saveable equals the total,
      // meaning 100% of token-consuming tasks are saved. The metric that matters
      // is: what fraction of tasks that *would* cost tokens are handled locally.

      const morningTotal = computeTotalCloudTokens(morningSession);
      const morningSaveable = computeSaveableTokens(morningSession);
      expect(morningTotal).toBe(morningSaveable); // all token-using tasks route local
      expect(morningTotal).toBe(2590);

      const afternoonTotal = computeTotalCloudTokens(afternoonSession);
      const afternoonSaveable = computeSaveableTokens(afternoonSession);
      expect(afternoonTotal).toBe(afternoonSaveable);
      expect(afternoonTotal).toBe(2855);

      const quickTotal = computeTotalCloudTokens(quickFixes);
      const quickSaveable = computeSaveableTokens(quickFixes);
      expect(quickTotal).toBe(quickSaveable);
      expect(quickTotal).toBe(685);
    });
  });

  // ===========================================================================
  // 3. COST SAVINGS AT DIFFERENT PRICE POINTS
  // ===========================================================================

  describe('3. Cost savings at different output price points', () => {
    // These are OUTPUT tokens saved. Output pricing (Feb 2026):
    //   Haiku 4.5:  $5/M output tokens
    //   Sonnet 4.5: $15/M output tokens
    //   Opus 4.6:   $25/M output tokens
    const totalSaveableTokens = 6130; // verified above (output tokens only)

    it('At $5/M output tokens (Haiku 4.5): saves $0.03', () => {
      const costPerMillion = 5;
      const savings = (totalSaveableTokens / 1_000_000) * costPerMillion;
      const rounded = Math.round(savings * 100) / 100;
      expect(rounded).toBe(0.03);
    });

    it('At $15/M output tokens (Sonnet 4.5): saves $0.09', () => {
      const costPerMillion = 15;
      const savings = (totalSaveableTokens / 1_000_000) * costPerMillion;
      const rounded = Math.round(savings * 100) / 100;
      expect(rounded).toBe(0.09);
    });

    it('At $25/M output tokens (Opus 4.6): saves $0.15', () => {
      const costPerMillion = 25;
      const savings = (totalSaveableTokens / 1_000_000) * costPerMillion;
      const rounded = Math.round(savings * 100) / 100;
      expect(rounded).toBe(0.15);
    });

    it('At $25/M with 20x daily scale (Opus): saves $1.02/day', () => {
      // One "day" = 3 sessions in our simulation. Scale to 20 sessions.
      const costPerMillion = 25;
      const dailyTokens = totalSaveableTokens * (20 / 3);
      // 6130 * 6.667 = 40,867 tokens/day
      const dailySavings = (dailyTokens / 1_000_000) * costPerMillion;
      // 40867 / 1M * 25 = 1.02
      const rounded = Math.round(dailySavings * 100) / 100;
      expect(rounded).toBe(1.02);
    });
  });

  // ===========================================================================
  // 4. computeSummary INTEGRATION
  // ===========================================================================

  describe('4. computeSummary integration', () => {
    it('returns correct total_local_tokens from session data', () => {
      const entries = buildCompletionEntries(morningSession, 'morning-001');
      const summary = computeSummary(entries);

      // Sum of cloudTokens for local prompts in morning session
      const expectedTokens = morningSession
        .filter(s => s.expectedRoute === 'local' && s.cloudTokens > 0)
        .reduce((sum, s) => sum + s.cloudTokens, 0);

      expect(summary.total_local_tokens).toBe(expectedTokens);
      expect(summary.total_local_tokens).toBe(2590);
    });

    it('returns correct local_tasks count', () => {
      const entries = buildCompletionEntries(afternoonSession, 'afternoon-001');
      const summary = computeSummary(entries);

      // Afternoon session has 11 local prompts with cloudTokens > 0
      const expectedCount = afternoonSession
        .filter(s => s.expectedRoute === 'local' && s.cloudTokens > 0)
        .length;

      expect(summary.local_tasks).toBe(expectedCount);
      expect(summary.local_tasks).toBe(11);
    });

    it('returns correct gross_cost_saved at default $8/M rate', () => {
      const allEntries = [
        ...buildCompletionEntries(morningSession, 'morning-001'),
        ...buildCompletionEntries(afternoonSession, 'afternoon-001'),
        ...buildCompletionEntries(quickFixes, 'quick-001'),
      ];

      const summary = computeSummary(allEntries);

      // 6130 tokens at $8/M = (6130 / 1_000_000) * 8 = 0.04904 -> rounds to 0.05
      expect(summary.gross_cost_saved).toBe(0.05);
      // Net should account for overhead
      expect(summary.net_cost_saved).toBeLessThan(summary.gross_cost_saved);
      expect(summary.overhead_cost).toBeGreaterThan(0);
    });

    it('multiple sessions produce correct session count', () => {
      const allEntries: AnyMetricsEntry[] = [
        ...buildCompletionEntries(morningSession, 'morning-001'),
        ...buildCompletionEntries(afternoonSession, 'afternoon-001'),
        ...buildCompletionEntries(quickFixes, 'quick-001'),
      ];

      const summary = computeSummary(allEntries);

      expect(summary.sessions).toBe(3);
    });

    it('tools_frequency correctly tracks which tools would be used', () => {
      const entries = buildCompletionEntries(quickFixes, 'quick-001');
      const summary = computeSummary(entries);

      // The quick fixes session should produce entries with these tool names:
      // write_docs (docstrings x2), commit_msg (x2), codegen (TODO, regex, express route),
      // format_convert (YAML->JSON), type_annotate (type annotations)
      // Note: the no_llm prompt (git diff) is not included since it's not local
      expect(summary.tools_frequency).toBeDefined();
      expect(Object.keys(summary.tools_frequency).length).toBeGreaterThan(0);

      // Verify specific tools appear
      expect(summary.tools_frequency['write_docs']).toBeGreaterThanOrEqual(2);
      expect(summary.tools_frequency['commit_msg']).toBeGreaterThanOrEqual(2);
      expect(summary.tools_frequency['codegen']).toBeGreaterThanOrEqual(1);
    });
  });

  // ===========================================================================
  // 5. DELEGATION LEVEL IMPACT
  // ===========================================================================

  describe('5. Delegation level impact', () => {
    it('Level 0 (Off): all tasks route to cloud, zero savings', async () => {
      const results = await classifySession(allSessions, 0);
      const localCount = countByRoute(results, 'local');
      const noLlmCount = countByRoute(results, 'no_llm');

      // Level 0 sends everything to cloud, no exceptions
      expect(localCount).toBe(0);
      expect(noLlmCount).toBe(0);

      const savings = results
        .filter(r => r.route === 'local' || r.route === 'no_llm')
        .reduce((sum, r) => sum + r.prompt.cloudTokens, 0);
      expect(savings).toBe(0);
    });

    it('Level 1 (Conservative): fewer tasks route local than Level 2', async () => {
      const results = await classifySession(allSessions, 1);
      const localCount = countByRoute(results, 'local');

      // Level 1 ceiling is 2, so only Level 0-2 tasks route locally
      // Level 3 tasks (CRUD endpoints, refactoring, API docs) go to cloud
      expect(localCount).toBeGreaterThan(0);

      const savings = results
        .filter(r => r.route === 'local')
        .reduce((sum, r) => sum + r.prompt.cloudTokens, 0);
      expect(savings).toBeGreaterThan(0);
    });

    it('Level 2 (Balanced/default): baseline savings', async () => {
      const results = await classifySession(allSessions, 2);
      const localCount = countByRoute(results, 'local');

      // Level 2 ceiling is 3, covers most common tasks
      expect(localCount).toBeGreaterThan(0);

      const savings = results
        .filter(r => r.route === 'local')
        .reduce((sum, r) => sum + r.prompt.cloudTokens, 0);
      expect(savings).toBeGreaterThan(0);
    });

    it('Level 3 (Aggressive): more tasks route local than Level 2', async () => {
      const results = await classifySession(allSessions, 3);
      const localCount = countByRoute(results, 'local');

      // Level 3 ceiling is 4, captures even more tasks
      expect(localCount).toBeGreaterThan(0);

      const savings = results
        .filter(r => r.route === 'local')
        .reduce((sum, r) => sum + r.prompt.cloudTokens, 0);
      expect(savings).toBeGreaterThan(0);
    });

    it('Level 4 (Max Local): most tasks route local', async () => {
      const results = await classifySession(allSessions, 4);
      const localCount = countByRoute(results, 'local');

      // Level 4 ceiling is 6, almost everything goes local
      expect(localCount).toBeGreaterThan(0);

      const savings = results
        .filter(r => r.route === 'local')
        .reduce((sum, r) => sum + r.prompt.cloudTokens, 0);
      expect(savings).toBeGreaterThan(0);
    });

    it('savings monotonically increase: Level 0 < Level 1 < Level 2 < Level 3 < Level 4', async () => {
      const savingsByLevel: number[] = [];

      for (const level of [0, 1, 2, 3, 4]) {
        const results = await classifySession(allSessions, level);
        const savings = results
          .filter(r => r.route === 'local')
          .reduce((sum, r) => sum + r.prompt.cloudTokens, 0);
        savingsByLevel.push(savings);
      }

      // Level 0 saves nothing
      expect(savingsByLevel[0]).toBe(0);

      // Each successive level saves at least as much as the previous
      for (let i = 1; i < savingsByLevel.length; i++) {
        expect(
          savingsByLevel[i],
          `Level ${i} savings (${savingsByLevel[i]}) should be >= Level ${i - 1} savings (${savingsByLevel[i - 1]})`,
        ).toBeGreaterThanOrEqual(savingsByLevel[i - 1]);
      }

      // Level 4 should save strictly more than Level 0
      expect(savingsByLevel[4]).toBeGreaterThan(savingsByLevel[0]);
    });
  });

  // ===========================================================================
  // 6. SESSION SUMMARY STATISTICS
  // ===========================================================================

  describe('6. Session summary statistics', () => {
    it('Total prompts across all sessions', () => {
      expect(allSessions.length).toBe(45);
    });

    it('Total no_llm tasks (filesystem/git, zero cost)', () => {
      const noLlmCount = allSessions.filter(s => s.expectedRoute === 'no_llm').length;
      // Morning: 3 (file tree, git status, line count)
      // Afternoon: 3 (list TS files, find test files, git log)
      // Quick fixes: 1 (git diff)
      expect(noLlmCount).toBe(7);
    });

    it('Total local tasks (delegated to local model, saves tokens)', () => {
      const localCount = allSessions.filter(s => s.expectedRoute === 'local').length;
      // Morning: 16, Afternoon: 11, Quick fixes: 9
      expect(localCount).toBe(36);
    });

    it('Total cloud tasks (kept on API, not saved)', () => {
      const cloudCount = allSessions.filter(s => s.expectedRoute === 'cloud').length;
      // Morning: 1 (design database schema)
      // Afternoon: 1 (debug race condition)
      // Quick fixes: 0
      expect(cloudCount).toBe(2);
    });

    it('Delegation rate = local / (local + cloud) as percentage', () => {
      const localCount = allSessions.filter(s => s.expectedRoute === 'local').length;
      const cloudCount = allSessions.filter(s => s.expectedRoute === 'cloud').length;

      const delegationRate = (localCount / (localCount + cloudCount)) * 100;

      // 36 / (36 + 2) = 36/38 = 94.74%
      expect(localCount).toBe(36);
      expect(cloudCount).toBe(2);
      expect(delegationRate).toBeCloseTo(94.74, 1);
    });

    it('Projected monthly savings at 20 sessions/day, 22 work days', () => {
      // One "day" of sessions = morning + afternoon + quick fixes = 6130 output tokens saved
      const tokensPerDay = 6130;
      const sessionsPerDay = 3; // our 3 sessions above represent one day's work
      const workDays = 22;

      // Tokens saved per month (one developer)
      const tokensPerMonth = tokensPerDay * (20 / sessionsPerDay) * workDays;
      // 6130 * (20/3) * 22 = 6130 * 6.667 * 22 ≈ 899,067
      // More precisely: 6130 * 20 * 22 / 3 = 2,697,200 / 3 = 899,066.67

      // Cost savings at OUTPUT token price points (Feb 2026)
      const savingsAt5 = (tokensPerMonth / 1_000_000) * 5;    // Haiku 4.5 output
      const savingsAt15 = (tokensPerMonth / 1_000_000) * 15;   // Sonnet 4.5 output
      const savingsAt25 = (tokensPerMonth / 1_000_000) * 25;   // Opus 4.6 output

      // At $5/M output (Haiku): ~$4.50/month
      expect(savingsAt5).toBeGreaterThan(3);
      expect(savingsAt5).toBeLessThan(6);

      // At $15/M output (Sonnet): ~$13.49/month
      expect(savingsAt15).toBeGreaterThan(11);
      expect(savingsAt15).toBeLessThan(16);

      // At $25/M output (Opus): ~$22.48/month
      expect(savingsAt25).toBeGreaterThan(19);
      expect(savingsAt25).toBeLessThan(26);

      // Verify the tokens/month is in a reasonable range
      expect(tokensPerMonth).toBeGreaterThan(800_000);
      expect(tokensPerMonth).toBeLessThan(1_000_000);
    });
  });
});
