// src/types.ts
// Shared interfaces for all language parsers

export interface PortInfo {
  name: string;
  type: string;
  default?: string;
}

export interface MethodInfo {
  name: string;
  params: PortInfo[];
  returnType: string;
  decorators: string[];
  lineNumber: number;
  isAsync: boolean;
  isPrivate: boolean;
  complexity: number;
}

export interface ClassInfo {
  name: string;
  bases: string[];
  methods: MethodInfo[];
  attributes: PortInfo[];
  decorators: string[];
  lineNumber: number;
}

export interface ImportInfo {
  module: string;
  names: string[];
  isFrom: boolean;
  lineNumber: number;
}

export interface MetaBlock {
  name?: string;
  type?: string;
  desc?: string;
  inputs?: string[];
  outputs?: string[];
  deps?: string[];
  methods?: string[];
  errors?: string[];
  raw: Record<string, string>;
}

export interface HardcodedValue {
  value: string;
  type: 'string' | 'number' | 'url' | 'ip' | 'path' | 'credential';
  lineNumber: number;
  context: string;
}

export interface UnusedItem {
  name: string;
  kind: 'import' | 'method' | 'variable';
  lineNumber: number;
}

export interface DiagnosticItem {
  message: string;
  severity: 'error' | 'warning' | 'info';
  lineNumber: number;
  source: string;    // e.g. "Pylance", "ESLint", "typescript"
  code: string;      // e.g. "E0001", "no-unused-vars"
}

export interface DepIssue {
  name: string;
  status: 'missing' | 'installed' | 'unknown';
  lineNumber: number;
  installCmd?: string;
}

export interface TodoItem {
  text: string;
  type: 'TODO' | 'FIXME' | 'HACK' | 'BUG' | 'NOTE';
  lineNumber: number;
}

export interface PromptEntry {
  timestamp: number;
  fileName: string;
  prompt: string;
  type: 'generate' | 'convert' | 'snippet';
}

export interface ExternalUsage {
  name: string;
  kind: 'method' | 'class' | 'function';
  usedIn: string[];  // short filenames where it's used
}

export interface FileStats {
  fileName: string;
  language: string;
  meta: MetaBlock | null;
  classes: ClassInfo[];
  functions: MethodInfo[];
  imports: ImportInfo[];
  globalVars: PortInfo[];
  connections: string[];
  errorTypes: string[];
  debugPoints: number[];
  totalLines: number;
  codeLines: number;
  warnings: string[];
  description: string;
  classDescriptions: Record<string, string>;
  hardcoded: HardcodedValue[];
  unused: UnusedItem[];
  diagnostics: DiagnosticItem[];
  depIssues: DepIssue[];
  todos: TodoItem[];
  externalUsage: ExternalUsage[];
}
