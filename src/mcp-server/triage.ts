import { ollamaChat } from './health.js';
import { loadConfig } from './config.js';

export interface TriageResult {
  category: string;
  level: number;
  confidence: number;
}

/**
 * JSON schema sent to Ollama's `format` field for structured output.
 * Ollama validates output against this, guaranteeing parseable JSON.
 */
const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    category: {
      type: 'string',
      enum: ['TRIVIAL', 'SIMPLE', 'MODERATE', 'COMPLEX', 'EXPERT'],
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
    },
  },
  required: ['category'],
};

const TRIAGE_PROMPT = `Classify this coding task into exactly one category. Return JSON with "category" and "confidence" (0-1).

Categories:
- TRIVIAL: docstrings, comments, formatting, renaming, simple regex
- SIMPLE: type definitions, test scaffolding, format conversion, explanations
- MODERATE: utility functions, single-file refactoring, CRUD endpoints, configs
- COMPLEX: multi-file changes, architecture decisions, debugging, optimization
- EXPERT: system design, security analysis, novel algorithms, major migrations

Task: {task_description}`;

const CATEGORY_TO_LEVEL: Record<string, number> = {
  trivial: 1,
  simple: 2,
  moderate: 3,
  complex: 5,
  expert: 6,
};

interface TriageJson {
  category?: string;
  confidence?: number;
}

export async function triageWithLocalModel(taskDescription: string): Promise<TriageResult> {
  const config = loadConfig();
  const triageModel = config.routing.triage_model ?? config.ollama.default_model;
  const prompt = TRIAGE_PROMPT.replace('{task_description}', taskDescription);

  try {
    const result = await ollamaChat(prompt, {
      model: triageModel,
      temperature: 0.1,
      max_tokens: 60,
      timeoutMs: 5000,
      format: TRIAGE_SCHEMA,
    });

    // Try structured JSON parse first
    const parsed = parseTriageJson(result.response);
    if (parsed) {
      return parsed;
    }

    // Fallback: substring matching for models that ignore format
    const category = parseTriageText(result.response.trim().toLowerCase());
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

function parseTriageJson(response: string): TriageResult | null {
  try {
    const json = JSON.parse(response) as TriageJson;
    const rawCategory = (json.category ?? '').toLowerCase();
    if (!(rawCategory in CATEGORY_TO_LEVEL)) return null;

    const modelConfidence = typeof json.confidence === 'number'
      ? Math.min(1, Math.max(0, json.confidence))
      : 0.7;

    // Clamp model-reported confidence: don't trust <0.3 or >0.95
    const confidence = Math.min(0.95, Math.max(0.3, modelConfidence));

    return {
      category: rawCategory,
      level: CATEGORY_TO_LEVEL[rawCategory],
      confidence,
    };
  } catch {
    return null;
  }
}

function parseTriageText(response: string): string {
  const categories = ['trivial', 'simple', 'moderate', 'complex', 'expert'];
  for (const cat of categories) {
    if (response.includes(cat)) {
      return cat;
    }
  }
  return 'unknown';
}
