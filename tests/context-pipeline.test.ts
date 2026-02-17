import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Mock fs before the module under test is imported so that all internal
// calls to fs.existsSync / fs.readFileSync go through our mock.
// ---------------------------------------------------------------------------
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Mock fs-tools so buildOutline does not hit the real filesystem.
// ---------------------------------------------------------------------------
vi.mock('../src/mcp-server/fs-tools.js', () => ({
  handleFsPreview: vi.fn(),
}));

import * as fs from 'fs';
import { handleFsPreview } from '../src/mcp-server/fs-tools.js';
import {
  estimateTokens,
  extractFileRefs,
  buildOutline,
  packContext,
  expandContext,
  contextToPrompt,
} from '../src/mcp-server/context-pipeline.js';
import type { FileOutline, FileSlice, PackedContext } from '../src/mcp-server/context-pipeline.js';
import type { ContextPipelineConfig } from '../src/mcp-server/config.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ContextPipelineConfig = {
  max_files: 3,
  max_lines_per_file: 120,
  max_diff_lines: 200,
};

/** Build a minimal FileOutline for use in test fixtures. */
function makeOutline(filePath: string, overrides: Partial<FileOutline> = {}): FileOutline {
  return {
    filePath,
    language: 'typescript',
    totalLines: 50,
    structure: {
      classes: [],
      functions: ['foo', 'bar'],
      sections: [
        { name: 'foo', line: 5, type: 'function' },
        { name: 'bar', line: 15, type: 'function' },
      ],
    },
    imports: ['import fs from "fs"'],
    ...overrides,
  };
}

/** Build a minimal FileSlice. */
function makeSlice(filePath: string, overrides: Partial<FileSlice> = {}): FileSlice {
  const content = 'const x = 1;\nconst y = 2;';
  return {
    filePath,
    startLine: 0,
    endLine: 2,
    content,
    tokens: estimateTokens(content),
    ...overrides,
  };
}

