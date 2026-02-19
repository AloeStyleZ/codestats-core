// src/pythonParser.ts
// Parsea código Python y extrae stats sin depender de librerías externas.

import { PortInfo, MethodInfo, ClassInfo, ImportInfo, MetaBlock, HardcodedValue, UnusedItem, FileStats } from './types';

// Re-export for backward compat
export { PortInfo, MethodInfo, ClassInfo, ImportInfo, MetaBlock, HardcodedValue, UnusedItem, FileStats } from './types';
export function parsePythonCode(code: string, fileName: string): FileStats {
  const lines = code.split('\n');
  const meta = parseMetaBlock(code);
  const imports = parseImports(lines);
  const classes = parseClasses(lines);
  const functions = parseTopLevelFunctions(lines);
  const globalVars = parseGlobalVars(lines);
  const errorTypes = parseErrorTypes(lines);
  const debugPoints = parseDebugPoints(lines);

  // Build connections list from imports + detected calls
  const connections = buildConnections(imports, lines);

  // Calculate code lines (non-empty, non-comment, non-docstring)
  const codeLines = countCodeLines(lines);

  // Generate warnings by comparing meta vs actual
  const warnings = generateWarnings(meta, imports, classes, functions, connections);

  // Generate descriptions
  const description = meta?.desc || generateFileDescription(meta, classes, functions, imports, fileName);
  const classDescriptions = generateClassDescriptions(classes, imports);

  // New analysis
  const hardcoded = detectHardcodedValues(lines);
  const unused = detectUnusedCode(lines, imports, classes, functions);

  return {
    fileName,
    language: 'python',
    meta,
    classes,
    functions,
    imports,
    globalVars,
    connections,
    errorTypes,
    debugPoints,
    totalLines: lines.length,
    codeLines,
    warnings,
    description,
    classDescriptions,
    hardcoded,
    unused,
    diagnostics: [],
    depIssues: [],
    todos: [],
    externalUsage: []
  };
}

function parseMetaBlock(code: string): MetaBlock | null {
  // Support both raw ---meta and # ---meta (Python comments)
  const metaMatch = code.match(/#?\s*---meta\s*\n([\s\S]*?)\n#?\s*---/);
  if (!metaMatch) return null;

  const raw: Record<string, string> = {};
  const block = metaMatch[1];
  
  for (const line of block.split('\n')) {
    const cleaned = line.replace(/^#\s*/, ''); // strip Python comment prefix
    const kv = cleaned.match(/^(\w+)\s*:\s*(.+)$/);
    if (kv) {
      raw[kv[1].trim()] = kv[2].trim();
    }
  }

  const parseList = (val?: string): string[] => {
    if (!val) return [];
    // Handle [a, b, c] or a, b, c
    const cleaned = val.replace(/^\[|\]$/g, '');
    return cleaned.split(',').map(s => s.trim()).filter(Boolean);
  };

  return {
    name: raw['name'],
    type: raw['type'],
    desc: raw['desc'],
    inputs: parseList(raw['in']),
    outputs: parseList(raw['out']),
    deps: parseList(raw['deps']),
    methods: parseList(raw['methods']),
    errors: parseList(raw['errors']),
    raw
  };
}

function parseImports(lines: string[]): ImportInfo[] {
  const imports: ImportInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // from X import Y, Z
    const fromMatch = line.match(/^from\s+([\w.]+)\s+import\s+(.+)$/);
    if (fromMatch) {
      const names = fromMatch[2].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      imports.push({ module: fromMatch[1], names, isFrom: true, lineNumber: i + 1 });
      continue;
    }

    // import X, Y
    const importMatch = line.match(/^import\s+(.+)$/);
    if (importMatch) {
      const modules = importMatch[1].split(',').map(m => m.trim().split(/\s+as\s+/)[0].trim());
      for (const mod of modules) {
        imports.push({ module: mod, names: [mod], isFrom: false, lineNumber: i + 1 });
      }
    }
  }

  return imports;
}

function parseClasses(lines: string[]): ClassInfo[] {
  const classes: ClassInfo[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const classMatch = line.match(/^class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/);
    if (!classMatch) continue;

    const decorators = collectDecorators(lines, i);
    const bases = classMatch[2] ? classMatch[2].split(',').map(b => b.trim()).filter(Boolean) : [];
    const methods = parseClassMethods(lines, i);
    const attributes = parseClassAttributes(lines, i);

    classes.push({
      name: classMatch[1],
      bases,
      methods,
      attributes,
      decorators,
      lineNumber: i + 1
    });
  }

  return classes;
}

function parseClassAttributes(lines: string[], classLineIdx: number): PortInfo[] {
  const attrs: PortInfo[] = [];
  const classIndent = getIndent(lines[classLineIdx]);

  // Look inside __init__ for self.X = assignments
  for (let i = classLineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const currentIndent = getIndent(line);
    if (currentIndent <= classIndent && line.trim() !== '') break;

    const selfAttr = line.match(/self\.(\w+)\s*(?::\s*(\w+))?\s*=/);
    if (selfAttr) {
      const existing = attrs.find(a => a.name === selfAttr[1]);
      if (!existing) {
        attrs.push({ name: selfAttr[1], type: selfAttr[2] || 'Any' });
      }
    }
  }

  return attrs;
}

function parseClassMethods(lines: string[], classLineIdx: number): MethodInfo[] {
  const methods: MethodInfo[] = [];
  const classIndent = getIndent(lines[classLineIdx]);
  const methodIndent = classIndent + 4; // standard Python indent

  for (let i = classLineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;

    // Stop if we're back to class-level or less indentation (and not empty)
    const currentIndent = getIndent(line);
    if (currentIndent <= classIndent && line.trim() !== '') break;

    const defMatch = line.match(/^(\s*)(async\s+)?def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*(.+?))?\s*:/);
    if (defMatch && getIndent(line) >= methodIndent) {
      const decorators = collectDecorators(lines, i);
      const params = parseParams(defMatch[4]);
      // Remove 'self' and 'cls' from params
      const filteredParams = params.filter(p => p.name !== 'self' && p.name !== 'cls');
      
      methods.push({
        name: defMatch[3],
        params: filteredParams,
        returnType: defMatch[5]?.trim() || 'Any',
        decorators,
        lineNumber: i + 1,
        isAsync: !!defMatch[2],
        isPrivate: defMatch[3].startsWith('_'),
        complexity: countBranches(lines, i)
      });
    }
  }

  return methods;
}

