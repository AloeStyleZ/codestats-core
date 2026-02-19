// src/phpParser.ts
import { PortInfo, MethodInfo, ClassInfo, ImportInfo, MetaBlock, HardcodedValue, UnusedItem, FileStats } from './types';
import { parseMetaBlock, detectHardcoded, detectUnused, genFileDesc, genClassDescs } from './parserUtils';

export function parsePhpCode(code: string, fileName: string): FileStats {
  const lines = code.split('\n');
  const meta = parseMetaBlock(code);
  const imports = parsePhpImports(lines);
  const classes = parsePhpClasses(lines);
  const functions = parsePhpFunctions(lines);
  const globalVars = parsePhpGlobals(lines);
  const errorTypes = parsePhpErrors(lines);
  const debugPoints = parsePhpDebug(lines);
  const connections = imports.map(i => i.module);
  const codeLines = countPhpCodeLines(lines);
  const warnings = genWarnings(meta, imports);
  const description = meta?.desc || genFileDesc(meta, classes, functions, imports, fileName);
  const classDescriptions = genClassDescs(classes, imports);
  const hardcoded = detectHardcoded(lines, '//');
  const unused = detectUnused(lines, imports, classes, functions, '//');
  

  return {
    fileName, language: 'php', meta, classes, functions, imports, globalVars,
    connections, errorTypes, debugPoints, totalLines: lines.length, codeLines,
    warnings, description, classDescriptions, hardcoded, unused, diagnostics: [], depIssues: [], todos: [], externalUsage: []
  };
}

function parsePhpImports(lines: string[]): ImportInfo[] {
  const imports: ImportInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    // use Namespace\Class
    const u = l.match(/^use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;/);
    if (u) {
      const parts = u[1].split('\\');
      const name = u[2] || parts[parts.length - 1];
      imports.push({ module: u[1], names: [name], isFrom: true, lineNumber: i + 1 });
      continue;
    }
    // require/include
    const r = l.match(/^(?:require|include|require_once|include_once)\s*\(?['"]([^'"]+)['"]\)?/);
    if (r) imports.push({ module: r[1], names: [r[1]], isFrom: false, lineNumber: i + 1 });
  }
  return imports;
}

function parsePhpClasses(lines: string[]): ClassInfo[] {
  const classes: ClassInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const cm = l.match(/^(?:abstract\s+|final\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?\s*\{?/);
    if (!cm) continue;
    const bases: string[] = [];
    if (cm[2]) bases.push(cm[2]);
    if (cm[3]) bases.push(...cm[3].split(',').map(s => s.trim()));
    const methods = parsePhpClassMethods(lines, i);
    const attrs = parsePhpClassAttrs(lines, i);
    classes.push({ name: cm[1], bases, methods, attributes: attrs, decorators: [], lineNumber: i + 1 });
  }
  return classes;
}

function parsePhpClassMethods(lines: string[], classLine: number): MethodInfo[] {
  const methods: MethodInfo[] = [];
  let depth = 0; let started = false;
  for (let i = classLine; i < lines.length; i++) {
    const l = lines[i];
    for (const ch of l) { if (ch === '{') { depth++; started = true; } if (ch === '}') depth--; }
    if (started && depth <= 0) break;
    const mm = l.match(/^\s+(?:(public|private|protected)\s+)?(?:(static)\s+)?function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*\??([\w\\|]+))?\s*/);
    if (mm) {
      const params = parsePhpParams(mm[4]);
      const vis = mm[1] || 'public';
      methods.push({
        name: mm[3], params, returnType: mm[5] || 'mixed', decorators: mm[2] ? ['static'] : [],
        lineNumber: i + 1, isAsync: false, isPrivate: vis === 'private' || vis === 'protected',
        complexity: countPhpBranches(lines, i)
      });
    }
  }
  return methods;
}

