/**
 * Integration tests for the full classification pipeline.
 *
 * These tests exercise classifyTask() end-to-end with 50+ realistic prompts
 * organized by expected complexity category. The config module is mocked to
 * provide a controlled environment, and use_local_triage is disabled so that
 * Layers 1 (patterns) and 2 (signals) handle classification without requiring
 * a live Ollama instance.
 *
 * The classification engine uses two layers when triage is disabled:
 *   Layer 1 — Static pattern matching (keyword-based rules)
 *   Layer 2 — Signal extraction and heuristic scoring
 *
 * Prompts that lack pattern keywords AND lack signal-triggering language
 * (scope markers, reasoning words, cost-of-wrong keywords, novelty markers)
 * will score low on Layer 2 regardless of their semantic complexity. This is
 * a known limitation of the pattern+heuristic approach; Layer 3 (LLM triage)
 * exists to catch these cases in production.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks -- must be declared before any imports that use the mocked modules
// ---------------------------------------------------------------------------

vi.mock('../../src/mcp-server/config.js', () => ({
  loadConfig: () => ({
    delegation_level: 2,
    ollama: {
      base_url: 'http://localhost:11434',
      default_model: 'test-model',
      fallback_model: null,
      timeout_ms: 5000,
      health_timeout_ms: 3000,
    },
    routing: {
      use_local_triage: false,
      use_historical_learning: false,
      enable_decomposition: false,
      triage_model: null,
    },
    specialist_models: {},
    metrics: { enabled: false, log_path: '' },
    welcome: {
      show_savings: true,
      show_models: true,
      show_level: true,
      cost_per_million_tokens: 8,
    },
  }),
}));

// Mock global fetch so no real network calls happen even if triage is somehow
// invoked (belt-and-suspenders).
const mockFetch = vi.fn().mockImplementation(async (url: string) => {
  if (typeof url === 'string' && url.includes('/api/chat')) {
    return {
      ok: true,
      json: async () => ({
        message: { content: 'MODERATE' },
        eval_count: 10,
        prompt_eval_count: 50,
        done_reason: 'stop',
      }),
      text: async () => 'MODERATE',
    };
  }
  // Fallback for any other fetch (e.g. health checks)
  return {
    ok: true,
    json: async () => ({ models: [] }),
    text: async () => '',
  };
});

vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Import the system under test AFTER mocks are in place
// ---------------------------------------------------------------------------

import { classifyTask, type RoutingDecision } from '../../src/mcp-server/router.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Common structural assertions that every classification result must satisfy.
 */
function assertValidResult(result: RoutingDecision): void {
  expect(result).toBeDefined();
  expect(['no_llm', 'local', 'cloud']).toContain(result.route);
  expect(result.task_complexity).toBeGreaterThanOrEqual(0);
  expect(result.task_complexity).toBeLessThanOrEqual(6);
  expect(result.confidence).toBeGreaterThan(0);
  expect(result.confidence).toBeLessThanOrEqual(1);
  expect(typeof result.reason).toBe('string');
  expect(result.reason.length).toBeGreaterThan(0);
  expect(
    typeof result.classification_layer === 'string' ||
      typeof result.classification_layer === 'number',
  ).toBe(true);
  expect(result.escalation_policy).toBeDefined();
}

/**
 * Assert a result routes locally (either 'local' or 'no_llm').
 */
function expectLocal(result: RoutingDecision): void {
  expect(
    result.route === 'local' || result.route === 'no_llm',
  ).toBe(true);
}

/**
 * Assert a result routes to the cloud.
 */