function parseTopLevelFunctions(lines: string[]): MethodInfo[] {
  const functions: MethodInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const defMatch = line.match(/^(async\s+)?def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*(.+?))?\s*:/);
    if (!defMatch) continue;

    const decorators = collectDecorators(lines, i);
    const params = parseParams(defMatch[3]);

    functions.push({
      name: defMatch[2],
      params,
      returnType: defMatch[4]?.trim() || 'Any',
      decorators,
      lineNumber: i + 1,
      isAsync: !!defMatch[1],
      isPrivate: defMatch[2].startsWith('_'),
      complexity: countBranches(lines, i)
    });
  }

  return functions;
}

function parseParams(paramStr: string): PortInfo[] {
  if (!paramStr.trim()) return [];
  
  const params: PortInfo[] = [];
  // Simple split - doesn't handle nested generics perfectly but works for most cases
  const parts = splitParams(paramStr);
  
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === '*' || trimmed === '/') continue;
    if (trimmed.startsWith('**') || trimmed.startsWith('*')) {
      const clean = trimmed.replace(/^\*{1,2}/, '');
      const [name, type] = splitNameType(clean);
      params.push({ name: `${trimmed.startsWith('**') ? '**' : '*'}${name}`, type: type || 'Any' });
      continue;
    }

    let defaultVal: string | undefined;
    let mainPart = trimmed;
    
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > -1) {
      defaultVal = trimmed.slice(eqIdx + 1).trim();
      mainPart = trimmed.slice(0, eqIdx).trim();
    }

    const [name, type] = splitNameType(mainPart);
    params.push({ name, type: type || 'Any', default: defaultVal });
  }

  return params;
}

function splitParams(paramStr: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = '';
  
  for (const ch of paramStr) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) result.push(current);
  return result;
}

function splitNameType(s: string): [string, string] {
  const colonIdx = s.indexOf(':');
  if (colonIdx === -1) return [s.trim(), 'Any'];
  return [s.slice(0, colonIdx).trim(), s.slice(colonIdx + 1).trim()];
}

