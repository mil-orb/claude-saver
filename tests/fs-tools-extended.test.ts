import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleFs, handleFsPreview } from '../src/mcp-server/fs-tools.js';

// ─── Fixture setup ──────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));

  // Create directory structure:
  //   tmpDir/
  //     src/
  //       index.ts
  //       utils.ts
  //       helpers/
  //         format.ts
  //     config/
  //       settings.json
  //       package.json
  //     .hidden-dir/
  //       secret.txt
  //     .gitignore
  //     .env
  //     README.md
  //     node_modules/
  //       dep/
  //         index.js
  //     sample.py
  //     sample.go
  //     sample.rs

  fs.mkdirSync(path.join(tmpDir, 'src'));
  fs.mkdirSync(path.join(tmpDir, 'src', 'helpers'));
  fs.mkdirSync(path.join(tmpDir, 'config'));
  fs.mkdirSync(path.join(tmpDir, '.hidden-dir'));
  fs.mkdirSync(path.join(tmpDir, 'node_modules', 'dep'), { recursive: true });

  // src/index.ts — rich TypeScript file for preview tests
  fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), [
    'import { Router } from "express";',
    'import * as fs from "fs";',
    'const config = require("./config");',
    '',
    'export class AppServer {',
    '  private port: number;',
    '  constructor(port: number) { this.port = port; }',
    '}',
    '',
    'export abstract class BaseHandler {',
    '  abstract handle(): void;',
    '}',
    '',
    'export function startServer(port: number): void {',
    '  console.log("starting");',
    '}',
    '',
    'export async function stopServer(): Promise<void> {',
    '  console.log("stopping");',
    '}',
    '',
    'export const greet = (name: string) => `Hello ${name}`;',
    '',
    'const internal = (x: number) => x * 2;',
    '',
    'export default AppServer;',
    '',
  ].join('\n'));

  // src/utils.ts — additional TypeScript file
  fs.writeFileSync(path.join(tmpDir, 'src', 'utils.ts'), [
    'import path from "path";',
    '',
    'export function formatDate(d: Date): string {',
    '  return d.toISOString();',
    '}',
    '',
    'export const slugify = (s: string) => s.toLowerCase().replace(/ /g, "-");',
    '',
    'module.exports = { formatDate, slugify };',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(tmpDir, 'src', 'helpers', 'format.ts'), 'export function bold(s: string) { return `**${s}**`; }\n');

  // config files
  fs.writeFileSync(path.join(tmpDir, 'config', 'settings.json'), '{ "debug": true }\n');
  fs.writeFileSync(path.join(tmpDir, 'config', 'package.json'), '{ "name": "inner" }\n');

  // hidden files
  fs.writeFileSync(path.join(tmpDir, '.hidden-dir', 'secret.txt'), 'secret\n');
  fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules\n.env\n');
  fs.writeFileSync(path.join(tmpDir, '.env'), 'API_KEY=abc\n');

  // README with many lines for head-mode tests
  const readmeLines: string[] = [];
  for (let i = 1; i <= 50; i++) {
    readmeLines.push(`Line ${i} of the README file`);
  }
  fs.writeFileSync(path.join(tmpDir, 'README.md'), readmeLines.join('\n'));

  // node_modules file (should be skipped by find)
  fs.writeFileSync(path.join(tmpDir, 'node_modules', 'dep', 'index.js'), 'module.exports = {};\n');

  // Polyglot sample files for extToLanguage
  fs.writeFileSync(path.join(tmpDir, 'sample.py'), [
    'import os',
    'from pathlib import Path',
    '',
    'class Greeter:',
    '    def greet(self, name: str) -> str:',
    '        return f"Hello {name}"',
    '',
    'def main():',
    '    g = Greeter()',
    '    print(g.greet("world"))',
    '',
    'async def async_main():',
    '    pass',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(tmpDir, 'sample.go'), 'package main\n\nfunc main() {\n}\n');
  fs.writeFileSync(path.join(tmpDir, 'sample.rs'), 'pub async fn serve() {}\nfn helper() {}\n');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────────

/** Convert all backslashes to forward slashes for comparison */
function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

// ═════════════════════════════════════════════════════════════════
// Cross-platform path handling
// ═════════════════════════════════════════════════════════════════

describe('Cross-platform path handling', () => {
  it('handleFs stat works with forward slashes on any OS', async () => {
    const forwardSlashPath = tmpDir.replace(/\\/g, '/');
    const result = await handleFs('stat', forwardSlashPath, {}) as {
      name: string; type: string;
    };
    expect(result.name).toBe(path.basename(tmpDir));
    expect(result.type).toBe('directory');
  });

  it('handleFs stat works with the OS-native path separator', async () => {
    const nativePath = path.join(tmpDir, 'src', 'index.ts');
    const result = await handleFs('stat', nativePath, {}) as {
      name: string; type: string; size: string;
    };
    expect(result.name).toBe('index.ts');
    expect(result.type).toBe('file');
    expect(result.size).toBeTruthy();
  });

  it('handleFs tree returns entries with consistent separators', async () => {
    const result = await handleFs('tree', tmpDir, { depth: 2 }) as {
      name: string; type: string; children?: Array<{ name: string }>;
    };
    expect(result.type).toBe('directory');
    // Entry names should be basenames (no separators at all)
    if (result.children) {
      for (const child of result.children) {
        expect(child.name).not.toContain('/');
        expect(child.name).not.toContain('\\');
      }
    }
  });

  it('handleFs find returns relative paths regardless of input format', async () => {
    const forwardSlashPath = tmpDir.replace(/\\/g, '/');
    const result = await handleFs('find', forwardSlashPath, { pattern: '*.ts' }) as {
      matches: string[];
    };
    expect(result.matches.length).toBeGreaterThan(0);
    for (const m of result.matches) {
      // Relative paths should not start with the tmpDir
      expect(path.isAbsolute(m)).toBe(false);
    }
  });
});

// ═════════════════════════════════════════════════════════════════
// Tree operation edge cases
// ═════════════════════════════════════════════════════════════════

describe('Tree operation edge cases', () => {
  it('tree with depth 0 returns only the root entry (no children)', async () => {
    const result = await handleFs('tree', tmpDir, { depth: 0 }) as {
      name: string; type: string; children?: unknown[];
    };
    expect(result.name).toBe(path.basename(tmpDir));
    expect(result.type).toBe('directory');
    // depth 0 means currentDepth (0) is NOT < maxDepth (0), so no children
    expect(result.children).toBeUndefined();
  });

  it('tree with depth 1 returns immediate children only', async () => {
    const result = await handleFs('tree', tmpDir, { depth: 1 }) as {
      name: string; children?: Array<{ name: string; children?: unknown[] }>;
    };
    expect(result.children).toBeDefined();
    const childNames = result.children!.map((c) => c.name);
    // Should include visible directories and files
    expect(childNames).toContain('src');
    expect(childNames).toContain('config');
    expect(childNames).toContain('README.md');
    // depth 1: children of root are listed, but THEIR children are not expanded
    const srcChild = result.children!.find((c) => c.name === 'src');
    expect(srcChild).toBeDefined();
    // src at depth=1: currentDepth would be 1 which is NOT < maxDepth 1, so no children
    expect(srcChild!.children).toBeUndefined();
  });

  it('tree filters out dot-files except .gitignore', async () => {
    const result = await handleFs('tree', tmpDir, { depth: 1 }) as {
      children?: Array<{ name: string }>;
    };
    const childNames = result.children!.map((c) => c.name);
    expect(childNames).toContain('.gitignore');
    expect(childNames).not.toContain('.env');
    expect(childNames).not.toContain('.hidden-dir');
  });

  it('tree caps at 100 entries per directory', async () => {
    // Create a directory with 120 files
    const bigDir = path.join(tmpDir, 'big-dir');
    fs.mkdirSync(bigDir, { recursive: true });
    for (let i = 0; i < 120; i++) {
      fs.writeFileSync(path.join(bigDir, `file-${String(i).padStart(3, '0')}.txt`), '');
    }

    const result = await handleFs('tree', bigDir, { depth: 1 }) as {
      children?: Array<{ name: string }>;
    };
    expect(result.children).toBeDefined();
    expect(result.children!.length).toBeLessThanOrEqual(100);

    // Clean up the big directory
    fs.rmSync(bigDir, { recursive: true, force: true });
  });
});

// ═════════════════════════════════════════════════════════════════
// Find operation edge cases
// ═════════════════════════════════════════════════════════════════

describe('Find operation edge cases', () => {
  it('find with pattern "*.ts" matches TypeScript files', async () => {
    const result = await handleFs('find', tmpDir, { pattern: '*.ts' }) as {
      matches: string[];
    };
    expect(result.matches.length).toBeGreaterThanOrEqual(3); // index.ts, utils.ts, format.ts
    for (const m of result.matches) {
      expect(normalize(m)).toMatch(/\.ts$/);
    }
  });

  it('find with pattern "*.json" matches JSON files', async () => {
    const result = await handleFs('find', tmpDir, { pattern: '*.json' }) as {
      matches: string[];
    };
    expect(result.matches.length).toBeGreaterThanOrEqual(2); // settings.json, package.json
    for (const m of result.matches) {
      expect(normalize(m)).toMatch(/\.json$/);
    }
  });

  it('find skips node_modules directories', async () => {
    const result = await handleFs('find', tmpDir, { pattern: '*.js' }) as {
      matches: string[];
    };
    // node_modules/dep/index.js should NOT appear
    for (const m of result.matches) {
      expect(normalize(m)).not.toContain('node_modules');
    }
  });

  it('find respects maxDepth parameter', async () => {
    // depth 0 means only the root directory itself is scanned
    const shallow = await handleFs('find', tmpDir, { pattern: '*.ts', depth: 0 }) as {
      matches: string[];
    };
    // At depth 0, only direct children of tmpDir are checked.
    // src/index.ts is at depth 1, so it should NOT appear.
    for (const m of shallow.matches) {
      expect(normalize(m)).not.toContain('/');
    }

    // depth 1 should pick up src/*.ts but not src/helpers/*.ts
    const mid = await handleFs('find', tmpDir, { pattern: '*.ts', depth: 1 }) as {
      matches: string[];
    };
    const midNormalized = mid.matches.map(normalize);
    const hasDirectSrc = midNormalized.some((m) => m.startsWith('src/'));
    expect(hasDirectSrc).toBe(true);
    const hasDeepHelper = midNormalized.some((m) => m.includes('helpers/'));
    expect(hasDeepHelper).toBe(false);
  });

  it('find caps at 500 results', async () => {
    // The 500-cap check in findFiles fires when entering a new directory via
    // walk(). Within a single flat directory all entries are pushed without a
    // mid-loop cap check. So we need to spread files across many subdirectories
    // so that the guard `matches.length >= 500` triggers between walk() calls.
    const manyDir = path.join(tmpDir, 'many-files');
    fs.mkdirSync(manyDir, { recursive: true });
    // Create 60 subdirectories, each with 10 .dat files = 600 total
    for (let d = 0; d < 60; d++) {
      const sub = path.join(manyDir, `sub-${String(d).padStart(3, '0')}`);
      fs.mkdirSync(sub, { recursive: true });
      for (let f = 0; f < 10; f++) {
        fs.writeFileSync(path.join(sub, `item-${f}.dat`), '');
      }
    }

    const result = await handleFs('find', manyDir, { pattern: '*.dat', depth: 5 }) as {
      matches: string[];
    };
    expect(result.matches.length).toBeLessThanOrEqual(500);
    // Should have found some matches (at least a few hundred before the cap)
    expect(result.matches.length).toBeGreaterThan(0);

    fs.rmSync(manyDir, { recursive: true, force: true });
  });
});

// ═════════════════════════════════════════════════════════════════
// List operation
// ═════════════════════════════════════════════════════════════════

describe('List operation', () => {
  it('list returns entries with name, type, and size', async () => {
    const result = await handleFs('list', path.join(tmpDir, 'config'), {}) as {
      entries: Array<{ name: string; type: string; size: number }>;
    };
    expect(result.entries.length).toBe(2);
    for (const entry of result.entries) {
      expect(entry).toHaveProperty('name');
      expect(entry).toHaveProperty('type');
      expect(entry).toHaveProperty('size');
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.size).toBe('number');
    }
  });

  it('list handles mixed files and directories', async () => {
    const result = await handleFs('list', tmpDir, {}) as {
      entries: Array<{ name: string; type: string; size: number }>;
    };
    const types = result.entries.map((e) => e.type);
    expect(types).toContain('file');
    expect(types).toContain('directory');
  });
});

// ═════════════════════════════════════════════════════════════════
// Preview modes
// ═════════════════════════════════════════════════════════════════

describe('Preview modes', () => {
  const indexPath = () => path.join(tmpDir, 'src', 'index.ts');
  const utilsPath = () => path.join(tmpDir, 'src', 'utils.ts');
  const readmePath = () => path.join(tmpDir, 'README.md');

  describe('head mode', () => {
    it('head with default (10 lines) returns first 10 lines', async () => {
      const result = await handleFsPreview(readmePath(), 'head') as {
        lines: string[]; total_lines: number;
      };
      expect(result.lines.length).toBe(10);
      expect(result.lines[0]).toBe('Line 1 of the README file');
      expect(result.lines[9]).toBe('Line 10 of the README file');
    });

    it('head mode returns total_lines count', async () => {
      const result = await handleFsPreview(readmePath(), 'head') as {
        lines: string[]; total_lines: number;
      };
      expect(result.total_lines).toBe(50);
    });
  });

  describe('imports mode', () => {
    it('extracts TypeScript import statements', async () => {
      const result = await handleFsPreview(indexPath(), 'imports') as {
        imports: string[]; language: string;
      };
      expect(result.imports).toContain('import { Router } from "express";');
      expect(result.imports).toContain('import * as fs from "fs";');
      expect(result.language).toBe('typescript');
    });

    it('extracts require() statements', async () => {
      const result = await handleFsPreview(indexPath(), 'imports') as {
        imports: string[];
      };
      const hasRequire = result.imports.some((i) => i.includes('require('));
      expect(hasRequire).toBe(true);
    });
  });

  describe('exports mode', () => {
    it('extracts export statements', async () => {
      const result = await handleFsPreview(indexPath(), 'exports') as {
        exports: string[]; language: string;
      };
      expect(result.language).toBe('typescript');
      const exportTexts = result.exports.join('\n');
      expect(exportTexts).toContain('export class AppServer');
      expect(exportTexts).toContain('export function startServer');
      expect(exportTexts).toContain('export async function stopServer');
      expect(exportTexts).toContain('export const greet');
      expect(exportTexts).toContain('export default AppServer');
    });

    it('extracts module.exports statements', async () => {
      const result = await handleFsPreview(utilsPath(), 'exports') as {
        exports: string[];
      };
      const hasModuleExports = result.exports.some((e) => e.includes('module.exports'));
      expect(hasModuleExports).toBe(true);
    });
  });

  describe('signatures mode', () => {
    it('extracts function declarations', async () => {
      const result = await handleFsPreview(indexPath(), 'signatures') as {
        signatures: string[]; language: string;
      };
      const sigTexts = result.signatures.join('\n');
      expect(sigTexts).toContain('function startServer');
      expect(sigTexts).toContain('async function stopServer');
    });

    it('extracts arrow functions assigned to const', async () => {
      const result = await handleFsPreview(indexPath(), 'signatures') as {
        signatures: string[];
      };
      const hasArrow = result.signatures.some((s) => s.includes('greet'));
      expect(hasArrow).toBe(true);
    });
  });

  describe('structure mode', () => {
    it('finds classes and functions', async () => {
      const result = await handleFsPreview(indexPath(), 'structure') as {
        classes: string[]; functions: string[]; language: string;
      };
      expect(result.classes).toContain('AppServer');
      expect(result.classes).toContain('BaseHandler');
      expect(result.functions).toContain('startServer');
      expect(result.functions).toContain('stopServer');
      expect(result.functions).toContain('greet');
      expect(result.language).toBe('typescript');
    });

    it('returns correct line numbers', async () => {
      const result = await handleFsPreview(indexPath(), 'structure') as {
        sections: Array<{ name: string; line: number; type: string }>;
      };
      const appServerSection = result.sections.find((s) => s.name === 'AppServer' && s.type === 'class');
      expect(appServerSection).toBeDefined();
      // "export class AppServer" is on line 5 of index.ts
      expect(appServerSection!.line).toBe(5);

      const startServerSection = result.sections.find((s) => s.name === 'startServer');
      expect(startServerSection).toBeDefined();
      // "export function startServer" is on line 14
      expect(startServerSection!.line).toBe(14);
    });
  });
});

// ═════════════════════════════════════════════════════════════════
// Error handling
// ═════════════════════════════════════════════════════════════════

describe('Error handling', () => {
  it('handleFs throws for unknown operation', async () => {
    await expect(handleFs('bogus_op', tmpDir, {})).rejects.toThrow('Unknown operation: bogus_op');
  });

  it('handleFsPreview throws for unknown mode', async () => {
    const filePath = path.join(tmpDir, 'README.md');
    await expect(handleFsPreview(filePath, 'bogus_mode')).rejects.toThrow('Unknown preview mode: bogus_mode');
  });

  it('handleFs stat throws for non-existent path', async () => {
    const noSuchPath = path.join(tmpDir, 'does-not-exist.txt');
    await expect(handleFs('stat', noSuchPath, {})).rejects.toThrow();
  });

  it('handleFsPreview throws for file > 10MB', async () => {
    // Create an actual file larger than 10MB (the threshold in fs-tools.ts).
    // Buffer.alloc is fast since the OS can provide zero-filled pages.
    const bigFile = path.join(tmpDir, 'bigfile.txt');
    const tenMBPlus = 10_000_001;
    fs.writeFileSync(bigFile, Buffer.alloc(tenMBPlus));

    try {
      await expect(handleFsPreview(bigFile, 'head')).rejects.toThrow('File too large');
    } finally {
      fs.unlinkSync(bigFile);
    }
  });
});

// ═════════════════════════════════════════════════════════════════
// extToLanguage mapping (tested via preview modes)
// ═════════════════════════════════════════════════════════════════

describe('extToLanguage mapping', () => {
  it('.ts maps to typescript', async () => {
    const result = await handleFsPreview(path.join(tmpDir, 'src', 'index.ts'), 'imports') as {
      language: string;
    };
    expect(result.language).toBe('typescript');
  });

  it('.py maps to python', async () => {
    const result = await handleFsPreview(path.join(tmpDir, 'sample.py'), 'imports') as {
      language: string;
    };
    expect(result.language).toBe('python');
  });

  it('.go maps to go', async () => {
    const result = await handleFsPreview(path.join(tmpDir, 'sample.go'), 'structure') as {
      language: string;
    };
    expect(result.language).toBe('go');
  });

  it('.rs maps to rust', async () => {
    const result = await handleFsPreview(path.join(tmpDir, 'sample.rs'), 'signatures') as {
      language: string;
    };
    expect(result.language).toBe('rust');
  });

  it('unknown extension maps to "unknown"', async () => {
    const unknownFile = path.join(tmpDir, 'data.xyz');
    fs.writeFileSync(unknownFile, 'some content\n');

    const result = await handleFsPreview(unknownFile, 'imports') as {
      language: string;
    };
    expect(result.language).toBe('unknown');

    fs.unlinkSync(unknownFile);
  });
});
