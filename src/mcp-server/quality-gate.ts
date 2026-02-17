import {
  detectFailureSignals,
  evaluateEscalation,
  hasUnmatchedBrackets,
  hasUnmatchedBraces,
  type FailureSignal,
} from './escalation.js';
import type { QualityGateConfig } from './config.js';

export interface GateCheck {
  name: string;
  passed: boolean;
  reason?: string;
  hard: boolean;
}

export interface QualityGateResult {
  accepted: boolean;
  hard_failures: GateCheck[];
  soft_failures: GateCheck[];
  all_checks: GateCheck[];
  checks_passed: number;
  checks_total: number;
  should_retry: boolean;
  should_escalate: boolean;
  failure_signals: FailureSignal[];
}

export interface GateOptions {
  config: QualityGateConfig;
  expectedLanguage?: string;
  allowedFiles?: string[];
  requiredSections?: string[];
  expectedOutputTokens?: number;
}

// ── Hard Gates (any failure → escalate) ──

function checkCompleteness(output: string): GateCheck {
  const markers = /\b(TODO|TBD|FIXME|PLACEHOLDER|XXX)\b/;
  const match = output.match(markers);
  return {
    name: 'completeness',
    passed: !match,
    reason: match ? `Found placeholder marker: ${match[0]}` : undefined,
    hard: true,
  };
}

function checkCodeParse(output: string): GateCheck {
  // Extract code blocks if present
  const codeMatch = output.match(/```[\w]*\n([\s\S]*?)```/);
  const code = codeMatch ? codeMatch[1] : output;

  const bracketIssue = hasUnmatchedBrackets(code);
  const braceIssue = hasUnmatchedBraces(code);

  return {
    name: 'code_parse',
    passed: !bracketIssue && !braceIssue,
    reason: bracketIssue ? 'Unmatched brackets' : braceIssue ? 'Unmatched braces' : undefined,
    hard: true,
  };
}

function checkScopeCompliance(output: string, allowedFiles?: string[]): GateCheck {
  if (!allowedFiles || allowedFiles.length === 0) {
    return { name: 'scope_compliance', passed: true, hard: true };
  }

  // Extract file references from the output
  const fileRefs = output.match(/(?:["'`])?(?:\.\/|[\w-]+\/)+[\w.-]+\.\w{1,6}(?:["'`])?/g) ?? [];
  const normalized = fileRefs.map(r => r.replace(/["'`]/g, ''));
  const allowedSet = new Set(allowedFiles.map(f => f.replace(/\\/g, '/')));

  const outOfScope = normalized.filter(ref => {
    const norm = ref.replace(/\\/g, '/');
    return !allowedSet.has(norm) && ![...allowedSet].some(a => norm.endsWith(a) || a.endsWith(norm));
  });

  return {
    name: 'scope_compliance',
    passed: outOfScope.length === 0,
    reason: outOfScope.length > 0 ? `Files outside scope: ${outOfScope.join(', ')}` : undefined,
    hard: true,
  };
}

function checkRequiredSections(output: string, requiredSections?: string[]): GateCheck {
  if (!requiredSections || requiredSections.length === 0) {
    return { name: 'required_sections', passed: true, hard: true };
  }

  const missing = requiredSections.filter(section => {
    const pattern = new RegExp(`\\b${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return !pattern.test(output);
  });

  return {
    name: 'required_sections',
    passed: missing.length === 0,
    reason: missing.length > 0 ? `Missing sections: ${missing.join(', ')}` : undefined,
    hard: true,
  };
}

function checkLength(output: string, minLength: number, maxLength: number): GateCheck {
  const len = output.trim().length;
  if (len < minLength) {
    return { name: 'length', passed: false, reason: `Output too short: ${len} chars (min ${minLength})`, hard: true };
  }
  if (len > maxLength) {
    return { name: 'length', passed: false, reason: `Output too long: ${len} chars (max ${maxLength})`, hard: true };
  }
  return { name: 'length', passed: true, hard: true };
}

// ── Soft Gates (failure → retry, then escalate) ──

function checkNoHedging(output: string): GateCheck {
  const hedgePatterns = /\b(i think|maybe|possibly|not sure|might|perhaps|i believe|could be|it seems)\b/gi;
  const matches = output.match(hedgePatterns) ?? [];

  return {
    name: 'no_hedging',
    passed: matches.length < 3,
    reason: matches.length >= 3 ? `Excessive hedging: ${matches.length} instances` : undefined,
    hard: false,
  };
}

function checkProportionality(output: string, expectedTokens?: number): GateCheck {
  if (!expectedTokens || expectedTokens <= 0) {
    return { name: 'proportionality', passed: true, hard: false };
  }

  const actualTokens = Math.ceil(output.length / 4);
  const ratio = actualTokens / expectedTokens;

  // Too short (< 20% of expected) or too long (> 500% of expected)
  if (ratio < 0.2) {
    return { name: 'proportionality', passed: false, reason: `Output disproportionately short: ${actualTokens} tokens vs ${expectedTokens} expected`, hard: false };
  }
  if (ratio > 5) {
    return { name: 'proportionality', passed: false, reason: `Output disproportionately long: ${actualTokens} tokens vs ${expectedTokens} expected`, hard: false };
  }

  return { name: 'proportionality', passed: true, hard: false };
}

// ── Core ──

export function runQualityGate(output: string, options: GateOptions): QualityGateResult {
  const { config, expectedLanguage, allowedFiles, requiredSections, expectedOutputTokens } = options;

  // Run existing escalation detection first
  const failureSignals = detectFailureSignals(output, expectedLanguage);
  const escalation = evaluateEscalation(failureSignals);

  // If escalation already rejects, short-circuit
  if (!escalation.accept && escalation.severity === 'major') {
    return {
      accepted: false,
      hard_failures: [{ name: 'escalation_signals', passed: false, reason: escalation.escalation_context, hard: true }],
      soft_failures: [],
      all_checks: [{ name: 'escalation_signals', passed: false, reason: escalation.escalation_context, hard: true }],
      checks_passed: 0,
      checks_total: 1,
      should_retry: false,
      should_escalate: true,
      failure_signals: failureSignals,
    };
  }

  const allChecks: GateCheck[] = [];

  // Hard gates
  if (config.check_completeness) {
    allChecks.push(checkCompleteness(output));
  }
  if (config.check_code_parse) {
    allChecks.push(checkCodeParse(output));
  }
  if (config.check_scope) {
    allChecks.push(checkScopeCompliance(output, allowedFiles));
  }
  allChecks.push(checkRequiredSections(output, requiredSections));
  allChecks.push(checkLength(output, config.min_output_length, config.max_output_length));

  // Soft gates
  if (config.check_hedging) {
    allChecks.push(checkNoHedging(output));
  }
  if (config.check_proportionality) {
    allChecks.push(checkProportionality(output, expectedOutputTokens));
  }

  const hardFailures = allChecks.filter(c => c.hard && !c.passed);
  const softFailures = allChecks.filter(c => !c.hard && !c.passed);
  const passed = allChecks.filter(c => c.passed).length;

  const hasHardFailure = hardFailures.length > 0;
  const hasSoftFailure = softFailures.length > 0;

  return {
    accepted: !hasHardFailure && !hasSoftFailure,
    hard_failures: hardFailures,
    soft_failures: softFailures,
    all_checks: allChecks,
    checks_passed: passed,
    checks_total: allChecks.length,
    should_retry: !hasHardFailure && hasSoftFailure,
    should_escalate: hasHardFailure,
    failure_signals: failureSignals,
  };
}