function parsePhpClassAttrs(lines: string[], classLine: number): PortInfo[] {
  const attrs: PortInfo[] = [];
  let depth = 0; let started = false;
  for (let i = classLine; i < lines.length; i++) {
    const l = lines[i];
    for (const ch of l) { if (ch === '{') { depth++; started = true; } if (ch === '}') depth--; }
    if (started && depth <= 0) break;
    // property declarations
    const pa = l.match(/^\s+(?:public|private|protected)\s+(?:static\s+)?(?:\??([\w\\]+)\s+)?\$(\w+)/);
    if (pa) attrs.push({ name: '$' + pa[2], type: pa[1] || 'mixed' });
    // $this->x = in constructor
    const ta = l.match(/\$this->(\w+)\s*=/);
    if (ta && !attrs.find(a => a.name === '$' + ta[1])) attrs.push({ name: '$' + ta[1], type: 'mixed' });
  }
  return attrs;
}

function parsePhpFunctions(lines: string[]): MethodInfo[] {
  const fns: MethodInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const indent = l.search(/\S/);
    if (indent > 2) continue;
    const f = l.match(/^function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*\??([\w\\|]+))?\s*/);
    if (f) {
      fns.push({
        name: f[1], params: parsePhpParams(f[2]), returnType: f[3] || 'mixed', decorators: [],
        lineNumber: i + 1, isAsync: false, isPrivate: f[1].startsWith('_'),
        complexity: countPhpBranches(lines, i)
      });
    }
  }
  return fns;
}

function parsePhpGlobals(lines: string[]): PortInfo[] {
  const vars: PortInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    const cm = l.match(/^(?:define\s*\(\s*['"](\w+)['"]\s*,\s*(.+)\))/);
    if (cm) vars.push({ name: cm[1], type: 'const', default: cm[2].replace(/\);?$/, '').trim() });
    const cv = l.match(/^const\s+(\w+)\s*=\s*(.+);/);
    if (cv) vars.push({ name: cv[1], type: 'const', default: cv[2].trim() });
  }
  return vars;
}

function parsePhpParams(s: string): PortInfo[] {
  if (!s.trim()) return [];
  const params: PortInfo[] = [];
  for (const part of s.split(',')) {
    const t = part.trim(); if (!t) continue;
    let type = 'mixed', name = t, def: string | undefined;
    const eq = t.indexOf('=');
    if (eq > -1) { def = t.slice(eq + 1).trim(); name = t.slice(0, eq).trim(); }
    // ?Type $name or Type $name
    const tp = name.match(/^(\??\w[\w\\|]*)\s+(\$\w+)$/);
    if (tp) { type = tp[1]; name = tp[2]; }
    else if (name.startsWith('$')) { /* keep as is */ }
    else { const dp = name.match(/(\$\w+)/); if (dp) name = dp[1]; }
    params.push({ name, type, default: def });
  }
  return params;
}

function parsePhpErrors(lines: string[]): string[] {
  const errs = new Set<string>();
  for (const l of lines) {
    const t = l.match(/throw\s+new\s+(\w+)/); if (t) errs.add(t[1]);
    const c = l.match(/catch\s*\(\s*(\w[\w\\|]*)\s/); if (c) errs.add(c[1]);
  }
  return Array.from(errs);
}

function parsePhpDebug(lines: string[]): number[] {
  const pts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('try') || t.match(/catch\s*\(/) || t.match(/}\s*catch/)) pts.push(i + 1);
  }
  return pts;
}

function countPhpBranches(lines: string[], start: number): number {
  let b = 0, d = 0, s = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) { if (ch === '{') { d++; s = true; } if (ch === '}') d--; }
    if (s && d <= 0) break;
    const t = lines[i].trim();
    if (/^(if|elseif|else|for|foreach|while|switch|case)\b/.test(t)) b++;
  }
  return b;
}

function countPhpCodeLines(lines: string[]): number {
  let c = 0, inB = false;
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith('/*')) inB = true;
    if (inB) { if (t.includes('*/')) inB = false; continue; }
    if (t === '' || t.startsWith('//') || t.startsWith('#') || t === '<?php' || t === '?>') continue;
    c++;
  }
  return c;
}

function genWarnings(meta: MetaBlock | null, imports: ImportInfo[]): string[] {
  if (!meta) return [];
  const w: string[] = [];
  if (meta.deps) {
    const mods = new Set(imports.map(i => i.module));
    for (const d of meta.deps) { if (![...mods].some(m => m.includes(d) || d.includes(m))) w.push(`\u26a0 Meta declara dep "${d}" no encontrada en imports`); }
  }
  return w;
}
