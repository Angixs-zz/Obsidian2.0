# Obsidian2.0

Aplicación local para explorar y editar una bóveda de Obsidian desde el navegador. No necesita cuenta, servicios remotos ni CDN; los archivos permanecen en tu equipo.

El **Universo de notas** ofrece grafo 2D/3D, constelaciones por carpeta y efectos espaciales opcionales.

El editor incluye sugerencias locales de enlaces, mapa de secciones, preguntas
pendientes, comparación de cambios externos e historial recuperable de borradores.

**Versión web:** <https://angixs-zz.github.io/Obsidian2.0/>. La página descarga la interfaz desde GitHub Pages, pero la bóveda no se publica: el navegador accede a tu carpeta local solo cuando le das permiso. La versión local sigue disponible sin GitHub.

## Ejecutar

Necesitas Python 3.10+ y, para editar directamente, un navegador Chromium reciente.

```bash
./"Abrir Obsidian Web.sh" --no-open
```

Abre <http://127.0.0.1:8765/>. En macOS puedes usar `Abrir Obsidian Web.command`; en Windows, `Abrir Obsidian Web.bat`. El servidor solo escucha en `127.0.0.1`.

## Documentación y pruebas

- [Guía en español](LEEME.md)
- [Registro de cambios](CHANGELOG.md)
- `npm test` y `npm run check` (Node.js 20+ para las pruebas)

La bóveda se lee y se modifica únicamente con permisos otorgados por el navegador. La demostración incluida es de solo lectura.
