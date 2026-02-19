// src/testGenerator.ts
// Genera tests de Pytest basados en las stats parseadas del código.

import { FileStats, ClassInfo, MethodInfo, PortInfo } from './pythonParser';

export function generatePytestCode(stats: FileStats): string {
  const lines: string[] = [];

  lines.push(`# Tests auto-generados por CodeStat`);
  lines.push(`# Archivo analizado: ${stats.fileName}`);
  lines.push(`import pytest`);

  // Import the module under test
  const moduleName = stats.fileName.replace(/\.py$/, '').replace(/\//g, '.');
  lines.push(`from ${moduleName} import *`);
  lines.push('');

  // Generate tests for top-level functions
  for (const fn of stats.functions) {
    if (fn.isPrivate) continue;
    lines.push(...generateFunctionTests(fn, null));
    lines.push('');
  }

  // Generate tests for classes
  for (const cls of stats.classes) {
    lines.push(...generateClassTests(cls));
    lines.push('');
  }

  // Generate error handling tests
  if (stats.errorTypes.length > 0) {
    lines.push(...generateErrorTests(stats));
    lines.push('');
  }

  return lines.join('\n');
}

function generateFunctionTests(fn: MethodInfo, className: string | null): string[] {
  const lines: string[] = [];
  const prefix = className ? `${className}_` : '';
  const callPrefix = className ? 'instance.' : '';
  const asyncPrefix = fn.isAsync ? 'async ' : '';
  const awaitPrefix = fn.isAsync ? 'await ' : '';
  const decorator = fn.isAsync ? '@pytest.mark.asyncio\n' : '';

  // Test: basic call with default/mock params
  lines.push(`${decorator}${asyncPrefix}def test_${prefix}${fn.name}_returns_expected_type():`);
  if (className) {
    lines.push(`    instance = ${className}()`);
  }
  const mockArgs = fn.params.map(p => generateMockValue(p)).join(', ');
  lines.push(`    result = ${awaitPrefix}${callPrefix}${fn.name}(${mockArgs})`);
  lines.push(`    assert result is not None  # TODO: verificar tipo esperado: ${fn.returnType}`);
  lines.push('');

  // Test: with None/empty params if they're optional
  const optionalParams = fn.params.filter(p => p.default !== undefined);
  if (optionalParams.length > 0) {
    const requiredArgs = fn.params
      .filter(p => p.default === undefined)
      .map(p => generateMockValue(p))
      .join(', ');
    lines.push(`${decorator}${asyncPrefix}def test_${prefix}${fn.name}_with_defaults():`);
    if (className) {
      lines.push(`    instance = ${className}()`);
    }
    lines.push(`    result = ${awaitPrefix}${callPrefix}${fn.name}(${requiredArgs})`);
    lines.push(`    assert result is not None`);
    lines.push('');
  }

  // Test: edge case for each param
  for (const param of fn.params) {
    if (param.name.startsWith('*')) continue;
    const edgeValue = generateEdgeValue(param);
    if (edgeValue !== null) {
      lines.push(`${decorator}${asyncPrefix}def test_${prefix}${fn.name}_edge_case_${param.name}():`);
      if (className) {
        lines.push(`    instance = ${className}()`);
      }
      const args = fn.params.map(p => p.name === param.name ? edgeValue : generateMockValue(p)).join(', ');
      lines.push(`    # Edge case: ${param.name} con valor límite`);
      lines.push(`    try:`);
      lines.push(`        result = ${awaitPrefix}${callPrefix}${fn.name}(${args})`);
      lines.push(`    except Exception as e:`);
      lines.push(`        assert isinstance(e, (ValueError, TypeError))  # Debería manejar edge case`);
      lines.push('');
    }
  }

  return lines;
}

function generateClassTests(cls: ClassInfo): string[] {
  const lines: string[] = [];

  lines.push(`# ── Tests para ${cls.name} ──`);
  lines.push('');

  // Test: instantiation
  lines.push(`def test_${cls.name}_instantiation():`);
  lines.push(`    instance = ${cls.name}()`);
  lines.push(`    assert instance is not None`);
  lines.push('');

  // Test: each public method
  for (const method of cls.methods) {
    if (method.isPrivate) continue;
    if (method.name === '__init__') continue;
    lines.push(...generateFunctionTests(method, cls.name));
  }

  // Test: check attributes exist after init
  if (cls.attributes.length > 0) {
    lines.push(`def test_${cls.name}_has_expected_attributes():`);
    lines.push(`    instance = ${cls.name}()`);
    for (const attr of cls.attributes) {
      lines.push(`    assert hasattr(instance, '${attr.name}')`);
    }
    lines.push('');
  }

  return lines;
}

function generateErrorTests(stats: FileStats): string[] {
  const lines: string[] = [];

  lines.push(`# ── Tests de manejo de errores ──`);
  lines.push('');

  for (const errorType of stats.errorTypes) {
    lines.push(`def test_handles_${errorType.toLowerCase()}():`);
    lines.push(`    """Verifica que ${errorType} se maneja correctamente."""`);
    lines.push(`    # TODO: provocar condición que dispare ${errorType}`);
    lines.push(`    # Las líneas de debug relevantes son: ${stats.debugPoints.join(', ')}`);
    lines.push(`    pass`);
    lines.push('');
  }

  return lines;
}

function generateMockValue(param: PortInfo): string {
  const t = param.type.toLowerCase();
  if (param.default) return param.default;
  if (t.includes('str')) return '"test_value"';
  if (t.includes('int')) return '1';
  if (t.includes('float')) return '1.0';
  if (t.includes('bool')) return 'True';
  if (t.includes('list')) return '[]';
  if (t.includes('dict')) return '{}';
  if (t.includes('none') || t.includes('optional')) return 'None';
  if (t === 'any') return '"test"';
  return 'None  # TODO: mock para tipo ' + param.type;
}

function generateEdgeValue(param: PortInfo): string | null {
  const t = param.type.toLowerCase();
  if (t.includes('str')) return '""';
  if (t.includes('int')) return '0';
  if (t.includes('float')) return '0.0';
  if (t.includes('list')) return '[]';
  if (t.includes('dict')) return '{}';
  if (t.includes('optional')) return 'None';
  return null;
}

export function generatePromptTemplate(): string {
  return `Genera código en formato CodeStats-Core.

REGLAS OBLIGATORIAS:
1. Incluye un bloque meta al inicio usando comentarios del lenguaje:

# ---meta (Python) o // ---meta (JS/TS/PHP)
# name: NombreDelComponente
# type: service|controller|model|util|repository
# desc: Qué hace en 1-2 oraciones
# in: [tipo param1, tipo param2]
# out: TipoRetorno | TipoError
# deps: [dep1, dep2]
# methods: [metodo1(firma), metodo2(firma)]
# errors: [Error1, Error2]
# ---

2. Código compacto y funcional
3. Tipado estricto en TODOS los parámetros y retornos
4. Manejo de errores con excepciones tipadas
5. Máximo 5 params por función, máximo 30 líneas por método
6. NO incluyas: comentarios decorativos, docstrings extensos, valores hardcoded (URLs, credenciales, puertos)
7. SÍ incluye: type hints, manejo de errores, constantes con nombre
8. Declara en meta.deps TODAS las dependencias externas

Mi petición:
`;
}
