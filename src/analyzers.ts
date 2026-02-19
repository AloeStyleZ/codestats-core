// src/analyzers.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { DepIssue, TodoItem, ImportInfo, ClassInfo, MethodInfo } from './types';

// Python stdlib — never show these in dependencies
const PY_STDLIB = new Set([
  'os','sys','re','json','math','datetime','typing','pathlib','collections',
  'abc','functools','itertools','hashlib','logging','unittest','io','time',
  'random','string','copy','enum','dataclasses','contextlib','asyncio',
  'subprocess','shutil','glob','tempfile','threading','multiprocessing',
  'socket','http','urllib','base64','csv','xml','html','sqlite3','struct',
  'argparse','textwrap','uuid','decimal','fractions','statistics','operator',
  'pprint','warnings','traceback','inspect','dis','gc','weakref','array',
  'queue','heapq','bisect','configparser','secrets','hmac','pickle',
  'shelve','dbm','gzip','zipfile','tarfile','lzma','bz2','zlib','signal',
  'mmap','ctypes','platform','sysconfig','site','venv','compileall',
  'py_compile','profile','cProfile','timeit','trace','pdb','faulthandler',
  'atexit','builtins','importlib','pkgutil','modulefinder','runpy',
  '_thread','concurrent','types','codecs','unicodedata','stringprep',
  'readline','rlcompleter','struct','codecs',
  'tkinter','turtle','idlelib','turtledemo','test','distutils','ensurepip',
  'lib2to3','xmlrpc','email','mailbox','mimetypes','webbrowser',
  'cgi','cgitb','wsgiref','ftplib','poplib','imaplib','smtplib',
  'telnetlib','socketserver','select','selectors','ssl',
]);

// Node builtins — never show these
const NODE_BUILTINS = new Set([
  'fs','path','os','http','https','url','querystring','stream','buffer',
  'events','util','crypto','zlib','net','dns','tls','child_process',
  'cluster','readline','repl','vm','assert','console','process',
  'timers','worker_threads','perf_hooks','async_hooks','inspector',
  'v8','string_decoder','punycode','module',
  'node:fs','node:path','node:os','node:http','node:https','node:url',
  'node:crypto','node:stream','node:events','node:util','node:child_process',
  'node:worker_threads','node:net','node:dns','node:tls','node:zlib',
  'node:assert','node:buffer','node:readline','node:cluster',
]);

// ══════════════════════════════════════════════
// DEPENDENCY HEALTH CHECK
// ══════════════════════════════════════════════

export function checkDependencies(imports: ImportInfo[], filePath: string, language: string): DepIssue[] {
  const issues: DepIssue[] = [];

  // Filter: only external, non-stdlib imports
  const externalImports = imports.filter(imp => {
    if (!isExternalImport(imp, language)) return false;
    const base = imp.module.split(/[./\\]/)[0];
    if (language === 'python' && PY_STDLIB.has(base)) return false;
    if ((language.startsWith('javascript') || language.startsWith('typescript')) && NODE_BUILTINS.has(imp.module)) return false;
    if (language === 'php') {
      const ns = imp.module.split('\\')[0];
      if (ns === 'App' || ns === 'Database' || ns === 'Tests') return false;
    }
    return true;
  });

  if (externalImports.length === 0) return [];

  // Try to get actually installed packages
  const installed = getInstalledPackages(filePath, language);

  for (const imp of externalImports) {
    const depName = normalizeDep(imp.module, language);
    if (!depName) continue;

    let status: DepIssue['status'] = 'unknown';

    if (installed && installed.size > 0) {
      const found = installed.has(depName.toLowerCase())
        || installed.has(depName.toLowerCase().replace(/-/g, '_'))
        || installed.has(depName.toLowerCase().replace(/_/g, '-'));
      status = found ? 'installed' : 'missing';
    }

    // Always generate install command if not confirmed installed
    let installCmd = '';
    if (status !== 'installed') {
      if (language === 'python') installCmd = `pip install ${depName}`;
      else if (language.startsWith('javascript') || language.startsWith('typescript')) installCmd = `npm install ${depName}`;
      else if (language === 'php') installCmd = `composer require ${depName}`;
    }

    issues.push({ name: depName, status, lineNumber: imp.lineNumber, installCmd });
  }

  return issues;
}

