# Changelog

## 2.3.1 — 2026-11-15

- Aviso «Sin escritura en la carpeta» en la barra lateral cuando el navegador abre
  la bóveda sin permiso de escritura, con instrucciones concretas para Brave y para
  el resto de navegadores.
- El botón Nueva nota y el de carpeta explican el motivo real en lugar de pedir abrir
  una carpeta que ya está abierta. Brave requiere `brave://flags/#file-system-access-api`.

## 2.3.0 — 2026-11-15

### Cinco ayudas locales para escribir
- Enlaces sugeridos por menciones de títulos, alias y palabras compartidas; inserción
  de rutas completas y exclusión de enlaces existentes, código y comentarios.
- Mapa de secciones y enlaces del borrador, con navegación a la línea original.
- Preguntas, tareas sin completar y marcadores «investigar», «revisar», «pendiente»
  y «TODO» reunidos mientras escribes.
- Comparador de borrador y archivo actual antes de guardar cambios en conflicto,
  con combinación manual editable y comprobación adicional antes de escribir.
- Historial local recuperable tras recargar: último texto actualizado al escribir,
  hasta 10 versiones por nota, con vista previa, recuperación y borrado explícitos.
- Los cambios escritos durante un guardado permanecen pendientes; se bloquea la
  navegación durante la escritura para no mezclar notas.

## Publicación web

- GitHub Pages publica únicamente la app y la demo desde `main`;
  no incluye el servidor, los tests ni archivos privados del equipo.
- Las rutas relativas mantienen funcionales demo, PWA, iconos y grafo bajo
  `/Obsidian2.0/`. La bóveda sigue accediéndose con permiso local del navegador.

## 2.2.0 — 2026-11-13

### Universo de notas
1. Colores de constelación estables por carpeta principal.
2. Agrupación física suave de las notas de la misma carpeta.
3. Nebulosas tenues detrás de las constelaciones (limitadas para bóvedas grandes).
4. Cielo de estrellas determinista, sin recursos externos.
5. Estrella fugaz ocasional, desactivada con movimiento reducido.
6. Halo luminoso sutil alrededor de los planetas enlazados.
7. Resaltado de vecinos y conexiones al enfocar un planeta.
8. Leyenda interactiva con recuentos para destacar una carpeta.
9. Buscador local de nodos: centra el resultado y Enter abre la nota.
10. Botón «Estrellas» para apagar/encender los efectos ambientales; la animación
    se pausa con la pestaña oculta y se limita a 20 fps en bóvedas pequeñas.
- Botón **Pantalla completa** en el grafo 2D/3D: amplía el lienzo sin perder
  controles, leyenda ni búsqueda. Se sale con el botón o con `Esc`.

## 2.1.0 — 2026-11-13

### Grafo interactivo
- Cada nodo se puede arrastrar con el ratón o el dedo; la simulación de fuerzas
  hace que sus vecinos lo sigan con una animación suave y un pequeño efecto de
  inercia al soltarlo.
- Nueva vista 3D con perspectiva, profundidad, giro de cámara y órbita automática;
  el botón **Vista 3D / Vista 2D** alterna entre ambas sin perder la posición.
- En 3D se gira arrastrando el fondo, se desplaza con `Shift` y se acerca con la
  rueda o la pinza. En 2D el fondo se desplaza y el zoom se ancla al cursor.
- Controles de teclado en el lienzo: `V`, `O`, `0`, `+`, `-` y flechas.
- Etiquetas y conexiones con profundidad, resaltado de los enlaces del nodo activo
  y reencuadre automático al cambiar de vista.
- Cada nodo muestra el nombre de su archivo en una etiqueta con fondo sólido y texto
  de alto contraste, legible en tema claro y oscuro. Aparecen antes (con menos zoom),
  se ocultan al alejarse y evitan solapamientos dando prioridad al nodo activo.

## 2.0.0 — 2026-11-13