function parseGlobalVars(lines: string[]): PortInfo[] {
  const vars: PortInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (getIndent(line) !== 0) continue;
    
    // UPPER_CASE = value (constants)
    const constMatch = line.match(/^([A-Z_][A-Z0-9_]*)\s*(?::\s*(\w+))?\s*=\s*(.+)$/);
    if (constMatch) {
      vars.push({
        name: constMatch[1],
        type: constMatch[2] || inferType(constMatch[3]),
        default: constMatch[3].trim()
      });
    }
  }

  return vars;
}

function inferType(value: string): string {
  const v = value.trim();
  if (v === 'True' || v === 'False') return 'bool';
  if (/^-?\d+$/.test(v)) return 'int';
  if (/^-?\d+\.\d+$/.test(v)) return 'float';
  if (/^["']/.test(v)) return 'str';
  if (v.startsWith('[')) return 'list';
  if (v.startsWith('{')) return 'dict';
  if (v.startsWith('(')) return 'tuple';
  return 'Any';
}

function parseErrorTypes(lines: string[]): string[] {
  const errors = new Set<string>();

  for (const line of lines) {
    const raiseMatch = line.match(/raise\s+(\w+)/);
    if (raiseMatch) errors.add(raiseMatch[1]);

    const exceptMatch = line.match(/except\s+(\w+)/);
    if (exceptMatch && exceptMatch[1] !== 'Exception') errors.add(exceptMatch[1]);
  }

  return Array.from(errors);
}

function parseDebugPoints(lines: string[]): number[] {
  const points: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('try:') || trimmed.startsWith('except ') || trimmed.startsWith('except:')) {
      points.push(i + 1);
    }
  }
  return points;
}

function collectDecorators(lines: string[], defLineIdx: number): string[] {
  const decorators: string[] = [];
  for (let j = defLineIdx - 1; j >= 0; j--) {
    const prev = lines[j].trim();
    if (prev.startsWith('@')) {
      decorators.unshift(prev);
    } else if (prev === '') {
      continue;
    } else {
      break;
    }
  }
  return decorators;
}

function getIndent(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function countBranches(lines: string[], startIdx: number): number {
  let branches = 0;
  const baseIndent = getIndent(lines[startIdx]);

  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = getIndent(line);
    if (indent <= baseIndent && line.trim() !== '') break;

    const trimmed = line.trim();
    if (/^(if|elif|else|for|while|except|case)\b/.test(trimmed)) branches++;
    if (/\bif\b/.test(trimmed) && !trimmed.startsWith('if') && !trimmed.startsWith('elif')) branches++; // inline if
  }

  return branches;
}

function buildConnections(imports: ImportInfo[], lines: string[]): string[] {
  const conns = new Set<string>();

  for (const imp of imports) {
    conns.add(imp.module);
    for (const name of imp.names) {
      if (name !== '*') conns.add(name);
    }
  }

  return Array.from(conns);
}

function countCodeLines(lines: string[]): number {
  let count = 0;
  let inDocstring = false;

  for (const line of lines) {
    const trimmed = line.trim();
    
    if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
      const quote = trimmed.slice(0, 3);
      if (inDocstring) {
        inDocstring = false;
        continue;
      }
      // Check if docstring opens and closes on same line
      if (trimmed.length > 3 && trimmed.endsWith(quote)) {
        continue; // single-line docstring, skip
      }
      inDocstring = true;
      continue;
    }

    if (inDocstring) continue;
    if (trimmed === '') continue;
    if (trimmed.startsWith('#')) continue;

    count++;
  }

  return count;
}

function generateWarnings(
  meta: MetaBlock | null,
  imports: ImportInfo[],
  classes: ClassInfo[],
  functions: MethodInfo[],
  connections: string[]
): string[] {
  // Meta block is for prompt generation only — no runtime validation needed
  return [];
}

