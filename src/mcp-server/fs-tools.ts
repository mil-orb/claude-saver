import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

interface FsOptions {
  pattern?: string;
  depth?: number;
  options?: Record<string, string>;
}

// ═══════════════════════════════════════════════════════════════
// claudesaver_fs — metadata only, never file contents
// ═══════════════════════════════════════════════════════════════

export async function handleFs(
  operation: string,
  targetPath: string,
  opts: FsOptions
): Promise<unknown> {
  const absPath = path.resolve(targetPath);

  switch (operation) {
    case 'tree':
      return buildTree(absPath, opts.depth ?? 3);

    case 'list':
      return listDirectory(absPath);

    case 'find':
      return findFiles(absPath, opts.pattern ?? '*', opts.depth ?? 10);

    case 'stat':
      return fileStat(absPath);

    case 'count_lines':
      return countLines(absPath);

    case 'git_status':
      return gitCommand(absPath, ['status', '--porcelain']);

    case 'git_log': {
      const count = parseInt(opts.options?.count ?? '10', 10);
      if (isNaN(count) || count < 1 || count > 500) {
        throw new Error('git_log count must be a number between 1 and 500');
      }
      return gitCommand(absPath, ['log', '--oneline', `-${count}`]);
    }

    case 'git_diff_names':
      return gitCommand(absPath, ['diff', '--name-only']);

    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
}

interface TreeEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
  children?: TreeEntry[];
}

function buildTree(dirPath: string, maxDepth: number, currentDepth = 0): TreeEntry {
  const stat = fs.statSync(dirPath);
  const name = path.basename(dirPath);

  if (!stat.isDirectory()) {
    return { name, type: 'file', size: stat.size };
  }

  const entry: TreeEntry = { name, type: 'directory' };

  if (currentDepth < maxDepth) {
    try {
      const entries = fs.readdirSync(dirPath);
      entry.children = entries
        .filter((e: string) => !e.startsWith('.') || e === '.gitignore')
        .slice(0, 100) // safety cap
        .map((e: string) => {
          try {
            return buildTree(path.join(dirPath, e), maxDepth, currentDepth + 1);
          } catch {
            return { name: e, type: 'file' as const, size: 0 };
          }
        });
    } catch {
      // Permission denied, etc.
    }
  }

  return entry;
}

function listDirectory(dirPath: string): { entries: Array<{ name: string; type: string; size: number }> } {
  const entries = fs.readdirSync(dirPath);
  return {
    entries: entries.map((name: string) => {
      try {
        const stat = fs.statSync(path.join(dirPath, name));
        return {
          name,
          type: stat.isDirectory() ? 'directory' : 'file',
          size: stat.size,
        };
      } catch {
        return { name, type: 'unknown', size: 0 };
      }
    }),
  };
}

