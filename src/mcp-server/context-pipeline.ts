import * as fs from 'fs';
import * as path from 'path';
import { handleFsPreview } from './fs-tools.js';
import type { ContextPipelineConfig } from './config.js';

export interface FileOutline {
  filePath: string;
  language: string;
  totalLines: number;
  structure: {
    classes: string[];
    functions: string[];
    sections: Array<{ name: string; line: number; type: string }>;
  };
  imports: string[];
}

export interface FileSlice {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  tokens: number;
}

export interface PackedContext {
  task: string;
  outlines: FileOutline[];
  slices: FileSlice[];
  totalTokens: number;
  budget: number;
  filesIncluded: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function extractFileRefs(taskDescription: string): string[] {
  const refs = new Set<string>();

  // Quoted paths: "src/foo.ts" or 'src/foo.ts'
  const quotedPaths = taskDescription.match(/["'`]([^"'`\s]+\.\w{1,6})["'`]/g);
  if (quotedPaths) {
    for (const match of quotedPaths) {
      refs.add(match.replace(/["'`]/g, ''));
    }
  }

  // Bare file paths: word/word.ext (must have directory separator or start with ./)
  const barePaths = taskDescription.match(/(?:\.\/|[\w-]+\/)+[\w.-]+\.\w{1,6}/g);
  if (barePaths) {
    for (const match of barePaths) {
      refs.add(match);
    }
  }

  // Backtick-wrapped file names: `filename.ext`
  const backtickRefs = taskDescription.match(/`([^`\s]+\.\w{1,6})`/g);
  if (backtickRefs) {
    for (const match of backtickRefs) {
      refs.add(match.replace(/`/g, ''));
    }
  }

  return [...refs];
}

export async function buildOutline(filePath: string): Promise<FileOutline | null> {
  try {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) return null;

    const structureResult = await handleFsPreview(absPath, 'structure') as {
      language: string;
      total_lines: number;
      classes: string[];
      functions: string[];
      sections: Array<{ name: string; line: number; type: string }>;
    };

    const importsResult = await handleFsPreview(absPath, 'imports') as {
      imports: string[];
    };

    return {
      filePath: absPath,
      language: structureResult.language,
      totalLines: structureResult.total_lines,
      structure: {
        classes: structureResult.classes,
        functions: structureResult.functions,
        sections: structureResult.sections,
      },
      imports: importsResult.imports,
    };
  } catch {
    return null;
  }
}

function readFileSlice(filePath: string, startLine: number, maxLines: number): FileSlice | null {
  try {
    const absPath = path.resolve(filePath);
    const content = fs.readFileSync(absPath, 'utf-8');
    const lines = content.split('\n');
    const endLine = Math.min(startLine + maxLines, lines.length);
    const sliceContent = lines.slice(startLine, endLine).join('\n');

    return {
      filePath: absPath,
      startLine,
      endLine,
      content: sliceContent,
      tokens: estimateTokens(sliceContent),
    };
  } catch {
    return null;
  }
}

export async function packContext(
  task: string,
  fileRefs: string[],
  budget: number,
  pipelineConfig: ContextPipelineConfig
): Promise<PackedContext> {
  const maxFiles = Math.min(fileRefs.length, pipelineConfig.max_files);
  const taskTokens = estimateTokens(task);
  let remainingBudget = budget - taskTokens;

  const outlines: FileOutline[] = [];
  const slices: FileSlice[] = [];

  // Phase 1: Pack outlines first (cheapest, most informative)
  const filesToProcess = fileRefs.slice(0, maxFiles);
  for (const ref of filesToProcess) {
    if (remainingBudget <= 0) break;

    const outline = await buildOutline(ref);
    if (!outline) continue;

    const outlineText = formatOutline(outline);
    const outlineTokens = estimateTokens(outlineText);

    if (outlineTokens <= remainingBudget) {
      outlines.push(outline);
      remainingBudget -= outlineTokens;
    }
  }

  // Phase 2: Pack file slices with remaining budget
  for (const outline of outlines) {
    if (remainingBudget <= 100) break;

    const maxLines = pipelineConfig.max_lines_per_file;
    const slice = readFileSlice(outline.filePath, 0, maxLines);
    if (!slice) continue;

    if (slice.tokens <= remainingBudget) {
      slices.push(slice);
      remainingBudget -= slice.tokens;
    }
  }

  return {
    task,
    outlines,
    slices,
    totalTokens: budget - remainingBudget,
    budget,
    filesIncluded: outlines.length,
  };
}

export async function expandContext(
  previous: PackedContext,
  newBudget: number,
  pipelineConfig: ContextPipelineConfig
): Promise<PackedContext> {
  let remainingBudget = newBudget - previous.totalTokens;
  const expandedSlices = [...previous.slices];

  // Expand existing slices with more lines
  for (const outline of previous.outlines) {
    if (remainingBudget <= 100) break;

    const existingSlice = expandedSlices.find(s => s.filePath === outline.filePath);
    if (existingSlice) {
      // Read more lines beyond what we already have
      const additionalLines = Math.min(
        pipelineConfig.max_lines_per_file * 2,
        outline.totalLines
      );
      const expanded = readFileSlice(outline.filePath, existingSlice.endLine, additionalLines - existingSlice.endLine);
      if (expanded && expanded.tokens <= remainingBudget) {
        existingSlice.endLine = expanded.endLine;
        existingSlice.content += '\n' + expanded.content;
        existingSlice.tokens += expanded.tokens;
        remainingBudget -= expanded.tokens;
      }
    } else {
      // Add a new slice for files that only had outlines
      const maxLines = pipelineConfig.max_lines_per_file * 2;
      const slice = readFileSlice(outline.filePath, 0, maxLines);
      if (slice && slice.tokens <= remainingBudget) {
        expandedSlices.push(slice);
        remainingBudget -= slice.tokens;
      }
    }
  }

  return {
    ...previous,
    slices: expandedSlices,
    totalTokens: newBudget - remainingBudget,
    budget: newBudget,
  };
}

function formatOutline(outline: FileOutline): string {
  const parts: string[] = [
    `File: ${outline.filePath} (${outline.language}, ${outline.totalLines} lines)`,
  ];

  if (outline.imports.length > 0) {
    parts.push(`Imports: ${outline.imports.join(', ')}`);
  }

  if (outline.structure.classes.length > 0) {
    parts.push(`Classes: ${outline.structure.classes.join(', ')}`);
  }

  if (outline.structure.functions.length > 0) {
    parts.push(`Functions: ${outline.structure.functions.join(', ')}`);
  }

  return parts.join('\n');
}

export function contextToPrompt(packed: PackedContext): string {
  const parts: string[] = [];

  parts.push(`Task: ${packed.task}`);

  if (packed.outlines.length > 0) {
    parts.push('\n--- File Context ---');
    for (const outline of packed.outlines) {
      parts.push(formatOutline(outline));
    }
  }

  if (packed.slices.length > 0) {
    parts.push('\n--- Code Snippets ---');
    for (const slice of packed.slices) {
      const fileName = path.basename(slice.filePath);
      parts.push(`\n// ${fileName} (lines ${slice.startLine + 1}-${slice.endLine})`);
      parts.push(slice.content);
    }
  }

  return parts.join('\n');
}
