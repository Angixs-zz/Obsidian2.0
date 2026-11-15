"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const W = require("../writing.js");
const C = require("../core.js");

test("mapa y pendientes conservan offsets sin incluir propiedades, código ni tareas hechas", () => {
  const raw = "---\nquestion: ¿secreta?\n---\n# Idea\n\n## Plan\n¿Dónde empezar?\n- [ ] Investigar un caso\n- [x] Revisar hecho\n```\n# Falso\n¿código?\n```\n%% ¿comentario? %%\n[[Proyecto]]";
  const result = W.analyze(raw);
  assert.deepEqual(result.sections.map((s) => s.text), ["Idea", "Plan"]);
  assert.deepEqual(result.pending.map((p) => p.text), ["¿Dónde empezar?", "- [ ] Investigar un caso"]);
  for (const item of [...result.sections, ...result.pending]) assert.ok(raw.slice(item.offset).startsWith(item.level ? "#".repeat(item.level) : item.text));
  assert.deepEqual(result.links, ["Proyecto"]);
});

test("sugerencias usan menciones sin acentos y excluyen nota actual y enlaces existentes", () => {
  const notes = [C.parseNote("Actual.md", "# Actual", 1), C.parseNote("Ideas/Canción.md", "# Canción", 1),
    C.parseNote("Otra.md", "---\naliases: [Música clásica]\n---\n# Otra", 1)];
  const resolve = (target) => target === "Ideas/Canción" ? "Ideas/Canción.md" : null;
  const result = W.suggestions("Pienso en musica clasica y cancion. [[Ideas/Canción]]", "Actual.md", notes, resolve);
  assert.deepEqual(result.map((r) => r.path), ["Otra.md"]);
  assert.equal(W.suggestions("`musica clasica` y %%cancion%%", "Actual.md", notes, resolve).length, 0);
});

test("sugerencias no confunden subcadenas con menciones", () => {
  const notes = [C.parseNote("Sol.md", "", 1)];
  assert.equal(W.suggestions("solamente", "Actual.md", notes, () => null).length, 0);
  assert.equal(W.suggestions("El sol.", "Actual.md", notes, () => null).length, 1);
});

function memory() {
  const data = new Map();
  return { getItem: (key) => data.get(key) || null, setItem: (key, value) => data.set(key, value) };
}

test("borrador sobrevive a una nueva instancia y está aislado por bóveda/ruta", () => {
  const storage = memory(), store = W.draftStore(storage);
  store.capture("a", "Uno.md", "primero", { checkpoint: true, now: 1 });
  store.capture("a", "Uno.md", "segundo", { now: 2 });
  store.capture("b", "Uno.md", "otra bóveda", { now: 3 });
  const reopened = W.draftStore(storage);
  assert.deepEqual(reopened.list("a", "Uno.md").map((v) => v.text), ["segundo", "primero"]);
  assert.equal(reopened.list("b", "Uno.md")[0].text, "otra bóveda");
  assert.equal(reopened.list("a", "Dos.md").length, 0);
});

test("coalescencia, checkpoints y borrado no alteran otras notas", () => {
  const store = W.draftStore(memory());
  store.capture("v", "A", "1", { now: 0 });
  store.capture("v", "A", "12", { now: 1 });
  store.capture("v", "A", "123", { now: 31000 });
  assert.deepEqual(store.list("v", "A").map((v) => v.text), ["123", "12"]);
  store.capture("v", "A", "123", { checkpoint: true, now: 32000 });
  store.capture("v", "A", "1234", { now: 32001 });
  assert.equal(store.list("v", "A").length, 3);
  store.capture("v", "B", "otra");
  store.clear("v", "A");
  assert.equal(store.list("v", "A").length, 0);
  assert.equal(store.list("v", "B")[0].text, "otra");
});

test("límites del historial y fallos de cuota son explícitos", () => {
  const store = W.draftStore(memory());
  for (let i = 0; i < 15; i++) store.capture("v", "A", String(i), { checkpoint: true, now: i });
  assert.equal(store.list("v", "A").length, 10);
  assert.equal(store.capture("v", "A", "x".repeat(200001)).ok, false);
  assert.equal(store.list("v", "A")[0].text, "14");
  const blocked = W.draftStore({ getItem: () => null, setItem() { throw new Error("QuotaExceededError"); } });
  assert.equal(blocked.capture("v", "A", "texto").ok, false);
});
