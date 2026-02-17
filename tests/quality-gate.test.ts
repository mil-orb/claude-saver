import { describe, it, expect } from 'vitest';
import { runQualityGate } from '../src/mcp-server/quality-gate.js';
import type { GateOptions, QualityGateResult } from '../src/mcp-server/quality-gate.js';
import type { QualityGateConfig } from '../src/mcp-server/config.js';

const DEFAULT_GATE_CONFIG: QualityGateConfig = {
  enabled: true,
  check_completeness: true,
  check_code_parse: true,
  check_scope: true,
  check_hedging: true,
  check_proportionality: true,
  min_output_length: 20,
  max_output_length: 10000,
};

function makeOptions(overrides: Partial<GateOptions> = {}): GateOptions {
  return {
    config: DEFAULT_GATE_CONFIG,
    ...overrides,
  };
}

function withConfig(overrides: Partial<QualityGateConfig>): GateOptions {
  return makeOptions({ config: { ...DEFAULT_GATE_CONFIG, ...overrides } });
}

// A clean output that satisfies every gate at default settings
const CLEAN_OUTPUT = 'Here is the implementation of the requested function with all edge cases handled correctly.';

// ── Hard Gates ────────────────────────────────────────────────────────────────

describe('Hard gate: completeness', () => {
  it('passes when output contains no placeholder markers', () => {
    const result = runQualityGate(CLEAN_OUTPUT, makeOptions());
    const check = result.all_checks.find(c => c.name === 'completeness');
    expect(check?.passed).toBe(true);
  });

  it('fails when output contains TODO', () => {
    const output = 'The function is implemented. TODO: handle edge cases properly.';
    const result = runQualityGate(output, makeOptions());
    const check = result.all_checks.find(c => c.name === 'completeness');
    expect(check?.passed).toBe(false);
    expect(check?.reason).toContain('TODO');
  });

  it('fails when output contains TBD', () => {
    const output = 'Configuration is TBD and will be added in a follow-up commit.';
    const result = runQualityGate(output, makeOptions());
    const check = result.all_checks.find(c => c.name === 'completeness');
    expect(check?.passed).toBe(false);
    expect(check?.reason).toContain('TBD');
  });

  it('fails when output contains FIXME', () => {
    const output = 'The logic works but FIXME: this needs refactoring before shipping.';
    const result = runQualityGate(output, makeOptions());
    const check = result.all_checks.find(c => c.name === 'completeness');
    expect(check?.passed).toBe(false);
    expect(check?.reason).toContain('FIXME');
  });

  it('fails when output contains PLACEHOLDER', () => {
    const output = 'Replace the PLACEHOLDER value with the actual API key from config.';
    const result = runQualityGate(output, makeOptions());
    const check = result.all_checks.find(c => c.name === 'completeness');
    expect(check?.passed).toBe(false);
    expect(check?.reason).toContain('PLACEHOLDER');
  });

  it('fails when output contains XXX', () => {
    const output = 'This section is XXX and requires a proper implementation later.';
    const result = runQualityGate(output, makeOptions());
    const check = result.all_checks.find(c => c.name === 'completeness');
    expect(check?.passed).toBe(false);
    expect(check?.reason).toContain('XXX');
  });

  it('passes when output contains lowercase todo (case-sensitive check)', () => {
    const output = 'The code is complete. A todo list of follow-up ideas is documented elsewhere.';
    const result = runQualityGate(output, makeOptions());
    const check = result.all_checks.find(c => c.name === 'completeness');
    expect(check?.passed).toBe(true);
  });

  it('fails on first matched marker when multiple markers are present', () => {
    const output = 'First step is TODO, second step is FIXME, third is TBD in the system.';
    const result = runQualityGate(output, makeOptions());
    const check = result.all_checks.find(c => c.name === 'completeness');
    expect(check?.passed).toBe(false);
    expect(check?.reason).toBeDefined();
  });
});