function generateFileDescription(
  meta: MetaBlock | null,
  classes: ClassInfo[],
  functions: MethodInfo[],
  imports: ImportInfo[],
  fileName: string
): string {
  const name = meta?.name || fileName.replace(/\.py$/, '');
  const type = meta?.type || 'module';
  const parts: string[] = [];

  // Main purpose based on type and content
  if (type === 'service') {
    const mainClass = classes.find(c => c.name.toLowerCase().includes('service')) || classes[0];
    if (mainClass) {
      const actions = mainClass.methods
        .filter(m => m.name !== '__init__' && !m.isPrivate)
        .map(m => describeMethod(m))
        .filter(Boolean);
      parts.push(`${name} es un servicio que ${actions.length > 0 ? actions.join(', ') : 'gestiona operaciones de negocio'}.`);
    } else {
      parts.push(`${name} es un servicio.`);
    }
  } else if (type === 'model') {
    const models = classes.filter(c => !c.bases.some(b => /Error|Exception/.test(b)));
    if (models.length > 0) {
      const attrs = models[0].attributes.map(a => a.name).join(', ');
      parts.push(`${name} define el modelo de datos ${models[0].name}${attrs ? ' con atributos: ' + attrs : ''}.`);
    }
  } else if (type === 'controller') {
    parts.push(`${name} maneja las rutas y peticiones HTTP del recurso.`);
  } else if (type === 'util') {
    const fnNames = functions.map(f => f.name).join(', ');
    parts.push(`${name} provee funciones utilitarias: ${fnNames}.`);
  } else {
    parts.push(`${name} es un m\u00F3dulo que contiene ${classes.length} clase${classes.length !== 1 ? 's' : ''} y ${functions.length} funci\u00F3n${functions.length !== 1 ? 'es' : ''}.`);
  }

  // Deps summary
  const externalDeps = imports.filter(i => !i.module.startsWith('.')).map(i => i.module);
  if (externalDeps.length > 0) {
    parts.push(`Depende de: ${externalDeps.join(', ')}.`);
  }

  // Async note
  const asyncMethods = [
    ...functions.filter(f => f.isAsync),
    ...classes.flatMap(c => c.methods.filter(m => m.isAsync))
  ];
  if (asyncMethods.length > 0) {
    parts.push(`Usa operaciones as\u00EDncronas (${asyncMethods.length} m\u00E9todo${asyncMethods.length > 1 ? 's' : ''} async).`);
  }

  return parts.join(' ');
}

function generateClassDescriptions(classes: ClassInfo[], imports: ImportInfo[]): Record<string, string> {
  const descs: Record<string, string> = {};

  for (const cls of classes) {
    const parts: string[] = [];

    // Is it an exception?
    if (cls.bases.some(b => /Error|Exception/.test(b))) {
      parts.push(`${cls.name} es una excepci\u00F3n personalizada que extiende ${cls.bases.join(', ')}.`);
      descs[cls.name] = parts.join(' ');
      continue;
    }

    // Describe based on methods
    const publicMethods = cls.methods.filter(m => m.name !== '__init__' && !m.isPrivate);
    
    if (publicMethods.length === 0) {
      // Data class / model
      if (cls.attributes.length > 0) {
        parts.push(`${cls.name} es un modelo de datos con ${cls.attributes.length} atributo${cls.attributes.length > 1 ? 's' : ''}: ${cls.attributes.map(a => a.name).join(', ')}.`);
      } else {
        parts.push(`${cls.name} es una clase base.`);
      }
    } else {
      // Service/handler class
      const actions = publicMethods.map(m => describeMethod(m)).filter(Boolean);
      parts.push(`${cls.name} ${actions.length > 0 ? actions.join(', ') : 'contiene ' + publicMethods.length + ' m\u00E9todo' + (publicMethods.length > 1 ? 's' : '') + ' p\u00FAblico' + (publicMethods.length > 1 ? 's' : '')}.`);
    }

    // Init dependencies
    const init = cls.methods.find(m => m.name === '__init__');
    if (init && init.params.length > 0) {
      parts.push(`Recibe ${init.params.map(p => p.name).join(', ')} en su constructor.`);
    }

    // Inheritance
    if (cls.bases.length > 0 && !cls.bases.some(b => /Error|Exception/.test(b))) {
      parts.push(`Extiende ${cls.bases.join(', ')}.`);
    }

    descs[cls.name] = parts.join(' ');
  }

  return descs;
}

