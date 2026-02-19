// src/extension.ts — CodeStats-Core
import * as vscode from 'vscode';
import { FileStats, PromptEntry, DiagnosticItem, ExternalUsage } from './types';
import { parseCode, isSupported, getSupportedLanguages } from './languageRouter';
import { generatePytestCode, generatePromptTemplate } from './testGenerator';
import { StatsViewProvider } from './statsViewProvider';
import { checkDependencies, extractSnippetPrompt } from './analyzers';

let statsProvider: StatsViewProvider;
let lastStats: FileStats | null = null;
let promptHistory: PromptEntry[] = [];

// ── Short file name: parent/file.py ──
function shortName(fullPath: string): string {
  const sep = fullPath.includes('\\') ? '\\' : '/';
  const parts = fullPath.split(sep).filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 2] + '/' + parts[parts.length - 1];
  return parts[parts.length - 1] || 'unknown';
}

// ── Collect VS Code diagnostics for a specific file ──
function collectDiagnostics(uri: vscode.Uri): DiagnosticItem[] {
  const diags = vscode.languages.getDiagnostics(uri);
  return diags.map(d => ({
    message: d.message,
    severity: d.severity === vscode.DiagnosticSeverity.Error ? 'error'
            : d.severity === vscode.DiagnosticSeverity.Warning ? 'warning' : 'info',
    lineNumber: d.range.start.line + 1,
    source: d.source || '',
    code: typeof d.code === 'object' ? String(d.code.value) : d.code ? String(d.code) : ''
  }));
}

// ── Decoration types ──
const highlightDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(59, 130, 246, 0.12)',
  borderColor: 'rgba(59, 130, 246, 0.4)',
  borderWidth: '0 0 0 3px',
  borderStyle: 'solid',
  isWholeLine: true,
  overviewRulerColor: 'rgba(59, 130, 246, 0.6)',
  overviewRulerLane: vscode.OverviewRulerLane.Left,
});

const highlightLineDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(59, 130, 246, 0.22)',
  isWholeLine: true,
  fontWeight: 'bold',
});

function findBlockEnd(lines: string[], startLine: number): number {
  const startIndent = lines[startLine].search(/\S/);
  if (startIndent < 0) return startLine;
  let end = startLine;
  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') { end = i; continue; }
    if (line.search(/\S/) <= startIndent) break;
    end = i;
  }
  return end;
}

function highlightBlock(editor: vscode.TextEditor, line: number) {
  const lines = editor.document.getText().split('\n');
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length) return;
  const blockEnd = findBlockEnd(lines, idx);
  editor.setDecorations(highlightLineDecoration, [{ range: new vscode.Range(idx, 0, idx, lines[idx].length) }]);
  const body: vscode.DecorationOptions[] = [];
  for (let i = idx + 1; i <= blockEnd; i++) body.push({ range: new vscode.Range(i, 0, i, lines[i]?.length || 0) });
  editor.setDecorations(highlightDecoration, body);
}

function clearHighlights(editor: vscode.TextEditor) {
  editor.setDecorations(highlightLineDecoration, []);
  editor.setDecorations(highlightDecoration, []);
}

// ── Get Python interpreter path (supports conda, venv, pyenv) ──
async function getPythonPath(): Promise<string> {
  // 1. Try VS Code's Python extension API (knows about conda, venv, pyenv)
  try {
    const pythonExt = vscode.extensions.getExtension('ms-python.python');
    if (pythonExt) {
      if (!pythonExt.isActive) await pythonExt.activate();
      const api = pythonExt.exports;
      // New API (2023+)
      if (api?.environments?.getActiveEnvironmentPath) {
        const env = api.environments.getActiveEnvironmentPath();
        if (env?.path) return env.path;
      }
      // Legacy API
      if (api?.settings?.getExecutionDetails) {
        const details = api.settings.getExecutionDetails(vscode.workspace.workspaceFolders?.[0]?.uri);
        if (details?.execCommand?.[0]) return details.execCommand[0];
      }
    }
  } catch {}

  // 2. Try VS Code setting python.defaultInterpreterPath
  const config = vscode.workspace.getConfiguration('python');
  const configPath = config.get<string>('defaultInterpreterPath');
  if (configPath && configPath !== 'python') return configPath;

  // 3. Check common environment variables
  if (process.env.CONDA_PREFIX) {
    const isWin = process.platform === 'win32';
    const condaPython = require('path').join(process.env.CONDA_PREFIX, isWin ? 'python.exe' : 'bin/python');
    if (require('fs').existsSync(condaPython)) return condaPython;
  }
  if (process.env.VIRTUAL_ENV) {
    const isWin = process.platform === 'win32';
    const venvPython = require('path').join(process.env.VIRTUAL_ENV, isWin ? 'Scripts\\python.exe' : 'bin/python');
    if (require('fs').existsSync(venvPython)) return venvPython;
  }

  // 4. Fallback
  return 'python';
}

