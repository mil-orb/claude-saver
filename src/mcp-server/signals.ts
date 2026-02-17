import type { CostOfWrong } from './patterns.js';

export type Scope = 'function' | 'file' | 'module' | 'system';
export type OutputType = 'code_gen' | 'code_mod' | 'analysis' | 'text' | 'data_transform';
export type Novelty = 'boilerplate' | 'known_pattern' | 'adaptation' | 'novel';
export type Reversibility = 'easy_undo' | 'needs_review' | 'hard_to_reverse';

export interface TaskSignals {
  files_referenced: number;
  estimated_context_tokens: number;
  scope: Scope;
  reasoning_depth: number;
  requires_tool_chain: boolean;
  output_type: OutputType;
  novelty: Novelty;
  cost_of_wrong: CostOfWrong;
  reversibility: Reversibility;
  language_familiarity: number;
  has_examples: boolean;
  has_tests: boolean;
}

// Language familiarity for local models (higher = better local model performance)
const LANGUAGE_FAMILIARITY: Record<string, number> = {
  python: 0.9, javascript: 0.85, typescript: 0.85, java: 0.8,
  go: 0.75, rust: 0.6, cpp: 0.65, c: 0.65, csharp: 0.7,
  ruby: 0.7, php: 0.7, swift: 0.55, kotlin: 0.65,
  sql: 0.8, html: 0.9, css: 0.85, bash: 0.75, shell: 0.75,
  yaml: 0.9, json: 0.95, markdown: 0.9, toml: 0.85,
};

export function extractSignals(taskDescription: string): TaskSignals {
  const lower = taskDescription.toLowerCase();

  return {
    files_referenced: countFilesReferenced(lower),
    estimated_context_tokens: estimateContextTokens(lower),
    scope: inferScope(lower),
    reasoning_depth: computeReasoningDepth(lower),
    requires_tool_chain: detectToolChain(lower),
    output_type: inferOutputType(lower),
    novelty: inferNovelty(lower),
    cost_of_wrong: inferCostOfWrong(lower),
    reversibility: inferReversibility(lower),
    language_familiarity: detectLanguageFamiliarity(lower),
    has_examples: detectExamples(lower),
    has_tests: detectTests(lower),
  };
}

