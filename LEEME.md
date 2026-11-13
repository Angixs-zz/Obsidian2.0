# Obsidian Web

Una vista web **local-first** para leer y editar una bóveda de Obsidian desde el
navegador. La aplicación se sirve desde tu propio equipo y lee la carpeta de notas
directamente desde el disco.

**No sube nada a internet.** No hay cuentas, servidores remotos, analíticas, fuentes
externas ni CDN. El servidor solo escucha en `127.0.0.1` y no tiene acceso a la bóveda:
es el navegador quien lee y escribe los archivos con permiso explícito.

## Requisitos

- **Python 3.10 o posterior** para el servidor local.
- **Chrome, Edge, Brave u otro Chromium reciente** para lectura y edición completas.
  Firefox funciona en modo lectura con descarga al guardar.
- Node.js 20 o posterior solo si quieres ejecutar las pruebas.

## Inicio rápido

### Linux

```bash
cd "Obsidian Web"
./"Abrir Obsidian Web.sh"
```

También puedes hacer doble clic en `Abrir Obsidian Web.sh`.

### macOS

Haz doble clic en `Abrir Obsidian Web.command`, o desde Terminal:

```bash
./"Abrir Obsidian Web.sh"
```

### Windows

Haz doble clic en `Abrir Obsidian Web.bat`.

### Manualmente

```bash
cd "Obsidian Web"
python3 servidor.py
```

Abre `http://127.0.0.1:8765/`. El servidor solo acepta conexiones locales.

## Primeros pasos

1. Pulsa **Abrir carpeta** y elige la carpeta de tu bóveda, por ejemplo
   `.../Mis bibliotecas/Obsidian`.
2. Concede permiso de lectura. Para guardar, el navegador pedirá permiso de escritura.
3. Navega por el árbol, busca con `Ctrl K` o prueba la **demostración** incluida.

La última carpeta se recuerda en este navegador. Si el permiso caduca, pulsa
**Reabrir última** y vuelve a concederlo.

## Qué incluye

- **Lectura completa de Markdown**: títulos, listas, tablas, código, tareas, citas,
  callouts, resaltados `==texto==` y enlaces.
- **Enlaces internos** `[[nota]]`, `[[nota#sección]]`, `[[nota|alias]]` y adjuntos
  `![[imagen.png]]`; también enlaces Markdown a archivos `.md`.
- **Backlinks**, enlaces salientes y menciones sin enlace en el panel de detalles.
- **Buscador** sin distinción de acentos ni mayúsculas, con fragmentos y resaltado.
  Admite `tag:tema`, `path:carpeta` y exclusión con `-palabra`.
- **Paleta de comandos** con `Ctrl K`.
- **Grafo** de conexiones en 2D o 3D: arrastra un nodo y sus vecinos lo siguen con
  física suave, gira la cámara en 3D, usa rueda o pinza para acercar y haz clic para abrir.
  Cada punto muestra el nombre de su archivo en una etiqueta legible (con fondo y texto
  de alto contraste) desde poco zoom; se oculta al alejarse demasiado.
  El modo **Universo de notas** agrupa los planetas por carpeta con colores, nebulosas,
  estrellas y destellos sutiles. Puedes resaltar una carpeta en la leyenda, buscar una
  nota y pulsar Enter para abrirla, o apagar el ambiente con **Estrellas**. Las
  animaciones se detienen al ocultar la pestaña y respetan movimiento reducido.
  El botón **Pantalla completa** amplía el grafo con los controles y la búsqueda;
  vuelve al tamaño normal con el mismo botón o con `Esc`.
- **Etiquetas**, **favoritos** y **recientes**, guardados solo en este navegador.
- **Editor** con vista previa y guardado directo en disco; creación de notas nuevas.
- **Detección de cambios externos**: avisa si la nota cambió en Obsidian antes de guardar.
- **Recarga desde el disco** para incorporar cambios hechos fuera de la app.
- **Visor integrado** para imágenes, PDF, audio y vídeo; otros adjuntos se descargan o
  se abren en una pestaña.
- **Tema claro y oscuro**, diseño adaptable y panel de detalles deslizante en móvil.
- **Enlaces directos** a notas, etiquetas, carpetas y búsquedas mediante el hash de la URL.
- **PWA instalable** con service worker para la interfaz de la aplicación.

## Atajos

| Atajo | Acción |
| --- | --- |
| `Ctrl K` / `Cmd K` | Buscar y abrir una nota |
| `Ctrl S` / `Cmd S` | Guardar mientras editas |
| `Ctrl E` / `Cmd E` | Entrar al editor de la nota abierta |
| `/` | Enfocar el buscador lateral |
| `Esc` | Cerrar la paleta o el visor, o salir del editor |
| `Tab` (en el editor) | Insertar dos espacios |
| `↑` `↓` + `Enter` | Moverse y abrir en la paleta |
| `V` (en el grafo) | Alternar entre vista 2D y 3D |
| `O` (en el grafo 3D) | Activar o pausar la órbita automática |
| `0` (en el grafo) | Reencuadrar |
| `+` `-` (en el grafo) | Acercar o alejar |
| Flechas (en el grafo) | Desplazar en 2D u orbitar en 3D |
| `F` (en el grafo) | Activar o salir de pantalla completa |

En el menú `⋯` de cada nota tienes **Copiar enlace**, **Abrir en Obsidian**,
**Ver ruta** e **Imprimir / PDF**.