// ── Scan workspace for external usage of methods/classes from this file ──
async function scanExternalUsage(doc: vscode.TextDocument, stats: FileStats): Promise<ExternalUsage[]> {
  const results: ExternalUsage[] = [];

  // Collect all public names to search for
  const names: { name: string; kind: ExternalUsage['kind'] }[] = [];
  for (const cls of stats.classes) {
    names.push({ name: cls.name, kind: 'class' });
  }
  for (const cls of stats.classes) {
    for (const m of cls.methods) {
      if (m.name.startsWith('_')) continue; // skip private
      names.push({ name: m.name, kind: 'method' });
    }
  }
  for (const f of stats.functions) {
    if (f.name.startsWith('_')) continue;
    names.push({ name: f.name, kind: 'function' });
  }

  if (names.length === 0) return [];

  // Get the base name of current file (without extension) to detect imports of this module
  const currentFile = doc.fileName;
  const baseName = require('path').basename(currentFile).replace(/\.\w+$/, '');

  // Search workspace files (limit to supported languages, exclude current file)
  const langGlob = '**/*.{py,js,ts,jsx,tsx,php}';
  try {
    const files = await vscode.workspace.findFiles(langGlob, '**/node_modules/**', 50);

    for (const fileUri of files) {
      if (fileUri.fsPath === currentFile) continue;
      try {
        const content = (await vscode.workspace.fs.readFile(fileUri)).toString();
        const shortFile = shortName(fileUri.fsPath);

        for (const item of names) {
          // Check if this file references the name
          const re = new RegExp('\\b' + item.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
          if (re.test(content)) {
            const existing = results.find(r => r.name === item.name);
            if (existing) {
              if (!existing.usedIn.includes(shortFile)) existing.usedIn.push(shortFile);
            } else {
              results.push({ name: item.name, kind: item.kind, usedIn: [shortFile] });
            }
          }
        }
      } catch {}
    }
  } catch {}

  return results;
}

// ── Auto-analyze a document ──
async function analyzeDoc(doc: vscode.TextDocument) {
  if (!isSupported(doc.languageId)) return;
  const code = doc.getText();
  const fileName = shortName(doc.fileName);
  lastStats = parseCode(code, fileName, doc.languageId);
  lastStats.depIssues = checkDependencies(lastStats.imports, doc.fileName, doc.languageId);
  lastStats.diagnostics = collectDiagnostics(doc.uri);

  // Scan external usage (async, updates panel when done)
  lastStats.externalUsage = await scanExternalUsage(doc, lastStats);

  // Filter unused: remove items that are used externally
  const externalNames = new Set(lastStats.externalUsage.map(e => e.name));
  lastStats.unused = lastStats.unused.filter(u => !externalNames.has(u.name));

  statsProvider.updateStats(lastStats);
}

export function activate(context: vscode.ExtensionContext) {
  statsProvider = new StatsViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(StatsViewProvider.viewType, statsProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // Jump + highlight
  statsProvider.onJumpToLine((line: number) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const pos = new vscode.Position(line - 1, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    highlightBlock(editor, line);
  });

  // Clear highlights on click
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.kind === vscode.TextEditorSelectionChangeKind.Mouse) clearHighlights(e.textEditor);
    })
  );

  // ══════ AUTO-ANALYZE: when you open/switch to a file ══════
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document) analyzeDoc(editor.document);
    })
  );

  // Auto-analyze on save
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => analyzeDoc(doc))
  );

  // ══════ RE-ANALYZE when diagnostics change (errors appear after running/compiling) ══════
  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics((e) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      // Only re-analyze if the diagnostics change affects the current file
      const currentUri = editor.document.uri.toString();
      const affected = e.uris.some(u => u.toString() === currentUri);
      if (affected) analyzeDoc(editor.document);
    })
  );

  // Analyze current file on activation
  if (vscode.window.activeTextEditor) {
    analyzeDoc(vscode.window.activeTextEditor.document);
  }

  // ══════ COMMANDS (still available via Ctrl+Shift+P) ══════

  // Manual analyze
  context.subscriptions.push(
    vscode.commands.registerCommand('codestat.analyze', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('CodeStats-Core: No hay archivo abierto.'); return; }
      if (!isSupported(editor.document.languageId)) {
        vscode.window.showWarningMessage(`CodeStats-Core: "${editor.document.languageId}" no soportado. Soportados: ${getSupportedLanguages().join(', ')}`);
        return;
      }
      analyzeDoc(editor.document);
      vscode.window.showInformationMessage(`⚡ CodeStats-Core: Analizado ${shortName(editor.document.fileName)}`);
    })
  );

  // Copy prompt (generate new)
  context.subscriptions.push(
    vscode.commands.registerCommand('codestat.copyPrompt', async () => {
      const prompt = generatePromptTemplate();
      await vscode.env.clipboard.writeText(prompt);
      const editor = vscode.window.activeTextEditor;
      promptHistory.push({ timestamp: Date.now(), fileName: editor ? shortName(editor.document.fileName) : '', prompt, type: 'generate' });
      statsProvider.updatePromptHistory(promptHistory);
      vscode.window.showInformationMessage('CodeStats-Core: Prompt para GENERAR copiado.');
    })
  );

  // Copy convert prompt
  context.subscriptions.push(
    vscode.commands.registerCommand('codestat.copyConvertPrompt', async () => {
      const editor = vscode.window.activeTextEditor;
      const code = editor ? editor.document.getText() : '';
      const convertPrompt = `Convierte el siguiente código al formato CodeStat.

INSTRUCCIONES:
1. Analiza el código y genera un bloque meta al inicio (usa el estilo de comentario del lenguaje):

// ---meta (JS/TS/PHP) o # ---meta (Python)
// name: [nombre del componente]
// type: [service|controller|model|util|repository]
// desc: [qué hace en 1-2 oraciones]
// in: [parámetros de entrada]
// out: [tipos de retorno]
// deps: [dependencias]
// methods: [métodos públicos(firma)]
// errors: [excepciones]
// ---

2. Incluye el código ORIGINAL sin modificar
3. Agrega type hints donde falten
4. NO cambies lógica ni borres código

CÓDIGO A CONVERTIR:
${code}`;
      await vscode.env.clipboard.writeText(convertPrompt);
      promptHistory.push({ timestamp: Date.now(), fileName: editor ? shortName(editor.document.fileName) : '', prompt: convertPrompt, type: 'convert' });
      statsProvider.updatePromptHistory(promptHistory);
      vscode.window.showInformationMessage('CodeStats-Core: Prompt para CONVERTIR copiado con tu código.');
    })
  );

  // ══════ SNIPPET EXTRACTOR ══════
  context.subscriptions.push(
    vscode.commands.registerCommand('codestat.extractSnippet', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !lastStats) {
        vscode.window.showWarningMessage('CodeStats-Core: Analiza un archivo primero.');
        return;
      }
      // Collect all methods
      const items: vscode.QuickPickItem[] = [];
      for (const cls of lastStats.classes) {
        for (const m of cls.methods) {
          if (m.name === '__init__' || m.name === 'constructor' || m.name === '__construct') continue;
          items.push({ label: `${cls.name}.${m.name}()`, description: `L${m.lineNumber} · ${m.returnType}`, detail: m.params.map(p => p.name).join(', ') });
        }
      }
      for (const f of lastStats.functions) {
        items.push({ label: `${f.name}()`, description: `L${f.lineNumber} · ${f.returnType}`, detail: f.params.map(p => p.name).join(', ') });
      }
      if (items.length === 0) {
        vscode.window.showWarningMessage('CodeStats-Core: No hay métodos para extraer.');
        return;
      }
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Selecciona un método para generar prompt de mejora' });
      if (!pick) return;

      // Find the method
      const lines = editor.document.getText().split('\n');
      let method: any = null;
      let cls: any = null;
      for (const c of lastStats.classes) {
        for (const m of c.methods) {
          if (pick.label === `${c.name}.${m.name}()`) { method = m; cls = c; break; }
        }
        if (method) break;
      }
      if (!method) {
        for (const f of lastStats.functions) {
          if (pick.label === `${f.name}()`) { method = f; break; }
        }
      }
      if (!method) return;

      const snippet = extractSnippetPrompt(lines, method, cls, lastStats.imports, lastStats.language);
      await vscode.env.clipboard.writeText(snippet);
      promptHistory.push({ timestamp: Date.now(), fileName: shortName(editor.document.fileName), prompt: snippet, type: 'snippet' });
      statsProvider.updatePromptHistory(promptHistory);
      vscode.window.showInformationMessage(`CodeStats-Core: Prompt para mejorar ${method.name}() copiado.`);
    })
  );

  // ══════ SHOW PROMPT HISTORY ══════
  context.subscriptions.push(
    vscode.commands.registerCommand('codestat.showPromptHistory', async () => {
      if (promptHistory.length === 0) {
        vscode.window.showInformationMessage('CodeStats-Core: No hay prompts en el historial.');
        return;
      }
      const items = promptHistory.map((p, i) => ({
        label: `${p.type.toUpperCase()} · ${p.fileName}`,
        description: new Date(p.timestamp).toLocaleTimeString(),
        detail: p.prompt.slice(0, 80) + '...',
        idx: i
      })).reverse();
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Selecciona un prompt para copiar' });
      if (pick) {
        await vscode.env.clipboard.writeText(promptHistory[(pick as any).idx].prompt);
        vscode.window.showInformationMessage('CodeStats-Core: Prompt copiado al clipboard.');
      }
    })
  );

  // Generate tests (Python only)
  context.subscriptions.push(
    vscode.commands.registerCommand('codestat.generateTests', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('CodeStats-Core: No hay archivo abierto.'); return; }
      if (editor.document.languageId !== 'python') {
        vscode.window.showWarningMessage('CodeStats-Core: Tests solo disponible para Python.');
        return;
      }
      const code = editor.document.getText();
      const fileName = shortName(editor.document.fileName);
      const stats = parseCode(code, fileName, 'python');
      const testCode = generatePytestCode(stats);
      const newDoc = await vscode.workspace.openTextDocument({ content: testCode, language: 'python' });
      await vscode.window.showTextDocument(newDoc, vscode.ViewColumn.Beside);
      vscode.window.showInformationMessage(`⚡ CodeStats-Core: Tests generados`);
    })
  );

  // ══════ VERIFY DEPENDENCIES ══════
  context.subscriptions.push(
    vscode.commands.registerCommand('codestat.verifyDeps', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !lastStats) {
        vscode.window.showWarningMessage('CodeStats-Core: No hay archivo analizado.');
        return;
      }

      const lang = editor.document.languageId;
      const deps = lastStats.depIssues;
      if (deps.length === 0) {
        vscode.window.showInformationMessage('CodeStats-Core: No hay dependencias externas.');
        return;
      }

      // Get the Python interpreter that VS Code / the user is actually using
      const pythonPath = await getPythonPath();

      vscode.window.showInformationMessage(`CodeStats-Core: Verificando ${deps.length} dependencias...`);
      const cp = require('child_process');
      const fileDir = require('path').dirname(editor.document.fileName);
      let installed = 0, missing = 0;

      for (const dep of deps) {
        let checkCmd = '';
        if (lang === 'python') {
          const mod = dep.name.replace(/-/g, '_');
          checkCmd = `"${pythonPath}" -c "import importlib; importlib.import_module('${mod}')"`;
        } else if (lang.startsWith('javascript') || lang.startsWith('typescript')) {
          checkCmd = `node -e "require.resolve('${dep.name}')"`;
        } else if (lang === 'php') {
          checkCmd = `composer show ${dep.name}`;
        }
        if (!checkCmd) continue;

        try {
          cp.execSync(checkCmd, { cwd: fileDir, timeout: 10000, stdio: 'ignore' });
          dep.status = 'installed';
          dep.installCmd = '';
          installed++;
        } catch {
          dep.status = 'missing';
          if (lang === 'python') dep.installCmd = `"${pythonPath}" -m pip install ${dep.name}`;
          else if (lang.startsWith('javascript') || lang.startsWith('typescript')) dep.installCmd = `npm install ${dep.name}`;
          else if (lang === 'php') dep.installCmd = `composer require ${dep.name}`;
          missing++;
        }
      }

      statsProvider.updateStats(lastStats);
      if (missing === 0) {
        vscode.window.showInformationMessage(`CodeStats-Core: Todas las ${installed} dependencias instaladas ✓`);
      } else {
        vscode.window.showWarningMessage(`CodeStats-Core: ${installed} instaladas ✓ · ${missing} faltantes ✗`);
      }
    })
  );

  // ══════ INSTALL SINGLE DEPENDENCY ══════
  context.subscriptions.push(
    vscode.commands.registerCommand('codestat.installDep', (depName: string, installCmd: string) => {
      const editor = vscode.window.activeTextEditor;
      const fileDir = editor ? require('path').dirname(editor.document.fileName) : undefined;
      const terminal = vscode.window.createTerminal({ name: `Install: ${depName}`, cwd: fileDir });
      terminal.show();
      terminal.sendText(installCmd);
    })
  );

  console.log('CodeStats-Core activated');
}

export function deactivate() {
  highlightDecoration.dispose();
  highlightLineDecoration.dispose();
}
