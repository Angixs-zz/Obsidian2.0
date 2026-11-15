/* Ayudas de escritura locales. Sin red ni dependencias de interfaz. */
(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports ? require("./core.js") : root.ObsidianCore);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ObsidianWriting = api;
})(globalThis, function (Core) {
  "use strict";

  // Conserva offsets del texto original, excluyendo propiedades, comentarios y código.
  function visibleText(raw) {
    let chars = raw.split("");
    const mask = (start, end) => {
      for (let i = start; i < end; i++) if (chars[i] !== "\n") chars[i] = " ";
    };
    for (const range of Core.codeRanges(raw)) mask(range[0], range[1]);
    for (const match of raw.matchAll(/%%[\s\S]*?%%/g)) mask(match.index, match.index + match[0].length);
    const front = raw.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
    if (front) mask(0, front[0].length);
    return chars.join("");
  }

  function analyze(raw) {
    const sections = [], pending = [], links = [];
    let offset = 0;
    for (const line of visibleText(raw).split("\n")) {
      const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) sections.push({ text: heading[2], level: heading[1].length, offset });
      const done = /^\s*[-*+]\s+\[[xX]\]/.test(line);
      if (!done && !heading && (/[¿?]/.test(line) ||
        /\b(investigar|averiguar|revisar|pendiente|TODO)\b/i.test(line) || /^\s*[-*+]\s+\[ \]/.test(line))) {
        pending.push({ text: raw.slice(offset, offset + line.length).trim(), offset });
      }
      offset += line.length + 1;
    }
    for (const link of Core.extractLinks(visibleText(raw))) {
      if (!link.embed) links.push(link.target);
    }
    return { sections, pending, links: [...new Set(links)] };
  }

  function suggestions(raw, path, notes, resolve) {
    const prose = Core.normalize(Core.proseFor(visibleText(raw)));
    const linked = new Set(Core.extractLinks(raw).map((link) => resolve(link.target, path)).filter(Boolean));
    const words = new Set(prose.match(/[\p{L}\p{N}]{4,}/gu) || []);
    const results = [];
    for (const note of notes) {
      if (note.path === path || linked.has(note.path) || note.readError || note.tooLarge) continue;
      const names = [note.title, note.stem, ...(note.aliases || [])].filter(Boolean).map(Core.normalize);
      const mention = names.find((name) => name.length >= 3 && new RegExp(
        `(^|[^\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u"
      ).test(prose));
      const terms = new Set(names.join(" ").match(/[\p{L}\p{N}]{4,}/gu) || []);
      const matches = [...terms].filter((term) => words.has(term));
      if (!mention && matches.length < 2) continue;
      results.push({ path: note.path, title: note.title, score: mention ? 100 + mention.length : matches.length,
        reason: mention ? `Mencionas «${mention}»` : `Coinciden: ${matches.slice(0, 3).join(", ")}` });
    }
    return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 6);
  }

  // Persistencia síncrona del último texto: no depende de temporizadores al cerrar.
  // Límites globales deliberados; nunca se elimina el archivo de la bóveda.
  function draftStore(storage) {
    const KEY = "obsidian-web-drafts-v1";
    const MAX_TEXT = 200000, MAX_TOTAL = 1500000;
    const read = () => {
      const data = JSON.parse(storage.getItem(KEY) || '{"entries":[]}');
      if (!Array.isArray(data.entries)) throw new Error("Historial local inválido");
      return data;
    };
    return {
      list(vault, path) {
        try { return read().entries.find((entry) => entry.vault === vault && entry.path === path)?.versions || []; }
        catch { return []; }
      },
      capture(vault, path, text, { checkpoint = false, now = Date.now() } = {}) {
        if (!vault || !path) return { ok: false, reason: "Sin bóveda" };
        if (text.length > MAX_TEXT) return { ok: false, reason: "Borrador demasiado grande para la copia local (200.000 caracteres)" };
        try {
          const data = read();
          let entry = data.entries.find((item) => item.vault === vault && item.path === path);
          if (!entry) { entry = { vault, path, versions: [], checkpointAt: now }; data.entries.push(entry); }
          const previous = entry.versions[0];
          if (previous?.text === text) {
            if (checkpoint) { entry.checkpointAt = now; entry.keepNext = true; }
          } else {
            if (previous && !entry.keepNext && now - entry.checkpointAt < 30000) entry.versions.shift();
            else entry.checkpointAt = now;
            entry.versions.unshift({ text, at: now });
            entry.keepNext = checkpoint;
          }
          entry.updated = now;
          entry.versions = entry.versions.slice(0, 10);
          data.entries.sort((a, b) => b.updated - a.updated);
          data.entries = data.entries.slice(0, 30);
          let serialized = JSON.stringify(data);
          while (serialized.length > MAX_TOTAL) {
            const last = data.entries[data.entries.length - 1];
            if (last.versions.length > 1) last.versions.pop();
            else if (data.entries.length > 1) data.entries.pop();
            else throw new Error("Sin espacio para la copia local");
            serialized = JSON.stringify(data);
          }
          storage.setItem(KEY, serialized);
          return { ok: true };
        } catch {
          return { ok: false, reason: "No se pudo conservar la copia local: almacenamiento bloqueado o lleno" };
        }
      },
      clear(vault, path) {
        const data = read();
        data.entries = data.entries.filter((entry) => entry.vault !== vault || entry.path !== path);
        storage.setItem(KEY, JSON.stringify(data));
      }
    };
  }

  return { analyze, suggestions, draftStore };
});
