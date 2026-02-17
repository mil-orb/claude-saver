export type FailureSignal =
  | 'empty_output'
  | 'refusal'
  | 'syntax_error'
  | 'hallucinated_imports'
  | 'incomplete'
  | 'repetition_loop'
  | 'wrong_language'
  | 'confidence_caveat'
  | 'placeholder_markers';

export interface EscalationResult {
  accept: boolean;
  signals: FailureSignal[];
  severity: 'none' | 'minor' | 'major';
  escalation_context?: string;
}

const CRITICAL_SIGNALS: Set<FailureSignal> = new Set([
  'empty_output', 'refusal', 'repetition_loop',
]);

export function detectFailureSignals(
  output: string,
  expectedLanguage?: string
): FailureSignal[] {
  const signals: FailureSignal[] = [];

  // Empty or near-empty output
  if (output.trim().length < 10) {
    signals.push('empty_output');
    return signals; // No point checking further
  }

  // Refusal patterns
  if (/as an ai|i cannot|i'm not able|i can't help|i apologize but/i.test(output)) {
    signals.push('refusal');
  }

  // Repetition loop — same 50+ char substring repeated 3+ times
  if (/(.{50,})\1{2,}/.test(output)) {
    signals.push('repetition_loop');
  }

  // Incomplete output (cuts off mid-statement)
  const trimmed = output.trim();
  if (
    trimmed.endsWith('...') ||
    (trimmed.split('{').length - trimmed.split('}').length > 2) ||
    (trimmed.split('(').length - trimmed.split(')').length > 2)
  ) {
    signals.push('incomplete');
  }

  // Wrong language detection
  if (expectedLanguage) {
    const langMismatch = detectWrongLanguage(output, expectedLanguage);
    if (langMismatch) signals.push('wrong_language');
  }

  // Excessive hedging
  const hedgeCount = (output.match(/\b(i think|maybe|possibly|not sure|might|perhaps|i believe)\b/gi) ?? []).length;
  if (hedgeCount >= 3) {
    signals.push('confidence_caveat');
  }

  // Placeholder markers
  if (/\b(TODO|TBD|FIXME|PLACEHOLDER|XXX|HACK)\b/.test(output)) {
    signals.push('placeholder_markers');
  }

  // Basic syntax error detection for common languages
  if (expectedLanguage && hasObviousSyntaxErrors(output, expectedLanguage)) {
    signals.push('syntax_error');
  }

  return signals;
}

export function evaluateEscalation(signals: FailureSignal[]): EscalationResult {
  if (signals.length === 0) {
    return { accept: true, signals: [], severity: 'none' };
  }

  const hasCritical = signals.some(s => CRITICAL_SIGNALS.has(s));

  if (hasCritical || signals.length >= 2) {
    return {
      accept: false,
      signals,
      severity: 'major',
      escalation_context: `Local model failed: ${signals.join(', ')}`,
    };
  }

  // Single minor signal — accept with warning
  return {
    accept: true,
    signals,
    severity: 'minor',
  };
}

function detectWrongLanguage(output: string, expected: string): boolean {
  const langIndicators: Record<string, RegExp[]> = {
    python: [/\bdef\s+\w+\(/, /\bimport\s+\w+/, /\bclass\s+\w+:/, /^\s*#.*$/m],
    javascript: [/\bfunction\s+\w+\(/, /\bconst\s+\w+\s*=/, /=>\s*\{/, /\brequire\(/],
    typescript: [/:\s*(string|number|boolean)\b/, /\binterface\s+/, /\btype\s+\w+\s*=/],
    java: [/\bpublic\s+(class|static|void)/, /System\.out\.print/],
    go: [/\bfunc\s+\w+\(/, /\bpackage\s+\w+/, /\bfmt\.\w+/],
    rust: [/\bfn\s+\w+\(/, /\blet\s+mut\s+/, /\bimpl\s+/],
  };

  const expectedLower = expected.toLowerCase();
  const otherLanguages = Object.keys(langIndicators).filter(l => l !== expectedLower);

  for (const lang of otherLanguages) {
    const indicators = langIndicators[lang];
    if (!indicators) continue;
    const matchCount = indicators.filter(r => r.test(output)).length;
    if (matchCount >= 2) {
      // Check if expected language is also present
      const expectedIndicators = langIndicators[expectedLower];
      if (expectedIndicators) {
        const expectedMatchCount = expectedIndicators.filter(r => r.test(output)).length;
        if (expectedMatchCount < matchCount) return true;
      }
    }
  }

  return false;
}

function hasObviousSyntaxErrors(output: string, language: string): boolean {
  // Extract code blocks if present
  const codeMatch = output.match(/```[\w]*\n([\s\S]*?)```/);
  const code = codeMatch ? codeMatch[1] : output;

  switch (language.toLowerCase()) {
    case 'python':
      // Mismatched indentation is hard to detect, but unmatched parens/brackets are clear
      return hasUnmatchedBrackets(code);

    case 'javascript':
    case 'typescript':
      return hasUnmatchedBrackets(code) || hasUnmatchedBraces(code);

    case 'json':
      try { JSON.parse(code); return false; } catch { return true; }

    default:
      return hasUnmatchedBrackets(code) || hasUnmatchedBraces(code);
  }
}

export function hasUnmatchedBrackets(code: string): boolean {
  let parens = 0, brackets = 0;
  for (const ch of code) {
    if (ch === '(') parens++;
    if (ch === ')') parens--;
    if (ch === '[') brackets++;
    if (ch === ']') brackets--;
    if (parens < -2 || brackets < -2) return true;
  }
  return Math.abs(parens) > 2 || Math.abs(brackets) > 2;
}

export function hasUnmatchedBraces(code: string): boolean {
  let braces = 0;
  for (const ch of code) {
    if (ch === '{') braces++;
    if (ch === '}') braces--;
    if (braces < -2) return true;
  }
  return Math.abs(braces) > 2;
}