Revisión completa a partir de la auditoría: correcciones de datos, accesibilidad,
rendimiento y despliegue.

### Correcciones que evitan pérdida de datos
- Aviso antes de descartar un borrador al navegar, buscar, abrir otra nota o cerrar
  la pestaña (`beforeunload`).
- Un único guardado por `Ctrl S` y cola de escritura por archivo.
- Detección de cambios externos por `lastModified` antes de escribir; permite cargar
  la versión del disco o sobrescribir explícitamente.
- `createNote` comprueba el disco y ya no sobrescribe un `.md` existente.
- Las notas ilegibles o demasiado grandes no entran en el editor, para que un borrador
  vacío no pueda reemplazar contenido que la app no llegó a leer.
- El visor de adjuntos restaura el foco y atrapa `Tab`; el grafo libera sus listeners al
  abrir una nota desde un nodo.
- El índice de nombres (`byStem`) acumula resultados en vez de machacarlos y registra
  la clave sin extensión.
- Las claves de ruta se normalizan sin acentos y con/sin extensión.
- Se capturan errores por entrada y por archivo; las notas ilegibles se marcan.

### Análisis y búsqueda
- Las etiquetas reales al inicio de línea ya no se descartan; se ignoran encabezados,
  bloques de código y etiquetas escapadas.
- Frontmatter robusto: listas, mapas, bloques `|`/`>`, booleanos, números y valores
  vacíos; una regla horizontal ya no se confunde con frontmatter.
- Resaltado y fragmentos sin acentos usando un mapa de índices sobre el texto original.
- El resaltado escapa primero y no corrompe entidades HTML; sin `RegExp` por término.
- Búsqueda con `tag:tema`, `path:carpeta` y `-excluir`; cuerpos normalizados en caché.
- Menciones sin enlace con límites de palabra y sin bloques de código.
- Resolución exacta → relativa → alias → global única, con aviso visible de ambigüedad.

### Interfaz
- Tokens de color, radio, sombra y tipografía; escala con mínimo de 12 px y contraste
  AA para metadatos.
- Tema aplicado antes del primer pintado (sin FOUC).
- Iconos SVG coherentes; menos acciones primarias y menú `⋯` para el resto.
- Editor en dos paneles con scroll independiente y vista previa sobre el borrador real.
- Inspector convertido en panel lateral en pantallas estrechas.
- Visor integrado para imágenes, PDF, audio y vídeo; los adjuntos ya no dependen del
  bloqueador de ventanas emergentes.
- Tablas con scroll horizontal, código con tema claro/oscuro y estados de carga,
  vacío y error.
- Foco visible, diálogos con `role="dialog"`, trampa de foco en la paleta y respeto a
  `prefers-reduced-motion`.

### Arquitectura y datos
- Indexación con concurrencia limitada y caché en IndexedDB por bóveda, mtime y tamaño;
  conexión reutilizada y cerrada cuando otra pestaña necesita actualizar la base.
- Identidad estable de bóveda para favoritos, recientes y última nota.
- Router por hash con historial y enlaces directos a notas, etiquetas y carpetas.
- Estado de modo con capacidades (`leer`, `editar`, `crear`, `Obsidian`, `recargar`).
- Migración y versión del esquema de `localStorage`.
- URLs de blob con LRU y revocación; detección de cambios al enfocar.
- Grafo con punteros, pinza, limpieza de listeners y sin nodos erróneos al hacer clic.

### Despliegue
- Servidor HTTP/1.1 endurecido: allowlist de rutas, CSP por cabecera, `/health`,
  sin listados, validación de puerto y mensaje claro si está ocupado.
- Lanzador con PID, endpoint de salud, `--stop`, `--status` y apertura por plataforma.
- PWA instalable con manifest, service worker e iconos; licencias y atribución de
  dependencias; pruebas de `core.js` con `node --test` y CI.
