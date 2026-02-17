import { loadConfig } from './config.js';

export const TASK_CATEGORIES = [
  'codegen',
  'docs',
  'tests',
  'refactor',
  'analysis',
  'commit_messages',
  'formatting',
  'devops',
  'vision',
] as const;

export type TaskCategory = typeof TASK_CATEGORIES[number];

// Model capability ladder — default model size per task complexity level
const CAPABILITY_LADDER: Record<number, { size: string; examples: string[] }> = {
  0: { size: 'none', examples: ['no model needed — pure filesystem ops'] },
  1: { size: '1b-3b', examples: ['llama3.2:1b', 'qwen3:1.7b', 'gemma3:1b'] },
  2: { size: '7b-8b', examples: ['qwen3:8b', 'llama3.2:8b', 'gemma3:4b'] },
  3: { size: '12b-32b', examples: ['qwen3:32b', 'deepseek-coder-v2:16b', 'codestral:22b'] },
  4: { size: '32b-70b', examples: ['qwen3:72b', 'llama3.3:70b', 'deepseek-coder-v2:33b'] },
  5: { size: 'cloud-sonnet', examples: ['claude-sonnet-4-5'] },
  6: { size: 'cloud-opus', examples: ['claude-opus-4-6'] },
};

// Category detection keywords
const CATEGORY_PATTERNS: Record<TaskCategory, string[]> = {
  codegen: ['implement', 'write function', 'create class', 'generate code', 'build', 'code for'],
  docs: ['docstring', 'documentation', 'readme', 'jsdoc', 'comment', 'explain'],
  tests: ['test', 'spec', 'assertion', 'mock', 'fixture', 'coverage'],
  refactor: ['refactor', 'rename', 'extract', 'inline', 'simplify', 'restructure'],
  analysis: ['review', 'analyze', 'audit', 'explain', 'summarize', 'find bugs'],
  commit_messages: ['commit message', 'changelog', 'pr description', 'release notes'],
  formatting: ['format', 'lint', 'indent', 'sort imports', 'prettier', 'convert'],
  devops: ['dockerfile', 'docker', 'ci', 'github action', 'makefile', 'terraform', 'deploy'],
  vision: ['screenshot', 'image', 'diagram', 'ui', 'visual', 'layout'],
};

export function detectCategory(taskDescription: string): TaskCategory | undefined {
  const lower = taskDescription.toLowerCase();

  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    for (const pattern of patterns) {
      if (lower.includes(pattern)) {
        return category as TaskCategory;
      }
    }
  }

  return undefined;
}

export function selectModel(
  taskComplexity: number,
  category?: TaskCategory
): { model: string | undefined; source: 'specialist' | 'ladder' | 'default' } {
  const config = loadConfig();

  // Check specialist mappings first
  if (category && config.specialist_models[category]) {
    return { model: config.specialist_models[category], source: 'specialist' };
  }

  // Fall back to capability ladder
  const ladderEntry = CAPABILITY_LADDER[taskComplexity];
  if (ladderEntry && ladderEntry.size !== 'none' && !ladderEntry.size.startsWith('cloud')) {
    // Don't override — let the default model handle it
    // The ladder is informational for the user; we use the configured default
    return { model: undefined, source: 'ladder' };
  }

  return { model: undefined, source: 'default' };
}

export function getCapabilityLadder(): Record<number, { size: string; examples: string[] }> {
  return { ...CAPABILITY_LADDER };
}
