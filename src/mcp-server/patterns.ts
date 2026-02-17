export type Route = 'no_llm' | 'local' | 'cloud' | 'cloud_recommended';
export type CostOfWrong = 'trivial' | 'low' | 'medium' | 'high' | 'critical';

export interface PatternRule {
  patterns: string[];
  route: Route;
  level: number;
  confidence: number;
  cost_of_wrong: CostOfWrong;
  category?: string;
}

export interface PatternMatch {
  matched: true;
  rule: PatternRule;
  matchedPattern: string;
  confidence: number;
}

export interface PatternNoMatch {
  matched: false;
}

export type PatternResult = PatternMatch | PatternNoMatch;

export const STATIC_PATTERNS: PatternRule[] = [
  // ═══════════════════════════════════════════════════════════
  // TIER 0 — NO LLM NEEDED (Level 0)
  // ═══════════════════════════════════════════════════════════
  {
    patterns: ['list files', 'show directory', 'project structure',
      'folder structure', 'what files', 'tree'],
    route: 'no_llm', level: 0, confidence: 0.95, cost_of_wrong: 'trivial',
    category: 'filesystem',
  },
  {
    patterns: ['file size', 'line count', 'how many lines', 'how many files',
      'disk usage', 'file type', 'permissions', 'file exists'],
    route: 'no_llm', level: 0, confidence: 0.95, cost_of_wrong: 'trivial',
    category: 'filesystem',
  },
  {
    patterns: ['git status', 'git log', 'what changed', 'recent commits',
      'which files changed', 'git diff names', 'branch list'],
    route: 'no_llm', level: 0, confidence: 0.90, cost_of_wrong: 'trivial',
    category: 'filesystem',
  },
  {
    patterns: ['what does this import', 'show imports', 'show exports',
      'function signatures', 'list functions', 'list classes'],
    route: 'no_llm', level: 0, confidence: 0.85, cost_of_wrong: 'trivial',
    category: 'filesystem',
  },

  // ═══════════════════════════════════════════════════════════
  // LEVEL 1 — MICRO LOCAL MODEL (1-3B)
  // ═══════════════════════════════════════════════════════════
  {
    patterns: ['write docstring', 'add docstrings', 'document this function',
      'add jsdoc', 'add type hints', 'add comments'],
    route: 'local', level: 1, confidence: 0.90, cost_of_wrong: 'trivial',
    category: 'docs',
  },
  {
    patterns: ['commit message', 'changelog entry', 'pr description',
      'release notes', 'version bump'],
    route: 'local', level: 1, confidence: 0.90, cost_of_wrong: 'trivial',
    category: 'commit_messages',
  },
  {
    patterns: ['format this', 'fix indentation', 'sort imports',
      'fix whitespace', 'convert tabs to spaces', 'prettier'],
    route: 'local', level: 1, confidence: 0.95, cost_of_wrong: 'trivial',
    category: 'formatting',
  },
  {
    patterns: ['simple regex', 'write a regex', 'regex for',
      'regular expression for', 'glob pattern for'],
    route: 'local', level: 1, confidence: 0.85, cost_of_wrong: 'low',
    category: 'codegen',
  },
  {
    patterns: ['rename variable', 'rename function', 'rename class',
      'find and replace'],
    route: 'local', level: 1, confidence: 0.85, cost_of_wrong: 'low',
    category: 'refactor',
  },

  // ═══════════════════════════════════════════════════════════
  // LEVEL 2 — SMALL LOCAL MODEL (7-8B)
  // ═══════════════════════════════════════════════════════════
  {
    patterns: ['convert json to yaml', 'convert yaml to json', 'csv to json',
      'convert format', 'parse this', 'serialize', 'deserialize'],
    route: 'local', level: 2, confidence: 0.90, cost_of_wrong: 'low',
    category: 'formatting',
  },
  {
    patterns: ['explain this function', 'what does this do', 'explain this code',
      'summarize this file', 'what is this class for'],
    route: 'local', level: 2, confidence: 0.85, cost_of_wrong: 'trivial',
    category: 'analysis',
  },
  {
    patterns: ['write a unit test for', 'add test for', 'test scaffold',
      'mock this', 'create fixture', 'test template'],
    route: 'local', level: 2, confidence: 0.80, cost_of_wrong: 'low',
    category: 'tests',
  },
  {
    patterns: ['add error handling', 'add try catch', 'add validation',
      'add input validation', 'null check'],
    route: 'local', level: 2, confidence: 0.80, cost_of_wrong: 'low',
    category: 'codegen',
  },
  {
    patterns: ['create interface', 'create type', 'type definition',
      'create enum', 'create model', 'create schema'],
    route: 'local', level: 2, confidence: 0.85, cost_of_wrong: 'low',
    category: 'codegen',
  },

  // ═══════════════════════════════════════════════════════════
  // LEVEL 3 — MEDIUM LOCAL MODEL (12-32B)
  // ═══════════════════════════════════════════════════════════
  {
    patterns: ['crud endpoint', 'rest api endpoint', 'create route',
      'api handler', 'express route', 'fastapi endpoint'],
    route: 'local', level: 3, confidence: 0.80, cost_of_wrong: 'medium',
    category: 'codegen',
  },
  {
    patterns: ['implement function', 'write function', 'utility function',
      'helper function', 'create class'],
    route: 'local', level: 3, confidence: 0.70, cost_of_wrong: 'medium',
    category: 'codegen',
  },
  {
    patterns: ['simple refactor', 'extract function', 'extract method',
      'inline variable', 'simplify this'],
    route: 'local', level: 3, confidence: 0.70, cost_of_wrong: 'medium',
    category: 'refactor',
  },
  {
    patterns: ['add logging', 'add metrics', 'add monitoring',
      'add telemetry', 'instrument'],
    route: 'local', level: 3, confidence: 0.80, cost_of_wrong: 'low',
    category: 'codegen',
  },
  {
    patterns: ['readme', 'documentation', 'api docs', 'usage example',
      'getting started guide'],
    route: 'local', level: 3, confidence: 0.85, cost_of_wrong: 'low',
    category: 'docs',
  },
  {
    patterns: ['dockerfile', 'docker compose', 'makefile', 'github action',
      'ci config', 'yaml config', 'terraform'],
    route: 'local', level: 3, confidence: 0.75, cost_of_wrong: 'medium',
    category: 'devops',
  },

  // ═══════════════════════════════════════════════════════════
  // CLOUD — LEVEL 5+ (Sonnet/Opus)
  // ═══════════════════════════════════════════════════════════
  {
    patterns: ['architect', 'system design', 'design pattern for',
      'how should i structure', 'best approach for'],
    route: 'cloud_recommended', level: 5, confidence: 0.80, cost_of_wrong: 'high',
    category: 'analysis',
  },
  {
    patterns: ['security audit', 'vulnerability', 'penetration test',
      'threat model', 'security review'],
    route: 'cloud_recommended', level: 5, confidence: 0.90, cost_of_wrong: 'critical',
    category: 'analysis',
  },
  {
    patterns: ['refactor entire', 'rewrite module', 'migrate from',
      'major refactor', 'redesign'],
    route: 'cloud_recommended', level: 5, confidence: 0.75, cost_of_wrong: 'high',
    category: 'refactor',
  },
  {
    patterns: ['optimize algorithm', 'performance optimization',
      'reduce complexity', 'big-o', 'time complexity'],
    route: 'cloud_recommended', level: 5, confidence: 0.70, cost_of_wrong: 'high',
    category: 'analysis',
  },
  {
    patterns: ['debug this', 'why is this failing', 'trace this bug',
      'root cause', 'investigate'],
    route: 'cloud_recommended', level: 5, confidence: 0.65, cost_of_wrong: 'high',
    category: 'analysis',
  },
];

export function matchPatterns(taskDescription: string): PatternResult {
  const lower = taskDescription.toLowerCase();

  for (const rule of STATIC_PATTERNS) {
    for (const pattern of rule.patterns) {
      if (lower.includes(pattern.toLowerCase())) {
        return {
          matched: true,
          rule,
          matchedPattern: pattern,
          confidence: rule.confidence,
        };
      }
    }
  }

  return { matched: false };
}