describe('Hard gate: code_parse', () => {
  it('passes when braces and brackets are balanced', () => {
    const output = 'function add(a, b) { return a + b; } and call it with add(1, 2) for results.';
    const result = runQualityGate(output, makeOptions());
    const check = result.all_checks.find(c => c.name === 'code_parse');
    expect(check?.passed).toBe(true);
  });

  it('fails when braces are heavily unmatched (more than 2 open)', () => {
    // Three extra unclosed braces to exceed the tolerance of 2
    const output = 'function a() { function b() { function c() { function d() {';
    const result = runQualityGate(output, makeOptions());
    const check = result.all_checks.find(c => c.name === 'code_parse');
    expect(check?.passed).toBe(false);
    expect(check?.reason).toContain('Unmatched braces');
  });

  it('fails when brackets are heavily unmatched (more than 2 open)', () => {
    // Three extra unclosed brackets to exceed the tolerance of 2
    const output = 'const x = arr[map[obj[key[';
    const result = runQualityGate(output, makeOptions());
    const check = result.all_checks.find(c => c.name === 'code_parse');
    expect(check?.passed).toBe(false);
    expect(check?.reason).toContain('Unmatched brackets');
  });

  it('extracts and checks code inside fenced code blocks', () => {
    const output = [
      'Here is the code:',
      '```js',
      'function ok() { return 1; }',
      '```',
      'And that is all.',
    ].join('\n');
    const result = runQualityGate(output, makeOptions());
    const check = result.all_checks.find(c => c.name === 'code_parse');
    expect(check?.passed).toBe(true);
  });

  it('fails on unmatched braces inside a fenced code block', () => {
    const output = [
      'Here is the broken code:',
      '```ts',
      'function broken() { if (true) { if (true) { if (true) {',
      '```',
      'It has issues.',
    ].join('\n');
    const result = runQualityGate(output, makeOptions());
    const check = result.all_checks.find(c => c.name === 'code_parse');
    expect(check?.passed).toBe(false);
  });

  it('passes for deeply nested but balanced code', () => {
    const output = 'const v = a(b(c(d(1))));';
    const result = runQualityGate(output, makeOptions());
    const check = result.all_checks.find(c => c.name === 'code_parse');
    expect(check?.passed).toBe(true);
  });

  it('passes when there is no code at all', () => {
    const result = runQualityGate(CLEAN_OUTPUT, makeOptions());
    const check = result.all_checks.find(c => c.name === 'code_parse');
    expect(check?.passed).toBe(true);
  });

  it('passes with balanced mixed brackets and braces', () => {
    const output = 'const result = obj["key"] + arr[0] + fn({ a: [1, 2] });';
    const result = runQualityGate(output, makeOptions());
    const check = result.all_checks.find(c => c.name === 'code_parse');
    expect(check?.passed).toBe(true);
  });
});

describe('Hard gate: scope_compliance', () => {
  it('passes when no allowedFiles are specified', () => {
    const output = 'Modified src/foo/bar.ts and lib/utils.js in the project.';
    const result = runQualityGate(output, makeOptions());
    const check = result.all_checks.find(c => c.name === 'scope_compliance');
    expect(check?.passed).toBe(true);
  });

  it('passes when the output only references files in allowedFiles', () => {
    const output = 'Updated src/router.ts with the new route definitions.';
    const result = runQualityGate(output, makeOptions({ allowedFiles: ['src/router.ts'] }));
    const check = result.all_checks.find(c => c.name === 'scope_compliance');
    expect(check?.passed).toBe(true);
  });

  it('fails when the output references a file not in allowedFiles', () => {
    const output = 'Updated src/router.ts and then modified src/secret.ts as well.';
    const result = runQualityGate(output, makeOptions({ allowedFiles: ['src/router.ts'] }));
    const check = result.all_checks.find(c => c.name === 'scope_compliance');
    expect(check?.passed).toBe(false);
    expect(check?.reason).toContain('src/secret.ts');
  });

  it('passes with an empty allowedFiles array (no restriction)', () => {
    const output = 'Modified src/anything.ts freely across the codebase.';
    const result = runQualityGate(output, makeOptions({ allowedFiles: [] }));
    const check = result.all_checks.find(c => c.name === 'scope_compliance');
    expect(check?.passed).toBe(true);
  });

  it('handles suffix-based path matching (partial paths allowed)', () => {
    // The allowedFiles entry is just a basename; the output has a rooted path
    const output = 'Edited the file src/components/button.ts to fix the hover style.';
    const result = runQualityGate(output, makeOptions({ allowedFiles: ['components/button.ts'] }));
    const check = result.all_checks.find(c => c.name === 'scope_compliance');
    expect(check?.passed).toBe(true);
  });

  it('fails when multiple out-of-scope files are referenced', () => {
    const output = 'Changed src/alpha.ts, src/beta.ts, and src/gamma.ts for this feature.';
    const result = runQualityGate(output, makeOptions({ allowedFiles: ['src/alpha.ts'] }));
    const check = result.all_checks.find(c => c.name === 'scope_compliance');
    expect(check?.passed).toBe(false);
    expect(check?.reason).toContain('Files outside scope');
  });
});

