# CodeStats-Core

Panel lateral para VS Code que analiza tu código automáticamente al abrir o cambiar de archivo. Pensado para vibe coding — verificar código generado por IA en segundos.

## Lenguajes soportados

Python · JavaScript · TypeScript · JSX/TSX · PHP · HTML · CSS

## Qué muestra

- **Mapa de componentes** — Clases, métodos y funciones con click para navegar al código
- **Uso externo** — Detecta qué métodos y clases de tu archivo se usan en otros archivos del proyecto
- **Código sin uso** — Imports, métodos y variables que no se usan (excluye los que tienen uso externo)
- **Errores** — Errores de compilación/linting del archivo actual. Click copia el error completo
- **Dependencias** — Verifica si las librerías que importas están instaladas. Botón para instalar las faltantes. Compatible con conda, venv y pyenv
- **Hardcoded** — Detecta credenciales, URLs, IPs y puertos hardcodeados
- **TODO/FIXME** — Lista todos los TODO, FIXME, HACK, BUG y NOTE con click para navegar
- **Prompt history** — Historial de prompts copiados durante la sesión

## Instalar

```bash
# Clonar y compilar
cd codestats-core
npm install
npm run compile
```

Abrir la carpeta en VS Code, presionar `F5` para lanzar la extensión en modo desarrollo.

## Uso

Abre cualquier archivo soportado. El panel aparece automáticamente en el sidebar. No necesitas atajos ni comandos — se actualiza solo al cambiar de archivo o guardar.

### Comandos disponibles (Ctrl+Shift+P)

| Comando | Qué hace |
|---------|----------|
| Analizar archivo actual | Análisis manual |
| Copiar prompt para generar | Copia prompt optimizado para que la IA genere código compatible |
| Copiar prompt para convertir | Copia prompt + tu código para convertirlo al formato |
| Extraer prompt de método | Selecciona un método → genera prompt para mejorarlo |
| Ver historial de prompts | Lista de prompts copiados en la sesión |
| Verificar dependencias | Comprueba si las librerías están instaladas |
| Generar tests (Pytest) | Genera tests automáticos (solo Python) |

## Prompts

El archivo `PROMPT.md` incluye 5 prompts listos para copiar y pegar en cualquier IA:

1. **Generar código nuevo** con bloque meta
2. **Convertir código existente** al formato
3. **Convertir y compactar** para reducir tokens
4. **Corregir un error** — pega el error copiado del panel
5. **Mejorar un método** — generado automáticamente con el snippet extractor

## Licencia

MIT
