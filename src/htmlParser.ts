// src/htmlParser.ts
import { PortInfo, MethodInfo, ClassInfo, ImportInfo, MetaBlock, HardcodedValue, UnusedItem, FileStats } from './types';
import { parseMetaBlock, detectHardcoded, escRe } from './parserUtils';

export function parseHtmlCode(code: string, fileName: string): FileStats {
  const lines = code.split('\n');
  const meta = parseMetaBlock(code);
  const imports = parseHtmlImports(lines);
  const classes = parseHtmlComponents(lines);
  const functions = parseInlineScriptFunctions(lines);
  const globalVars: PortInfo[] = [];
  const errorTypes: string[] = [];
  const debugPoints: number[] = [];
  const connections = imports.map(i => i.module);
  const codeLines = countHtmlCodeLines(lines);
  const warnings: string[] = [];
  const hardcoded = detectHtmlHardcoded(lines);
  const unused = detectHtmlUnused(lines, imports, classes);
  const description = meta?.desc || genHtmlDesc(lines, classes, imports, fileName);
  const classDescriptions: Record<string, string> = {};
  classes.forEach(c => { classDescriptions[c.name] = `Secci\u00f3n <${c.name}> con ${c.attributes.length} atributo${c.attributes.length !== 1 ? 's' : ''}.`; });
  

  return {
    fileName, language: 'html', meta, classes, functions, imports, globalVars,
    connections, errorTypes, debugPoints, totalLines: lines.length, codeLines,
    warnings, description, classDescriptions, hardcoded, unused, diagnostics: [], depIssues: [], todos: [], externalUsage: []
  };
}

export function parseCssCode(code: string, fileName: string): FileStats {
  const lines = code.split('\n');
  const meta = parseMetaBlock(code);
  const selectors = parseCssSelectors(lines);
  const imports = parseCssImports(lines);
  const codeLines = countHtmlCodeLines(lines);
  const hardcoded = detectHtmlHardcoded(lines);
  const description = meta?.desc || `Hoja de estilos con ${selectors.length} selectores. ${imports.length ? 'Importa: ' + imports.map(i=>i.module).join(', ') + '.' : ''}`;

  return {
    fileName, language: 'css', meta, classes: selectors, functions: [], imports, globalVars: [],
    connections: imports.map(i => i.module), errorTypes: [], debugPoints: [],
    totalLines: lines.length, codeLines, warnings: [], description,
    classDescriptions: {}, hardcoded, unused: [], diagnostics: [], depIssues: [], todos: [], externalUsage: []
  };
}

// ── HTML IMPORTS: scripts, links, stylesheets ──
function parseHtmlImports(lines: string[]): ImportInfo[] {
  const imports: ImportInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // <script src="...">
    const scr = l.match(/<script[^>]+src=["']([^"']+)["']/);
    if (scr) imports.push({ module: scr[1], names: ['script'], isFrom: true, lineNumber: i + 1 });
    // <link rel="stylesheet" href="...">
    const lnk = l.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/);
    if (lnk && (l.includes('stylesheet') || lnk[1].endsWith('.css')))
      imports.push({ module: lnk[1], names: ['stylesheet'], isFrom: true, lineNumber: i + 1 });
    // @import in inline style
    const imp = l.match(/@import\s+(?:url\()?['"]([^'"]+)['"]/);
    if (imp) imports.push({ module: imp[1], names: ['css'], isFrom: true, lineNumber: i + 1 });
  }
  return imports;
}

// ── HTML "Components" = major structural elements ──
function parseHtmlComponents(lines: string[]): ClassInfo[] {
  const comps: ClassInfo[] = [];
  const majorTags = /^<(header|nav|main|section|article|aside|footer|form|table|div)\b([^>]*?)>?\s*$/i;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(majorTags);
    if (!m) continue;
    const tag = m[1].toLowerCase();
    const attrStr = m[2];
    const attrs = parseHtmlAttrs(attrStr);
    const idAttr = attrs.find(a => a.name === 'id');
    const classAttr = attrs.find(a => a.name === 'class');
    const name = idAttr ? `${tag}#${idAttr.type}` : classAttr ? `${tag}.${classAttr.type.split(' ')[0]}` : tag;
    comps.push({ name, bases: [tag], methods: [], attributes: attrs, decorators: [], lineNumber: i + 1 });
  }
  return comps;
}