function findFiles(dirPath: string, pattern: string, maxDepth: number): { matches: string[] } {
  const matches: string[] = [];
  const globRegex = globToRegex(pattern);

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth || matches.length >= 500) return;
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith('.') && entry !== '.gitignore') continue;
        const fullPath = path.join(dir, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            if (entry !== 'node_modules') {
              walk(fullPath, depth + 1);
            }
          } else if (globRegex.test(entry)) {
            matches.push(path.relative(dirPath, fullPath));
          }
        } catch {
          // Skip inaccessible files
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  walk(dirPath, 0);
  return { matches };
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function fileStat(filePath: string): {
  name: string;
  size: string;
  type: string;
  modified: string;
  created: string;
} {
  const stat = fs.statSync(filePath);
  return {
    name: path.basename(filePath),
    size: formatSize(stat.size),
    type: stat.isDirectory() ? 'directory' : 'file',
    modified: stat.mtime.toISOString(),
    created: stat.birthtime.toISOString(),
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function countLines(targetPath: string): { total: number; by_extension: Record<string, number> } {
  const stat = fs.statSync(targetPath);
  const result: Record<string, number> = {};
  let total = 0;

  function countFile(filePath: string): void {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').length;
      const ext = path.extname(filePath) || '(no ext)';
      result[ext] = (result[ext] ?? 0) + lines;
      total += lines;
    } catch {
      // Binary or unreadable
    }
  }

  function walk(dir: string, depth: number): void {
    if (depth > 10) return;
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        const full = path.join(dir, entry);
        try {
          const s = fs.statSync(full);
          if (s.isDirectory()) walk(full, depth + 1);
          else if (s.size < 1_000_000) countFile(full); // skip files > 1MB
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  if (stat.isDirectory()) {
    walk(targetPath, 0);
  } else if (stat.size < 1_000_000) {
    countFile(targetPath);
  }

  return { total, by_extension: result };
}

function gitCommand(cwd: string, args: string[]): { output: string } {
  try {
    const safeCwd = fs.statSync(cwd).isDirectory() ? cwd : path.dirname(cwd);
    const output = execFileSync('git', args, {
      cwd: safeCwd,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return { output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Git command failed: ${msg}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// claudesaver_fs_preview — structure only, no sensitive content
// ═══════════════════════════════════════════════════════════════

export async function handleFsPreview(
  filePath: string,
  mode: string,
  lines?: number
): Promise<unknown> {
  const absPath = path.resolve(filePath);
  const stat = fs.statSync(absPath);
  if (stat.size > 10_000_000) {
    throw new Error(`File too large: ${formatSize(stat.size)} (max 10MB)`);
  }
  const content = fs.readFileSync(absPath, 'utf-8');

  switch (mode) {
    case 'head':
      return headLines(content, lines ?? 10);

    case 'imports':
      return extractImports(content, absPath);

    case 'exports':
      return extractExports(content, absPath);

    case 'signatures':
      return extractSignatures(content, absPath);

    case 'structure':
      return extractStructure(content, absPath);

    default:
      throw new Error(`Unknown preview mode: ${mode}`);
  }
}

function headLines(content: string, n: number): { lines: string[]; total_lines: number } {
  const allLines = content.split('\n');
  return {
    lines: allLines.slice(0, n),
    total_lines: allLines.length,
  };
}

function extractImports(content: string, filePath: string): { imports: string[]; language: string } {
  const ext = path.extname(filePath);
  const lines = content.split('\n');
  const imports: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith('import ') ||
      trimmed.startsWith('from ') ||
      trimmed.match(/^(const|let|var)\s+.*=\s*require\(/) ||
      trimmed.startsWith('#include') ||
      trimmed.startsWith('using ') ||
      trimmed.startsWith('use ')
    ) {
      imports.push(trimmed);
    }
  }

  return { imports, language: extToLanguage(ext) };
}

function extractExports(content: string, filePath: string): { exports: string[]; language: string } {
  const ext = path.extname(filePath);
  const lines = content.split('\n');
  const exports: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith('export ') ||
      trimmed.startsWith('module.exports') ||
      trimmed.match(/^exports\./)
    ) {
      exports.push(trimmed.length > 120 ? trimmed.slice(0, 120) + '...' : trimmed);
    }
  }

  return { exports, language: extToLanguage(ext) };
}

function extractSignatures(content: string, filePath: string): { signatures: string[]; language: string } {
  const ext = path.extname(filePath);
  const lines = content.split('\n');
  const sigs: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // TypeScript/JavaScript function signatures
    if (
      trimmed.match(/^(export\s+)?(async\s+)?function\s+\w+/) ||
      trimmed.match(/^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/) ||
      // Python
      trimmed.match(/^(async\s+)?def\s+\w+/) ||
      // Go
      trimmed.match(/^func\s+/) ||
      // Rust
      trimmed.match(/^(pub\s+)?(async\s+)?fn\s+/) ||
      // Java/C#
      trimmed.match(/^(public|private|protected|static)\s+.*\w+\s*\(/)
    ) {
      // Truncate implementation
      const sig = trimmed.replace(/\{.*$/, '{...}').replace(/:\s*$/, '');
      sigs.push(sig.length > 150 ? sig.slice(0, 150) + '...' : sig);
    }
  }

  return { signatures: sigs, language: extToLanguage(ext) };
}

function extractStructure(content: string, filePath: string): {
  language: string;
  total_lines: number;
  classes: string[];
  functions: string[];
  sections: Array<{ name: string; line: number; type: string }>;
} {
  const ext = path.extname(filePath);
  const lines = content.split('\n');
  const classes: string[] = [];
  const functions: string[] = [];
  const sections: Array<{ name: string; line: number; type: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Classes
    const classMatch = trimmed.match(/^(export\s+)?(abstract\s+)?class\s+(\w+)/);
    if (classMatch) {
      classes.push(classMatch[3]);
      sections.push({ name: classMatch[3], line: i + 1, type: 'class' });
      continue;
    }

    // Functions (top-level)
    const funcMatch = trimmed.match(/^(export\s+)?(async\s+)?function\s+(\w+)/);
    if (funcMatch) {
      functions.push(funcMatch[3]);
      sections.push({ name: funcMatch[3], line: i + 1, type: 'function' });
      continue;
    }

    // Arrow functions assigned to const
    const arrowMatch = trimmed.match(/^(export\s+)?(const|let|var)\s+(\w+)\s*=/);
    if (arrowMatch && (trimmed.includes('=>') || trimmed.includes('function'))) {
      functions.push(arrowMatch[3]);
      sections.push({ name: arrowMatch[3], line: i + 1, type: 'function' });
    }

    // Python
    const pyFuncMatch = trimmed.match(/^(async\s+)?def\s+(\w+)/);
    if (pyFuncMatch) {
      functions.push(pyFuncMatch[2]);
      sections.push({ name: pyFuncMatch[2], line: i + 1, type: 'function' });
    }

    const pyClassMatch = trimmed.match(/^class\s+(\w+)/);
    if (pyClassMatch) {
      classes.push(pyClassMatch[1]);
      sections.push({ name: pyClassMatch[1], line: i + 1, type: 'class' });
    }
  }

  return {
    language: extToLanguage(ext),
    total_lines: lines.length,
    classes,
    functions,
    sections,
  };
}

function extToLanguage(ext: string): string {
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.cs': 'csharp',
    '.rb': 'ruby',
    '.php': 'php',
    '.c': 'c', '.h': 'c',
    '.cpp': 'cpp', '.hpp': 'cpp',
    '.md': 'markdown',
    '.json': 'json',
    '.yaml': 'yaml', '.yml': 'yaml',
  };
  return map[ext] ?? 'unknown';
}