function countFilesReferenced(text: string): number {
  // Count file paths, @mentions, and file-like references
  const filePatterns = [
    /\b[\w/.-]+\.\w{1,5}\b/g,       // file.ext patterns
    /@[\w/.-]+/g,                     // @file mentions
    /`[^`]*\.\w{1,5}`/g,             // backtick file refs
  ];

  const matches = new Set<string>();
  for (const pattern of filePatterns) {
    const found = text.match(pattern) ?? [];
    found.forEach(m => matches.add(m));
  }
  return matches.size;
}

function estimateContextTokens(text: string): number {
  const fileCount = countFilesReferenced(text);
  // Rough estimate: ~500 tokens per referenced file
  return fileCount * 500;
}

function inferScope(text: string): Scope {
  if (/across the (codebase|project|repo)|entire (codebase|project)|all files|everywhere/i.test(text)) {
    return 'system';
  }
  if (/this module|this package|this directory|multiple files|several files/i.test(text)) {
    return 'module';
  }
  if (/this file|single file|in this file|the file/i.test(text)) {
    return 'file';
  }
  return 'function';
}

function computeReasoningDepth(text: string): number {
  let depth = 0;

  // Multi-step indicators
  const stepWords = (text.match(/\b(then|next|after that|followed by|finally|first|second|third)\b/g) ?? []).length;
  depth += Math.min(stepWords * 0.15, 0.45);

  // Conditional language
  const conditionals = (text.match(/\b(if|unless|when|while|depending|consider|ensure|make sure)\b/g) ?? []).length;
  depth += Math.min(conditionals * 0.1, 0.3);

  // Complex verb phrases
  if (/analyze.*then.*refactor/i.test(text)) depth += 0.2;
  if (/debug.*fix.*test/i.test(text)) depth += 0.2;
  if (/understand.*implement/i.test(text)) depth += 0.15;

  // Question complexity
  if (/\bwhy\b/i.test(text)) depth += 0.1;
  if (/\bhow.*should\b/i.test(text)) depth += 0.15;

  return Math.min(depth, 1.0);
}

function detectToolChain(text: string): boolean {
  // Only trigger on patterns indicating iterative fix cycles, not simple "fix X" requests.
  // "fix indentation" or "fix the typo" are trivial — "debug and fix until tests pass" is iterative.
  return /\b(make it work|until|iterate|keep trying|back and forth|test.*fix|fix.*test|debug.*fix|try.*different)\b/i.test(text);
}

function inferOutputType(text: string): OutputType {
  if (/\b(convert|format|transform|parse|serialize|deserialize|json|yaml|csv)\b/i.test(text)) {
    return 'data_transform';
  }
  if (/\b(explain|summarize|analyze|review|describe|what does)\b/i.test(text)) {
    return 'analysis';
  }
  if (/\b(refactor|rename|move|extract|inline|modify|update|change|fix)\b/i.test(text)) {
    return 'code_mod';
  }
  if (/\b(docstring|comment|readme|documentation|message|note|changelog)\b/i.test(text)) {
    return 'text';
  }
  return 'code_gen';
}

function inferNovelty(text: string): Novelty {
  if (/\b(boilerplate|template|scaffold|skeleton|stub|placeholder)\b/i.test(text)) {
    return 'boilerplate';
  }
  if (/\b(crud|rest|api endpoint|config|env|setup|init)\b/i.test(text)) {
    return 'known_pattern';
  }
  if (/\b(novel|unique|custom|from scratch|new approach|innovative)\b/i.test(text)) {
    return 'novel';
  }
  if (/\b(adapt|modify|extend|customize|adjust|tweak)\b/i.test(text)) {
    return 'adaptation';
  }
  return 'known_pattern';
}

function inferCostOfWrong(text: string): CostOfWrong {
  if (/\b(security|auth|password|credential|secret|encrypt|vulnerability|production deploy)\b/i.test(text)) {
    return 'critical';
  }
  if (/\b(database migration|schema change|deploy|infrastructure|payment|billing)\b/i.test(text)) {
    return 'high';
  }
  if (/\b(refactor|api change|interface change|breaking change|public api)\b/i.test(text)) {
    return 'medium';
  }
  if (/\b(test|doc|comment|format|style|lint|readme)\b/i.test(text)) {
    return 'trivial';
  }
  return 'low';
}

function inferReversibility(text: string): Reversibility {
  if (/\b(migration|deploy|publish|release|delete|drop|remove.*permanently)\b/i.test(text)) {
    return 'hard_to_reverse';
  }
  if (/\b(refactor|rename across|change api|modify interface)\b/i.test(text)) {
    return 'needs_review';
  }
  return 'easy_undo';
}

function detectLanguageFamiliarity(text: string): number {
  for (const [lang, score] of Object.entries(LANGUAGE_FAMILIARITY)) {
    if (text.includes(lang)) return score;
  }
  // Check for common file extensions
  const extMatch = text.match(/\.(?:py|js|ts|go|rs|java|rb|php|c|cpp|cs)\b/);
  if (extMatch) {
    const extMap: Record<string, string> = {
      '.py': 'python', '.js': 'javascript', '.ts': 'typescript',
      '.go': 'go', '.rs': 'rust', '.java': 'java', '.rb': 'ruby',
      '.php': 'php', '.c': 'c', '.cpp': 'cpp', '.cs': 'csharp',
    };
    const lang = extMap[extMatch[0]];
    if (lang) return LANGUAGE_FAMILIARITY[lang] ?? 0.5;
  }
  return 0.5; // Default middle-ground
}

function detectExamples(text: string): boolean {
  return /\b(example|like this|such as|e\.g\.|for instance|similar to|pattern:)\b/i.test(text);
}

function detectTests(text: string): boolean {
  return /\b(test exists|has tests|test file|spec file|test suite|coverage)\b/i.test(text);
}

// Complexity scoring
export function computeComplexityScore(signals: TaskSignals): number {
  const scopeWeights: Record<Scope, number> = {
    function: 0.1, file: 0.3, module: 0.6, system: 0.9,
  };
  const noveltyWeights: Record<Novelty, number> = {
    boilerplate: 0.0, known_pattern: 0.1, adaptation: 0.4, novel: 0.8,
  };
  const costWeights: Record<CostOfWrong, number> = {
    trivial: 0.0, low: 0.1, medium: 0.3, high: 0.6, critical: 0.9,
  };

  let score = 0;
  score += scopeWeights[signals.scope];
  score += signals.reasoning_depth;
  score += signals.requires_tool_chain ? 0.3 : 0;
  score += noveltyWeights[signals.novelty];
  score += costWeights[signals.cost_of_wrong];

  // Context size penalty (ramps up with token count)
  const contextRatio = signals.estimated_context_tokens / 32000; // 32K default context
  score += Math.min(contextRatio * 0.5, 0.4);

  // Language bonus
  score -= signals.language_familiarity * 0.1;

  // Example/test bonus
  if (signals.has_examples) score -= 0.1;
  if (signals.has_tests) score -= 0.1;

  return Math.max(0, Math.min(1, score));
}

// Map score to complexity level
export function scoreToLevel(score: number): number {
  if (score < 0.15) return 1;
  if (score < 0.30) return 2;
  if (score < 0.50) return 3;
  if (score < 0.65) return 4; // Ambiguous zone
  if (score < 0.80) return 5;
  return 6;
}
