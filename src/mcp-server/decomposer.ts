import { ollamaChat } from './health.js';
import { loadConfig } from './config.js';

export interface Subtask {
  id: string;
  description: string;
  estimated_level: number;
  depends_on: string[];
}

export interface DecompositionResult {
  decomposed: boolean;
  subtasks: Subtask[];
  reason: string;
}

const DECOMPOSE_PROMPT = `Break the following complex coding task into smaller, independent subtasks.
For each subtask, estimate its complexity on a scale of 1-5:
1 = trivial (docstring, rename)
2 = simple (test scaffold, format conversion)
3 = moderate (utility function, CRUD endpoint)
4 = complex (multi-file refactor)
5 = expert (architecture, security)

Output ONLY valid JSON in this format:
{"subtasks": [{"id": "1", "description": "...", "level": 2, "depends_on": []}]}

Task: {task_description}

JSON:`;

export async function decomposeTask(taskDescription: string): Promise<DecompositionResult> {
  const config = loadConfig();

  if (!config.routing.enable_decomposition) {
    return { decomposed: false, subtasks: [], reason: 'Decomposition disabled' };
  }

  try {
    const result = await ollamaChat(
      DECOMPOSE_PROMPT.replace('{task_description}', taskDescription),
      { temperature: 0.2, max_tokens: 1000, timeoutMs: 10000 }
    );

    const parsed = parseDecompositionResponse(result.response);
    if (parsed.length === 0) {
      return { decomposed: false, subtasks: [], reason: 'Could not decompose' };
    }

    if (parsed.length === 1) {
      return { decomposed: false, subtasks: [], reason: 'Task is atomic' };
    }

    return { decomposed: true, subtasks: parsed, reason: `Decomposed into ${parsed.length} subtasks` };
  } catch {
    return { decomposed: false, subtasks: [], reason: 'Decomposition failed' };
  }
}

function parseDecompositionResponse(response: string): Subtask[] {
  try {
    // Try to extract JSON from the response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const data = JSON.parse(jsonMatch[0]) as {
      subtasks?: Array<{
        id?: string;
        description?: string;
        level?: number;
        depends_on?: string[];
      }>;
    };

    if (!data.subtasks || !Array.isArray(data.subtasks)) return [];

    return data.subtasks
      .filter(s => s.description)
      .map((s, i) => ({
        id: s.id ?? String(i + 1),
        description: s.description ?? '',
        estimated_level: Math.min(Math.max(s.level ?? 3, 1), 6),
        depends_on: s.depends_on ?? [],
      }));
  } catch {
    return [];
  }
}