describe('Hard gate: required_sections', () => {
  it('passes when no required sections are specified', () => {
    const result = runQualityGate(CLEAN_OUTPUT, makeOptions());
    const check = result.all_checks.find(c => c.name === 'required_sections');
    expect(check?.passed).toBe(true);
  });

  it('passes when all required sections are present (case-insensitive)', () => {
    const output = 'SUMMARY\nThis is a summary.\n\nDETAILS\nHere are the details of the implementation.';
    const result = runQualityGate(output, makeOptions({ requiredSections: ['summary', 'details'] }));
    const check = result.all_checks.find(c => c.name === 'required_sections');
    expect(check?.passed).toBe(true);
  });

  it('fails when a required section is missing', () => {
    const output = 'SUMMARY\nThis is only a summary with no other sections present.';
    const result = runQualityGate(output, makeOptions({ requiredSections: ['summary', 'conclusion'] }));
    const check = result.all_checks.find(c => c.name === 'required_sections');
    expect(check?.passed).toBe(false);
    expect(check?.reason).toContain('conclusion');
  });

  it('fails when all required sections are missing', () => {
    const output = 'Here is some unstructured output without any of the required headings.';
    const result = runQualityGate(output, makeOptions({ requiredSections: ['overview', 'rationale'] }));
    const check = result.all_checks.find(c => c.name === 'required_sections');
    expect(check?.passed).toBe(false);
    expect(check?.reason).toContain('overview');
    expect(check?.reason).toContain('rationale');
  });
});

describe('Hard gate: length', () => {
  it('passes when output length is within default bounds', () => {
    const output = 'This output is exactly long enough to satisfy the minimum length requirement.';
    const result = runQualityGate(output, makeOptions());
    const check = result.all_checks.find(c => c.name === 'length');
    expect(check?.passed).toBe(true);
  });

  it('fails when output is shorter than min_output_length', () => {
    // Use a custom high min_output_length so CLEAN_OUTPUT (93 chars) is still below it
    const result = runQualityGate(CLEAN_OUTPUT, withConfig({ min_output_length: 500, max_output_length: 10000 }));
    const check = result.all_checks.find(c => c.name === 'length');
    expect(check?.passed).toBe(false);
    expect(check?.reason).toContain('too short');
  });

  it('fails when output exceeds max_output_length', () => {
    // Use a custom small max_output_length so CLEAN_OUTPUT (93 chars) exceeds it.
    // This avoids building a huge string that could trigger the repetition-loop escalation.
    const result = runQualityGate(CLEAN_OUTPUT, withConfig({ min_output_length: 20, max_output_length: 50 }));
    const check = result.all_checks.find(c => c.name === 'length');
    expect(check?.passed).toBe(false);
    expect(check?.reason).toContain('too long');
  });

  it('passes at exactly min_output_length (edge: boundary inclusive)', () => {
    // 20 chars exactly, trimmed — no escalation signals in alphanumeric text
    const output = 'abcdefghijklmnopqrst';
    const result = runQualityGate(output, withConfig({ min_output_length: 20, max_output_length: 10000 }));
    const check = result.all_checks.find(c => c.name === 'length');
    expect(check?.passed).toBe(true);
  });

  it('passes at exactly max_output_length (edge: boundary inclusive)', () => {
    // Use a custom max_output_length equal to CLEAN_OUTPUT's trimmed length (93 chars).
    // CLEAN_OUTPUT has no escalation signals so the gate checks run normally.
    const output = CLEAN_OUTPUT;
    const result = runQualityGate(output, withConfig({ min_output_length: 20, max_output_length: 93 }));
    const check = result.all_checks.find(c => c.name === 'length');
    expect(check?.passed).toBe(true);
  });

  it('length check uses trimmed length (leading/trailing whitespace ignored)', () => {
    // Wrap CLEAN_OUTPUT (93 chars) in whitespace; set min to 500 so it still fails length
    const output = '   ' + CLEAN_OUTPUT + '   ';
    const result = runQualityGate(output, withConfig({ min_output_length: 500, max_output_length: 10000 }));
    const check = result.all_checks.find(c => c.name === 'length');
    expect(check?.passed).toBe(false);
    expect(check?.reason).toContain('too short');
  });
});

// ── Soft Gates ────────────────────────────────────────────────────────────────

