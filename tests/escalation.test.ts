import { describe, it, expect } from 'vitest';
import { detectFailureSignals, evaluateEscalation } from '../src/mcp-server/escalation.js';

describe('Escalation (Layer 4)', () => {
  describe('detectFailureSignals', () => {
    it('detects empty output', () => {
      const signals = detectFailureSignals('');
      expect(signals).toContain('empty_output');
    });

    it('detects near-empty output', () => {
      const signals = detectFailureSignals('   ok   ');
      expect(signals).toContain('empty_output');
    });

    it('detects refusal', () => {
      const signals = detectFailureSignals('As an AI language model, I cannot help with that request.');
      expect(signals).toContain('refusal');
    });

    it('detects AI refusal variants', () => {
      const signals = detectFailureSignals("I'm not able to generate code for that purpose.");
      expect(signals).toContain('refusal');
    });

    it('detects repetition loop', () => {
      const chunk = 'function hello() { console.log("hello world greeting"); } ';
      const repeatedContent = chunk.repeat(5);
      const signals = detectFailureSignals(repeatedContent);
      expect(signals).toContain('repetition_loop');
    });

    it('detects incomplete output with unmatched braces', () => {
      const signals = detectFailureSignals('function hello() {\n  const x = {\n    a: 1,\n    b: {');
      expect(signals).toContain('incomplete');
    });

    it('detects excessive hedging', () => {
      const signals = detectFailureSignals('I think maybe this could possibly work, but I believe perhaps it might not be the best approach');
      expect(signals).toContain('confidence_caveat');
    });

    it('returns empty for good output', () => {
      const signals = detectFailureSignals('function add(a: number, b: number): number { return a + b; }');
      expect(signals).toHaveLength(0);
    });

    it('detects wrong language', () => {
      const pythonOutput = 'def hello():\n    print("hello")\n\nimport os\nclass Foo:\n    pass';
      const signals = detectFailureSignals(pythonOutput, 'javascript');
      expect(signals).toContain('wrong_language');
    });

    it('does not flag correct language', () => {
      const jsOutput = 'function hello() { console.log("hello"); }\nconst x = require("fs");';
      const signals = detectFailureSignals(jsOutput, 'javascript');
      expect(signals).not.toContain('wrong_language');
    });
  });

  describe('evaluateEscalation', () => {
    it('accepts output with no failures', () => {
      const result = evaluateEscalation([]);
      expect(result.accept).toBe(true);
      expect(result.severity).toBe('none');
    });

    it('accepts with warning for single minor signal', () => {
      const result = evaluateEscalation(['confidence_caveat']);
      expect(result.accept).toBe(true);
      expect(result.severity).toBe('minor');
    });

    it('rejects for critical signal', () => {
      const result = evaluateEscalation(['empty_output']);
      expect(result.accept).toBe(false);
      expect(result.severity).toBe('major');
    });

    it('rejects for refusal', () => {
      const result = evaluateEscalation(['refusal']);
      expect(result.accept).toBe(false);
      expect(result.severity).toBe('major');
    });

    it('rejects for 2+ signals', () => {
      const result = evaluateEscalation(['confidence_caveat', 'incomplete']);
      expect(result.accept).toBe(false);
      expect(result.severity).toBe('major');
      expect(result.escalation_context).toBeDefined();
    });

    it('includes escalation context on rejection', () => {
      const result = evaluateEscalation(['empty_output', 'refusal']);
      expect(result.escalation_context).toContain('empty_output');
      expect(result.escalation_context).toContain('refusal');
    });
  });
});