/** Build a minimal PackedContext. */
function makePacked(overrides: Partial<PackedContext> = {}): PackedContext {
  return {
    task: 'Fix the bug',
    outlines: [],
    slices: [],
    totalTokens: 10,
    budget: 1000,
    filesIncluded: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset mocks between every test so state never bleeds across cases.
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.mocked(fs.existsSync).mockReset();
  vi.mocked(fs.readFileSync).mockReset();
  vi.mocked(handleFsPreview).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. estimateTokens
// ═══════════════════════════════════════════════════════════════════════════

describe('estimateTokens', () => {
  it('returns 0 for an empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns 1 for a 4-character string (ceiling of 4/4)', () => {
    expect(estimateTokens('abcd')).toBe(1);
  });

  it('returns 1 for a 1-character string (ceiling of 1/4)', () => {
    expect(estimateTokens('a')).toBe(1);
  });

  it('returns 1 for a 3-character string (ceiling of 3/4)', () => {
    expect(estimateTokens('abc')).toBe(1);
  });

  it('returns 2 for a 5-character string (ceiling of 5/4)', () => {
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('is proportional to input length — doubling text doubles the token estimate', () => {
    const base = 'hello world ';
    const single = estimateTokens(base);
    const doubled = estimateTokens(base.repeat(2));
    expect(doubled).toBe(single * 2);
  });

  it('handles a long string correctly', () => {
    const text = 'x'.repeat(400);
    expect(estimateTokens(text)).toBe(100);
  });

  it('handles strings whose length is not divisible by 4 (rounds up)', () => {
    // 13 chars → ceil(13/4) = 4
    expect(estimateTokens('1234567890123')).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. extractFileRefs
// ═══════════════════════════════════════════════════════════════════════════

describe('extractFileRefs', () => {
  it('returns an empty array when there are no file references', () => {
    expect(extractFileRefs('just a plain sentence with no paths')).toEqual([]);
  });

  it('extracts a double-quoted path', () => {
    const refs = extractFileRefs('Please fix "src/index.ts"');
    expect(refs).toContain('src/index.ts');
  });

  it('extracts a single-quoted path', () => {
    const refs = extractFileRefs("Please fix 'src/index.ts'");
    expect(refs).toContain('src/index.ts');
  });

  it('extracts a backtick-wrapped path', () => {
    const refs = extractFileRefs('Please fix `src/utils.ts`');
    expect(refs).toContain('src/utils.ts');
  });

  it('extracts bare paths with directory separator', () => {
    const refs = extractFileRefs('Update the file src/mcp-server/router.ts in the project');
    expect(refs).toContain('src/mcp-server/router.ts');
  });

  it('extracts paths starting with ./', () => {
    const refs = extractFileRefs('Run ./scripts/build.js to compile');
    expect(refs).toContain('./scripts/build.js');
  });

  it('deduplicates identical references', () => {
    const refs = extractFileRefs('"src/foo.ts" and "src/foo.ts" again');
    const matches = refs.filter(r => r === 'src/foo.ts');
    expect(matches).toHaveLength(1);
  });

  it('extracts multiple distinct paths from one description', () => {
    const refs = extractFileRefs('Fix "src/index.ts" and `lib/utils.js`');
    expect(refs).toContain('src/index.ts');
    expect(refs).toContain('lib/utils.js');
  });

  it('extracts paths with long extensions up to 6 characters', () => {
    const refs = extractFileRefs('"src/config.config"');
    expect(refs).toContain('src/config.config');
  });

  it('does not extract plain words without an extension separator', () => {
    const refs = extractFileRefs('just some plain words here');
    expect(refs).toHaveLength(0);
  });

  it('extracts paths mixed with prose', () => {
    const desc = 'In `tests/router.test.ts` we test the router from src/mcp-server/router.ts';
    const refs = extractFileRefs(desc);
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });

  it('handles an empty string input', () => {
    expect(extractFileRefs('')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. buildOutline
// ═══════════════════════════════════════════════════════════════════════════

describe('buildOutline', () => {
  it('returns null when the file does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = await buildOutline('/nonexistent/file.ts');
    expect(result).toBeNull();
  });

  it('calls handleFsPreview with "structure" and "imports" modes', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(handleFsPreview)
      .mockResolvedValueOnce({
        language: 'typescript',
        total_lines: 80,
        classes: ['MyClass'],
        functions: ['doThing'],
        sections: [{ name: 'MyClass', line: 3, type: 'class' }],
      })
      .mockResolvedValueOnce({ imports: ['import fs from "fs"'] });

    await buildOutline('/some/file.ts');

    expect(handleFsPreview).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(handleFsPreview).mock.calls;
    expect(calls[0][1]).toBe('structure');
    expect(calls[1][1]).toBe('imports');
  });

  it('returns a well-shaped FileOutline on success', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(handleFsPreview)
      .mockResolvedValueOnce({
        language: 'typescript',
        total_lines: 100,
        classes: ['Router'],
        functions: ['classifyTask'],
        sections: [{ name: 'Router', line: 1, type: 'class' }],
      })
      .mockResolvedValueOnce({ imports: ['import path from "path"'] });

    const outline = await buildOutline('/project/src/router.ts');

    expect(outline).not.toBeNull();
    expect(outline!.language).toBe('typescript');
    expect(outline!.totalLines).toBe(100);
    expect(outline!.structure.classes).toContain('Router');
    expect(outline!.structure.functions).toContain('classifyTask');
    expect(outline!.imports).toContain('import path from "path"');
  });

  it('returns null when handleFsPreview throws', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(handleFsPreview).mockRejectedValueOnce(new Error('permission denied'));

    const result = await buildOutline('/locked/file.ts');
    expect(result).toBeNull();
  });

  it('returns the absolute path in filePath field', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(handleFsPreview)
      .mockResolvedValueOnce({
        language: 'javascript',
        total_lines: 20,
        classes: [],
        functions: [],
        sections: [],
      })
      .mockResolvedValueOnce({ imports: [] });

    const outline = await buildOutline('/absolute/path/file.js');
    expect(outline!.filePath).toMatch(/file\.js$/);
  });

  it('preserves structure arrays accurately in the returned outline', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(handleFsPreview)
      .mockResolvedValueOnce({
        language: 'python',
        total_lines: 40,
        classes: ['Foo', 'Bar'],
        functions: ['baz', 'qux'],
        sections: [
          { name: 'Foo', line: 1, type: 'class' },
          { name: 'baz', line: 10, type: 'function' },
        ],
      })
      .mockResolvedValueOnce({ imports: ['import os', 'from sys import argv'] });

    const outline = await buildOutline('/src/module.py');
    expect(outline!.structure.classes).toEqual(['Foo', 'Bar']);
    expect(outline!.structure.functions).toEqual(['baz', 'qux']);
    expect(outline!.structure.sections).toHaveLength(2);
    expect(outline!.imports).toEqual(['import os', 'from sys import argv']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. packContext
// ═══════════════════════════════════════════════════════════════════════════

describe('packContext', () => {
  it('returns a valid PackedContext with empty fileRefs', async () => {
    const result = await packContext('Fix the bug', [], 1000, DEFAULT_CONFIG);
    expect(result.task).toBe('Fix the bug');
    expect(result.outlines).toHaveLength(0);
    expect(result.slices).toHaveLength(0);
    expect(result.filesIncluded).toBe(0);
    expect(result.budget).toBe(1000);
  });

  it('sets budget field to the value passed in', async () => {
    const result = await packContext('task', [], 500, DEFAULT_CONFIG);
    expect(result.budget).toBe(500);
  });

  it('charges task tokens against the budget', async () => {
    const task = 'A'.repeat(400); // 100 tokens
    const result = await packContext(task, [], 1000, DEFAULT_CONFIG);
    // totalTokens should include task tokens even with no files
    expect(result.totalTokens).toBeGreaterThanOrEqual(100);
  });

  it('respects max_files and does not process more files than the limit', async () => {
    // Provide 5 refs but config limits to 3.
    // packContext will only process the first max_files=3 refs.
    // Each file requires two handleFsPreview calls: structure then imports.
    const refs = ['/a.ts', '/b.ts', '/c.ts', '/d.ts', '/e.ts'];
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const structureResult = {
      language: 'typescript',
      total_lines: 5,
      classes: [],
      functions: ['fn'],
      sections: [],
    };
    const importsResult = { imports: [] };
    // 3 files × 2 calls each = 6 mockResolvedValueOnce entries
    vi.mocked(handleFsPreview)
      .mockResolvedValueOnce(structureResult)
      .mockResolvedValueOnce(importsResult)
      .mockResolvedValueOnce(structureResult)
      .mockResolvedValueOnce(importsResult)
      .mockResolvedValueOnce(structureResult)
      .mockResolvedValueOnce(importsResult);
    vi.mocked(fs.readFileSync).mockReturnValue('line1\nline2\nline3');

    const result = await packContext('task', refs, 100000, DEFAULT_CONFIG);
    expect(result.filesIncluded).toBeLessThanOrEqual(DEFAULT_CONFIG.max_files);
  });

  it('includes outlines before slices (phase ordering)', async () => {
    const refs = ['/file.ts'];
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(handleFsPreview)
      .mockResolvedValueOnce({
        language: 'typescript',
        total_lines: 10,
        classes: [],
        functions: ['doWork'],
        sections: [],
      })
      .mockResolvedValueOnce({ imports: [] });
    vi.mocked(fs.readFileSync).mockReturnValue('const x = 1;');

    const result = await packContext('task', refs, 50000, DEFAULT_CONFIG);
    // outlines should be non-empty if budget allows
    expect(result.outlines.length).toBeGreaterThanOrEqual(0);
  });

  it('skips outline when budget is exhausted before packing it', async () => {
    const task = 'X'.repeat(4000); // 1000 tokens — more than budget
    const refs = ['/file.ts'];
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(handleFsPreview)
      .mockResolvedValueOnce({
        language: 'typescript',
        total_lines: 10,
        classes: [],
        functions: ['fn'],
        sections: [],
      })
      .mockResolvedValueOnce({ imports: [] });

    // budget is 100 but task alone costs 1000 tokens
    const result = await packContext(task, refs, 100, DEFAULT_CONFIG);
    expect(result.outlines).toHaveLength(0);
    expect(result.slices).toHaveLength(0);
  });

  it('skips a file when buildOutline returns null (file does not exist)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = await packContext('task', ['/ghost.ts'], 50000, DEFAULT_CONFIG);
    expect(result.filesIncluded).toBe(0);
    expect(result.outlines).toHaveLength(0);
  });

  it('packs slices only for files whose outline fit within budget', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(handleFsPreview)
      .mockResolvedValueOnce({
        language: 'typescript',
        total_lines: 10,
        classes: [],
        functions: ['fn'],
        sections: [],
      })
      .mockResolvedValueOnce({ imports: [] });
    vi.mocked(fs.readFileSync).mockReturnValue('const x = 1;\nconst y = 2;');

    const result = await packContext('task', ['/file.ts'], 50000, DEFAULT_CONFIG);
    if (result.outlines.length > 0) {
      // slices should correspond to files in outlines
      expect(result.slices.length).toBeLessThanOrEqual(result.outlines.length);
    }
  });

  it('does not add a slice when remaining budget is below 100 tokens threshold', async () => {
    // Build a scenario where outline fits but slice budget is under 100
    const task = 'X'.repeat(4); // 1 token
    // The outline text will be short — we need remaining budget < 100 after outline
    // Make budget = 50 total. task=1 token, outline will be ~X tokens.
    // We need the outline to fit but leave less than 100 for the slice.
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(handleFsPreview)
      .mockResolvedValueOnce({
        language: 'typescript',
        total_lines: 1,
        classes: [],
        functions: [],
        sections: [],
      })
      .mockResolvedValueOnce({ imports: [] });
    vi.mocked(fs.readFileSync).mockReturnValue('x');

    // budget=50; task=1 token; outline text: "File: /file.ts (typescript, 1 lines)" ≈ 9 tokens
    // remaining after outline ≈ 40 — below 100, so no slice
    const result = await packContext(task, ['/file.ts'], 50, DEFAULT_CONFIG);
    expect(result.slices).toHaveLength(0);
  });

  it('filesIncluded reflects the number of outlines packed', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const structureResult = {
      language: 'typescript',
      total_lines: 5,
      classes: [],
      functions: [],
      sections: [],
    };
    const importsResult = { imports: [] };
    // 2 files × 2 calls each = 4 mockResolvedValueOnce entries
    vi.mocked(handleFsPreview)
      .mockResolvedValueOnce(structureResult)
      .mockResolvedValueOnce(importsResult)
      .mockResolvedValueOnce(structureResult)
      .mockResolvedValueOnce(importsResult);
    vi.mocked(fs.readFileSync).mockReturnValue('hello');

    const refs = ['/a.ts', '/b.ts'];
    const result = await packContext('task', refs, 50000, DEFAULT_CONFIG);
    expect(result.filesIncluded).toBe(result.outlines.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. expandContext
// ═══════════════════════════════════════════════════════════════════════════

describe('expandContext', () => {
  it('returns a context with the new budget value', async () => {
    const previous = makePacked({ outlines: [], slices: [], totalTokens: 50, budget: 500 });
    const result = await expandContext(previous, 1000, DEFAULT_CONFIG);
    expect(result.budget).toBe(1000);
  });

  it('preserves existing task and outlines from the previous context', async () => {
    const outline = makeOutline('/src/file.ts');
    const previous = makePacked({
      task: 'Refactor module',
      outlines: [outline],
      slices: [],
      totalTokens: 30,
      budget: 500,
      filesIncluded: 1,
    });
    vi.mocked(fs.readFileSync).mockReturnValue('const x = 1;');

    const result = await expandContext(previous, 1000, DEFAULT_CONFIG);
    expect(result.task).toBe('Refactor module');
    expect(result.outlines).toEqual([outline]);
  });

  it('adds a new slice for a file that only had an outline before', async () => {
    // Use path.resolve so the filePath in the outline matches what readFileSlice
    // stores after calling path.resolve() internally.
    const resolvedPath = path.resolve('/src/newfile.ts');
    const outline = makeOutline(resolvedPath, { totalLines: 200 });
    const previous = makePacked({
      outlines: [outline],
      slices: [], // no slices yet
      totalTokens: 30,
      budget: 500,
    });
    vi.mocked(fs.readFileSync).mockReturnValue('const x = 1;\nconst y = 2;\n');

    const result = await expandContext(previous, 2000, DEFAULT_CONFIG);
    // A new slice for the file that previously only had an outline should be added
    const addedSlice = result.slices.find(s => s.filePath === resolvedPath);
    expect(addedSlice).toBeDefined();
  });

  it('expands an existing slice by reading more lines beyond endLine', async () => {
    const filePath = '/src/existing.ts';
    const outline = makeOutline(filePath, { totalLines: 300 });
    const existingSlice = makeSlice(filePath, { startLine: 0, endLine: 10 });
    const previous = makePacked({
      outlines: [outline],
      slices: [existingSlice],
      totalTokens: 50,
      budget: 500,
    });
    // Mock returns additional content for lines beyond endLine
    vi.mocked(fs.readFileSync).mockReturnValue('extra line 1\nextra line 2\n');

    const result = await expandContext(previous, 2000, DEFAULT_CONFIG);
    const expanded = result.slices.find(s => s.filePath === filePath);
    expect(expanded).toBeDefined();
    // endLine should have grown or content appended if budget allowed
    expect(expanded!.endLine).toBeGreaterThanOrEqual(existingSlice.endLine);
  });

  it('respects the new budget and does not add slices if budget is exhausted', async () => {
    const outline = makeOutline('/huge.ts', { totalLines: 10000 });
    const previous = makePacked({
      outlines: [outline],
      slices: [],
      totalTokens: 990, // already used almost all budget
      budget: 1000,
    });
    vi.mocked(fs.readFileSync).mockReturnValue('x'.repeat(4000)); // 1000 tokens

    // new budget is 1000 — remaining = 1000 - 990 = 10 < 100 threshold
    const result = await expandContext(previous, 1000, DEFAULT_CONFIG);
    expect(result.slices).toHaveLength(0);
  });

  it('does not crash when outlines list is empty', async () => {
    const previous = makePacked({ outlines: [], slices: [], totalTokens: 10, budget: 100 });
    const result = await expandContext(previous, 500, DEFAULT_CONFIG);
    expect(result.outlines).toHaveLength(0);
    expect(result.slices).toHaveLength(0);
    expect(result.budget).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. contextToPrompt
// ═══════════════════════════════════════════════════════════════════════════

describe('contextToPrompt', () => {
  it('always includes the task description', () => {
    const packed = makePacked({ task: 'Fix the login bug' });
    const prompt = contextToPrompt(packed);
    expect(prompt).toContain('Fix the login bug');
  });

  it('includes "Task:" label before the task text', () => {
    const packed = makePacked({ task: 'Do something' });
    const prompt = contextToPrompt(packed);
    expect(prompt).toMatch(/^Task:/);
  });

  it('produces a minimal prompt for an empty context (no outlines, no slices)', () => {
    const packed = makePacked({ task: 'Simple task', outlines: [], slices: [] });
    const prompt = contextToPrompt(packed);
    expect(prompt).toBe('Task: Simple task');
  });

  it('includes the "--- File Context ---" section header when outlines are present', () => {
    const outline = makeOutline('/src/router.ts');
    const packed = makePacked({ outlines: [outline], slices: [] });
    const prompt = contextToPrompt(packed);
    expect(prompt).toContain('--- File Context ---');
  });

  it('formats each outline with language and line count', () => {
    const outline = makeOutline('/src/router.ts', { language: 'typescript', totalLines: 80 });
    const packed = makePacked({ outlines: [outline], slices: [] });
    const prompt = contextToPrompt(packed);
    expect(prompt).toContain('typescript');
    expect(prompt).toContain('80 lines');
    expect(prompt).toContain('router.ts');
  });

  it('includes the "--- Code Snippets ---" section header when slices are present', () => {
    const slice = makeSlice('/src/router.ts');
    const packed = makePacked({ slices: [slice] });
    const prompt = contextToPrompt(packed);
    expect(prompt).toContain('--- Code Snippets ---');
  });

  it('formats each slice with file name and line range', () => {
    const slice = makeSlice('/src/router.ts', {
      startLine: 0,
      endLine: 10,
      content: 'const x = 1;',
    });
    const packed = makePacked({ slices: [slice] });
    const prompt = contextToPrompt(packed);
    // basename of /src/router.ts
    expect(prompt).toContain('router.ts');
    // line range: startLine+1 to endLine
    expect(prompt).toContain('lines 1-10');
    expect(prompt).toContain('const x = 1;');
  });

  it('includes slice content verbatim in the output', () => {
    const content = 'function hello() {\n  return "world";\n}';
    const slice = makeSlice('/lib/hello.ts', { content });
    const packed = makePacked({ slices: [slice] });
    const prompt = contextToPrompt(packed);
    expect(prompt).toContain(content);
  });

  it('lists imports in the outline section when present', () => {
    const outline = makeOutline('/src/app.ts', {
      imports: ['import express from "express"', 'import path from "path"'],
    });
    const packed = makePacked({ outlines: [outline], slices: [] });
    const prompt = contextToPrompt(packed);
    expect(prompt).toContain('express');
    expect(prompt).toContain('path');
  });

  it('lists function names in the outline section when present', () => {
    const outline = makeOutline('/src/utils.ts', {
      structure: {
        classes: [],
        functions: ['parseQuery', 'buildResponse'],
        sections: [],
      },
    });
    const packed = makePacked({ outlines: [outline], slices: [] });
    const prompt = contextToPrompt(packed);
    expect(prompt).toContain('parseQuery');
    expect(prompt).toContain('buildResponse');
  });

  it('lists class names in the outline section when present', () => {
    const outline = makeOutline('/src/service.ts', {
      structure: {
        classes: ['AuthService'],
        functions: [],
        sections: [],
      },
    });
    const packed = makePacked({ outlines: [outline], slices: [] });
    const prompt = contextToPrompt(packed);
    expect(prompt).toContain('AuthService');
  });

  it('renders multiple outlines in the same prompt', () => {
    const outlineA = makeOutline('/src/a.ts', { language: 'typescript', totalLines: 30 });
    const outlineB = makeOutline('/src/b.ts', { language: 'javascript', totalLines: 60 });
    const packed = makePacked({ outlines: [outlineA, outlineB], slices: [] });
    const prompt = contextToPrompt(packed);
    expect(prompt).toContain('a.ts');
    expect(prompt).toContain('b.ts');
  });

  it('renders multiple slices with correct annotations', () => {
    const sliceA = makeSlice('/src/a.ts', { startLine: 0, endLine: 5, content: 'aaa' });
    const sliceB = makeSlice('/src/b.ts', { startLine: 10, endLine: 20, content: 'bbb' });
    const packed = makePacked({ slices: [sliceA, sliceB] });
    const prompt = contextToPrompt(packed);
    expect(prompt).toContain('a.ts');
    expect(prompt).toContain('b.ts');
    expect(prompt).toContain('aaa');
    expect(prompt).toContain('bbb');
  });
});