describe('Soft gate: no_hedging', () => {
  it('passes when there is no hedging language', () => {
    const result = runQualityGate(CLEAN_OUTPUT, makeOptions());
    const check = result.all_checks.find(c => c.name === 'no_hedging');
    expect(check?.passed).toBe(true);
    expect(check?.hard).toBe(false);
  });

  it('passes when there are exactly 2 hedging instances (threshold is 3)', () => {
    const output = 'I think this approach works well. Maybe there are alternatives, but this is solid and it is complete.';
    const result = runQualityGate(output, makeOptions());
    const check = result.all_checks.find(c => c.name === 'no_hedging');
    expect(check?.passed).toBe(true);
  });

  it('soft-fails when there are 3 or more hedging instances', () => {
    const output = 'I think this could possibly work. Maybe it is correct. Perhaps it might even be the right approach.';
    const result = runQualityGate(output, makeOptions());
    const check = result.all_checks.find(c => c.name === 'no_hedging');
    expect(check?.passed).toBe(false);
    expect(check?.hard).toBe(false);
    expect(check?.reason).toContain('Excessive hedging');
  });

  it('no_hedging failure produces a soft_failure, not a hard_failure', () => {
    const output = 'I think this could possibly work. Maybe it is correct. Perhaps it might even be the right approach.';
    const result = runQualityGate(output, makeOptions());
    expect(result.soft_failures.some(c => c.name === 'no_hedging')).toBe(true);
    expect(result.hard_failures.some(c => c.name === 'no_hedging')).toBe(false);
  });

  it('hedging check is case-insensitive', () => {
    const output = 'I THINK this is fine. MAYBE we proceed. POSSIBLY it will work. Done.';
    const result = runQualityGate(output, makeOptions());
    const check = result.all_checks.find(c => c.name === 'no_hedging');
    expect(check?.passed).toBe(false);
  });
});

describe('Soft gate: proportionality', () => {
  it('passes when no expectedOutputTokens are provided', () => {
    const result = runQualityGate(CLEAN_OUTPUT, makeOptions());
    const check = result.all_checks.find(c => c.name === 'proportionality');
    expect(check?.passed).toBe(true);
  });

  it('passes when actual token count is proportional to expected', () => {
    // Build ~400 chars from varied unique sentences (≈100 tokens); expected 100 → ratio 1.0.
    // No single 50+ char substring repeats 3+ times, so the repetition-loop escalation does not fire.
    const output = [
      'The router correctly dispatches requests to the right handler based on the path.',
      'All error boundaries are in place and have been verified by the test suite.',
      'The configuration is loaded from disk and merged with the built-in defaults.',
      'Token savings are calculated per completion and persisted to the metrics log.',
      'Health checks run on startup and report the Ollama availability to the hook.',
    ].join(' ');
    const result = runQualityGate(output, makeOptions({ expectedOutputTokens: 100 }));
    const check = result.all_checks.find(c => c.name === 'proportionality');
    expect(check?.passed).toBe(true);
  });

  it('soft-fails when output is disproportionately short (< 20% of expected)', () => {
    // 20 chars ≈ 5 tokens; expected 200 → ratio 0.025 (below 0.2 threshold)
    const output = 'Short answer only ok.';
    const result = runQualityGate(output, makeOptions({ expectedOutputTokens: 200 }));
    const check = result.all_checks.find(c => c.name === 'proportionality');
    expect(check?.passed).toBe(false);
    expect(check?.reason).toContain('disproportionately short');
    expect(check?.hard).toBe(false);
  });

  it('soft-fails when output is disproportionately long (> 500% of expected)', () => {
    // CLEAN_OUTPUT is 93 chars → ceil(93/4) = 24 tokens.
    // With expectedOutputTokens=4, ratio = 24/4 = 6.0 → above the 5.0 threshold.
    // CLEAN_OUTPUT has no escalation signals, so the full gate pipeline runs.
    const result = runQualityGate(CLEAN_OUTPUT, makeOptions({ expectedOutputTokens: 4 }));
    const check = result.all_checks.find(c => c.name === 'proportionality');
    expect(check?.passed).toBe(false);
    expect(check?.reason).toContain('disproportionately long');
    expect(check?.hard).toBe(false);
  });

  it('proportionality failure produces a soft_failure, not a hard_failure', () => {
    const output = 'Short answer only.  ';
    const result = runQualityGate(output, makeOptions({ expectedOutputTokens: 500 }));
    expect(result.soft_failures.some(c => c.name === 'proportionality')).toBe(true);
    expect(result.hard_failures.some(c => c.name === 'proportionality')).toBe(false);
  });
});

// ── Integration ───────────────────────────────────────────────────────────────

