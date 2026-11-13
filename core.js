/* Obsidian Web — funciones puras de análisis.
   Se carga como script clásico (window.ObsidianCore) y también se puede
   requerir desde Node para las pruebas: require("./core.js"). */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ObsidianCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));

  const normalize = (value) => String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  /* Normaliza y conserva un mapa hacia los índices del texto original.
     Sirve para buscar sin acentos y después resaltar el texto real. */
  function normalizeWithMap(value) {
    const source = String(value ?? "");
    let text = "";
    const map = [];
    for (let i = 0; i < source.length;) {
      const ch = String.fromCodePoint(source.codePointAt(i));
      const lower = normalize(ch);
      for (const piece of lower) {
        text += piece;
        for (let k = 0; k < piece.length; k += 1) map.push(i);
      }
      i += ch.length;
    }
    return { text, map };
  }

  const extname = (name) => {
    const dot = String(name).lastIndexOf(".");
    return dot > 0 ? String(name).slice(dot).toLowerCase() : "";
  };
  const basename = (path) => String(path).split("/").pop() || String(path);
  const stem = (name) => String(name).replace(/\.[^.]+$/, "");
  const dirname = (path) => String(path).includes("/") ? String(path).slice(0, String(path).lastIndexOf("/")) : "";
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  /* Rotación y proyección para la vista 3D del grafo. La cámara mira desde
     -Z hacia +Z; `scale` es el factor de perspectiva (mayor = más cerca). */
  function rotate3D(x, y, z, yaw = 0, pitch = 0) {
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;
    return {
      x: x1,
      y: y * cp - z1 * sp,
      z: y * sp + z1 * cp
    };
  }

  function projectPoint(point, options = {}) {
    const focal = Math.max(1, options.focal ?? 1500);
    const rotated = rotate3D(
      point?.x ?? 0,
      point?.y ?? 0,
      point?.z ?? 0,
      options.yaw ?? 0,
      options.pitch ?? 0
    );
    const depth = Math.max(focal * 0.35, focal + rotated.z);
    const scale = focal / depth;
    return { x: rotated.x * scale, y: rotated.y * scale, depth: rotated.z, scale };
  }

  const wordCount = (text) => (String(text ?? "").trim().match(/[\p{L}\p{N}_'-]+/gu) || []).length;
  const readingMinutes = (words) => Math.max(1, Math.round(words / 220));
  const cleanInline = (value) => String(value ?? "").replace(/[*_`]/g, "").trim();
  const slugify = (value) => normalize(value).replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-").slice(0, 80) || "seccion";

  /* ------------------------------- frontmatter ------------------------------ */

  function stripYamlComment(line) {
    let quote = "";
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quote) {
        if (ch === "\\" && quote === '"') { i += 1; continue; }
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
    }
    return line;
  }

  function splitInline(value, separator = ",") {
    const parts = [];
    let current = "";
    let depth = 0;
    let quote = "";
    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
      if (quote) {
        current += ch;
        if (ch === "\\" && quote === '"') { current += value[i + 1] || ""; i += 1; continue; }
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
      if (ch === "[" || ch === "{") depth += 1;
      if (ch === "]" || ch === "}") depth -= 1;
      if (ch === separator && depth === 0) { parts.push(current); current = ""; continue; }
      current += ch;
    }
    parts.push(current);
    return parts;
  }

  function parseScalar(raw) {
    let value = String(raw ?? "").trim();
    if (!value) return "";
    if (/^"(?:[^"\\]|\\.)*"$/s.test(value)) {
      try { return JSON.parse(value); } catch { return value.slice(1, -1); }
    }
    if (/^'(?:[^']|'')*'$/s.test(value)) return value.slice(1, -1).replace(/''/g, "'");
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      return inner ? splitInline(inner).map((part) => parseScalar(part)).filter((part) => part !== "") : [];
    }
    if (value.startsWith("{") && value.endsWith("}")) {
      const inner = value.slice(1, -1).trim();
      const object = {};
      if (inner) {
        for (const part of splitInline(inner)) {
          const match = part.match(/^\s*([^:]+):\s*(.*)$/s);
          if (match) object[match[1].trim().replace(/^["']|["']$/g, "")] = parseScalar(match[2]);
        }
      }
      return object;
    }
    if (/^(true|false)$/i.test(value)) return /^true$/i.test(value);
    if (/^(null|~)$/i.test(value)) return null;
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
    return value;
  }

  function parseYaml(text) {
    const tokens = [];
    for (const raw of String(text ?? "").split(/\r?\n/)) {
      const line = stripYamlComment(raw).replace(/\s+$/, "");
      if (!line.trim()) continue;
      const indent = line.length - line.trimStart().length;
      tokens.push({ indent, text: line.trim(), raw: line });
    }
    if (!tokens.length) return {};
    let pos = 0;

    function blockScalar(style, indent) {
      const parts = [];
      while (pos < tokens.length && tokens[pos].indent > indent) {
        parts.push(tokens[pos].raw.slice(tokens[pos].indent));
        pos += 1;
      }
      return style === ">" ? parts.join(" ").trim() : parts.join("\n");
    }

    function parseNode(index, indent) {
      return tokens[index].text.startsWith("-")
        ? parseArray(index, indent)
        : parseMap(index, indent);
    }

    function parseMap(index, indent) {
      const object = {};
      while (index < tokens.length) {
        const token = tokens[index];
        if (token.indent < indent) break;
        if (token.indent > indent) { index += 1; continue; }
        if (token.text.startsWith("-")) break;
        const match = token.text.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:]+):(?:\s*(.*))?$/s);
        if (!match) { index += 1; continue; }
        const key = match[1].trim().replace(/^["']|["']$/g, "");
        const rest = String(match[2] ?? "").trim();
        index += 1;
        if (/^[|>][-+]?$/.test(rest)) {
          pos = index;
          object[key] = blockScalar(rest[0], indent);
          index = pos;
        } else if (!rest) {
          if (index < tokens.length && tokens[index].indent > indent) {
            const result = parseNode(index, tokens[index].indent);
            object[key] = result.value;
            index = result.index;
          } else if (index < tokens.length && tokens[index].indent === indent && tokens[index].text.startsWith("-")) {
            const result = parseArray(index, indent);
            object[key] = result.value;
            index = result.index;
          } else {
            object[key] = "";
          }
        } else {
          object[key] = parseScalar(rest);
        }
      }
      return { value: object, index };
    }

    function parseArray(index, indent) {
      const array = [];
      while (index < tokens.length) {
        const token = tokens[index];
        if (token.indent !== indent || !token.text.startsWith("-")) break;
        const content = token.text.replace(/^-\s?/, "").trim();
        index += 1;
        if (!content) {
          if (index < tokens.length && tokens[index].indent > indent) {
            const result = parseNode(index, tokens[index].indent);
            array.push(result.value);
            index = result.index;
          } else {
            array.push("");
          }
          continue;
        }
        const objectStart = content.match(/^([^:]+):(?:\s*(.*))?$/s);
        const looksLikeUrl = /^["']?[a-z][a-z0-9+.-]*:\/\//i.test(content);
        if (objectStart && !looksLikeUrl) {
          const object = {};
          const key = objectStart[1].trim().replace(/^["']|["']$/g, "");
          const rest = String(objectStart[2] ?? "").trim();
          if (/^[|>][-+]?$/.test(rest)) {
            pos = index;
            object[key] = blockScalar(rest[0], indent);
            index = pos;
          } else if (rest) {
            object[key] = parseScalar(rest);
          } else if (index < tokens.length && tokens[index].indent > indent) {
            const result = parseNode(index, tokens[index].indent);
            object[key] = result.value;
            index = result.index;
          } else {
            object[key] = "";
          }
          if (index < tokens.length && tokens[index].indent > indent) {
            const result = parseMap(index, tokens[index].indent);
            Object.assign(object, result.value);
            index = result.index;
          }
          array.push(object);
        } else {
          array.push(parseScalar(content));
        }
      }
      return { value: array, index };
    }

    const result = parseNode(0, tokens[0].indent);
    return result.value && typeof result.value === "object" ? result.value : {};
  }

  function parseFrontmatter(text) {
    const source = String(text ?? "").replace(/^\uFEFF/, "");
    const lines = source.split(/\r?\n/);
    if (!/^---\s*$/.test(lines[0] || "")) return { properties: {}, body: source };
    let end = -1;
    for (let i = 1; i < lines.length; i += 1) {
      if (/^(---|\.\.\.)\s*$/.test(lines[i])) { end = i; break; }
    }
    if (end < 0) return { properties: {}, body: source };
    const block = lines.slice(1, end).join("\n");
    const body = lines.slice(end + 1).join("\n").replace(/^\r?\n/, "");
    let properties = {};
    try {
      const parsed = parseYaml(block);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) properties = parsed;
    } catch {
      properties = {};
    }
    return { properties, body };
  }

  function collectAliases(properties) {
    const raw = properties.aliases ?? properties.alias ?? [];
    let list;
    if (Array.isArray(raw)) list = raw;
    else if (raw && typeof raw === "object") list = Object.values(raw);
    else list = String(raw ?? "").split(",");
    return list.map((alias) => cleanInline(alias)).filter(Boolean);
  }

  function collectTags(properties) {
    const raw = properties.tags ?? properties.tag ?? [];
    let list;
    if (Array.isArray(raw)) list = raw;
    else if (raw && typeof raw === "object") list = Object.keys(raw);
    else list = String(raw ?? "").split(/[,\s]+/);
    return list.map((tag) => String(tag ?? "").replace(/^#/, "").trim()).filter(Boolean);
  }

  /* --------------------------------- cuerpo -------------------------------- */

  function codeRanges(body) {
    const ranges = [];
    const source = String(body ?? "");
    const fence = /(^|\n)([ \t]{0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]{0,3}\3[ \t]*(?=\n|$)|$)/g;
    for (const match of source.matchAll(fence)) {
      const start = match.index + match[1].length;
      ranges.push([start, match.index + match[0].length]);
    }
    for (const match of source.matchAll(/`+[^`\n]*`+/g)) {
      ranges.push([match.index, match.index + match[0].length]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    return ranges;
  }

  const inRanges = (ranges, index) => ranges.some(([start, end]) => index >= start && index < end);

  function collectTagsFromBody(body) {
    const tags = [];
    const source = String(body ?? "");
    const ranges = codeRanges(source);
    const lineStarts = [0];
    for (let i = 0; i < source.length; i += 1) if (source[i] === "\n") lineStarts.push(i + 1);
    for (const lineStart of lineStarts) {
      const lineEnd = source.indexOf("\n", lineStart);
      const end = lineEnd < 0 ? source.length : lineEnd;
      const line = source.slice(lineStart, end);
      if (/^\s{0,3}#{1,6}\s/.test(line)) continue;
      for (const match of line.matchAll(/(^|[\s(>])#([\p{L}\p{N}_][\p{L}\p{N}_/-]{0,59})/gu)) {
        const absolute = lineStart + match.index;
        if (inRanges(ranges, absolute)) continue;
        const tag = match[2].replace(/[-/]+$/, "");
        if (tag) tags.push(tag);
      }
    }
    return Array.from(new Set(tags));
  }

  function proseFor(body) {
    return String(body ?? "")
      .replace(/(^|\n)([ \t]{0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]{0,3}\3[ \t]*(?=\n|$)|$)/g, " ")
      .replace(/`+[^`\n]*`+/g, " ")
      .replace(/%%[\s\S]*?%%/g, " ")
      .replace(/!?\[\[[^\]]*\]\]/g, " ")
      .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/^\s{0,3}#{1,6}\s+.*$/gm, " ");
  }

  function contextAround(text, index) {
    const before = String(text).slice(Math.max(0, index - 90), index);
    const after = String(text).slice(index, index + 100);
    return (before.split(/\n/).pop() + after.split(/\n/)[0]).replace(/!?\[\[|\]\]/g, "").trim().slice(0, 150);
  }

  function extractLinks(body) {
    const source = String(body ?? "");
    const ranges = codeRanges(source);
    const comments = [];
    for (const match of source.matchAll(/%%[\s\S]*?%%/g)) comments.push([match.index, match.index + match[0].length]);
    const skip = (index) => inRanges(ranges, index) || inRanges(comments, index);
    const links = [];
    for (const match of source.matchAll(/(!?)\[\[([^\]\n]+?)\]\]/g)) {
      if (skip(match.index)) continue;
      const [target, alias] = match[2].split("|");
      links.push({
        embed: match[1] === "!",
        target: String(target || "").trim(),
        alias: String(alias || "").trim(),
        context: contextAround(source, match.index)
      });
    }
    for (const match of source.matchAll(/\[([^\]]+)\]\(([^)\s]+\.(?:md|markdown|txt)(?:#[^)]*)?)\)/gi)) {
      if (skip(match.index)) continue;
      let target = match[2];
      try { target = decodeURI(target); } catch { /* conservar tal cual */ }
      links.push({ embed: false, target: target.trim(), alias: match[1].trim(), context: contextAround(source, match.index) });
    }
    return links;
  }

  function parseHeadings(body) {
    const headings = [];
    const source = String(body ?? "");
    const ranges = codeRanges(source);
    const lines = source.split(/\r?\n/);
    let offset = 0;
    lines.forEach((line, index) => {
      if (!inRanges(ranges, offset)) {
        const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/);
        if (match) headings.push({ level: match[1].length, text: cleanInline(match[2]), line: index + 1 });
      }
      offset += line.length + 1;
    });
    return headings;
  }

  function parseNote(path, text, mtime, options = {}) {
    const raw = String(text ?? "");
    const { properties, body } = parseFrontmatter(raw);
    const aliases = collectAliases(properties);
    const tags = new Set(collectTags(properties));
    for (const tag of collectTagsFromBody(body)) tags.add(tag);
    const headings = parseHeadings(body);
    const links = extractLinks(body);
    const prose = proseFor(body);
    const propertyTitle = cleanInline(properties.title);
    const genericName = /^(índice|indice|index|inicio|sin título|sin titulo|untitled)$/i.test(stem(basename(path)));
    const firstH1 = headings.find((heading) => heading.level === 1);
    const title = propertyTitle || (genericName && firstH1 ? firstH1.text : stem(basename(path)));
    return {
      path,
      name: basename(path),
      stem: stem(basename(path)),
      title,
      body,
      raw,
      properties,
      aliases,
      tags: Array.from(tags),
      headings,
      links,
      words: wordCount(body),
      mtime: mtime || 0,
      bodyNorm: normalize(body),
      prose,
      proseNorm: normalize(prose),
      tooLarge: Boolean(options.tooLarge),
      readError: Boolean(options.readError)
    };
  }

  /* ------------------------------ resaltado -------------------------------- */

  function mergeRanges(ranges) {
    const sorted = ranges.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const range of sorted) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([range[0], range[1]]);
    }
    return merged;
  }

  function findMatchRanges(normalizedText, terms) {
    const ranges = [];
    const text = String(normalizedText ?? "");
    for (const rawTerm of terms || []) {
      const term = normalize(rawTerm);
      if (!term) continue;
      let index = 0;
      while (index <= text.length) {
        const found = text.indexOf(term, index);
        if (found < 0) break;
        ranges.push([found, found + term.length]);
        index = found + Math.max(1, term.length);
      }
    }
    return mergeRanges(ranges);
  }

  function highlightText(value, terms) {
    const original = String(value ?? "");
    if (!terms || !terms.length) return escapeHtml(original);
    const { text, map } = normalizeWithMap(original);
    const ranges = findMatchRanges(text, terms);
    if (!ranges.length) return escapeHtml(original);
    let html = "";
    let cursor = 0;
    for (const [start, end] of ranges) {
      const originalStart = map[start] ?? original.length;
      const originalEnd = (map[end - 1] ?? originalStart) + 1;
      if (originalStart < cursor) continue;
      html += escapeHtml(original.slice(cursor, originalStart));
      html += `<mark>${escapeHtml(original.slice(originalStart, originalEnd))}</mark>`;
      cursor = originalEnd;
    }
    return html + escapeHtml(original.slice(cursor));
  }

  function snippetText(body, terms, options = {}) {
    const source = String(body ?? "").replace(/\r?\n/g, "\n");
    const before = options.before ?? 70;
    const after = options.after ?? 150;
    const max = options.max ?? 180;
    const { text, map } = normalizeWithMap(source);
    const ranges = findMatchRanges(text, terms || []);
    if (!ranges.length) {
      const plain = source.replace(/\s+/g, " ").trim();
      return escapeHtml(plain.slice(0, max)) + (plain.length > max ? "…" : "");
    }
    const startNorm = Math.max(0, ranges[0][0] - before);
    const endNorm = Math.min(text.length, ranges[0][1] + after);
    const originalStart = map[startNorm] ?? 0;
    const originalEnd = endNorm < map.length ? map[endNorm] : source.length;
    const slice = source.slice(originalStart, originalEnd).replace(/\s+/g, " ").trim();
    return (originalStart > 0 ? "…" : "") + highlightText(slice, terms) + (originalEnd < source.length ? "…" : "");
  }

  function countOccurrences(normalizedText, term) {
    if (!term) return 0;
    let count = 0;
    let index = 0;
    while ((index = normalizedText.indexOf(term, index)) >= 0) {
      count += 1;
      index += Math.max(1, term.length);
    }
    return count;
  }

  return {
    escapeHtml,
    normalize,
    normalizeWithMap,
    extname,
    basename,
    stem,
    dirname,
    clamp,
    rotate3D,
    projectPoint,
    wordCount,
    readingMinutes,
    cleanInline,
    slugify,
    parseFrontmatter,
    parseYaml,
    parseScalar,
    collectAliases,
    collectTags,
    collectTagsFromBody,
    codeRanges,
    proseFor,
    contextAround,
    extractLinks,
    parseHeadings,
    parseNote,
    findMatchRanges,
    mergeRanges,
    highlightText,
    snippetText,
    countOccurrences
  };
});
