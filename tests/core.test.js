"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const C = require("../core.js");

test("etiquetas al inicio de línea y varias en la misma línea", () => {
  assert.deepEqual(C.collectTagsFromBody("texto\n#etiqueta"), ["etiqueta"]);
  assert.deepEqual(C.collectTagsFromBody("#proyecto #producto"), ["proyecto", "producto"]);
  assert.deepEqual(C.collectTagsFromBody("Una línea con #real y #tema/subtema."), ["real", "tema/subtema"]);
  assert.deepEqual(C.collectTagsFromBody("Etiqueta corta #x"), ["x"]);
});

test("las etiquetas ignoran encabezados, código y etiquetas escapadas", () => {
  assert.deepEqual(C.collectTagsFromBody("# Título\n## Otro\n#real"), ["real"]);
  assert.deepEqual(C.collectTagsFromBody("```\n#no-es-etiqueta\n```\n#sí"), ["sí"]);
  assert.deepEqual(C.collectTagsFromBody("texto `#codigo` y \\#escapada #visible"), ["visible"]);
});

test("la demo conserva #demo y #inicio", () => {
  const file = path.join(__dirname, "..", "demo", "Inicio.md");
  const note = C.parseNote("Inicio.md", fs.readFileSync(file, "utf8"), 1);
  assert.ok(note.tags.includes("demo"));
  assert.ok(note.tags.includes("inicio"));
  assert.ok(note.tags.includes("navegación"));
  assert.equal(note.title, "Inicio de la demostración");
  assert.ok(note.body.startsWith("# Inicio de la demostración"));
});

test("frontmatter admite listas, mapas, bloque y valores vacíos", () => {
  const { properties, body } = C.parseFrontmatter([
    "---",
    'title: "Hola"',
    "tags: [a, b]",
    "aliases:",
    "  - Uno",
    "  - Dos",
    "nested:",
    "  key: value",
    "bloque: |",
    "  linea 1",
    "  linea 2",
    "activo: true",
    "peso: 12",
    "vacio:",
    "---",
    "Cuerpo"
  ].join("\n"));
  assert.equal(properties.title, "Hola");
  assert.deepEqual(properties.tags, ["a", "b"]);
  assert.deepEqual(properties.aliases, ["Uno", "Dos"]);
  assert.deepEqual(properties.nested, { key: "value" });
  assert.equal(properties.bloque, "linea 1\nlinea 2");
  assert.equal(properties.activo, true);
  assert.equal(properties.peso, 12);
  assert.equal(properties.vacio, "");
  assert.equal(body, "Cuerpo");
});

test("una regla horizontal al inicio no se confunde con frontmatter", () => {
  const { properties, body } = C.parseFrontmatter("---\n\nTexto normal");
  assert.deepEqual(properties, {});
  assert.equal(body, "---\n\nTexto normal");
});

test("title vacío no produce un título en blanco", () => {
  const note = C.parseNote("Carpeta/Mi nota.md", "---\ntitle:\n---\nContenido", 1);
  assert.equal(note.title, "Mi nota");
});

test("extrae enlaces Markdown a .md, .markdown y .txt", () => {
  const note = C.parseNote("A.md", "Ver [B](notas/B.markdown#Tema) y [C](C.txt).", 1);
  assert.deepEqual(note.links.map((link) => link.target), ["notas/B.markdown#Tema", "C.txt"]);
});

test("parseNote ignora encabezados y enlaces dentro de código", () => {
  const text = "# Real\n\n```\n# Falso\n[[No existe]]\n```\n\n[[Otra]]";
  const note = C.parseNote("Nota.md", text, 1);
  assert.deepEqual(note.headings.map((item) => item.text), ["Real"]);
  assert.deepEqual(note.links.map((item) => item.target), ["Otra"]);
});

test("búsqueda sin acentos y resaltado sobre el texto original", () => {
  const html = C.highlightText("La canción & el <b>ruiseñor</b>", ["cancion", "ruisenor"]);
  assert.match(html, /<mark>canción<\/mark>/);
  assert.match(html, /<mark>ruiseñor<\/mark>/);
  assert.match(html, /&amp;/);
  assert.match(html, /&lt;b&gt;/);
  assert.doesNotMatch(html, /<b>/);
});

test("el resaltado no rompe entidades HTML", () => {
  const html = C.highlightText("Tom &amp; Jerry", ["amp"]);
  assert.equal(html, "Tom &amp;<mark>amp</mark>; Jerry");
});

test("el fragmento incluye contexto alrededor de la coincidencia", () => {
  const body = "Relleno ".repeat(30) + "La canción de hielo y fuego" + " relleno".repeat(30);
  const snippet = C.snippetText(body, ["cancion"]);
  assert.match(snippet, /<mark>canción<\/mark>/);
  assert.ok(snippet.length < 500);
  assert.ok(snippet.startsWith("…"));
});

test("normalizeWithMap conserva índices de caracteres acentuados", () => {
  const { text, map } = C.normalizeWithMap("canción");
  assert.equal(text, "cancion");
  assert.equal(map.length, text.length);
  assert.equal(map[6], 6);
});

test("slugify genera identificadores estables", () => {
  assert.equal(C.slugify("Índice de la Bóveda"), "indice-de-la-boveda");
  assert.equal(C.slugify("  ¡Hola, mundo!  "), "hola-mundo");
  assert.equal(C.slugify(""), "seccion");
});

test("los comentarios %% no forman parte del texto de menciones", () => {
  const prose = C.proseFor("Visible %%oculto [[Enlace]]%% final");
  assert.match(prose, /Visible/);
  assert.doesNotMatch(prose, /oculto|Enlace/);
});

test("alias y etiquetas de propiedades aceptan cadenas separadas por comas", () => {
  const properties = { aliases: "Uno, Dos", tags: "a, #b" };
  assert.deepEqual(C.collectAliases(properties), ["Uno", "Dos"]);
  assert.deepEqual(C.collectTags(properties), ["a", "b"]);
});

test("el título genérico usa el primer H1", () => {
  const note = C.parseNote("Inicio.md", "# Portada\n\nTexto", 1);
  assert.equal(note.title, "Portada");
});

test("el título propio gana al primer H1", () => {
  const note = C.parseNote("Inicio.md", "---\ntitle: Mi portada\n---\n# Otra", 1);
  assert.equal(note.title, "Mi portada");
});

test("countOccurrences no se solapa", () => {
  assert.equal(C.countOccurrences("cancion cancion", "cancion"), 2);
  assert.equal(C.countOccurrences("aaaa", "aa"), 2);
});

test("rotate3D conserva el punto sin rotación y gira sobre Y", () => {
  assert.deepEqual(C.rotate3D(1, 2, 3, 0, 0), { x: 1, y: 2, z: 3 });
  const rotated = C.rotate3D(1, 0, 0, Math.PI / 2, 0);
  assert.ok(Math.abs(rotated.x) < 1e-12);
  assert.ok(Math.abs(rotated.z + 1) < 1e-12);
});

test("projectPoint aplica perspectiva según la profundidad", () => {
  const near = C.projectPoint({ x: 10, y: -5, z: 0 }, { focal: 1000 });
  assert.equal(near.x, 10);
  assert.equal(near.y, -5);
  assert.equal(near.scale, 1);
  const far = C.projectPoint({ x: 10, y: 0, z: 1000 }, { focal: 1000 });
  assert.equal(far.scale, 0.5);
  assert.equal(far.x, 5);
  const close = C.projectPoint({ x: 10, y: 0, z: -500 }, { focal: 1000 });
  assert.equal(close.scale, 2);
  assert.equal(close.x, 20);
});