## Servidor y lanzador

El lanzador comprueba que el servidor responde antes de abrir el navegador y evita
arrancar dos instancias en el mismo puerto.

```bash
./"Abrir Obsidian Web.sh" --status     # ¿está activo?
./"Abrir Obsidian Web.sh" --stop       # detenerlo
./"Abrir Obsidian Web.sh" --port 9000  # usar otro puerto
./"Abrir Obsidian Web.sh" --no-open    # no abrir el navegador
```

También puedes usar `PORT=9000 ./"Abrir Obsidian Web.sh"` o
`python3 servidor.py --port 9000 --verbose`.

Comprobación de salud:

```bash
curl http://127.0.0.1:8765/health
# {"app": "obsidian-web", "version": "2.2.0", "status": "ok"}
```

El servidor sirve **solo** los archivos de esta carpeta mediante una lista blanca.
No muestra listados de directorios, no escribe en disco y no expone la bóveda.

## Instalar como aplicación (PWA)

En Chrome, Edge o Brave, abre la app desde `http://127.0.0.1:8765/` y usa
**Instalar Obsidian Web** en el menú del navegador. La interfaz queda cacheada por el
service worker; la bóveda se sigue leyendo con la API de archivos del navegador.

La app no ofrece HTTPS. No la publiques en una red, no la pongas detrás de un proxy
y no abras el puerto a internet: está pensada para tu equipo.

## Privacidad y datos

- El servidor solo escucha en `127.0.0.1` y únicamente entrega archivos de la
  aplicación; nunca entrega tu bóveda.
- Las notas se leen con la **File System Access API** de Chromium. El contenido no
  se envía por red.
- En `localStorage` (`obsidian-web-local-v1`) se guardan tema, favoritos, recientes,
  última nota por bóveda y preferencias de interfaz.
- En `IndexedDB` (`obsidian-web`) se guardan el permiso de la última carpeta, la
  identidad de cada bóveda y una caché del índice para reabrir más rápido. Esa caché
  puede incluir el texto analizado de notas pequeñas (hasta 200 KB) y no sale del
  navegador.
- Puedes borrar esos datos desde la configuración del sitio en el navegador. Las
  notas del disco no se tocan.
- Los enlaces externos se abren en una pestaña nueva con `rel="noreferrer noopener"`.
- La política CSP y las cabeceras de seguridad se aplican tanto en el HTML como en el
  servidor local.

## Navegadores

- **Chrome, Edge, Brave u otro Chromium reciente:** lectura, edición, creación de
  notas, reapertura de carpeta y “Abrir en Obsidian”.
- **Firefox:** lectura mediante el selector de archivos. Al guardar se descarga una
  copia del `.md`, porque Firefox no implementa la API de escritura de carpetas.
- **Safari:** puede leer y editar en modo descarga según la versión; no se garantiza
  la reapertura de carpetas.

## Límites conocidos

- No carga plugins, temas ni sincronización de Obsidian.
- Los archivos `.canvas` se muestran como adjuntos, no como tableros interactivos.
- Los PDF, hojas de cálculo y documentos se abren con el visor del sistema, del
  navegador o se descargan.
- El enlace “Abrir en Obsidian” usa el nombre de la carpeta como nombre de bóveda;
  funciona si esa carpeta ya está registrada en Obsidian con ese nombre.
- Las notas de más de 4 MB no se indexan para búsqueda. Se pueden abrir, pero la app
  bloquea su edición para no sobrescribir contenido que no llegó a leer; edítalas en
  Obsidian. Lo mismo ocurre si un archivo no se pudo leer por permisos.
- La detección automática de cambios externos depende del navegador; si no aparece,
  pulsa ↻ para recargar la bóveda.

## Pruebas y desarrollo

Requiere Node.js 20 o posterior solo para las pruebas.

```bash
npm test        # pruebas de core.js (frontmatter, etiquetas, búsqueda, enlaces)
npm run check   # sintaxis de JS y compilación de servidor.py
```

También hay un flujo de CI en `.github/workflows/ci.yml` y un registro de cambios en
`CHANGELOG.md`.

## Si algo no funciona

- **El botón de carpeta no hace nada:** usa Chrome o Edge y abre la app desde
  `http://127.0.0.1:8765/`, no con doble clic sobre `index.html`.
- **El puerto está ocupado:** ejecuta
  `./"Abrir Obsidian Web.sh" --port 9000` y abre `http://127.0.0.1:9000/`.
- **No aparecen cambios hechos en Obsidian:** pulsa ↻ en la barra superior.
- **No guarda:** concede el permiso de escritura cuando el navegador lo pida. Si
  abriste la carpeta en modo lectura, vuelve a abrirla.
- **El servidor no arranca:** revisa `.obsidian-web.log` (o el archivo indicado por el
  lanzador) y comprueba que `python3` está instalado.
- **Quiero detenerlo:** `./"Abrir Obsidian Web.sh" --stop`, o `Ctrl C` si lo arrancaste
  a mano.

## Licencia y atribución

El código de Obsidian Web se distribuye bajo licencia MIT; consulta `LICENSE`.
Las dependencias incluidas en `vendor/` conservan sus licencias: **marked** (MIT) y
**DOMPurify** (Apache-2.0 o MPL-2.0). Los detalles y los hashes SRI están en
`vendor/README.md`.