function describeMethod(m: MethodInfo): string {
  const name = m.name;
  // Try to extract verb from method name
  const parts = name.split('_');
  const verb = parts[0];
  const subject = parts.slice(1).join(' ');

  const verbMap: Record<string, string> = {
    'get': 'obtiene', 'find': 'busca', 'search': 'busca',
    'create': 'crea', 'add': 'agrega', 'insert': 'inserta',
    'update': 'actualiza', 'edit': 'edita', 'modify': 'modifica',
    'delete': 'elimina', 'remove': 'remueve', 'destroy': 'destruye',
    'validate': 'valida', 'check': 'verifica', 'verify': 'verifica',
    'send': 'env\u00EDa', 'emit': 'emite', 'notify': 'notifica',
    'save': 'guarda', 'store': 'almacena', 'persist': 'persiste',
    'load': 'carga', 'fetch': 'obtiene', 'retrieve': 'recupera',
    'process': 'procesa', 'handle': 'maneja', 'execute': 'ejecuta',
    'convert': 'convierte', 'transform': 'transforma', 'parse': 'parsea',
    'init': 'inicializa', 'setup': 'configura', 'configure': 'configura',
    'login': 'autentica', 'logout': 'cierra sesi\u00F3n', 'auth': 'autentica',
    'register': 'registra', 'signup': 'registra',
    'list': 'lista', 'count': 'cuenta', 'filter': 'filtra',
    'sort': 'ordena', 'group': 'agrupa', 'merge': 'combina',
    'export': 'exporta', 'import': 'importa', 'download': 'descarga',
    'upload': 'sube', 'sync': 'sincroniza', 'refresh': 'refresca',
    'start': 'inicia', 'stop': 'detiene', 'run': 'ejecuta',
    'open': 'abre', 'close': 'cierra', 'connect': 'conecta',
    'disconnect': 'desconecta', 'reset': 'reinicia', 'clear': 'limpia',
    'set': 'establece', 'enable': 'habilita', 'disable': 'deshabilita',
    'show': 'muestra', 'hide': 'oculta', 'render': 'renderiza',
    'build': 'construye', 'generate': 'genera', 'compute': 'calcula',
    'calculate': 'calcula', 'compare': 'compara', 'format': 'formatea',
    'log': 'registra', 'track': 'rastrea', 'monitor': 'monitorea',
    'subscribe': 'suscribe', 'unsubscribe': 'desuscribe', 'publish': 'publica',
    'map': 'mapea', 'reduce': 'reduce', 'collect': 'recolecta',
    'assign': 'asigna', 'allocate': 'asigna', 'distribute': 'distribuye',
    'lock': 'bloquea', 'unlock': 'desbloquea', 'encrypt': 'encripta',
    'decrypt': 'desencripta', 'hash': 'hashea', 'sign': 'firma',
    'schedule': 'programa', 'queue': 'encola', 'retry': 'reintenta',
    'rollback': 'revierte', 'commit': 'confirma', 'migrate': 'migra',
    'backup': 'respalda', 'restore': 'restaura', 'archive': 'archiva',
    'test': 'prueba', 'mock': 'simula', 'stub': 'simula',
    'assert': 'verifica', 'expect': 'espera', 'match': 'coincide',
    'is': 'verifica si es', 'has': 'verifica si tiene', 'can': 'verifica si puede',
  };

  const spanishVerb = verbMap[verb.toLowerCase()];
  if (spanishVerb && subject) {
    const retType = m.returnType !== 'Any' && m.returnType !== 'None' ? ` (retorna ${m.returnType})` : '';
    return `${spanishVerb} ${subject}${retType}`;
  }
  
  return '';
}

// ══════════════════════════════════════════════
// HARDCODED VALUES DETECTION
// ══════════════════════════════════════════════

function detectHardcodedValues(lines: string[]): HardcodedValue[] {
  const results: HardcodedValue[] = [];
  const urlRe = /https?:\/\/[^\s"']+/;
  const ipRe = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
  const pathRe = /["']\/[\w\-\/\.]+["']/;
  const credRe = /(?:password|secret|key|token|api_key|apikey|passwd|credential)\s*=\s*["'][^"']+["']/i;
  const portRe = /(?:port)\s*=\s*\d+/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;
    // Skip meta block
    if (trimmed.startsWith('# ---meta') || trimmed.startsWith('# ---')) continue;
    // Skip imports
    if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) continue;

    // Credentials (highest priority)
    const credMatch = line.match(credRe);
    if (credMatch) {
      const ctx = trimmed.split('=')[0].trim();
      results.push({ value: credMatch[0], type: 'credential', lineNumber: i + 1, context: ctx });
      continue; // don't double-count
    }

    // URLs
    const urlMatch = line.match(urlRe);
    if (urlMatch && !trimmed.startsWith('#')) {
      const ctx = trimmed.split('=')[0].trim();
      results.push({ value: urlMatch[0], type: 'url', lineNumber: i + 1, context: ctx });
    }

    // IPs
    const ipMatch = line.match(ipRe);
    if (ipMatch && !urlMatch) {
      results.push({ value: ipMatch[0], type: 'ip', lineNumber: i + 1, context: trimmed.split('=')[0].trim() });
    }

    // File paths
    const pathMatch = line.match(pathRe);
    if (pathMatch && !urlMatch) {
      results.push({ value: pathMatch[0], type: 'path', lineNumber: i + 1, context: trimmed.split('=')[0].trim() });
    }

    // Port assignments
    if (portRe.test(line)) {
      const val = line.match(/=\s*(\d+)/);
      if (val) results.push({ value: val[1], type: 'number', lineNumber: i + 1, context: 'port' });
    }

    // Hardcoded strings in assignments (not in function calls, not short)
    const assignStr = trimmed.match(/^(\w+)\s*=\s*["']([^"']{8,})["']\s*$/);
    if (assignStr && !/^[A-Z_]+$/.test(assignStr[1]) === false) {
      // Only flag non-constant assignments with long strings
      const varName = assignStr[1];
      if (!/^[A-Z_]+$/.test(varName)) {
        results.push({ value: assignStr[2], type: 'string', lineNumber: i + 1, context: varName });
      }
    }
  }

  return results;
}