// Get installed packages by checking multiple sources
function getInstalledPackages(filePath: string, language: string): Set<string> | null {
  const installed = new Set<string>();

  // 1. Check manifest files (package.json, requirements.txt, composer.json)
  let dir = path.dirname(filePath);
  for (let i = 0; i < 5; i++) {
    if (language.startsWith('javascript') || language.startsWith('typescript')) {
      const pkg = path.join(dir, 'package.json');
      if (fs.existsSync(pkg)) {
        try {
          const p = JSON.parse(fs.readFileSync(pkg, 'utf-8'));
          for (const k of Object.keys({ ...(p.dependencies || {}), ...(p.devDependencies || {}), ...(p.peerDependencies || {}) })) {
            installed.add(k.toLowerCase());
          }
        } catch {}
        // Also check node_modules
        const nm = path.join(dir, 'node_modules');
        if (fs.existsSync(nm)) {
          try { fs.readdirSync(nm).forEach(d => installed.add(d.toLowerCase())); } catch {}
        }
        return installed;
      }
    }

    if (language === 'python') {
      // Check requirements.txt
      const req = path.join(dir, 'requirements.txt');
      if (fs.existsSync(req)) {
        try {
          for (const line of fs.readFileSync(req, 'utf-8').split('\n')) {
            const name = line.trim().split(/[=<>!~\[]/)[0].trim().toLowerCase();
            if (name && !name.startsWith('#') && !name.startsWith('-')) installed.add(name);
          }
        } catch {}
      }
      // Check pyproject.toml
      const pyp = path.join(dir, 'pyproject.toml');
      if (fs.existsSync(pyp)) {
        try {
          const content = fs.readFileSync(pyp, 'utf-8');
          const depMatch = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
          if (depMatch) {
            for (const m of depMatch[1].matchAll(/["']([^"'>=<\s]+)/g)) installed.add(m[1].trim().toLowerCase());
          }
        } catch {}
      }
      // Run pip list for real verification
      try {
        const result = cp.execSync('pip list --format=columns 2>/dev/null || pip3 list --format=columns 2>/dev/null', {
          timeout: 5000, encoding: 'utf-8'
        });
        for (const line of result.split('\n').slice(2)) {
          const name = line.trim().split(/\s+/)[0];
          if (name) installed.add(name.toLowerCase());
        }
      } catch {}
      if (installed.size > 0) return installed;
    }

    if (language === 'php') {
      const comp = path.join(dir, 'composer.json');
      if (fs.existsSync(comp)) {
        try {
          const c = JSON.parse(fs.readFileSync(comp, 'utf-8'));
          for (const k of Object.keys({ ...(c.require || {}), ...(c['require-dev'] || {}) })) installed.add(k.toLowerCase());
        } catch {}
        return installed;
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return installed.size > 0 ? installed : null;
}

function isExternalImport(imp: ImportInfo, lang: string): boolean {
  if (lang === 'python') return !imp.module.startsWith('.');
  if (lang.startsWith('javascript') || lang.startsWith('typescript')) return !imp.module.startsWith('.') && !imp.module.startsWith('/');
  if (lang === 'php') return !imp.module.startsWith('.') && !imp.module.startsWith('/');
  return true;
}

function normalizeDep(module: string, lang: string): string | null {
  if (lang === 'python') {
    // Standard library — skip
    const stdlib = new Set(['os','sys','re','json','math','datetime','typing','pathlib','collections','abc','functools','itertools','hashlib','logging','unittest','io','time','random','string','copy','enum','dataclasses','contextlib','asyncio','subprocess','shutil','glob','tempfile','threading','multiprocessing','socket','http','urllib','base64','csv','xml','html','sqlite3','struct','argparse','textwrap','uuid','decimal','fractions','statistics','operator','pprint','warnings','traceback','inspect','dis','gc','weakref','array','queue','heapq','bisect','configparser','secrets','hmac','pickle','shelve','dbm','gzip','zipfile','tarfile','lzma','bz2','zlib','signal','mmap','ctypes','platform','sysconfig','site','venv','compileall','py_compile','profile','cProfile','timeit','trace','pdb','faulthandler','atexit','builtins','importlib','pkgutil','modulefinder','runpy','_thread','concurrent','types','codecs','unicodedata','stringprep','readline','rlcompleter','struct','codecs']);
    const base = module.split('.')[0];
    if (stdlib.has(base)) return null;
    return base;
  }
  if (lang.startsWith('javascript') || lang.startsWith('typescript')) {
    // Scoped: @scope/name -> @scope/name
    if (module.startsWith('@')) return module.split('/').slice(0, 2).join('/');
    return module.split('/')[0];
  }
  if (lang === 'php') {
    // Vendor namespace: App\... is internal
    const parts = module.split('\\');
    if (parts[0] === 'App' || parts[0] === 'Database' || parts[0] === 'Tests') return null;
    return parts.slice(0, 2).join('/').toLowerCase();
  }
  return module;
}

// ══════════════════════════════════════════════
// TODO / FIXME SCANNER
// ══════════════════════════════════════════════

export function scanTodos(lines: string[]): TodoItem[] {
  const todos: TodoItem[] = [];
  const re = /\b(TODO|FIXME|HACK|BUG|NOTE|XXX)\b[:\s]*(.*)/i;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) {
      let type = m[1].toUpperCase() as TodoItem['type'];
      if (type === 'XXX' as any) type = 'HACK';
      const text = m[2].trim().replace(/\*\/\s*$/, '').replace(/-->$/, '').trim() || '(sin descripci\u00f3n)';
      todos.push({ text, type: type as TodoItem['type'], lineNumber: i + 1 });
    }
  }
  return todos;
}

// ══════════════════════════════════════════════
// SNIPPET EXTRACTOR (prompt generator for a method)
// ══════════════════════════════════════════════

export function extractSnippetPrompt(
  lines: string[],
  method: MethodInfo,
  cls: ClassInfo | null,
  imports: ImportInfo[],
  language: string
): string {
  // Get the method source code
  const startIdx = method.lineNumber - 1;
  let endIdx = startIdx;
  let depth = 0; let started = false;

  if (language === 'python') {
    // Python: indentation-based
    const startIndent = lines[startIdx].search(/\S/);
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (lines[i].trim() === '') { endIdx = i; continue; }
      if (lines[i].search(/\S/) <= startIndent) break;
      endIdx = i;
    }
  } else {
    // Brace-based languages
    for (let i = startIdx; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '{') { depth++; started = true; }
        if (ch === '}') depth--;
      }
      endIdx = i;
      if (started && depth <= 0) break;
    }
  }

  const methodCode = lines.slice(startIdx, endIdx + 1).join('\n');

  // Build context
  const relevantImports = imports.map(i => {
    // Check if import is used in the method
    const methodText = methodCode;
    if (i.names.some(n => methodText.includes(n))) return lines[i.lineNumber - 1].trim();
    return null;
  }).filter(Boolean).join('\n');

  const classContext = cls ? `Clase: ${cls.name}${cls.bases.length ? ' extends ' + cls.bases.join(', ') : ''}` : '';
  const paramInfo = method.params.map(p => `${p.name}: ${p.type}`).join(', ');

  return `Mejora el siguiente m\u00e9todo. Mant\u00e9n la misma firma y comportamiento.

CONTEXTO:
- Lenguaje: ${language}
${classContext ? '- ' + classContext : ''}
- M\u00e9todo: ${method.name}(${paramInfo}) \u2192 ${method.returnType}
- Async: ${method.isAsync ? 'S\u00ed' : 'No'}
- Complejidad actual: ${method.complexity} branches

IMPORTS RELEVANTES:
${relevantImports || '(ninguno detectado)'}

C\u00d3DIGO ACTUAL:
\`\`\`
${methodCode}
\`\`\`

INSTRUCCIONES:
- Mejora legibilidad y mantenibilidad
- Agrega type hints donde falten
- Mejora manejo de errores si es necesario
- Reduce complejidad si es posible
- NO cambies la firma p\u00fablica (nombre, params, return type)
- Devuelve SOLO el m\u00e9todo mejorado, sin explicaci\u00f3n`;
}
