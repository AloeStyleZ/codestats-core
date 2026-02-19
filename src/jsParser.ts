// src/jsParser.ts
import { PortInfo, MethodInfo, ClassInfo, ImportInfo, MetaBlock, HardcodedValue, UnusedItem, FileStats } from './types';
import { parseMetaBlock, detectHardcoded, detectUnused, escRe, genFileDesc, genClassDescs } from './parserUtils';

export function parseJsCode(code: string, fileName: string): FileStats {
  const lines = code.split('\n');
  const meta = parseMetaBlock(code);
  const imports = parseJsImports(lines);
  const classes = parseJsClasses(lines);
  const functions = parseJsFunctions(lines);
  const globalVars = parseJsGlobals(lines);
  const errorTypes = parseJsErrors(lines);
  const debugPoints = parseJsDebug(lines);
  const connections = imports.map(i => i.module);
  const codeLines = countJsCodeLines(lines);
  const warnings = genWarnings(meta, imports, connections);
  const description = meta?.desc || genFileDesc(meta, classes, functions, imports, fileName);
  const classDescriptions = genClassDescs(classes, imports);
  const hardcoded = detectHardcoded(lines, '//');
  const unused = detectUnused(lines, imports, classes, functions, '//');
  

  return {
    fileName, language: 'javascript', meta, classes, functions, imports, globalVars,
    connections, errorTypes, debugPoints, totalLines: lines.length, codeLines,
    warnings, description, classDescriptions, hardcoded, unused, diagnostics: [], depIssues: [], todos: [], externalUsage: []
  };
}

function parseJsImports(lines: string[]): ImportInfo[] {
  const imports: ImportInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    // import X from 'Y'
    const im1 = l.match(/^import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/);
    if (im1) {
      const names = im1[1] ? im1[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean) : [im1[2]];
      imports.push({ module: im1[3], names, isFrom: true, lineNumber: i + 1 });
      continue;
    }
    // import * as X from 'Y'
    const im2 = l.match(/^import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (im2) { imports.push({ module: im2[2], names: [im2[1]], isFrom: true, lineNumber: i + 1 }); continue; }
    // const X = require('Y')
    const im3 = l.match(/(?:const|let|var)\s+(?:\{([^}]+)\}|(\w+))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]/);
    if (im3) {
      const names = im3[1] ? im3[1].split(',').map(n => n.trim()).filter(Boolean) : [im3[2]];
      imports.push({ module: im3[3], names, isFrom: false, lineNumber: i + 1 });
    }
  }
  return imports;
}

function parseJsClasses(lines: string[]): ClassInfo[] {
  const classes: ClassInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const cm = l.match(/^(?:export\s+)?class\s+(\w+)(?:\s+extends\s+([\w.]+))?\s*\{/);
    if (!cm) continue;
    const decorators = collectJsDecorators(lines, i);
    const bases = cm[2] ? [cm[2]] : [];
    const methods = parseJsClassMethods(lines, i);
    const attrs = parseJsClassAttrs(lines, i);
    classes.push({ name: cm[1], bases, methods, attributes: attrs, decorators, lineNumber: i + 1 });
  }
  return classes;
}

function parseJsClassMethods(lines: string[], classLine: number): MethodInfo[] {
  const methods: MethodInfo[] = [];
  let depth = 0; let started = false;
  for (let i = classLine; i < lines.length; i++) {
    const l = lines[i];
    for (const ch of l) { if (ch === '{') { depth++; started = true; } if (ch === '}') depth--; }
    if (started && depth <= 0) break;
    if (i === classLine) continue;
    // method patterns: name(params) / async name(params) / get name() / set name()
    const mm = l.match(/^\s+(?:(?:static|public|private|protected|readonly)\s+)*(async\s+)?(?:get\s+|set\s+)?(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^\s{]+))?\s*\{?/);
    if (mm && mm[2] !== 'if' && mm[2] !== 'for' && mm[2] !== 'while' && mm[2] !== 'switch') {
      const decs = collectJsDecorators(lines, i);
      const params = parseJsParams(mm[3]);
      const isPriv = l.includes('private') || mm[2].startsWith('_') || mm[2].startsWith('#');
      methods.push({
        name: mm[2], params, returnType: mm[4] || 'any', decorators: decs,
        lineNumber: i + 1, isAsync: !!mm[1], isPrivate: isPriv, complexity: countJsBranches(lines, i)
      });
    }
  }
  return methods;
}

function parseJsClassAttrs(lines: string[], classLine: number): PortInfo[] {
  const attrs: PortInfo[] = [];
  let depth = 0; let started = false;
  for (let i = classLine; i < lines.length; i++) {
    const l = lines[i];
    for (const ch of l) { if (ch === '{') { depth++; started = true; } if (ch === '}') depth--; }
    if (started && depth <= 0) break;
    // this.x = ... in constructor
    const ta = l.match(/this\.(\w+)\s*=\s*/);
    if (ta) { if (!attrs.find(a => a.name === ta[1])) attrs.push({ name: ta[1], type: 'any' }); }
    // TS class fields: name: type
    const cf = l.match(/^\s+(?:public|private|protected|readonly|\s)*(\w+)\s*(?:\?)?:\s*(\w[\w<>[\]|]*)/);
    if (cf && !l.includes('(')) { if (!attrs.find(a => a.name === cf[1])) attrs.push({ name: cf[1], type: cf[2] }); }
  }
  return attrs;
}

