import { ollamaChat } from './health.js';
import { loadConfig } from './config.js';

export interface TriageResult {
  category: string;
  level: number;
  confidence: number;
}

const TRIAGE_PROMPT = `You are a task classifier. Classify the following coding task into exactly one category. Respond with ONLY the category name, nothing else.

Categories:
- TRIVIAL: docstrings, comments, formatting, renaming, simple regex
- SIMPLE: type definitions, test scaffolding, format conversion, explanations
- MODERATE: utility functions, single-file refactoring, CRUD endpoints, configs
- COMPLEX: multi-file changes, architecture decisions, debugging, optimization
- EXPERT: system design, security analysis, novel algorithms, major migrations

Task: {task_description}

Category:`;

const CATEGORY_TO_LEVEL: Record<string, number> = {
  trivial: 1,
  simple: 2,
  moderate: 3,
  complex: 5,
  expert: 6,
};

export async function triageWithLocalModel(taskDescription: string): Promise<TriageResult> {
  const config = loadConfig();
  const triageModel = config.routing.triage_model ?? config.ollama.default_model;
  const prompt = TRIAGE_PROMPT.replace('{task_description}', taskDescription);

  try {
    const result = await ollamaChat(prompt, {
      model: triageModel,
      temperature: 0.1,
      max_tokens: 20,
      timeoutMs: 5000,
    });

    const response = result.response.trim().toLowerCase();
    const category = parseTriageResponse(response);
    const level = CATEGORY_TO_LEVEL[category] ?? 3;

    return {
      category,
      level,
      confidence: category === 'unknown' ? 0.3 : 0.7,
    };
  } catch {
    // On failure, default to Level 3 (medium local)
    return {
      category: 'moderate',
      level: 3,
      confidence: 0.3,
    };
  }
}

function parseTriageResponse(response: string): string {
  // Extract the category from potentially messy output
  const categories = ['trivial', 'simple', 'moderate', 'complex', 'expert'];

  for (const cat of categories) {
    if (response.includes(cat)) {
      return cat;
    }
  }

  return 'unknown';
}