function parseHtmlAttrs(s: string): PortInfo[] {
  const attrs: PortInfo[] = [];
  const re = /(\w[\w-]*)=["']([^"']*?)["']/g;
  let m;
  while ((m = re.exec(s)) !== null) attrs.push({ name: m[1], type: m[2] });
  return attrs;
}

// ── Inline script functions ──
function parseInlineScriptFunctions(lines: string[]): MethodInfo[] {
  const fns: MethodInfo[] = [];
  let inScript = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.includes('<script') && !l.includes('src=')) inScript = true;
    if (l.includes('</script>')) { inScript = false; continue; }
    if (!inScript) continue;
    const f = l.match(/(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
    if (f) {
      const params = f[2].split(',').filter(Boolean).map(p => ({ name: p.trim(), type: 'any' }));
      fns.push({ name: f[1], params, returnType: 'any', decorators: [],
        lineNumber: i + 1, isAsync: l.includes('async'), isPrivate: false, complexity: 0 });
    }
    const f2 = l.match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/);
    if (f2) {
      fns.push({ name: f2[1], params: [], returnType: 'any', decorators: [],
        lineNumber: i + 1, isAsync: l.includes('async'), isPrivate: false, complexity: 0 });
    }
  }
  return fns;
}

// ── CSS selectors as "classes" ──
function parseCssSelectors(lines: string[]): ClassInfo[] {
  const sels: ClassInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    const m = l.match(/^([.#@]?[\w\-:[\]=*>~+, .#]+)\s*\{/);
    if (m && !l.startsWith('/*')) {
      const props = parseCssProps(lines, i);
      sels.push({ name: m[1].trim(), bases: [], methods: [], attributes: props, decorators: [], lineNumber: i + 1 });
    }
  }
  return sels;
}

function parseCssProps(lines: string[], start: number): PortInfo[] {
  const props: PortInfo[] = [];
  let d = 0;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) { if (ch === '{') d++; if (ch === '}') d--; }
    if (i > start) {
      const pm = lines[i].trim().match(/^([\w-]+)\s*:\s*(.+?)(?:;|$)/);
      if (pm) props.push({ name: pm[1], type: pm[2].trim() });
    }
    if (d <= 0 && i > start) break;
  }
  return props;
}

function parseCssImports(lines: string[]): ImportInfo[] {
  const imports: ImportInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/@import\s+(?:url\()?['"]([^'"]+)['"]/);
    if (m) imports.push({ module: m[1], names: ['css'], isFrom: true, lineNumber: i + 1 });
  }
  return imports;
}

// ── HTML hardcoded ──
function countHtmlCodeLines(lines: string[]): number {
  let c = 0, inComment = false;
  for (const l of lines) {
    const t = l.trim();
    if (t.includes('<!--')) inComment = true;
    if (inComment) { if (t.includes('-->')) inComment = false; continue; }
    if (t === '') continue;
    c++;
  }
  return c;
}

function detectHtmlHardcoded(lines: string[]): HardcodedValue[] {
  const results: HardcodedValue[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const url = l.match(/(?:href|src|action)=["'](https?:\/\/[^"']+)["']/);
    if (url) results.push({ value: url[1], type: 'url', lineNumber: i + 1, context: url[0].split('=')[0] });
    const ip = l.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
    if (ip && !url) results.push({ value: ip[1], type: 'ip', lineNumber: i + 1, context: 'inline' });
  }
  return results;
}

// ── HTML unused ──
function detectHtmlUnused(lines: string[], imports: ImportInfo[], classes: ClassInfo[]): UnusedItem[] {
  const unused: UnusedItem[] = [];
  // Check CSS classes defined but not used (basic)
  const fullText = lines.join('\n');
  for (const imp of imports) {
    // Can't easily check external resource usage, skip
  }
  return unused;
}

// ── HTML description ──
function genHtmlDesc(lines: string[], classes: ClassInfo[], imports: ImportInfo[], fileName: string): string {
  const scripts = imports.filter(i => i.names.includes('script')).length;
  const styles = imports.filter(i => i.names.includes('stylesheet') || i.names.includes('css')).length;
  const sections = classes.length;
  return `${fileName} tiene ${sections} secciones principales, ${scripts} script${scripts !== 1 ? 's' : ''} y ${styles} stylesheet${styles !== 1 ? 's' : ''}.`;
}

// ── HTML trust ──
// end of htmlParser