function expectCloud(result: RoutingDecision): void {
  expect(result.route).toBe('cloud');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Routing E2E Integration Tests', () => {
  // Default delegation level from the mocked config is 2 (ceiling = 3).

  // =======================================================================
  // 1. TRIVIAL TASKS  (should route LOCAL, Level 1-2)
  // =======================================================================
  describe('Category 1: Trivial tasks (expect LOCAL, Level 1-2)', () => {
    const trivialPrompts = [
      'add a docstring to this function',
      'generate a commit message for these changes',
      'convert this JSON to YAML',
      'add type annotations to this function',
      'write a TODO comment for this section',
      'format this code according to prettier rules',
      'rename the variable `x` to `userCount`',
      'add JSDoc comments to all exported functions',
      'generate a .gitignore for a Node.js project',
      'write a simple hello world in Python',
    ];

    it.each(trivialPrompts)(
      'routes "%s" locally at Level 1-2',
      async (prompt) => {
        const result = await classifyTask(prompt);
        assertValidResult(result);
        expectLocal(result);
        expect(result.task_complexity).toBeLessThanOrEqual(2);
      },
    );

    it('all trivial prompts have non-trivial confidence', async () => {
      for (const prompt of trivialPrompts) {
        const result = await classifyTask(prompt);
        expect(result.confidence).toBeGreaterThanOrEqual(0.5);
      }
    });
  });

  // =======================================================================
  // 2. SIMPLE TASKS  (should route LOCAL, Level 2-3)
  // =======================================================================
  describe('Category 2: Simple tasks (expect LOCAL, Level 2-3)', () => {
    const simplePrompts = [
      'write unit tests for this utility function',
      'create a basic Express route handler for GET /users',
      'generate a TypeScript interface from this JSON response',
      'add input validation to this form handler',
      'write a README section describing installation steps',
      'create a simple React component that displays a user card',
      'refactor this function to use async/await instead of callbacks',
      'add error handling to this API call',
      'write a migration script to add a created_at column',
      'create a Dockerfile for this Node.js application',
    ];

    it.each(simplePrompts)(
      'routes "%s" locally at Level 2-3',
      async (prompt) => {
        const result = await classifyTask(prompt);
        assertValidResult(result);
        expectLocal(result);
        expect(result.task_complexity).toBeLessThanOrEqual(3);
      },
    );

    it('simple tasks consistently stay within the local ceiling', async () => {
      for (const prompt of simplePrompts) {
        const result = await classifyTask(prompt);
        // With delegation_level=2, the ceiling is 3. These should stay under.
        expect(result.task_complexity).toBeLessThanOrEqual(3);
      }
    });
  });

  // =======================================================================
  // 3. COMPLEX TASKS  (should route CLOUD, Level 4+)
  //
  // These prompts are chosen to trigger cloud routing through either:
  //   - Layer 1 pattern matches (keywords like "redesign", "architect",
  //     "debug this", "security", "vulnerability")
  //   - Layer 2 signal scoring (keywords for scope, cost_of_wrong, novelty)
  // =======================================================================
  describe('Category 3: Complex tasks (expect CLOUD, Level 4+)', () => {
    const complexPrompts = [
      // Pattern: "redesign"
      'redesign the authentication system to use JWT with refresh tokens and implement session management across microservices',
      // Signals: "payment" + "billing" -> critical/high cost_of_wrong
      'debug why the payment processing fails intermittently in production -- check the Stripe webhook handler, retry logic, and database transaction isolation',
      // Signals: "security" + "vulnerability" -> critical cost_of_wrong
      'review this codebase for security vulnerabilities including SQL injection, XSS, and CSRF',
      // Signals: "custom" -> novel novelty
      'implement OAuth2 with PKCE flow supporting Google, GitHub, and custom SAML providers',
      // Pattern: "architect"
      'architect a plugin system that supports hot-reloading, dependency injection, and lifecycle hooks',
      // Signals: "debug" + "fix" -> toolchain; multiple reasoning keywords
      'debug a race condition in our distributed task queue that causes duplicate processing under high load',
      // Pattern: "security review"
      'perform a security review of the authentication module and ensure credentials are handled correctly',
      // Pattern: "major refactor"
      'major refactor of the data access layer to support both PostgreSQL and MongoDB backends',
      // Pattern: "debug this"
      'debug this intermittent test failure in the CI pipeline that only happens under concurrent load',
      // Signals: "production deploy" -> critical cost; "infrastructure" -> high cost
      'plan the production deploy of our new infrastructure with zero-downtime migration and rollback strategy',
    ];

    it.each(complexPrompts)('routes "%s" to cloud', async (prompt) => {
      const result = await classifyTask(prompt);
      assertValidResult(result);
      expectCloud(result);
    });

    it('complex tasks have complexity >= 4', async () => {
      for (const prompt of complexPrompts) {
        const result = await classifyTask(prompt);
        expect(result.task_complexity).toBeGreaterThanOrEqual(4);
      }
    });
  });

  // =======================================================================
  // 4. EXPERT TASKS  (should route CLOUD, Level 5-6)
  // =======================================================================
  describe('Category 4: Expert tasks (expect CLOUD, Level 5-6)', () => {
    const expertPrompts = [
      // Pattern: "system design" / "architect"
      'design the complete system architecture for a multi-tenant SaaS platform with data isolation, billing integration, and white-label customization',
      // Signals: "custom" -> novel novelty
      'implement a custom query optimizer for our domain-specific language that generates efficient SQL across PostgreSQL and MongoDB',
      // Pattern: "threat model" + "security"
      'build a comprehensive threat model for our authentication and payment infrastructure to identify novel attack vectors',
    ];

    it.each(expertPrompts)('routes "%s" to cloud', async (prompt) => {
      const result = await classifyTask(prompt);
      assertValidResult(result);
      expectCloud(result);
    });

    it('expert tasks are classified at Level 5-6', async () => {
      for (const prompt of expertPrompts) {
        const result = await classifyTask(prompt);
        expect(result.task_complexity).toBeGreaterThanOrEqual(5);
      }
    });
  });

  // =======================================================================
  // 5. EDGE CASES
  // =======================================================================
  describe('Category 5: Edge cases', () => {
    it('handles empty string without crashing', async () => {
      const result = await classifyTask('');
      assertValidResult(result);
      // An empty prompt has no signals; should default to something benign.
      expect(result.task_complexity).toBeLessThanOrEqual(3);
    });

    it('handles very long prompt (1000+ chars) without crashing', async () => {
      const longPrompt =
        'Please refactor the following function to be more readable. '.repeat(20) +
        'Also add comprehensive error handling for edge cases. '.repeat(10) +
        'Make sure the code follows our team coding standards and add appropriate tests. '.repeat(5);
      expect(longPrompt.length).toBeGreaterThan(1000);

      const result = await classifyTask(longPrompt);
      assertValidResult(result);
      // A very long prompt about refactoring should still classify properly.
      expect(result.task_complexity).toBeGreaterThanOrEqual(1);
    });

    it('handles prompt with embedded code blocks', async () => {
      const prompt = `Fix the bug in this function:
\`\`\`typescript
function add(a: number, b: number): number {
  return a - b; // bug: should be a + b
}
\`\`\`
Make sure to add unit tests for edge cases.`;
      const result = await classifyTask(prompt);
      assertValidResult(result);
    });

    it('handles prompt in Japanese', async () => {
      const prompt = 'この関数にドキュメントを追加してください';
      const result = await classifyTask(prompt);
      assertValidResult(result);
      // Non-English prompt will miss pattern matches and fall to Layer 2.
      // It should still produce a valid, low-complexity result.
      expect(result.task_complexity).toBeLessThanOrEqual(4);
    });

    it('handles prompt in Spanish', async () => {
      const prompt =
        'Crear una interfaz de TypeScript para el modelo de usuario con validaciones';
      const result = await classifyTask(prompt);
      assertValidResult(result);
      expect(result.task_complexity).toBeLessThanOrEqual(4);
    });

    it('handles ambiguous short prompt: "fix this"', async () => {
      const result = await classifyTask('fix this');
      assertValidResult(result);
      // "fix" triggers tool-chain detection; the prompt is short/vague.
      // Should still produce a valid classification.
    });

    it('handles prompt with file paths', async () => {
      const result = await classifyTask(
        'update src/components/Header.tsx to add navigation',
      );
      assertValidResult(result);
      // References a single file -- should be manageable locally.
      expectLocal(result);
    });

    it('handles prompt with multiple file references', async () => {
      const result = await classifyTask(
        'refactor src/auth/login.ts, src/auth/register.ts, src/auth/middleware.ts, ' +
          'src/models/User.ts, and src/routes/auth.ts to use a shared authentication service',
      );
      assertValidResult(result);
      // Multiple files + refactor across module = higher complexity.
      expect(result.task_complexity).toBeGreaterThanOrEqual(3);
    });

    it('handles prompt with only whitespace', async () => {
      const result = await classifyTask('   \n\t  ');
      assertValidResult(result);
    });

    it('handles prompt with special characters', async () => {
      const result = await classifyTask(
        'fix the regex /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$/ for email validation',
      );
      assertValidResult(result);
    });

    it('handles prompt with numeric content', async () => {
      const result = await classifyTask(
        'add error code 404 and 500 handlers to the middleware chain',
      );
      assertValidResult(result);
    });
  });

  // =======================================================================
  // 6. DELEGATION LEVEL OVERRIDES
  // =======================================================================
  describe('Category 6: Delegation level overrides', () => {
    it('Level 0 always returns cloud regardless of task', async () => {
      const result = await classifyTask('add a comment', {
        delegationLevel: 0,
      });
      assertValidResult(result);
      expectCloud(result);
      expect(result.classification_layer).toBe('level_gate');
      expect(result.escalation_policy).toBe('none');
    });

    it('Level 5 always returns local regardless of task', async () => {
      const result = await classifyTask(
        'design a complete distributed system architecture',
        { delegationLevel: 5 },
      );
      assertValidResult(result);
      expectLocal(result);
      expect(result.classification_layer).toBe('level_gate');
      expect(result.escalation_policy).toBe('never');
    });

    it('Level 1 routes complex tasks to cloud (ceiling = 2)', async () => {
      const result = await classifyTask('create a crud endpoint for users', {
        delegationLevel: 1,
      });
      assertValidResult(result);
      expectCloud(result);
      expect(result.reason).toContain('exceeds ceiling');
    });

    it('Level 1 routes trivial tasks locally', async () => {
      const result = await classifyTask('format this code', {
        delegationLevel: 1,
      });
      assertValidResult(result);
      expectLocal(result);
      expect(result.task_complexity).toBeLessThanOrEqual(2);
    });

    it('Level 3 allows medium complexity tasks locally (ceiling = 4)', async () => {
      const result = await classifyTask('create a crud endpoint for users', {
        delegationLevel: 3,
      });
      assertValidResult(result);
      expectLocal(result);
    });

    it('Level 4 has ceiling 6 but cloud_recommended still routes to cloud', async () => {
      const result = await classifyTask('architect a microservices system', {
        delegationLevel: 4,
      });
      assertValidResult(result);
      // cloud_recommended maps to 'cloud' in the router
      expectCloud(result);
    });
  });

  // =======================================================================
  // 7. CLASSIFICATION LAYER VERIFICATION
  // =======================================================================
  describe('Category 7: Classification layer tracking', () => {
    it('pattern-matched tasks report Layer 1', async () => {
      const result = await classifyTask('write docstring for this function');
      expect(result.classification_layer).toBe(1);
    });

    it('no_llm filesystem tasks report Layer 1', async () => {
      const result = await classifyTask('list files in the project');
      expect(result.classification_layer).toBe(1);
      expect(result.route).toBe('no_llm');
    });

    it('tasks without pattern match fall to Layer 2', async () => {
      // A prompt that does not match any static pattern
      const result = await classifyTask(
        'calculate the fibonacci sequence iteratively',
      );
      expect(result.classification_layer).toBe(2);
    });

    it('Level 0 gate reports level_gate layer', async () => {
      const result = await classifyTask('anything', { delegationLevel: 0 });
      expect(result.classification_layer).toBe('level_gate');
    });

    it('Level 5 gate reports level_gate layer', async () => {
      const result = await classifyTask('anything', { delegationLevel: 5 });
      expect(result.classification_layer).toBe('level_gate');
    });
  });

  // =======================================================================
  // 8. ESCALATION POLICY VERIFICATION
  // =======================================================================
  describe('Category 8: Escalation policy by delegation level', () => {
    it('Level 1 has "immediate" escalation policy', async () => {
      const result = await classifyTask('add a docstring', {
        delegationLevel: 1,
      });
      expect(result.escalation_policy).toBe('immediate');
    });

    it('Level 2 has "standard" escalation policy', async () => {
      const result = await classifyTask('add a docstring', {
        delegationLevel: 2,
      });
      expect(result.escalation_policy).toBe('standard');
    });

    it('Level 3 has "tolerant" escalation policy', async () => {
      const result = await classifyTask('add a docstring', {
        delegationLevel: 3,
      });
      expect(result.escalation_policy).toBe('tolerant');
    });

    it('Level 4 has "minimal" escalation policy', async () => {
      const result = await classifyTask('add a docstring', {
        delegationLevel: 4,
      });
      expect(result.escalation_policy).toBe('minimal');
    });
  });

  // =======================================================================
  // 9. SPECIALIST KEY AND MODEL SUGGESTION
  // =======================================================================
  describe('Category 9: Specialist key and model suggestions', () => {
    it('docstring tasks have "docs" specialist key', async () => {
      const result = await classifyTask('add docstrings to this module');
      expect(result.specialist_key).toBe('docs');
    });

    it('commit message tasks have "commit_messages" specialist key', async () => {
      const result = await classifyTask('generate a commit message');
      expect(result.specialist_key).toBe('commit_messages');
    });

    it('formatting tasks have "formatting" specialist key', async () => {
      const result = await classifyTask('format this code');
      expect(result.specialist_key).toBe('formatting');
    });

    it('test tasks have "tests" specialist key', async () => {
      const result = await classifyTask('write a unit test for this function');
      expect(result.specialist_key).toBe('tests');
    });

    it('security audit tasks have "analysis" specialist key', async () => {
      const result = await classifyTask('security audit of the auth module');
      expect(result.specialist_key).toBe('analysis');
    });

    it('pattern-matched tasks include a suggested model', async () => {
      const result = await classifyTask('convert json to yaml');
      expect(result.suggested_model).toBeDefined();
      expect(typeof result.suggested_model).toBe('string');
    });

    it('Layer 2 fallback tasks include a suggested model', async () => {
      const result = await classifyTask(
        'calculate the fibonacci sequence iteratively',
      );
      expect(result.suggested_model).toBeDefined();
    });
  });

  // =======================================================================
  // 10. COST-OF-WRONG PROPAGATION
  // =======================================================================
  describe('Category 10: Cost-of-wrong propagation', () => {
    it('security tasks have "critical" cost_of_wrong', async () => {
      const result = await classifyTask('security audit of the codebase');
      expect(result.cost_of_wrong).toBe('critical');
    });

    it('formatting tasks have "trivial" cost_of_wrong', async () => {
      const result = await classifyTask('format this code');
      expect(result.cost_of_wrong).toBe('trivial');
    });

    it('test tasks have "low" cost_of_wrong via pattern', async () => {
      const result = await classifyTask('write a unit test for this function');
      expect(result.cost_of_wrong).toBe('low');
    });

    it('devops tasks have "medium" cost_of_wrong', async () => {
      const result = await classifyTask('create a Dockerfile for this app');
      expect(result.cost_of_wrong).toBe('medium');
    });
  });

  // =======================================================================
  // 11. NO NETWORK CALLS VERIFICATION
  // =======================================================================
  describe('Category 11: No network calls made', () => {
    beforeAll(() => {
      mockFetch.mockClear();
    });

    it('classifying a trivial task does not call fetch', async () => {
      mockFetch.mockClear();
      await classifyTask('add a comment to this function');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('classifying a complex task does not call fetch (triage disabled)', async () => {
      mockFetch.mockClear();
      await classifyTask(
        'redesign the authentication system with JWT and refresh tokens',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('classifying via Layer 2 heuristics does not call fetch', async () => {
      mockFetch.mockClear();
      await classifyTask('calculate prime numbers up to N');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // =======================================================================
  // 12. HEURISTIC LIMITATIONS -- prompts that are semantically complex but
  //     lack pattern/signal keywords and thus classify at lower levels.
  //     These document known gaps in the pattern+heuristic engine that
  //     Layer 3 (LLM triage) is designed to address.
  // =======================================================================
  describe('Category 12: Heuristic engine limitations (known gaps)', () => {
    const semanticallyComplexButLowSignal = [
      'implement a real-time collaborative editing feature using CRDTs with conflict resolution',
      'design a caching strategy for our GraphQL API that handles cache invalidation across 5 microservices',
      'optimize database queries -- we have N+1 problems across 12 endpoints and need to implement DataLoader',
      'implement end-to-end encryption for our messaging feature with key rotation and forward secrecy',
      'build a distributed consensus algorithm for our cluster coordination that handles network partitions and split-brain scenarios',
    ];

    it.each(semanticallyComplexButLowSignal)(
      'classifies "%s" without crashing (may under-classify)',
      async (prompt) => {
        const result = await classifyTask(prompt);
        assertValidResult(result);
        // These prompts are semantically complex but lack the specific
        // keywords the pattern/signal engine looks for. Without Layer 3
        // triage they will likely classify at Level 2-3 (local).
        // This is expected behavior -- Layer 3 exists to catch these cases.
        expect(result.classification_layer).toBe(2);
      },
    );

    it('documents that these tasks would need Layer 3 for correct classification', async () => {
      for (const prompt of semanticallyComplexButLowSignal) {
        const result = await classifyTask(prompt);
        // Without triage, these complex tasks route locally.
        // In production with use_local_triage=true, they would hit Layer 3
        // where the LLM would recognize the complexity.
        expectLocal(result);
      }
    });
  });

  // =======================================================================
  // 13. BATCH CONSISTENCY -- all prompts produce valid output
  // =======================================================================
  describe('Category 13: Batch consistency across all 50+ prompts', () => {
    const allPrompts = [
      // ---- Trivial (10) ----
      'add a docstring to this function',
      'generate a commit message for these changes',
      'convert this JSON to YAML',
      'add type annotations to this function',
      'write a TODO comment for this section',
      'format this code according to prettier rules',
      'rename the variable `x` to `userCount`',
      'add JSDoc comments to all exported functions',
      'generate a .gitignore for a Node.js project',
      'write a simple hello world in Python',
      // ---- Simple (10) ----
      'write unit tests for this utility function',
      'create a basic Express route handler for GET /users',
      'generate a TypeScript interface from this JSON response',
      'add input validation to this form handler',
      'write a README section describing installation steps',
      'create a simple React component that displays a user card',
      'refactor this function to use async/await instead of callbacks',
      'add error handling to this API call',
      'write a migration script to add a created_at column',
      'create a Dockerfile for this Node.js application',
      // ---- Complex (10) ----
      'redesign the authentication system to use JWT with refresh tokens and implement session management across microservices',
      'debug why the payment processing fails intermittently in production -- check the Stripe webhook handler, retry logic, and database transaction isolation',
      'review this codebase for security vulnerabilities including SQL injection, XSS, and CSRF',
      'implement OAuth2 with PKCE flow supporting Google, GitHub, and custom SAML providers',
      'architect a plugin system that supports hot-reloading, dependency injection, and lifecycle hooks',
      'debug a race condition in our distributed task queue that causes duplicate processing under high load',
      'perform a security review of the authentication module and ensure credentials are handled correctly',
      'major refactor of the data access layer to support both PostgreSQL and MongoDB backends',
      'debug this intermittent test failure in the CI pipeline that only happens under concurrent load',
      'plan the production deploy of our new infrastructure with zero-downtime migration and rollback strategy',
      // ---- Expert (3) ----
      'design the complete system architecture for a multi-tenant SaaS platform with data isolation, billing integration, and white-label customization',
      'implement a custom query optimizer for our domain-specific language that generates efficient SQL across PostgreSQL and MongoDB',
      'build a comprehensive threat model for our authentication and payment infrastructure to identify novel attack vectors',
      // ---- Semantically complex but low-signal (5) ----
      'implement a real-time collaborative editing feature using CRDTs with conflict resolution',
      'design a caching strategy for our GraphQL API that handles cache invalidation across 5 microservices',
      'optimize database queries -- we have N+1 problems across 12 endpoints and need to implement DataLoader',
      'implement end-to-end encryption for our messaging feature with key rotation and forward secrecy',
      'build a distributed consensus algorithm for our cluster coordination that handles network partitions and split-brain scenarios',
      // ---- Edge cases (12) ----
      '',
      '   \n\t  ',
      'fix this',
      'この関数にドキュメントを追加してください',
      'Crear una interfaz de TypeScript para el modelo de usuario con validaciones',
      'update src/components/Header.tsx to add navigation',
      'fix the regex /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$/ for email validation',
      'add error code 404 and 500 handlers to the middleware chain',
      'calculate the fibonacci sequence iteratively',
      'create a hello world web server',
      'explain this code',
      'what does this function do',
      // ---- Additional coverage (10) ----
      'list files in the project',
      'git status',
      'show me the folder structure',
      'add logging to the user service',
      'create a GitHub Action workflow for CI',
      'write a simple regex for email validation',
      'explain this code block and summarize what it does',
      'extract function from this long method',
      'sort imports in this file',
      'add try catch error handling to this endpoint',
    ];

    it(`contains at least 50 prompts (has ${allPrompts.length})`, () => {
      expect(allPrompts.length).toBeGreaterThanOrEqual(50);
    });

    it('all prompts produce structurally valid results', async () => {
      for (const prompt of allPrompts) {
        const result = await classifyTask(prompt);
        assertValidResult(result);
      }
    });

    it('no prompt causes an exception', async () => {
      for (const prompt of allPrompts) {
        await expect(classifyTask(prompt)).resolves.toBeDefined();
      }
    });

    it('all results have a non-empty reason', async () => {
      for (const prompt of allPrompts) {
        const result = await classifyTask(prompt);
        expect(result.reason.trim().length).toBeGreaterThan(0);
      }
    });

    it('trivial prompts in the batch all route locally', async () => {
      // First 10 prompts are trivial
      for (const prompt of allPrompts.slice(0, 10)) {
        const result = await classifyTask(prompt);
        expectLocal(result);
      }
    });

    it('complex prompts in the batch all route to cloud', async () => {
      // Prompts 20-29 are complex
      for (const prompt of allPrompts.slice(20, 30)) {
        const result = await classifyTask(prompt);
        expectCloud(result);
      }
    });
  });
});