function parseJsFunctions(lines: string[]): MethodInfo[] {
  const fns: MethodInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const indent = l.search(/\S/);
    if (indent > 2) continue; // skip nested
    // function name() / async function name() / const name = (async) (...) =>
    const f1 = l.match(/^(?:export\s+)?(?:default\s+)?(async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^\s{]+))?/);
    if (f1) {
      const decs = collectJsDecorators(lines, i);
      fns.push({ name: f1[2], params: parseJsParams(f1[3]), returnType: f1[4] || 'any', decorators: decs,
        lineNumber: i + 1, isAsync: !!f1[1], isPrivate: f1[2].startsWith('_'), complexity: countJsBranches(lines, i) });
      continue;
    }
    const f2 = l.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(async\s+)?(?:\([^)]*\)|(\w+))\s*(?::\s*\([^)]*\)\s*=>\s*([^\s{]+))?\s*=>/);
    if (f2) {
      fns.push({ name: f2[1], params: [], returnType: f2[4] || 'any', decorators: [],
        lineNumber: i + 1, isAsync: !!f2[2], isPrivate: f2[1].startsWith('_'), complexity: countJsBranches(lines, i) });
    }
  }
  return fns;
}

function parseJsGlobals(lines: string[]): PortInfo[] {
  const vars: PortInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    const cm = l.match(/^(?:export\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*(?::\s*(\w+))?\s*=\s*(.+)/);
    if (cm) vars.push({ name: cm[1], type: cm[2] || inferJsType(cm[3]), default: cm[3].replace(/;$/, '').trim() });
  }
  return vars;
}

function parseJsErrors(lines: string[]): string[] {
  const errs = new Set<string>();
  for (const l of lines) {
    const t = l.match(/throw\s+new\s+(\w+)/); if (t) errs.add(t[1]);
    const c = l.match(/catch\s*\(\s*(\w+)\s*(?::\s*(\w+))?\)/); if (c && c[2]) errs.add(c[2]);
  }
  return Array.from(errs);
}

function parseJsDebug(lines: string[]): number[] {
  const pts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('try') || t.startsWith('catch') || t.startsWith('} catch')) pts.push(i + 1);
  }
  return pts;
}

function parseJsParams(s: string): PortInfo[] {
  if (!s.trim()) return [];
  const params: PortInfo[] = [];
  for (const part of splitJsParams(s)) {
    const t = part.trim(); if (!t) continue;
    let name = t, type = 'any', def: string | undefined;
    const eq = t.indexOf('=');
    if (eq > -1) { def = t.slice(eq + 1).trim(); name = t.slice(0, eq).trim(); }
    const col = name.indexOf(':');
    if (col > -1) { type = name.slice(col + 1).trim(); name = name.slice(0, col).trim(); }
    name = name.replace(/^\.\.\.|[?]$/g, '');
    if (name) params.push({ name, type, default: def });
  }
  return params;
}

function splitJsParams(s: string): string[] {
  const r: string[] = []; let d = 0, c = '';
  for (const ch of s) {
    if ('({[<'.includes(ch)) d++;
    if (')}]>'.includes(ch)) d--;
    if (ch === ',' && d === 0) { r.push(c); c = ''; } else c += ch;
  }
  if (c.trim()) r.push(c);
  return r;
}

function collectJsDecorators(lines: string[], idx: number): string[] {
  const decs: string[] = [];
  for (let j = idx - 1; j >= 0; j--) {
    const p = lines[j].trim();
    if (p.startsWith('@')) decs.unshift(p); else if (p === '') continue; else break;
  }
  return decs;
}

function countJsBranches(lines: string[], start: number): number {
  let b = 0, d = 0, started = false;
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    for (const ch of l) { if (ch === '{') { d++; started = true; } if (ch === '}') d--; }
    if (started && d <= 0) break;
    const t = l.trim();
    if (/^(if|else if|else|for|while|switch|case)\b/.test(t)) b++;
    if (/\?\s*/.test(t) && t.includes(':')) b++; // ternary
  }
  return b;
}

function countJsCodeLines(lines: string[]): number {
  let c = 0, inBlock = false;
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith('/*')) { inBlock = true; }
    if (inBlock) { if (t.includes('*/')) inBlock = false; continue; }
    if (t === '' || t.startsWith('//')) continue;
    c++;
  }
  return c;
}

function inferJsType(val: string): string {
  const v = val.trim().replace(/;$/, '');
  if (v === 'true' || v === 'false') return 'boolean';
  if (/^-?\d+$/.test(v)) return 'number';
  if (/^-?\d+\.\d+$/.test(v)) return 'number';
  if (/^['"`]/.test(v)) return 'string';
  if (v.startsWith('[')) return 'array';
  if (v.startsWith('{')) return 'object';
  return 'any';
}

function genWarnings(meta: MetaBlock | null, imports: ImportInfo[], connections: string[]): string[] {
  if (!meta) return [];
  const w: string[] = [];
  if (meta.deps) {
    const mods = new Set(imports.map(i => i.module));
    for (const d of meta.deps) { if (![...mods].some(m => m.includes(d) || d.includes(m))) w.push(`\u26a0 Meta declara dep "${d}" no encontrada en imports`); }
    for (const i of imports) { if (!meta.deps.some(d => i.module.includes(d) || d.includes(i.module))) w.push(`\u26a0 Import "${i.module}" no declarado en meta.deps`); }
  }
  return w;
}