describe('Integration: escalation short-circuit', () => {
  it('empty output sets should_escalate and skips all gate checks', () => {
    const result = runQualityGate('', makeOptions());
    expect(result.should_escalate).toBe(true);
    expect(result.accepted).toBe(false);
    // Short-circuit means only the synthetic escalation_signals check is present
    expect(result.all_checks).toHaveLength(1);
    expect(result.all_checks[0].name).toBe('escalation_signals');
  });

  it('refusal output sets should_escalate', () => {
    const output = 'As an AI, I cannot help with that request at all.';
    const result = runQualityGate(output, makeOptions());
    expect(result.should_escalate).toBe(true);
    expect(result.accepted).toBe(false);
  });

  it('repetition loop sets should_escalate', () => {
    const chunk = 'function greet() { console.log("hello wonderful world"); } ';
    const looped = chunk.repeat(5);
    const result = runQualityGate(looped, makeOptions());
    expect(result.should_escalate).toBe(true);
    expect(result.accepted).toBe(false);
  });

  it('should_retry is false when should_escalate is true via short-circuit', () => {
    const result = runQualityGate('', makeOptions());
    expect(result.should_retry).toBe(false);
  });
});

describe('Integration: retry logic', () => {
  it('only soft failures set should_retry to true and accepted to false', () => {
    // Trigger hedging soft-fail only; output must be long enough and otherwise clean
    const output = [
      'I think the implementation is fine.',
      'Maybe there is a better approach.',
      'Perhaps this could be optimized later.',
      'The function is complete and ready for review.',
    ].join(' ');
    const result = runQualityGate(output, makeOptions());
    expect(result.hard_failures).toHaveLength(0);
    expect(result.soft_failures.length).toBeGreaterThan(0);
    expect(result.should_retry).toBe(true);
    expect(result.should_escalate).toBe(false);
    expect(result.accepted).toBe(false);
  });

  it('hard failure alongside soft failure sets should_escalate, not should_retry', () => {
    // Hard fail: output too short (below custom min of 500).
    // Soft fail: hedging language present (3+ instances).
    // Use CLEAN_OUTPUT with hedging prepended — long enough to pass empty_output
    // escalation (> 10 chars) but below the 500-char minimum.
    const output = 'I think this might possibly be good enough. ' + CLEAN_OUTPUT;
    const result = runQualityGate(output, withConfig({ min_output_length: 500, max_output_length: 10000 }));
    expect(result.should_escalate).toBe(true);
    expect(result.should_retry).toBe(false);
  });

  it('accepted is true when all checks pass', () => {
    const result = runQualityGate(CLEAN_OUTPUT, makeOptions());
    expect(result.accepted).toBe(true);
    expect(result.should_retry).toBe(false);
    expect(result.should_escalate).toBe(false);
  });

  it('checks_passed and checks_total are consistent', () => {
    const result = runQualityGate(CLEAN_OUTPUT, makeOptions());
    expect(result.checks_total).toBe(result.all_checks.length);
    expect(result.checks_passed).toBe(result.all_checks.filter(c => c.passed).length);
  });
});

describe('Integration: config toggles', () => {
  it('disabling check_completeness skips the completeness check', () => {
    const output = 'The result is TODO: finish this implementation properly now.';
    const result = runQualityGate(output, withConfig({ check_completeness: false }));
    const check = result.all_checks.find(c => c.name === 'completeness');
    expect(check).toBeUndefined();
    // Should not be treated as a hard failure from completeness
    expect(result.hard_failures.some(c => c.name === 'completeness')).toBe(false);
  });

  it('disabling check_hedging skips the no_hedging check', () => {
    const output = [
      'I think this is fine.',
      'Maybe there is a better approach.',
      'Perhaps this could be optimized later.',
      'The function is complete and ready.',
    ].join(' ');
    const result = runQualityGate(output, withConfig({ check_hedging: false }));
    const check = result.all_checks.find(c => c.name === 'no_hedging');
    expect(check).toBeUndefined();
  });

  it('disabling check_code_parse skips the code_parse check', () => {
    const output = 'function broken() { if (true) { if (true) { if (true) { and it is all fine.';
    const result = runQualityGate(output, withConfig({ check_code_parse: false }));
    const check = result.all_checks.find(c => c.name === 'code_parse');
    expect(check).toBeUndefined();
  });

  it('disabling check_proportionality skips the proportionality check', () => {
    // 20 chars / 4 = 5 tokens; expected 500 → ratio 0.01 would normally soft-fail
    const output = 'Short answer only ok.';
    const result = runQualityGate(
      output,
      makeOptions({
        expectedOutputTokens: 500,
        config: { ...DEFAULT_GATE_CONFIG, check_proportionality: false },
      }),
    );
    const check = result.all_checks.find(c => c.name === 'proportionality');
    expect(check).toBeUndefined();
  });
});