// ══════════════════════════════════════════════
// UNUSED CODE DETECTION
// ══════════════════════════════════════════════

function detectUnusedCode(lines: string[], imports: ImportInfo[], classes: ClassInfo[], functions: MethodInfo[]): UnusedItem[] {
  const unused: UnusedItem[] = [];
  const importLineSet = new Set(imports.map(i => i.lineNumber - 1));

  const typingSkip = new Set([
    'Dict', 'List', 'Set', 'Tuple', 'Optional', 'Union', 'Any', 'Type',
    'Callable', 'Iterator', 'Generator', 'Sequence', 'Mapping', 'Iterable',
    'ClassVar', 'Final', 'Literal', 'TypeVar', 'Generic', 'Protocol',
    'Awaitable', 'Coroutine', 'AsyncIterator', 'AsyncGenerator',
    'NamedTuple', 'TypedDict', 'Annotated', 'TypeAlias', 'Self',
  ]);

  // Strip strings and comments so we don't match inside "config.json" or # json comment
  const codeOnly = lines.map((l, idx) => {
    if (importLineSet.has(idx)) return ''; // skip import lines
    let s = l;
    s = s.replace(/#.*$/g, '');                           // remove # comments
    s = s.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '');  // remove triple-quoted (single line)
    s = s.replace(/"(?:[^"\\]|\\.)*"/g, '""');            // replace "strings" with empty
    s = s.replace(/'(?:[^'\\]|\\.)*'/g, "''");            // replace 'strings' with empty
    s = s.replace(/f"(?:[^"\\]|\\.)*"/g, '""');           // f-strings
    s = s.replace(/f'(?:[^'\\]|\\.)*'/g, "''");
    return s;
  }).join('\n');

  for (const imp of imports) {
    for (const name of imp.names) {
      if (name === '*' || name.length <= 1) continue;
      if (/^typing/.test(imp.module) || typingSkip.has(name)) continue;

      // Search in code-only text (strings/comments stripped)
      const re = new RegExp('\\b' + escapeRegex(name) + '\\b');
      if (!re.test(codeOnly)) {
        unused.push({ name, kind: 'import', lineNumber: imp.lineNumber });
      }
    }
  }

  // Unused methods: defined but never called elsewhere in the file
  const allMethods = [
    ...functions.map(f => ({ name: f.name, line: f.lineNumber })),
    ...classes.flatMap(c => c.methods
      .filter(m => m.name !== '__init__' && !m.name.startsWith('__'))
      .map(m => ({ name: m.name, line: m.lineNumber }))
    )
  ];

  for (const m of allMethods) {
    // Check if method name appears as a call somewhere (name followed by '(' or referenced)
    const callRe = new RegExp('(?:self\\.|\\b)' + escapeRegex(m.name) + '\\s*\\(');
    // Remove the def line itself from search
    const linesWithout = lines.filter((_, idx) => idx !== m.line - 1).join('\n');
    if (!callRe.test(linesWithout)) {
      // Also check if it's referenced without call (as callback)
      const refRe = new RegExp('\\b' + escapeRegex(m.name) + '\\b');
      const defsRemoved = linesWithout.replace(/def\s+\w+/g, '');
      if (!refRe.test(defsRemoved)) {
        unused.push({ name: m.name, kind: 'method', lineNumber: m.line });
      }
    }
  }

  return unused;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// end of pythonParser
