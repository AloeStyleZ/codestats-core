// src/parserUtils.ts
// Shared utilities across all language parsers

import { PortInfo, MethodInfo, ClassInfo, ImportInfo, MetaBlock, HardcodedValue, UnusedItem } from './types';

// ══════════════════════════════════════════════
// META BLOCK (universal — works with any comment style)
// ══════════════════════════════════════════════

export function parseMetaBlock(code: string): MetaBlock | null {
  // Supports: # ---meta, // ---meta, /* ---meta, <!-- ---meta
  const metaMatch = code.match(/(?:#|\/\/|\/?\*|<!--)\s*---meta\s*\n([\s\S]*?)\n\s*(?:#|\/\/|\*|<!--)\s*---/);
  if (!metaMatch) return null;
  const raw: Record<string, string> = {};
  for (const line of metaMatch[1].split('\n')) {
    const clean = line.replace(/^\s*(?:#|\/\/|\*|<!--)\s*/, '').trim();
    const sep = clean.indexOf(':');
    if (sep > 0) {
      const key = clean.slice(0, sep).trim();
      const val = clean.slice(sep + 1).trim();
      raw[key] = val;
    }
  }
  const parseList = (s?: string): string[] | undefined => {
    if (!s) return undefined;
    const m = s.match(/\[(.+)\]/);
    return m ? m[1].split(',').map(x => x.trim()) : [s];
  };
  return {
    name: raw['name'], type: raw['type'], desc: raw['desc'],
    inputs: parseList(raw['in']), outputs: parseList(raw['out']),
    deps: parseList(raw['deps']), methods: parseList(raw['methods']),
    errors: parseList(raw['errors']), raw
  };
}

// ══════════════════════════════════════════════
// HARDCODED VALUES (universal)
// ══════════════════════════════════════════════

export function detectHardcoded(lines: string[], commentPrefix: string): HardcodedValue[] {
  const results: HardcodedValue[] = [];
  const urlRe = /https?:\/\/[^\s"'`]+/;
  const ipRe = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
  const credRe = /(?:password|secret|key|token|api_key|apikey|passwd|credential|auth)\s*[:=]\s*["'`][^"'`]+["'`]/i;
  const portRe = /(?:port)\s*[:=]\s*\d+/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith(commentPrefix) || trimmed.startsWith('#')) continue;
    if (trimmed.includes('---meta') || trimmed.includes('---')) continue;
    if (/^(?:import |from |use |require|include)/.test(trimmed)) continue;

    const ctx = trimmed.split(/[:=]/)[0].trim().slice(0, 30);

    const credMatch = line.match(credRe);
    if (credMatch) { results.push({ value: credMatch[0], type: 'credential', lineNumber: i + 1, context: ctx }); continue; }

    const urlMatch = line.match(urlRe);
    if (urlMatch) { results.push({ value: urlMatch[0], type: 'url', lineNumber: i + 1, context: ctx }); }

    const ipMatch = line.match(ipRe);
    if (ipMatch && !urlMatch) { results.push({ value: ipMatch[0], type: 'ip', lineNumber: i + 1, context: ctx }); }

    if (portRe.test(line)) {
      const val = line.match(/[:=]\s*(\d+)/);
      if (val) results.push({ value: val[1], type: 'number', lineNumber: i + 1, context: 'port' });
    }
  }
  return results;
}

// ══════════════════════════════════════════════
// UNUSED CODE (universal)
// ══════════════════════════════════════════════

export function detectUnused(lines: string[], imports: ImportInfo[], classes: ClassInfo[], functions: MethodInfo[], commentPrefix: string): UnusedItem[] {
  const unused: UnusedItem[] = [];
  const importLineSet = new Set(imports.map(i => i.lineNumber - 1));

  const typingNames = new Set([
    'Dict', 'List', 'Set', 'Tuple', 'Optional', 'Union', 'Any', 'Type',
    'Callable', 'Iterator', 'Generator', 'Sequence', 'Mapping', 'Iterable',
    'ClassVar', 'Final', 'Literal', 'TypeVar', 'Generic', 'Protocol',
    'Awaitable', 'Coroutine', 'AsyncIterator', 'AsyncGenerator',
    'NamedTuple', 'TypedDict', 'Annotated', 'TypeAlias', 'Self',
    'FC', 'ReactNode', 'PropsWithChildren', 'ComponentType',
    'CSSProperties', 'MouseEvent', 'ChangeEvent', 'FormEvent',
  ]);

  // Strip strings and comments to avoid false positives like "config.json" matching `json`
  const codeOnly = lines.map((l, idx) => {
    if (importLineSet.has(idx)) return '';
    let s = l;
    s = s.replace(/\/\/.*$/g, '');                        // remove // comments
    s = s.replace(/#.*$/g, '');                            // remove # comments
    s = s.replace(/\/\*[\s\S]*?\*\//g, '');               // remove /* */ (single line)
    s = s.replace(/"(?:[^"\\]|\\.)*"/g, '""');             // replace "strings"
    s = s.replace(/'(?:[^'\\]|\\.)*'/g, "''");             // replace 'strings'
    s = s.replace(/`(?:[^`\\]|\\.)*`/g, '``');             // replace `template literals`
    return s;
  }).join('\n');

  for (const imp of imports) {
    for (const name of imp.names) {
      if (name === '*' || name.length <= 1) continue;
      if (/^typing|^types$|^collections\.abc/.test(imp.module) || typingNames.has(name)) continue;

      const re = new RegExp('\\b' + escRe(name) + '\\b');
      if (!re.test(codeOnly)) {
        unused.push({ name, kind: 'import', lineNumber: imp.lineNumber });
      }
    }
  }

  const allMethods = [
    ...functions.map(f => ({ name: f.name, line: f.lineNumber })),
    ...classes.flatMap(c => c.methods
      .filter(m => m.name !== '__init__' && m.name !== 'constructor' && m.name !== '__construct' && !m.name.startsWith('__'))
      .map(m => ({ name: m.name, line: m.lineNumber }))
    )
  ];

  for (const m of allMethods) {
    const callRe = new RegExp('(?:self\\.|this\\.|\\$this->|\\b)' + escRe(m.name) + '\\s*\\(');
    const linesWithout = lines.filter((_, idx) => idx !== m.line - 1).join('\n');
    if (!callRe.test(linesWithout)) {
      const refRe = new RegExp('\\b' + escRe(m.name) + '\\b');
      const defsRemoved = linesWithout.replace(/(?:def|function|async function)\s+\w+/g, '');
      if (!refRe.test(defsRemoved)) unused.push({ name: m.name, kind: 'method', lineNumber: m.line });
    }
  }
  return unused;
}

export function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ══════════════════════════════════════════════
// DESCRIPTION GENERATORS (universal)
// ══════════════════════════════════════════════

export function genFileDesc(meta: MetaBlock | null, classes: ClassInfo[], functions: MethodInfo[], imports: ImportInfo[], fileName: string): string {
  const name = meta?.name || fileName.replace(/\.\w+$/, '');
  const type = meta?.type || 'module';
  const parts: string[] = [];

  if (type === 'service' || type === 'controller') {
    const main = classes[0];
    if (main) {
      const actions = main.methods.filter(m => !m.isPrivate && m.name !== '__init__' && m.name !== 'constructor' && m.name !== '__construct');
      parts.push(`${name} contiene ${actions.length} m\u00e9todo${actions.length !== 1 ? 's' : ''} p\u00fablico${actions.length !== 1 ? 's' : ''}.`);
    }
  } else {
    parts.push(`${name} contiene ${classes.length} clase${classes.length !== 1 ? 's' : ''} y ${functions.length} funci\u00f3n${functions.length !== 1 ? 'es' : ''}.`);
  }

  const ext = imports.filter(i => !i.module.startsWith('.')).map(i => i.module);
  if (ext.length > 0) parts.push(`Deps: ${ext.slice(0, 5).join(', ')}${ext.length > 5 ? '...' : ''}.`);

  const asyncM = [...functions.filter(f => f.isAsync), ...classes.flatMap(c => c.methods.filter(m => m.isAsync))];
  if (asyncM.length > 0) parts.push(`${asyncM.length} m\u00e9todo${asyncM.length > 1 ? 's' : ''} async.`);

  return parts.join(' ');
}

export function genClassDescs(classes: ClassInfo[], _imports: ImportInfo[]): Record<string, string> {
  const d: Record<string, string> = {};
  for (const c of classes) {
    const pub = c.methods.filter(m => !m.isPrivate && m.name !== '__init__' && m.name !== 'constructor' && m.name !== '__construct');
    if (c.bases.some(b => /Error|Exception/.test(b))) {
      d[c.name] = `${c.name} es una excepci\u00f3n que extiende ${c.bases.join(', ')}.`;
    } else if (pub.length === 0 && c.attributes.length > 0) {
      d[c.name] = `${c.name} es un modelo con ${c.attributes.length} atributo${c.attributes.length > 1 ? 's' : ''}: ${c.attributes.map(a => a.name).join(', ')}.`;
    } else {
      d[c.name] = `${c.name} tiene ${pub.length} m\u00e9todo${pub.length !== 1 ? 's' : ''} p\u00fablico${pub.length !== 1 ? 's' : ''}${c.bases.length ? '. Extiende ' + c.bases.join(', ') : ''}.`;
    }
  }
  return d;
}
