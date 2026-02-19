// src/languageRouter.ts
import { FileStats } from './types';
import { parsePythonCode } from './pythonParser';
import { parseJsCode } from './jsParser';
import { parsePhpCode } from './phpParser';
import { parseHtmlCode, parseCssCode } from './htmlParser';
import { scanTodos } from './analyzers';

export type SupportedLang = 'python' | 'javascript' | 'typescript' | 'javascriptreact' | 'typescriptreact' | 'php' | 'html' | 'css';

const langMap: Record<string, SupportedLang> = {
  'python': 'python', 'javascript': 'javascript', 'typescript': 'typescript',
  'javascriptreact': 'javascriptreact', 'typescriptreact': 'typescriptreact',
  'php': 'php', 'html': 'html', 'css': 'css',
};

export function isSupported(languageId: string): boolean { return languageId in langMap; }
export function getSupportedLanguages(): string[] { return Object.keys(langMap); }

export function parseCode(code: string, fileName: string, languageId: string): FileStats {
  let stats: FileStats;
  switch (languageId) {
    case 'python': stats = parsePythonCode(code, fileName); break;
    case 'javascript': case 'typescript': case 'javascriptreact': case 'typescriptreact':
      stats = parseJsCode(code, fileName); break;
    case 'php': stats = parsePhpCode(code, fileName); break;
    case 'html': stats = parseHtmlCode(code, fileName); break;
    case 'css': stats = parseCssCode(code, fileName); break;
    default: stats = parsePythonCode(code, fileName);
  }

  // Enrich with todos (universal)
  const lines = code.split('\n');
  stats.todos = scanTodos(lines);
  // diagnostics and depIssues filled by extension (needs VS Code API)
  if (!stats.diagnostics) stats.diagnostics = [];
  if (!stats.depIssues) stats.depIssues = [];

  return stats;
}
