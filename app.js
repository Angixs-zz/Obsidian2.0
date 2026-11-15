/* Obsidian Web — lector y editor local-first.
   Los archivos se leen en el navegador. No hay red, cuentas ni telemetría. */
(() => {
  "use strict";

  const Core = window.ObsidianCore;
  const Writing = window.ObsidianWriting;
  if (!Core || !Writing) {
    document.body.textContent = "Falta un módulo de la aplicación (core.js o writing.js). Recarga la página para actualizarla.";
    return;
  }

  const {
    escapeHtml, normalize, normalizeWithMap, extname, basename, stem, dirname, clamp,
    rotate3D, projectPoint,
    wordCount, readingMinutes, cleanInline, slugify, parseFrontmatter, parseNote,
    highlightText, snippetText, findMatchRanges, countOccurrences
  } = Core;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const IGNORED_DIRS = new Set([".obsidian", ".trash", ".archivo", ".respaldos", ".git", "node_modules", "__pycache__", ".sync", ".stfolder"]);
  const NOTE_EXT = new Set([".md", ".markdown", ".txt"]);
  const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp"]);
  const AUDIO_EXT = new Set([".mp3", ".m4a", ".wav", ".ogg"]);
  const VIDEO_EXT = new Set([".mp4", ".webm", ".mov"]);
  const ATTACH_EXT = new Set([...IMAGE_EXT, ".pdf", ...AUDIO_EXT, ...VIDEO_EXT, ".xlsx", ".docx", ".pptx", ".canvas"]);
  const STORE_KEY = "obsidian-web-local-v1";
  const SETTINGS_VERSION = 2;
  const INDEX_CACHE_VERSION = 2;
  const MAX_TEXT = 4 * 1024 * 1024;
  const MAX_CACHED_TEXT = 200 * 1024;
  const MAX_URLS = 40;
  const CONCURRENCY = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));

  const reduceMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const state = {
    mode: null,
    vaultId: "",
    vaultName: "",
    rootHandle: null,
    savedHandle: null,
    files: new Map(),
    notes: new Map(),
    attachments: new Map(),
    byPath: new Map(),
    byStem: new Map(),
    byAlias: new Map(),
    backlinks: new Map(),
    tags: new Map(),
    urls: new Map(),
    indexCache: null,
    errors: [],
    indexing: false,
    view: { name: "home" },
    currentPath: null,
    editing: false,
    dirty: false,
    preview: true,
    saving: false,
    externalChange: false,
    query: "",
    graph: null,
    recent: [],
    favorites: new Set(),
    openFolders: new Set(),
    treeInitialized: false,
    paletteIndex: 0,
    paletteItems: [],
    paletteLastFocus: null,
    toastTimer: null,
    mentionsCache: new Map(),
    normCache: new Map(),
    historyReady: false,
    observer: null,
    viewerPath: null,
    viewerLastFocus: null
  };

  /* ------------------------------ utilidades ------------------------------ */

  const icon = (name, extra = "") => `<svg class="icon ${extra}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  const fmtNumber = (value) => new Intl.NumberFormat("es-MX").format(value || 0);
  const fmtBytes = (value) => {
    if (!value) return "0 B";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  };
  const fmtDate = (value) => {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" });
  };
  const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const debounce = (fn, wait = 160) => {
    let timer = 0;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  };
  const newId = () => (crypto && crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);

  const store = {
    load() {
      try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
    },
    save(data) {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* modo privado o cuota llena */ }
    }
  };

  function migrateSettings(raw) {
    const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const next = { ...data, schemaVersion: SETTINGS_VERSION };
    if (!next.vaults || typeof next.vaults !== "object") next.vaults = {};
    if (!next.lastNotes || typeof next.lastNotes !== "object") next.lastNotes = {};
    if (next.lastVault && next.lastNote && !next.lastNotes[next.lastVault]) next.lastNotes[next.lastVault] = next.lastNote;
    if (!["light", "dark"].includes(next.theme)) delete next.theme;
    for (const [key, value] of Object.entries(next.vaults)) {
      if (!value || typeof value !== "object") { next.vaults[key] = { favorites: [], recent: [] }; continue; }
      value.favorites = Array.isArray(value.favorites) ? value.favorites.slice(0, 500) : [];
      value.recent = Array.isArray(value.recent) ? value.recent.slice(0, 30) : [];
    }
    delete next.lastVault;
    delete next.lastNote;
    return next;
  }

  let settings = migrateSettings(store.load());

  /* ------------------------------- IndexedDB ------------------------------- */

  const idb = {
    db: null,
    open() {
      if (this.db) return this.db;
      this.db = new Promise((resolve, reject) => {
        const request = indexedDB.open("obsidian-web", 2);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("handles")) db.createObjectStore("handles");
          if (!db.objectStoreNames.contains("vaults")) db.createObjectStore("vaults");
          if (!db.objectStoreNames.contains("index")) db.createObjectStore("index");
        };
        request.onsuccess = () => {
          const db = request.result;
          // Otra pestaña puede pedir una actualización: se cierra para no bloquearla.
          db.onversionchange = () => { db.close(); this.db = null; };
          resolve(db);
        };
        request.onerror = () => {
          this.db = null;
          reject(request.error);
        };
      });
      return this.db;
    },
    async put(dbStore, key, value) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(dbStore, "readwrite");
        tx.objectStore(dbStore).put(value, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    },
    async get(dbStore, key) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(dbStore, "readonly");
        const request = tx.objectStore(dbStore).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    },
    set(key, value) { return this.put("handles", key, value); },
    getHandle(key) { return this.get("handles", key); },
    setIndex(key, value) { return this.put("index", key, value); },
    getIndex(key) { return this.get("index", key); }
  };

  /* --------------------------- identidad de bóveda -------------------------- */

  function vaultSettings() {
    if (!state.vaultId && !state.vaultName) return { favorites: [], recent: [] };
    settings.vaults = settings.vaults || {};
    let found = state.vaultId ? settings.vaults[state.vaultId] : null;
    if (!found && state.vaultName) found = settings.vaults[state.vaultName];
    if (found && !settings.vaults[state.vaultId] && state.vaultId) settings.vaults[state.vaultId] = found;
    return found || { favorites: [], recent: [] };
  }

  function persistVault() {
    if (!state.vaultId) return;
    settings.vaults = settings.vaults || {};
    settings.vaults[state.vaultId] = {
      favorites: Array.from(state.favorites).slice(0, 500),
      recent: state.recent.slice(0, 30)
    };
    settings.theme = document.documentElement.dataset.theme || "dark";
    store.save(settings);
  }

  async function identifyVault(handle) {
    const list = (await idb.get("vaults", "list").catch(() => null)) || [];
    const items = Array.isArray(list) ? list : [];
    for (const item of items) {
      if (!item || !item.handle) continue;
      try {
        if (await handle.isSameEntry(item.handle)) return item;
      } catch { /* handle caducado */ }
    }
    const item = { id: `fs:${newId()}`, name: handle.name, handle };
    items.push(item);
    idb.put("vaults", "list", items.slice(-40)).catch(() => {});
    return item;
  }

  /* --------------------------------- tema ---------------------------------- */

  function applyTheme(theme) {
    const next = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    settings.theme = next;
    store.save(settings);
    const button = $("#themeToggle");
    if (button) {
      button.innerHTML = icon(next === "light" ? "moon" : "sun");
      button.title = next === "light" ? "Cambiar a tema oscuro" : "Cambiar a tema claro";
    }
    if (state.graph && state.graph.redraw) state.graph.redraw();
  }

  function toast(message, kind = "") {
    const el = $("#toast");
    if (!el) return;
    el.textContent = message;
    el.className = `toast show ${kind}`.trim();
    el.setAttribute("role", kind === "error" ? "alert" : "status");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { el.className = "toast"; el.textContent = ""; }, kind === "error" ? 6500 : 3400);
  }

  function scrollTop() {
    const view = $("#view");
    if (view) view.scrollTop = 0;
  }

  function setBusy(busy) {
    const view = $("#view");
    if (view) {
      view.setAttribute("aria-busy", busy ? "true" : "false");
      view.classList.toggle("is-busy", Boolean(busy));
    }
  }

  function loadingView(label) {
    return `<div class="loading-view" role="status">
      <div class="skeleton skeleton-title"></div>
      <div class="skeleton skeleton-line"></div>
      <div class="skeleton skeleton-line short"></div>
      <p>${escapeHtml(label)}</p>
      <div class="progress-track"><i id="indexProgressBar"></i></div>
    </div>`;
  }

  function updateProgress(done, total) {
    const label = `${fmtNumber(done)} de ${fmtNumber(total)}`;
    const stats = $("#vaultStats");
    if (stats) stats.textContent = `Indexando ${label}…`;
    const bar = $("#indexProgressBar");
    if (bar && total) bar.style.width = `${Math.round((done / total) * 100)}%`;
  }

  /* ------------------------------ capacidades ------------------------------ */

  function capabilities() {
    const mode = state.mode;
    return {
      read: mode !== null,
      edit: mode === "fs" || mode === "files",
      create: mode === "fs",
      obsidian: mode === "fs",
      reload: mode === "fs",
      demo: mode === "demo"
    };
  }

  // Brave bloquea la API de archivos por defecto; Firefox y Safari no la ofrecen.
  function writeSupportHint() {
    if (navigator.brave) return "Brave bloquea la escritura en carpetas. Activa brave://flags/#file-system-access-api, reinicia Brave y vuelve a abrir la carpeta, o usa Chrome o Edge.";
    return "Este navegador no permite escribir en carpetas locales. Usa Chrome o Edge para guardar directamente en tus archivos.";
  }

  function syncModeUi() {
    const caps = capabilities();
    const readOnly = state.mode === "files";
    document.body.dataset.mode = state.mode || "none";
    const create = $("#newNote");
    if (create) {
      create.disabled = !caps.create;
      create.title = caps.create ? "Nueva nota" : (readOnly ? "No se pueden crear notas sin escritura en la carpeta. " + writeSupportHint() : "Crear notas requiere abrir una carpeta");
    }
    const notice = $("#writeNotice");
    if (notice) {
      notice.hidden = !readOnly;
      notice.innerHTML = readOnly ? `<strong>Sin escritura en la carpeta</strong><span>Puedes leer y editar, pero Guardar descarga una copia en lugar de actualizar el archivo, y no se pueden crear notas. ${escapeHtml(writeSupportHint())}</span>` : "";
    }
    const reload = $("#reloadVault");
    if (reload) {
      reload.disabled = !caps.reload;
      reload.title = caps.reload ? "Recargar desde el disco" : "Recargar solo está disponible al abrir una carpeta";
    }
    const badge = $("#modeBadge");
    if (badge) {
      badge.hidden = !(caps.demo || readOnly);
      badge.textContent = caps.demo ? "Demostración · solo lectura" : (readOnly ? "Sin escritura" : "");
    }
  }

  /* --------------------------- archivos y bóveda --------------------------- */

  function revokeUrls() {
    for (const entry of state.urls.values()) URL.revokeObjectURL(entry.url);
    state.urls.clear();
  }

  function resetState() {
    if (state.graph && state.graph.cleanup) state.graph.cleanup();
    state.graph = null;
    revokeUrls();
    if (state.observer) {
      try { state.observer.disconnect(); } catch { /* nada */ }
      state.observer = null;
    }
    state.files.clear();
    state.notes.clear();
    state.attachments.clear();
    state.byPath.clear();
    state.byStem.clear();
    state.byAlias.clear();
    state.backlinks.clear();
    state.tags.clear();
    state.mentionsCache.clear();
    state.normCache.clear();
    state.errors = [];
    state.indexCache = null;
    state.currentPath = null;
    state.editing = false;
    state.dirty = false;
    state.externalChange = false;
    state.saving = false;
    state.query = "";
    state.openFolders.clear();
    state.treeInitialized = false;
    state.vaultId = "";
    state.vaultName = "";
    state.rootHandle = null;
    state.mode = null;
    state.historyReady = false;
  }

  async function walkDirectory(handle, prefix = "") {
    let iterator;
    try {
      iterator = handle.values();
    } catch (error) {
      state.errors.push({ path: prefix || handle.name || "carpeta", error });
      return;
    }
    try {
      for await (const entry of iterator) {
        const name = entry.name;
        if (name.startsWith(".") || IGNORED_DIRS.has(name)) continue;
        const path = prefix ? `${prefix}/${name}` : name;
        try {
          if (entry.kind === "directory") {
            await walkDirectory(entry, path);
          } else {
            const extension = extname(name);
            if (!NOTE_EXT.has(extension) && !ATTACH_EXT.has(extension)) continue;
            state.files.set(path, { path, name, handle: entry, extension, mtime: 0, size: 0 });
          }
        } catch (error) {
          state.errors.push({ path, error });
        }
      }
    } catch (error) {
      state.errors.push({ path: prefix || handle.name || "carpeta", error });
    }
  }

  async function filesFromInput(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const rootName = (files[0].webkitRelativePath || "").split("/")[0] || "Biblioteca";
    resetState();
    state.mode = "files";
    state.vaultId = `files:${rootName}`;
    state.vaultName = rootName;
    for (const file of files) {
      const relative = file.webkitRelativePath || file.name;
      const parts = relative.split("/");
      parts.shift();
      const path = parts.join("/") || file.name;
      const extension = extname(file.name);
      if (!NOTE_EXT.has(extension) && !ATTACH_EXT.has(extension)) continue;
      state.files.set(path, { path, name: file.name, file, extension, mtime: file.lastModified, size: file.size });
    }
    setBusy(true);
    $("#view").innerHTML = loadingView("Leyendo los archivos seleccionados…");
    await finishOpen();
  }

  async function openDirectoryPicker(options = {}) {
    if (options.guard !== false && !confirmDiscard()) return;
    if (!window.showDirectoryPicker) {
      $("#fallbackPicker").click();
      return;
    }
    let handle;
    try {
      handle = await window.showDirectoryPicker();
    } catch (error) {
      if (error && error.name === "AbortError") return;
      console.error(error);
      toast("No se pudo abrir la carpeta: " + (error.message || error.name), "error");
      return;
    }
    const permission = await handle.queryPermission({ mode: "readwrite" }).catch(() => "prompt");
    resetState();
    state.mode = "fs";
    state.rootHandle = handle;
    state.savedHandle = handle;
    state.vaultName = handle.name;
    const vault = await identifyVault(handle);
    state.vaultId = vault.id;
    idb.set("lastHandle", handle).catch(() => {});
    const reopen = $("#reopenVault");
    if (reopen) { reopen.textContent = "Reabrir última"; reopen.hidden = false; }
    setBusy(true);
    $("#view").innerHTML = loadingView("Leyendo la carpeta…");
    try {
      await walkDirectory(handle);
      await finishOpen();
      if (permission !== "granted") toast("Abierta en solo lectura. Al guardar se pedirá permiso.");
    } catch (error) {
      console.error(error);
      toast("No se pudo abrir la carpeta: " + (error.message || error.name), "error");
      setBusy(false);
    }
  }

  async function reopenSaved() {
    if (!confirmDiscard()) return;
    const handle = state.savedHandle;
    if (!handle) { openDirectoryPicker({ guard: false }); return; }
    try {
      let permission = await handle.queryPermission({ mode: "read" });
      if (permission !== "granted") permission = await handle.requestPermission({ mode: "read" });
      if (permission !== "granted") { toast("El navegador no dio permiso para leer esa carpeta.", "error"); return; }
      resetState();
      state.mode = "fs";
      state.rootHandle = handle;
      state.vaultName = handle.name;
      const vault = await identifyVault(handle);
      state.vaultId = vault.id;
      setBusy(true);
      $("#view").innerHTML = loadingView("Releyendo la carpeta…");
      await walkDirectory(handle);
      await finishOpen();
    } catch (error) {
      console.error(error);
      toast("No se pudo reabrir la carpeta. Elige otra vez.", "error");
      openDirectoryPicker({ guard: false });
    }
  }

  async function finishOpen() {
    const started = performance.now();
    await buildIndex();
    const vault = vaultSettings();
    state.favorites = new Set((vault.favorites || []).filter((path) => state.notes.has(path)));
    state.recent = Array.isArray(vault.recent) ? vault.recent.filter((path) => state.notes.has(path)) : [];
    const last = settings.lastNotes[state.vaultId] || null;
    const vaultName = $("#vaultName");
    if (vaultName) vaultName.textContent = state.vaultName;
    const stats = $("#vaultStats");
    if (stats) stats.textContent = `${fmtNumber(state.notes.size)} notas`;
    document.title = `${state.vaultName} · Obsidian Web`;
    syncModeUi();
    renderTree();
    startObserver();
    state.historyReady = true;
    let restored = false;
    if (location.hash.startsWith("#/")) restored = applyLocation();
    if (!restored) {
      if (last && state.notes.has(last)) openNote(last, { history: false });
      else setView({ name: "home" }, { history: false });
    }
    if (!location.hash || location.hash === "#") history.replaceState(null, "", hashForView());
    setBusy(false);
    if (state.errors.length) {
      toast(`Bóveda abierta con ${fmtNumber(state.errors.length)} incidencia(s). Revisa el aviso en Inicio.`, "error");
    } else {
      toast(`Bóveda lista: ${fmtNumber(state.notes.size)} notas en ${Math.round(performance.now() - started)} ms`);
    }
  }

  async function buildIndex() {
    state.notes.clear();
    state.attachments.clear();
    state.byPath.clear();
    state.byStem.clear();
    state.byAlias.clear();
    state.mentionsCache.clear();
    state.normCache.clear();
    state.indexing = true;

    let cache = { version: INDEX_CACHE_VERSION, entries: {} };
    try {
      const stored = await idb.getIndex(state.vaultId);
      if (stored && stored.version === INDEX_CACHE_VERSION && stored.entries && typeof stored.entries === "object") cache = stored;
    } catch { /* sin caché */ }
    const cachedEntries = cache.entries;
    const nextEntries = {};

    const paths = Array.from(state.files.keys()).sort((a, b) => a.localeCompare(b, "es"));
    const noteRecords = [];
    for (const path of paths) {
      const record = state.files.get(path);
      if (NOTE_EXT.has(record.extension)) noteRecords.push(record);
      else state.attachments.set(path, record);
    }

    const total = noteRecords.length;
    let done = 0;
    updateProgress(done, total);
    const results = new Array(total);

    let cursor = 0;
    const worker = async () => {
      while (cursor < total) {
        const index = cursor;
        cursor += 1;
        const record = noteRecords[index];
        let file = record.file;
        let mtime = record.mtime || 0;
        let size = record.size || 0;
        try {
          if (record.handle) file = await record.handle.getFile();
          mtime = (file && file.lastModified) || mtime;
          size = (file && typeof file.size === "number") ? file.size : size;
          record.mtime = mtime;
          record.size = size;
        } catch (error) {
          state.errors.push({ path: record.path, error });
          results[index] = parseNote(record.path, "", mtime, { readError: true });
          done += 1;
          continue;
        }

        const cached = cachedEntries[record.path];
        if (cached && cached.note && cached.mtime === mtime && cached.size === size) {
          results[index] = { ...cached.note, path: record.path, mtime };
          nextEntries[record.path] = cached;
        } else {
          let text = "";
          let tooLarge = false;
          try {
            if (size > MAX_TEXT) tooLarge = true;
            else text = await file.text();
          } catch (error) {
            state.errors.push({ path: record.path, error });
          }
          const note = parseNote(record.path, text, mtime, { tooLarge });
          results[index] = note;
          if (!tooLarge && text.length <= MAX_CACHED_TEXT) {
            nextEntries[record.path] = { mtime, size, note: cleanNoteForCache(note) };
          }
        }
        done += 1;
        if (done % 8 === 0 || done === total) updateProgress(done, total);
        if (done % 40 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };

    try {
      const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(1, total)) }, worker);
      await Promise.all(workers);
    } catch (error) {
      state.errors.push({ path: "índice", error });
    }

    for (let i = 0; i < results.length; i += 1) {
      if (results[i]) state.notes.set(results[i].path, results[i]);
    }

    state.indexCache = { version: INDEX_CACHE_VERSION, entries: nextEntries };
    idb.setIndex(state.vaultId, state.indexCache).catch(() => {});
    rebuildPathIndex();
    rebuildLinks();
    rebuildTags();
    state.indexing = false;
  }

  function cleanNoteForCache(note) {
    return {
      ...note,
      links: note.links.map(({ resolved, ambiguous, candidates, ...link }) => link)
    };
  }

  function rebuildPathIndex() {
    state.byPath.clear();
    state.byStem.clear();
    state.byAlias.clear();
    const addStem = (key, path) => {
      if (!key) return;
      if (!state.byStem.has(key)) state.byStem.set(key, []);
      const list = state.byStem.get(key);
      if (!list.includes(path)) list.push(path);
    };
    for (const [path, note] of state.notes) {
      const noExt = path.replace(/\.(md|markdown|txt)$/i, "");
      const pathKeys = new Set([
        path.toLowerCase(), normalize(path),
        noExt.toLowerCase(), normalize(noExt)
      ]);
      for (const key of pathKeys) if (key) state.byPath.set(key, path);
      const name = basename(path);
      const nameKeys = new Set([
        name.toLowerCase(), normalize(name),
        stem(name).toLowerCase(), normalize(stem(name))
      ]);
      for (const key of nameKeys) addStem(key, path);
      for (const alias of note.aliases) {
        const key = normalize(alias);
        if (!state.byAlias.has(key)) state.byAlias.set(key, []);
        const list = state.byAlias.get(key);
        if (!list.includes(path)) list.push(path);
      }
    }
  }

  function resolveLinkInfo(target, fromPath) {
    if (!target) return fromPath ? { path: fromPath, ambiguous: false } : null;
    let clean = String(target).trim().split("|")[0].split("#")[0].split("^")[0].trim();
    if (!clean) return fromPath ? { path: fromPath, ambiguous: false } : null;
    clean = clean.replace(/^\.\//, "");
    const lower = clean.toLowerCase();
    const noExt = lower.replace(/\.(md|markdown|txt)$/i, "");
    const exactKeys = [lower, normalize(clean), noExt, normalize(noExt)];
    for (const key of exactKeys) {
      if (state.byPath.has(key)) return { path: state.byPath.get(key), ambiguous: false, via: "exact" };
    }
    const fromDir = fromPath ? dirname(fromPath) : "";
    if (fromDir) {
      const relative = `${fromDir}/${clean}`;
      for (const key of [relative.toLowerCase(), normalize(relative)]) {
        if (state.byPath.has(key)) return { path: state.byPath.get(key), ambiguous: false, via: "relative" };
      }
    }
    const alias = state.byAlias.get(normalize(clean));
    if (alias && alias.length) {
      return { path: alias[0], ambiguous: alias.length > 1, candidates: alias.slice(), via: "alias" };
    }
    const name = basename(clean);
    const candidates = state.byStem.get(name.toLowerCase())
      || state.byStem.get(normalize(name))
      || state.byStem.get(stem(name).toLowerCase())
      || state.byStem.get(normalize(stem(name)))
      || [];
    const unique = Array.from(new Set(candidates));
    if (!unique.length) return null;
    if (unique.length === 1) return { path: unique[0], ambiguous: false, via: "global" };
    const ranked = unique.slice().sort((a, b) => {
      const aNear = fromDir && dirname(a) === fromDir ? 0 : 1;
      const bNear = fromDir && dirname(b) === fromDir ? 0 : 1;
      return aNear - bNear || a.length - b.length || a.localeCompare(b, "es");
    });
    return { path: ranked[0], ambiguous: true, candidates: ranked, via: "global" };
  }

  function resolveLink(target, fromPath) {
    const info = resolveLinkInfo(target, fromPath);
    return info ? info.path : null;
  }

  function attachmentInfo(target) {
    if (!target) return null;
    const clean = String(target).trim().split("|")[0].split("#")[0].trim();
    if (!clean) return null;
    if (state.attachments.has(clean)) return { path: clean, ambiguous: false };
    const lower = clean.toLowerCase();
    const normalized = normalize(clean);
    const name = basename(clean).toLowerCase();
    const normalizedName = normalize(basename(clean));
    const matches = [];
    for (const [path, record] of state.attachments) {
      const recordName = record.name.toLowerCase();
      if (path.toLowerCase() === lower || normalize(path) === normalized
        || recordName === name || normalize(record.name) === normalizedName) {
        matches.push(path);
      }
    }
    if (!matches.length) return null;
    return { path: matches[0], ambiguous: matches.length > 1, candidates: matches };
  }

  function attachmentPath(target) {
    const info = attachmentInfo(target);
    return info ? info.path : null;
  }

  function rebuildLinks() {
    state.backlinks.clear();
    state.mentionsCache.clear();
    for (const note of state.notes.values()) {
      note.links = note.links.map((link) => {
        const info = link.embed && IMAGE_EXT.has(extname(link.target.split("|")[0].trim()))
          ? attachmentInfo(link.target)
          : resolveLinkInfo(link.target, note.path);
        return {
          ...link,
          resolved: info ? info.path : null,
          ambiguous: info ? Boolean(info.ambiguous) : false,
          candidates: info && info.candidates ? info.candidates : undefined
        };
      });
      for (const link of note.links) {
        if (!link.resolved || link.embed) continue;
        if (!state.notes.has(link.resolved)) continue;
        if (!state.backlinks.has(link.resolved)) state.backlinks.set(link.resolved, []);
        const list = state.backlinks.get(link.resolved);
        if (!list.some((item) => item.from === note.path)) list.push({ from: note.path, context: link.context || "" });
      }
    }
  }

  function rebuildTags() {
    state.tags.clear();
    for (const note of state.notes.values()) {
      for (const tag of note.tags) {
        if (!state.tags.has(tag)) state.tags.set(tag, new Set());
        state.tags.get(tag).add(note.path);
      }
    }
  }

  function replaceNote(path, text, mtime) {
    const note = parseNote(path, text, mtime);
    state.notes.set(path, note);
    state.normCache.delete(path);
    state.mentionsCache.clear();
    if (state.indexCache) {
      if (text.length <= MAX_CACHED_TEXT) {
        state.indexCache.entries[path] = { mtime, size: new Blob([text]).size, note: cleanNoteForCache(note) };
      } else {
        delete state.indexCache.entries[path];
      }
      persistIndexCache();
    }
    rebuildPathIndex();
    rebuildLinks();
    rebuildTags();
    return note;
  }

  const persistIndexCache = debounce(() => {
    if (!state.indexCache || !state.vaultId) return;
    idb.setIndex(state.vaultId, state.indexCache).catch(() => {});
  }, 700);

  /* --------------------------- markdown a HTML ---------------------------- */

  const CODE_TOKEN = "OW-CODE-TOKEN-";

  function renderMarkdown(source, note) {
    const stash = [];
    let text = String(source || "");
    // Primero se protege el código; así los comentarios %% dentro de un bloque
    // de código no se comen código real.
    text = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (block) => {
      stash.push(block);
      return `\n\n${CODE_TOKEN}${stash.length - 1}-END\n\n`;
    });
    text = text.replace(/`[^`\n]+`/g, (code) => {
      stash.push(code);
      return `${CODE_TOKEN}${stash.length - 1}-END`;
    });
    text = text.replace(/%%[\s\S]*?%%/g, "");
    text = text.replace(/==([^=\n]+)==/g, "<mark>$1</mark>");

    const current = note || { path: state.currentPath || "", title: "" };

    text = text.replace(/(!?)\[\[([^\]\n]+?)\]\]/g, (match, bang, raw) => {
      const [targetPart, aliasPart] = raw.split("|");
      const target = targetPart.trim();
      const alias = (aliasPart || "").trim();
      const anchor = target.includes("#") ? target.split("#").slice(1).join("#").trim() : "";
      const cleanTarget = target.split("#")[0].split("^")[0].trim();
      const info = resolveLinkInfo(cleanTarget, current.path);
      const targetNote = info ? state.notes.get(info.path) : null;
      const label = alias || (targetNote ? targetNote.title : cleanTarget) || target;

      if (bang === "!") {
        const isImage = IMAGE_EXT.has(extname(cleanTarget));
        const attachment = attachmentInfo(cleanTarget);
        if (isImage) {
          if (!attachment) return `<span class="missing-attachment">${icon("alert")} Imagen no encontrada: ${escapeHtml(cleanTarget)}</span>`;
          const warning = attachment.ambiguous ? ` title="Hay varios adjuntos con ese nombre; se muestra ${escapeHtml(basename(attachment.path))}"` : "";
          return `<img class="wiki-embed" data-attach="${escapeHtml(attachment.path)}" alt="${escapeHtml(label)}" loading="lazy"${warning}>`;
        }
        if (attachment) {
          return `<a class="attach-card" href="#" data-attach="${escapeHtml(attachment.path)}"><span class="attach-icon">${attachmentIcon(attachment.path)}</span><span><b>${escapeHtml(basename(attachment.path))}</b><small>Abrir adjunto</small></span></a>`;
        }
        if (targetNote) {
          const excerpt = excerptFor(targetNote, anchor);
          return `<button class="embed-note" data-note="${escapeHtml(targetNote.path)}"><b>${escapeHtml(targetNote.title)}${anchor ? " › " + escapeHtml(anchor) : ""}</b><span>${escapeHtml(excerpt)}</span></button>`;
        }
        return `<span class="missing-attachment">${icon("alert")} No se encontró: ${escapeHtml(cleanTarget)}</span>`;
      }

      if (info && state.notes.has(info.path)) {
        const ambiguous = info.ambiguous ? ` class="wiki-link is-ambiguous"` : ` class="wiki-link"`;
        const warning = info.ambiguous ? ` title="Enlace ambiguo: ${escapeHtml((info.candidates || []).map((path) => basename(path)).join(" · "))}. Se abrirá ${escapeHtml(basename(info.path))}."` : "";
        return `<a href="#"${ambiguous} data-note="${escapeHtml(info.path)}"${anchor ? ` data-anchor="${escapeHtml(anchor)}"` : ""}${warning}>${escapeHtml(label)}</a>`;
      }
      const attachment = attachmentInfo(cleanTarget);
      if (attachment) {
        return `<a href="#" class="wiki-link" data-attach="${escapeHtml(attachment.path)}">${escapeHtml(label)}</a>`;
      }
      return `<span class="wiki-link is-broken" title="No existe una nota con ese nombre">${escapeHtml(label)}</span>`;
    });

    text = text.replace(/(^|[\s(>])#([\p{L}\p{N}_][\p{L}\p{N}_/-]{0,59})/gu, (match, prefix, tag) => {
      return `${prefix}<a href="#" class="tag-link" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</a>`;
    });

    let html = "";
    try {
      html = marked.parse(text, { gfm: true, breaks: false });
    } catch (error) {
      html = `<p>${escapeHtml(text)}</p>`;
    }

    html = html.replace(new RegExp(`${CODE_TOKEN}(\\d+)-END`, "g"), (match, index) => {
      const block = stash[Number(index)] || "";
      if (block.startsWith("```") || block.startsWith("~~~")) {
        const body = block.replace(/^```[^\n]*\n?|^~~~[^\n]*\n?/g, "").replace(/```$|~~~$/g, "");
        return `<pre><code>${escapeHtml(body.replace(/\n$/, ""))}</code></pre>`;
      }
      return `<code>${escapeHtml(block.replace(/^`|`$/g, ""))}</code>`;
    });

    html = DOMPurify.sanitize(html, {
      ADD_ATTR: ["target", "rel", "data-note", "data-tag", "data-attach", "data-anchor", "class", "title", "loading"],
      ADD_TAGS: ["mark"]
    });

    const holder = document.createElement("div");
    holder.innerHTML = html;
    upgradeMarkdown(holder);
    return holder.innerHTML;
  }

  function excerptFor(note, anchor) {
    let body = note.body;
    if (anchor) {
      const lines = body.split("\n");
      const index = lines.findIndex((line) => line.replace(/^#+\s*/, "").trim().toLowerCase() === anchor.toLowerCase());
      if (index >= 0) {
        const level = (lines[index].match(/^#+/) || ["#"])[0].length;
        let end = lines.length;
        for (let i = index + 1; i < lines.length; i += 1) {
          const match = lines[i].match(/^(#{1,6})\s/);
          if (match && match[1].length <= level) { end = i; break; }
        }
        body = lines.slice(index + 1, end).join("\n");
      }
    }
    return body
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/!\[\[[^\]]+\]\]/g, " ")
      .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, "$1")
      .replace(/[#>*_`~-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 260) || "Nota sin texto.";
  }

  function upgradeMarkdown(holder) {
    const seen = new Map();
    $$("h1, h2, h3, h4, h5, h6", holder).forEach((heading) => {
      let slug = slugify(heading.textContent);
      if (seen.has(slug)) {
        const count = seen.get(slug) + 1;
        seen.set(slug, count);
        slug = `${slug}-${count}`;
      } else {
        seen.set(slug, 0);
      }
      heading.id = slug;
      const link = document.createElement("a");
      link.className = "heading-anchor";
      link.href = `#${slug}`;
      link.textContent = "#";
      link.setAttribute("aria-label", "Enlace a esta sección");
      heading.appendChild(link);
    });

    $$("table", holder).forEach((table) => {
      const wrap = document.createElement("div");
      wrap.className = "table-scroll";
      table.replaceWith(wrap);
      wrap.appendChild(table);
    });

    $$("blockquote", holder).forEach((quote) => {
      const first = quote.querySelector("p");
      if (!first) return;
      const match = first.innerHTML.match(/^\[!([\w-]+)\][+-]?\s*([^\n<]*)(?:\n|<br\s*\/?>)?\s*/);
      if (!match) return;
      quote.classList.add("callout");
      const title = document.createElement("div");
      title.className = "callout-title";
      title.textContent = (match[2] || match[1]).trim();
      const rest = first.innerHTML.slice(match[0].length);
      if (rest.trim()) first.innerHTML = rest;
      else first.remove();
      quote.prepend(title);
    });

    $$("input[type=checkbox]", holder).forEach((input) => { input.disabled = true; });

    $$("img[data-attach]", holder).forEach((image) => {
      const path = image.dataset.attach;
      attachmentURL(path).then((url) => {
        if (url) image.src = url;
        else image.replaceWith(missingAttachment(path));
      }).catch(() => image.replaceWith(missingAttachment(path)));
    });

    $$("a[href]", holder).forEach((link) => {
      const href = link.getAttribute("href") || "";
      if (/^https?:/i.test(href)) {
        link.target = "_blank";
        link.rel = "noreferrer noopener";
      }
      const mdLink = href.match(/^(?:\.\/)?(.+?)\.(?:md|markdown|txt)(?:#(.+))?$/i);
      if (mdLink) {
        try {
          link.dataset.wiki = decodeURI(mdLink[1]);
          if (mdLink[2]) link.dataset.anchor = decodeURI(mdLink[2]);
        } catch {
          link.dataset.wiki = mdLink[1];
        }
        link.setAttribute("href", "#");
        link.classList.add("wiki-link");
      }
    });
  }

  function missingAttachment(name) {
    const span = document.createElement("span");
    span.className = "missing-attachment";
    span.textContent = "Adjunto no encontrado: " + basename(name);
    return span;
  }

  function attachmentIcon(path) {
    const extension = extname(path);
    if (extension === ".pdf") return "PDF";
    if ([".xlsx", ".docx", ".pptx"].includes(extension)) return "DOC";
    if (AUDIO_EXT.has(extension)) return "AUD";
    if (VIDEO_EXT.has(extension)) return "VID";
    return "FILE";
  }

  function trimUrls() {
    while (state.urls.size > MAX_URLS) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [key, entry] of state.urls) {
        if (entry.used < oldest) { oldest = entry.used; oldestKey = key; }
      }
      if (oldestKey == null) break;
      const entry = state.urls.get(oldestKey);
      URL.revokeObjectURL(entry.url);
      state.urls.delete(oldestKey);
    }
  }

  async function attachmentURL(path) {
    if (!path) return null;
    const record = state.files.get(path);
    if (!record) return null;
    const cached = state.urls.get(path);
    try {
      const file = record.handle ? await record.handle.getFile() : record.file;
      if (!file) return null;
      const mtime = file.lastModified || record.mtime || 0;
      if (cached && cached.mtime === mtime && cached.size === file.size) {
        cached.used = Date.now();
        return cached.url;
      }
      if (cached) URL.revokeObjectURL(cached.url);
      const url = URL.createObjectURL(file);
      state.urls.set(path, { url, mtime, size: file.size, used: Date.now() });
      trimUrls();
      return url;
    } catch (error) {
      console.warn("No se pudo abrir el adjunto", path, error);
      return null;
    }
  }

  async function openAttachment(path) {
    const extension = extname(path);
    if (IMAGE_EXT.has(extension) || extension === ".pdf" || AUDIO_EXT.has(extension) || VIDEO_EXT.has(extension)) {
      await openViewer(path);
      return;
    }
    // La pestaña se abre de forma síncrona para no perder el gesto del usuario.
    const win = window.open("", "_blank");
    const url = await attachmentURL(path);
    if (win) {
      if (url) win.location.href = url;
      else win.close();
    }
    if (!url) { toast("No se pudo abrir el adjunto.", "error"); return; }
    if (!win) await openViewer(path);
  }

  async function openViewer(path) {
    const url = await attachmentURL(path);
    if (!url) { toast("No se pudo abrir el adjunto.", "error"); return; }
    const modal = $("#attachmentViewer");
    const body = $("#viewerBody");
    const title = $("#viewerTitle");
    const download = $("#viewerDownload");
    if (!modal || !body) { window.open(url, "_blank", "noopener"); return; }
    if (modal.hidden) state.viewerLastFocus = document.activeElement;
    state.viewerPath = path;
    title.textContent = basename(path);
    download.href = url;
    download.download = basename(path);
    download.hidden = false;
    const extension = extname(path);
    if (IMAGE_EXT.has(extension)) body.innerHTML = `<img src="${escapeHtml(url)}" alt="${escapeHtml(basename(path))}">`;
    else if (extension === ".pdf") body.innerHTML = `<iframe src="${escapeHtml(url)}" title="${escapeHtml(basename(path))}"></iframe>`;
    else if (AUDIO_EXT.has(extension)) body.innerHTML = `<audio controls autoplay src="${escapeHtml(url)}"></audio>`;
    else if (VIDEO_EXT.has(extension)) body.innerHTML = `<video controls autoplay src="${escapeHtml(url)}"></video>`;
    else body.innerHTML = `<p class="empty-mini">Vista previa no disponible. Usa el botón de descarga.</p>`;
    modal.hidden = false;
    $("#viewerClose").focus();
  }

  function closeViewer() {
    const modal = $("#attachmentViewer");
    if (!modal || modal.hidden) return false;
    modal.hidden = true;
    const body = $("#viewerBody");
    if (body) body.innerHTML = "";
    state.viewerPath = null;
    const previous = state.viewerLastFocus;
    state.viewerLastFocus = null;
    if (previous && typeof previous.focus === "function" && previous.isConnected) previous.focus();
    return true;
  }

  /* ------------------------------ componentes ------------------------------ */

  function noteCard(path, options = {}) {
    const note = state.notes.get(path);
    if (!note) return "";
    const tags = note.tags.slice(0, 3).map((tag) => `<span class="chip">#${escapeHtml(tag)}</span>`).join("");
    const subtitle = options.subtitle || `${dirname(path) || "Raíz"} · ${fmtNumber(note.words)} palabras`;
    return `<button class="note-card" data-note="${escapeHtml(path)}">
      <strong>${escapeHtml(note.title)}</strong>
      <span>${escapeHtml(subtitle)}</span>
      ${tags ? `<div class="mini-tags">${tags}</div>` : ""}
    </button>`;
  }

  function buildTree() {
    const root = { folders: new Map(), files: [] };
    for (const path of state.files.keys()) {
      const parts = path.split("/");
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const name = parts[i];
        if (!node.folders.has(name)) node.folders.set(name, { folders: new Map(), files: [] });
        node = node.folders.get(name);
      }
      node.files.push(path);
    }
    return root;
  }

  function renderTree() {
    const tree = buildTree();
    if (!state.treeInitialized) {
      state.treeInitialized = true;
      for (const name of tree.folders.keys()) state.openFolders.add(name);
    }
    const html = renderTreeLevel(tree, "");
    $("#fileTree").innerHTML = html || `<p class="empty-mini" style="padding:8px">Abre una carpeta para ver tus notas.</p>`;
  }

  function renderTreeLevel(node, prefix) {
    let html = "";
    const folders = Array.from(node.folders.keys()).sort((a, b) => a.localeCompare(b, "es"));
    for (const name of folders) {
      const path = prefix ? `${prefix}/${name}` : name;
      const child = node.folders.get(name);
      const count = countFiles(child);
      const isOpen = state.openFolders.has(path);
      html += `<details class="tree-folder" data-folder="${escapeHtml(path)}"${isOpen ? " open" : ""}>
        <summary><span>${escapeHtml(name)}</span><small>${count}</small></summary>
        <div class="tree-children">${renderTreeLevel(child, path)}</div>
      </details>`;
    }
    const files = node.files.slice().sort((a, b) => {
      const aNote = state.notes.has(a) ? 0 : 1;
      const bNote = state.notes.has(b) ? 0 : 1;
      if (aNote !== bNote) return aNote - bNote;
      return basename(a).localeCompare(basename(b), "es");
    });
    for (const path of files) {
      const active = state.currentPath === path ? " active" : "";
      const name = basename(path);
      const note = state.notes.get(path);
      const icon = note ? "" : attachmentIcon(path);
      html += `<button class="tree-file${active}" data-path="${escapeHtml(path)}" title="${escapeHtml(path)}"${active ? ' aria-current="page"' : ""}>${icon ? `<small class="tree-ext">${icon}</small>` : ""}<span>${escapeHtml(note ? note.title : name)}</span></button>`;
    }
    return html;
  }

  function countFiles(node) {
    let count = node.files.length;
    for (const child of node.folders.values()) count += countFiles(child);
    return count;
  }

  function folderPaths() {
    const folders = new Set();
    for (const path of state.files.keys()) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i += 1) folders.add(parts.slice(0, i).join("/"));
    }
    return Array.from(folders).sort((a, b) => a.localeCompare(b, "es"));
  }

  function revealInTree(path) {
    if (!path) return;
    const folder = dirname(path);
    let prefix = "";
    let changed = false;
    for (const part of folder.split("/").filter(Boolean)) {
      prefix = prefix ? `${prefix}/${part}` : part;
      if (!state.openFolders.has(prefix)) { state.openFolders.add(prefix); changed = true; }
    }
    if (changed) renderTree();
    requestAnimationFrame(() => {
      const button = $$(".tree-file").find((item) => item.dataset.path === path);
      if (button) button.scrollIntoView({ block: "nearest" });
    });
  }

  function brokenLinks() {
    const broken = [];
    for (const note of state.notes.values()) {
      for (const link of note.links) {
        if (link.resolved || link.embed) continue;
        broken.push({ from: note.path, target: link.target, ambiguous: Boolean(link.ambiguous) });
      }
    }
    return broken;
  }

  function topLinked(limit = 8) {
    return Array.from(state.backlinks.entries())
      .map(([path, list]) => ({ path, count: list.length }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .filter((item) => item.count > 0);
  }

  /* --------------------------------- inicio -------------------------------- */

  function renderHomeView() {
    const view = $("#view");
    if (!state.notes.size) {
      view.innerHTML = `<div class="empty-state"><div class="empty-card">
        <div class="empty-icon">${icon("graph")}</div>
        <h1>Tu biblioteca, sin subirla a ningún lado</h1>
        <p>Elige la carpeta donde están tus notas. El navegador la lee directamente de tu disco y guarda el progreso solo en este equipo.</p>
        <div class="empty-actions">
          <button id="emptyOpen" class="primary-btn">${icon("folder")} Abrir mi carpeta</button>
          <button id="emptyDemo" class="ghost-btn">Ver demostración</button>
        </div>
        <p class="privacy-note">Funciona en Chrome, Edge u otro navegador con acceso a carpetas. En Firefox se abre en modo lectura mediante el selector de archivos.</p>
      </div></div>`;
      $("#emptyOpen")?.addEventListener("click", () => openDirectoryPicker());
      $("#emptyDemo")?.addEventListener("click", () => openDemo());
      return;
    }

    const notes = Array.from(state.notes.values());
    const totalWords = notes.reduce((sum, note) => sum + note.words, 0);
    const linkCount = notes.reduce((sum, note) => sum + note.links.length, 0);
    const broken = brokenLinks();
    const recent = state.recent.map((path) => state.notes.get(path)).filter(Boolean).slice(0, 6);
    const indexes = notes
      .filter((note) => /^(inicio|índice|indice|index)$/i.test(note.stem) || /índice/i.test(note.stem))
      .sort((a, b) => a.path.localeCompare(b.path, "es"))
      .slice(0, 8);
    const linked = topLinked(6);
    const folderCounts = new Map();
    for (const note of notes) {
      const top = note.path.includes("/") ? note.path.split("/")[0] : "Raíz";
      folderCounts.set(top, (folderCounts.get(top) || 0) + 1);
    }
    const folders = Array.from(folderCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 7);
    const maxFolder = Math.max(1, ...folders.map(([, count]) => count));
    const errors = state.errors;

    const section = (title, hint, content) => `<section class="home-section">
      <div class="section-title"><h2>${escapeHtml(title)}</h2><span>${escapeHtml(hint)}</span></div>
      ${content}
    </section>`;

    view.innerHTML = `<div class="home">
      ${errors.length ? `<div class="notice error" role="alert"><strong>${icon("alert")} ${fmtNumber(errors.length)} incidencia(s) al leer la bóveda</strong>
        <span>${escapeHtml(errors.slice(0, 3).map((item) => item.path).join(" · "))}${errors.length > 3 ? "…" : ""}. Las notas afectadas se muestran vacías; el resto funciona con normalidad.</span></div>` : ""}

      <section class="hero">
        <div class="eyebrow">Biblioteca local · Obsidian Web</div>
        <h1>${escapeHtml(state.vaultName)}</h1>
        <p>Lectura y edición directamente desde tu disco. Nada sale de este equipo.</p>
        <div class="hero-actions">
          <button data-action="random">${icon("shuffle")} Nota al azar</button>
          <button data-action="focus-search">${icon("search")} Buscar</button>
          <button data-action="graph">${icon("graph")} Ver grafo</button>
          <button data-action="reopen">${icon("folder")} Cambiar de carpeta</button>
        </div>
      </section>

      <div class="stat-grid">
        <div class="stat"><b>${fmtNumber(notes.length)}</b><span>notas</span></div>
        <div class="stat"><b>${fmtNumber(state.tags.size)}</b><span>etiquetas</span></div>
        <div class="stat"><b>${fmtNumber(linkCount)}</b><span>enlaces</span></div>
        <div class="stat"><b>${fmtNumber(totalWords)}</b><span>palabras</span></div>
      </div>

      <div class="home-grid">
        <div class="home-col">
          ${section("Continúa leyendo", "últimas notas abiertas", recent.length
            ? `<div class="card-grid">${recent.map((note) => noteCard(note.path, { subtitle: `${fmtNumber(note.words)} palabras · ${readingMinutes(note.words)} min` })).join("")}</div>`
            : `<p class="empty-mini">Todavía no has abierto ninguna nota.</p>`)}
          ${section("Puntos de entrada", "índices e inicios", indexes.length
            ? `<div class="card-grid">${indexes.map((note) => noteCard(note.path, { subtitle: dirname(note.path) || "Raíz" })).join("")}</div>`
            : `<p class="empty-mini">No hay notas llamadas Inicio, Índice o Index.</p>`)}
        </div>
        <div class="home-col">
          ${section("Notas más enlazadas", "por backlinks", linked.length
            ? `<div class="card-grid">${linked.map((item) => noteCard(item.path, { subtitle: `${item.count} enlaces entrantes` })).join("")}</div>`
            : `<p class="empty-mini">Todavía no hay enlaces entre notas.</p>`)}
          ${section("Carpetas", `${folders.length} grupos principales`, `<div class="folder-bars">${folders.map(([name, count]) => `<button class="folder-bar" data-folder="${escapeHtml(name)}">
            <span>${escapeHtml(name)}</span>
            <span class="bar"><i style="width:${Math.round((count / maxFolder) * 100)}%"></i></span>
            <b>${count}</b>
          </button>`).join("")}</div>`)}
        </div>
      </div>

      <section class="health-strip">
        <div class="section-title"><h2>Salud de la biblioteca</h2><span>diagnóstico rápido</span></div>
        <div class="health-items">
          <button class="health-item${broken.length ? " warn" : ""}" data-action="broken">
            ${icon(broken.length ? "alert" : "check")}
            <span><b>${fmtNumber(broken.length)} enlaces sin destino</b><small>${broken.length ? "Revisa nombres que no coinciden" : "Todos los enlaces resuelven"}</small></span>
          </button>
          <button class="health-item" data-action="tags">
            ${icon("hash")}
            <span><b>${fmtNumber(state.tags.size)} etiquetas</b><small>Explora por tema</small></span>
          </button>
          <button class="health-item" data-action="graph">
            ${icon("graph")}
            <span><b>${fmtNumber(linkCount)} conexiones</b><small>Abre el grafo interactivo</small></span>
          </button>
        </div>
      </section>
    </div>`;
  }

  /* ------------------------------ vistas y ruta ----------------------------- */

  function hashForView() {
    const view = state.view;
    if (view.name === "note" && state.currentPath) return `#/nota/${encodeURIComponent(state.currentPath)}`;
    if (view.name === "tag") return `#/etiqueta/${encodeURIComponent(view.tag || "")}`;
    if (view.name === "folder") return `#/carpeta/${encodeURIComponent(view.folder || "")}`;
    if (view.name === "search") return state.query ? `#/buscar/${encodeURIComponent(state.query)}` : "#/buscar";
    return `#/${view.name || "home"}`;
  }

  function pushHistory() {
    if (!state.historyReady) return;
    const hash = hashForView();
    if (location.hash !== hash) history.pushState({ at: Date.now() }, "", hash);
  }

  function confirmDiscard() {
    if (state.saving) { toast("Espera a que termine el guardado.", "warn"); return false; }
    if (!(state.editing && state.dirty)) return true;
    return window.confirm("Hay cambios sin guardar en esta nota. ¿Descartarlos?");
  }

  function setView(view, options = {}) {
    if (options.guard !== false && !confirmDiscard()) return false;
    if (view.name !== "graph" && state.graph && state.graph.cleanup) {
      state.graph.cleanup();
      state.graph = null;
    }
    state.view = view;
    state.editing = false;
    state.dirty = false;
    $$(".nav-btn").forEach((button) => {
      const active = button.dataset.view === view.name;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    document.body.classList.remove("sidebar-open", "inspector-open");
    updateBreadcrumbs();
    if (view.name !== "note") {
      const inspector = $("#inspector");
      if (inspector) inspector.innerHTML = "";
    }
    if (options.history !== false) pushHistory();
    if (view.name === "graph") renderGraph(); else renderView();
    if (view.name !== "note") document.title = `${state.vaultName || "Obsidian Web"} · Obsidian Web`;
    return true;
  }

  function renderView() {
    if (state.view.name === "note" && state.currentPath) return renderNoteView(state.currentPath);
    if (state.view.name === "search") return renderSearchView();
    if (state.view.name === "tags") return renderTagsView();
    if (state.view.name === "tag") return renderTagView(state.view.tag);
    if (state.view.name === "folder") return renderFolderView(state.view.folder);
    if (state.view.name === "recent") return renderListView("Recientes", "Las últimas notas que abriste.", state.recent, "recent");
    if (state.view.name === "favorites") return renderListView("Favoritos", "Notas que marcaste con la estrella.", Array.from(state.favorites), "favorites");
    if (state.view.name === "broken") return renderBrokenView();
    return renderHomeView();
  }

  function applyLocation() {
    const hash = location.hash;
    if (!hash || !hash.startsWith("#/")) return false;
    const body = hash.slice(2);
    const slash = body.indexOf("/");
    const kind = slash < 0 ? body : body.slice(0, slash);
    let argument = slash < 0 ? "" : body.slice(slash + 1);
    try { argument = decodeURIComponent(argument); } catch { /* conservar */ }
    if (kind === "nota") {
      if (!state.notes.has(argument)) return false;
      return openNote(argument, { history: false }) !== false;
    }
    if (kind === "etiqueta") return setView({ name: "tag", tag: argument }, { history: false }) !== false;
    if (kind === "carpeta") return setView({ name: "folder", folder: argument }, { history: false }) !== false;
    if (kind === "buscar") {
      if (!confirmDiscard()) return false;
      state.query = argument;
      const input = $("#searchInput");
      if (input && input.value !== argument) input.value = argument;
      setView({ name: "search" }, { history: false, guard: false });
      return true;
    }
    const views = ["home", "recent", "favorites", "tags", "graph", "broken"];
    if (views.includes(kind)) return setView({ name: kind }, { history: false }) !== false;
    return false;
  }

  function handlePopState() {
    if (!state.notes.size && !state.mode) return;
    if (!applyLocation()) history.replaceState(null, "", hashForView());
  }

  /* ---------------------------------- nota --------------------------------- */

  const drafts = Writing.draftStore({
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value)
  });

  function rememberDraft(path, text, checkpoint = false) {
    const result = drafts.capture(state.vaultId, path, text, { checkpoint });
    const label = $("#draftStatus");
    if (label) {
      label.textContent = result.ok ? "Copia local del borrador actualizada · no guarda en el archivo" : result.reason;
      label.classList.toggle("draft-error", !result.ok);
    }
    return result;
  }

  function writingDialog(title, content, setup) {
    const previousFocus = document.activeElement;
    const dialog = document.createElement("dialog");
    dialog.className = "writing-dialog";
    dialog.setAttribute("aria-labelledby", "writingDialogTitle");
    dialog.innerHTML = `<h2 id="writingDialogTitle">${escapeHtml(title)}</h2>${content}`;
    document.body.appendChild(dialog);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      dialog.close();
      dialog.remove();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
    // El Escape del diálogo no debe descartar la nota en el listener global.
    dialog.addEventListener("keydown", (event) => event.stopPropagation());
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    setup(dialog, close);
    dialog.showModal();
    return dialog;
  }

  function showDraftHistory(path, editor) {
    const versions = drafts.list(state.vaultId, path);
    writingDialog("Historial local de borradores", `
      <p>Recuperar reemplaza el texto del editor, no el archivo. Guarda después para escribir en disco.
      Hasta 10 versiones por nota; las copias antiguas se eliminan al alcanzar el límite local.</p>
      <label>Versión <select id="draftVersion">${versions.map((version, index) =>
        `<option value="${index}">${escapeHtml(new Date(version.at).toLocaleString())} · ${version.text.length} caracteres</option>`).join("")}</select></label>
      <label>Vista previa<textarea id="draftText" readonly></textarea></label>
      <div class="writing-dialog-actions"><button id="recoverDraft"${versions.length ? "" : " disabled"}>Recuperar en el editor</button>
      <button id="clearDrafts"${versions.length ? "" : " disabled"}>Borrar este historial</button><button id="closeDrafts">Cerrar</button></div>`,
    (dialog, close) => {
      const select = $("#draftVersion", dialog), preview = $("#draftText", dialog);
      const update = () => { preview.value = versions[Number(select.value)]?.text ?? ""; };
      select.addEventListener("change", update);
      update();
      $("#recoverDraft", dialog).onclick = () => {
        const version = versions[Number(select.value)];
        if (!version || !editor.isConnected) return;
        // Conservar el texto que estamos a punto de reemplazar.
        const backup = rememberDraft(path, editor.value, true);
        if (!backup.ok && !window.confirm("No se pudo respaldar el texto actual. ¿Reemplazarlo de todos modos?")) return;
        editor.value = version.text;
        rememberDraft(path, editor.value, true);
        editor.dispatchEvent(new Event("input", { bubbles: true }));
        close();
        editor.focus();
      };
      $("#clearDrafts", dialog).onclick = () => {
        if (!window.confirm("¿Borrar las copias locales de esta nota? El archivo y el texto del editor no se modifican.")) return;
        try {
          drafts.clear(state.vaultId, path);
          $("#draftStatus").textContent = "Historial borrado. Se creará otra copia cuando escribas.";
          close();
        } catch { toast("No se pudo borrar el historial.", "error"); }
      };
      $("#closeDrafts", dialog).onclick = close;
    });
  }

  function compareVersions(path, draft, disk) {
    return new Promise((resolve) => {
      let settled = false;
      const dialog = writingDialog(`Cambios externos: ${basename(path)}`, `
        <p>Compara ambas versiones. Puedes combinar cambios en «Texto a guardar». No se escribirá nada hasta que lo confirmes.
      Las líneas exclusivas de cada versión se muestran debajo; revisa también el orden en los paneles completos.</p>
        <div class="writing-compare">
          <section><label>Tu borrador<textarea id="compareDraft" readonly></textarea></label><pre id="draftChanges"></pre></section>
          <section><label>Archivo actual en disco<textarea id="compareDisk" readonly></textarea></label><pre id="diskChanges"></pre></section>
        </div>
        <label>Texto a guardar (editable)<textarea id="mergedText"></textarea></label>
        <div class="writing-dialog-actions"><button id="saveMerged">Guardar texto combinado</button>
        <button id="useDisk">Llevar versión del disco al editor</button><button id="cancelMerge">Seguir editando sin guardar</button></div>`,
      (element, close) => {
        $("#compareDraft", element).value = draft;
        $("#compareDisk", element).value = disk;
        $("#mergedText", element).value = draft;
        const delta = (a, b) => {
          const other = new Set(b.split("\n"));
          return a.split("\n").map((line, i) => other.has(line) ? null : `${i + 1}: ${line}`).filter(Boolean).slice(0, 80).join("\n")
            || "Sin líneas de texto exclusivas (puede haber cambios de orden o repetición).";
        };
        $("#draftChanges", element).textContent = delta(draft, disk);
        $("#diskChanges", element).textContent = delta(disk, draft);
        const finish = (value) => { settled = true; resolve(value); close(); };
        $("#saveMerged", element).onclick = () => finish({ action: "save", text: $("#mergedText", element).value });
        $("#useDisk", element).onclick = () => finish({ action: "load", text: disk });
        $("#cancelMerge", element).onclick = () => finish(null);
      });
      dialog.addEventListener("close", () => { if (!settled) resolve(null); }, { once: true });
    });
  }

  function bindWritingTools(note, editor) {
    let offered = [];
    const panel = $("#writingAssist");
    const vaultId = state.vaultId;
    const render = () => {
      if (!editor.isConnected || state.currentPath !== note.path || state.vaultId !== vaultId) return;
      const model = Writing.analyze(editor.value);
      offered = Writing.suggestions(editor.value, note.path, state.notes.values(), resolveLink);
      const jumps = (items) => items.slice(0, 80).map((item) =>
        `<button type="button" data-writing-offset="${item.offset}" style="--section-level:${item.level || 1}">${escapeHtml(item.text)}</button>`).join("");
      $("#writingMap", panel).innerHTML = `<div class="idea-root">${escapeHtml(note.title)}</div><div class="idea-branches">${jumps(model.sections) || "<p>Usa # y ## para dar estructura a tus ideas.</p>"}</div>
        <p>${model.pending.length} preguntas o pendientes · ${model.links.length} enlaces</p>
        <div class="idea-links">${model.links.slice(0, 20).map((link) => `<span>${escapeHtml(link)}</span>`).join("")}</div>`;
      $("#writingPending", panel).innerHTML = jumps(model.pending) || "<p>No hay preguntas ni tareas pendientes detectadas.</p>";
      $("#writingSuggestions", panel).innerHTML = offered.map((item, index) =>
        `<button type="button" data-writing-link="${index}"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.path)} · ${escapeHtml(item.reason)}</small></button>`).join("")
        || "<p>Escribe sobre otra nota para encontrar conexiones. Se excluyen los enlaces ya insertados.</p>";
    };
    const update = debounce(render, 400);
    editor.addEventListener("input", () => {
      rememberDraft(note.path, editor.value);
      update();
    });
    panel.addEventListener("click", (event) => {
      const jump = event.target.closest("[data-writing-offset]");
      if (jump) {
        editor.focus();
        const start = Number(jump.dataset.writingOffset);
        const end = editor.value.indexOf("\n", start);
        editor.setSelectionRange(start, end < 0 ? editor.value.length : end);
        editor.scrollTop = editor.value.slice(0, start).split("\n").length * parseFloat(getComputedStyle(editor).lineHeight) - editor.clientHeight / 2;
      }
      const link = event.target.closest("[data-writing-link]");
      if (link) {
        const item = offered[Number(link.dataset.writingLink)];
        if (!item) return;
        // Ruta completa evita ambigüedad entre archivos con el mismo nombre.
        const target = item.path.replace(/\.(md|markdown|txt)$/i, "");
        const insertion = /[\[\]|#]/.test(target)
          ? `[${item.title.replace(/[[\]\\]/g, "\\$&")}](${encodeURI(item.path).replace(/[()#]/g, (c) => "%" + c.charCodeAt(0).toString(16))})`
          : `[[${target}]]`;
        editor.setRangeText(insertion, editor.selectionStart, editor.selectionEnd, "end");
        editor.dispatchEvent(new Event("input", { bubbles: true }));
        editor.focus();
      }
    });
    $("#draftHistory").onclick = () => showDraftHistory(note.path, editor);
    const previous = drafts.list(vaultId, note.path);
    $("#draftStatus").textContent = previous.length && previous[0].text !== editor.value
      ? "Hay un borrador anterior distinto. Puedes recuperarlo desde Historial."
      : "Se conservará una copia local al escribir; el archivo solo cambia al guardar.";
    if (!previous.length) rememberDraft(note.path, editor.value, true);
    else {
      const result = drafts.capture(vaultId, note.path, previous[0].text, { checkpoint: true });
      if (!result.ok) {
        $("#draftStatus").textContent = result.reason;
        $("#draftStatus").classList.add("draft-error");
      }
    }
    render();
  }

  function openNote(path, options = {}) {
    if (!state.notes.has(path)) {
      toast("Esa nota ya no existe en la carpeta.", "error");
      return false;
    }
    if (options.guard !== false && !confirmDiscard()) return false;
    if (state.graph && state.graph.cleanup) {
      state.graph.cleanup();
      state.graph = null;
    }
    const changed = state.currentPath !== path;
    state.currentPath = path;
    state.view = { name: "note" };
    state.editing = false;
    state.dirty = false;
    state.externalChange = false;
    if (options.history !== false) {
      state.recent = [path, ...state.recent.filter((item) => item !== path)].slice(0, 30);
      persistVault();
    }
    settings.lastNotes[state.vaultId] = path;
    store.save(settings);
    $$(".nav-btn").forEach((button) => {
      button.classList.remove("active");
      button.removeAttribute("aria-current");
    });
    $$(".tree-file").forEach((button) => {
      const active = button.dataset.path === path;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    if (changed) scrollTop();
    if (options.history !== false) pushHistory();
    renderNoteView(path);
    revealInTree(path);
    document.body.classList.remove("sidebar-open");
    return true;
  }

  function noteMenu(note) {
    const caps = capabilities();
    return `<details class="action-menu">
      <summary class="icon-btn" aria-label="Más acciones de la nota" title="Más acciones">${icon("more")}</summary>
      <div class="menu-pop">
        <button data-action="copy-link">${icon("link")} Copiar enlace</button>
        <button data-action="open-obsidian"${caps.obsidian ? "" : " disabled"}>${icon("external")} Abrir en Obsidian</button>
        <button data-action="reveal">${icon("folder")} Ver ruta</button>
        <button data-action="print">${icon("printer")} Imprimir / PDF</button>
      </div>
    </details>`;
  }

  function renderNoteView(path) {
    const note = state.notes.get(path);
    if (!note) return setView({ name: "home" });
    const view = $("#view");
    const backlinks = state.backlinks.get(path) || [];
    const isFavorite = state.favorites.has(path);
    const folder = dirname(path);
    const caps = capabilities();
    const canEdit = caps.edit && !note.tooLarge && !note.readError;
    if (state.editing && !canEdit) {
      state.editing = false;
      state.dirty = false;
    }

    if (state.editing) {
      updateBreadcrumbs();
      const draft = state.dirty && $("#noteEditor") ? $("#noteEditor").value : note.raw;
      view.innerHTML = `<div class="note">
        <div class="note-head">
          <div class="note-kicker">${escapeHtml(folder || "Raíz")}</div>
          <h1>${escapeHtml(note.title)}</h1>
          <div class="note-meta"><span>Editando</span><span>${fmtNumber(note.words)} palabras</span><span>${escapeHtml(note.name)}</span></div>
        </div>
        <div class="editor-wrap">
          <div class="editor-bar">
            <button class="primary" data-edit-save>${icon("check")} Guardar cambios</button>
            <button data-edit-cancel>Cancelar</button>
            <button data-edit-preview class="${state.preview ? "on" : ""}">${icon("panel")} Vista previa</button>
            <button id="draftHistory" type="button">Historial de borradores</button>
            <span class="spacer"></span>
            <span id="editorState">${state.dirty ? "Sin guardar" : "Sin cambios"}</span>
          </div>
          <p id="draftStatus" class="draft-status" role="status"></p>
          <div class="editor-panes${state.preview ? " split" : ""}">
            <textarea id="noteEditor" spellcheck="true" aria-label="Editor de ${escapeHtml(note.title)}">${escapeHtml(draft)}</textarea>
            <div id="editorPreview" class="markdown-body" ${state.preview ? "" : "hidden"}></div>
          </div>
          <div id="writingAssist" class="writing-assist">
            <details open><summary>Mapa de ideas</summary><div id="writingMap"></div></details>
            <details open><summary>Preguntas pendientes</summary><div id="writingPending"></div></details>
            <details open><summary>Enlaces sugeridos · local</summary><div id="writingSuggestions"></div></details>
          </div>
        </div>
      </div>`;
      const editor = $("#noteEditor");
      editor.dataset.path = path;
      const preview = $("#editorPreview");
      const refreshPreview = debounce(() => {
        if (!editor.isConnected || !state.preview || !preview) return;
        const draftNote = parseNote(note.path, editor.value, note.mtime);
        preview.innerHTML = renderMarkdown(draftNote.body, draftNote);
      }, 220);
      editor.addEventListener("input", () => {
        state.dirty = true;
        $("#editorState").textContent = "Sin guardar";
        refreshPreview();
      });
      editor.addEventListener("keydown", (event) => {
        // Ctrl+S lo maneja un único listener global (evita dos guardados a la vez).
        if (event.key === "Tab") {
          event.preventDefault();
          const start = editor.selectionStart;
          editor.setRangeText("  ", start, editor.selectionEnd, "end");
          editor.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      if (state.preview && preview) {
        const draftNote = parseNote(note.path, draft, note.mtime);
        preview.innerHTML = renderMarkdown(draftNote.body, draftNote);
      }
      renderInspector(note, backlinks);
      bindWritingTools(note, editor);
      return;
    }

    updateBreadcrumbs();
    document.title = `${note.title} · Obsidian Web`;
    view.innerHTML = `<article class="note">
      <header class="note-head">
        <div class="note-kicker">${escapeHtml(folder || "Raíz")}</div>
        <div class="note-title-row">
          <h1>${escapeHtml(note.title)}</h1>
          <div class="note-actions">
            <button data-action="favorite" class="chip-button${isFavorite ? " on" : ""}" aria-pressed="${isFavorite}">${icon("star")} ${isFavorite ? "En favoritos" : "Favorito"}</button>
            <button data-action="edit" class="primary-action"${canEdit ? "" : " disabled"} title="${canEdit ? "Editar la nota" : (caps.edit ? "Esta nota no se pudo leer completa; edítala en Obsidian" : writeSupportHint())}">${icon("edit")} Editar</button>
            ${noteMenu(note)}
          </div>
        </div>
        <div class="note-meta">
          <span>${fmtNumber(note.words)} palabras</span>
          <span>${readingMinutes(note.words)} min de lectura</span>
          ${note.mtime ? `<span>Editada el ${fmtDate(note.mtime)}</span>` : ""}
        </div>
        ${note.tags.length ? `<div class="note-tags">${note.tags.map((tag) => `<button class="chip accent" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</button>`).join("")}</div>` : ""}
      </header>
      ${note.tooLarge ? `<div class="notice warn" role="status"><strong>${icon("alert")} Nota demasiado grande</strong><span>Supera ${fmtBytes(MAX_TEXT)} y no se indexó su contenido. Puedes abrirla en Obsidian o editar el archivo directamente.</span></div>` : ""}
      ${note.readError ? `<div class="notice error" role="alert"><strong>${icon("alert")} No se pudo leer esta nota</strong><span>Comprueba los permisos del archivo y pulsa ↻ para recargar la bóveda.</span></div>` : ""}
      ${state.externalChange ? `<div class="notice warn" role="status"><strong>${icon("alert")} La nota cambió en el disco</strong><span>Obsidian u otro programa la modificó después de abrirla. <button class="inline-action" data-action="reload-note">Cargar la versión del disco</button></span></div>` : ""}
      <div class="markdown-body">${renderMarkdown(note.body, note)}</div>
      <footer class="note-foot">
        <span>${escapeHtml(note.path)}</span>
        <span>${fmtNumber(backlinks.length)} enlaces entrantes</span>
      </footer>
    </article>`;
    renderInspector(note, backlinks);
  }

  function renderInspector(note, backlinks) {
    const inspector = $("#inspector");
    if (!inspector) return;
    const outgoing = note.links.filter((link) => link.resolved && !link.embed && state.notes.has(link.resolved));
    const seen = new Set();
    const outgoingUnique = outgoing.filter((link) => {
      if (seen.has(link.resolved)) return false;
      seen.add(link.resolved);
      return true;
    });
    const mentions = unlinkedMentions(note);
    const props = Object.entries(note.properties || {}).filter(([key]) => !["tags", "aliases", "alias", "tag"].includes(key));

    inspector.innerHTML = `
      <section class="inspector-section">
        <h3>En esta nota</h3>
        <div class="outline-list">${note.headings.length ? note.headings.slice(0, 18).map((heading) => `<button class="h${heading.level}" data-anchor="${escapeHtml(slugify(heading.text))}">${escapeHtml(heading.text)}</button>`).join("") : `<p class="empty-mini">Sin encabezados.</p>`}</div>
      </section>
      <section class="inspector-section">
        <h3>Enlaces entrantes · ${backlinks.length}</h3>
        <div class="link-list">${backlinks.length ? backlinks.slice(0, 14).map((item) => {
          const source = state.notes.get(item.from);
          return `<button data-note="${escapeHtml(item.from)}">${escapeHtml(source ? source.title : basename(item.from))}<small>${escapeHtml(item.context || item.from)}</small></button>`;
        }).join("") : `<p class="empty-mini">Ninguna nota enlaza aquí todavía.</p>`}</div>
      </section>
      <section class="inspector-section">
        <h3>Enlaces salientes · ${outgoingUnique.length}</h3>
        <div class="link-list">${outgoingUnique.length ? outgoingUnique.slice(0, 14).map((link) => {
          const target = state.notes.get(link.resolved);
          const warning = link.ambiguous ? `<small class="warn-text">Enlace ambiguo · ${escapeHtml((link.candidates || []).map((path) => basename(path)).join(" · "))}</small>` : "";
          return `<button data-note="${escapeHtml(link.resolved)}">${escapeHtml(target ? target.title : basename(link.resolved))}<small>${escapeHtml(dirname(link.resolved) || "Raíz")}</small>${warning}</button>`;
        }).join("") : `<p class="empty-mini">Esta nota no enlaza a otras.</p>`}</div>
      </section>
      <section class="inspector-section">
        <h3>Menciones sin enlace · ${mentions.length}</h3>
        <div class="link-list">${mentions.length ? mentions.slice(0, 8).map((path) => {
          const other = state.notes.get(path);
          return `<button data-note="${escapeHtml(path)}">${escapeHtml(other ? other.title : basename(path))}<small>Menciona «${escapeHtml(note.stem)}»</small></button>`;
        }).join("") : `<p class="empty-mini">No hay menciones sueltas.</p>`}</div>
      </section>
      ${props.length ? `<section class="inspector-section"><h3>Propiedades</h3><div class="prop-list">${props.map(([key, value]) => `<div class="prop-row"><span>${escapeHtml(key)}</span><span>${escapeHtml(Array.isArray(value) ? value.join(", ") : value)}</span></div>`).join("")}</div></section>` : ""}
    `;
    inspector.hidden = false;
  }

  function unlinkedMentions(note) {
    if (note.stem.length < 4) return [];
    const cached = state.mentionsCache.get(note.path);
    if (cached) return cached;
    const needle = normalize(note.stem);
    const boundary = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}($|[^\\p{L}\\p{N}])`, "u");
    const linked = new Set((state.backlinks.get(note.path) || []).map((item) => item.from));
    const result = [];
    for (const other of state.notes.values()) {
      if (other.path === note.path || linked.has(other.path)) continue;
      if (!other.proseNorm) continue;
      if (boundary.test(other.proseNorm)) result.push(other.path);
      if (result.length >= 10) break;
    }
    state.mentionsCache.set(note.path, result);
    return result;
  }

  function toggleFavorite() {
    const path = state.currentPath;
    if (!path) return;
    if (state.favorites.has(path)) state.favorites.delete(path);
    else state.favorites.add(path);
    persistVault();
    renderNoteView(path);
  }

  /* -------------------------------- guardado ------------------------------- */

  const writeQueues = new Map();

  function enqueueWrite(path, task) {
    const previous = writeQueues.get(path) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    writeQueues.set(path, next);
    next.finally(() => {
      if (writeQueues.get(path) === next) writeQueues.delete(path);
    }).catch(() => {});
    return next;
  }

  async function saveCurrentNote() {
    if (state.saving) return;
    const path = state.currentPath;
    const editor = $("#noteEditor");
    const knownNote = state.notes.get(path);
    if (!path || !editor) return;
    if (!knownNote || knownNote.tooLarge || knownNote.readError) {
      toast("No se guarda: la nota no se leyó completa. Edítala en Obsidian.", "error");
      return;
    }
    let content = editor.value;
    const submitted = content;
    rememberDraft(path, content, true);
    const record = state.files.get(path);
    if (state.mode === "fs" && record && record.handle) {
      state.saving = true;
      const stateLabel = $("#editorState");
      if (stateLabel) stateLabel.textContent = "Guardando…";
      try {
        const outcome = await enqueueWrite(path, async () => {
          let permission = await record.handle.queryPermission({ mode: "readwrite" });
          if (permission !== "granted") permission = await record.handle.requestPermission({ mode: "readwrite" });
          if (permission !== "granted") return { error: "permiso" };
          const before = await record.handle.getFile();
          const disk = await before.text();
          if (disk !== knownNote.raw) {
            const choice = await compareVersions(path, content, disk);
            if (!choice) return { cancelled: true };
            if (choice.action === "load") return { load: disk, mtime: before.lastModified };
            content = choice.text;
            rememberDraft(path, content, true);
            // No pisar una tercera versión aparecida mientras se comparaba.
            if (await (await record.handle.getFile()).text() !== disk) return { changedAgain: true };
          }
          const writable = await record.handle.createWritable();
          try {
            await writable.write(content);
            await writable.close();
          } catch (error) {
            await writable.abort?.().catch(() => {});
            throw error;
          }
          const file = await record.handle.getFile();
          return { mtime: file.lastModified || Date.now(), size: file.size };
        });
        if (outcome.cancelled || outcome.changedAgain) {
          if (stateLabel) stateLabel.textContent = "Sin guardar";
          if (outcome.changedAgain) {
            // Conservar también la combinación manual para volver a compararla.
            if (editor.value === submitted) {
              editor.value = content;
              editor.dispatchEvent(new Event("input", { bubbles: true }));
            }
            toast("El archivo volvió a cambiar. Conservamos tu borrador; pulsa Guardar para comparar otra vez.", "warn");
          }
          return;
        }
        if (typeof outcome.load === "string") {
          rememberDraft(path, editor.value, true);
          replaceNote(path, outcome.load, outcome.mtime);
          editor.value = outcome.load;
          state.dirty = false;
          renderNoteView(path);
          toast("Versión del disco en el editor. Tu borrador anterior queda en Historial.");
          return;
        }
        if (outcome.error) {
          if (stateLabel) stateLabel.textContent = "Sin guardar";
          toast("No diste permiso de escritura.", "error");
          return;
        }
        replaceNote(path, content, outcome.mtime);
        state.externalChange = false;
        // Si se siguió escribiendo durante la operación, ese texto sigue pendiente.
        if (editor.value === submitted) editor.value = content;
        state.dirty = editor.value !== content;
        if (stateLabel) stateLabel.textContent = state.dirty ? "Hay cambios posteriores sin guardar" : "Guardado";
        rememberDraft(path, editor.value, true);
        if (!state.dirty) renderNoteView(path);
        renderTree();
        toast("Nota guardada en el disco.");
      } catch (error) {
        console.error(error);
        if (stateLabel) stateLabel.textContent = "Sin guardar";
        toast("No se pudo guardar: " + (error.message || error.name), "error");
      } finally {
        state.saving = false;
      }
      return;
    }

    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = basename(path);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    replaceNote(path, content, Date.now());
    state.dirty = false;
    const stateLabel = $("#editorState");
    if (stateLabel) stateLabel.textContent = "Descargado";
    toast("Modo lectura: la nota se descargó para que la reemplaces a mano.");
  }

  function copyNoteLink() {
    const path = state.currentPath;
    if (!path) return;
    const note = state.notes.get(path);
    const sameStem = note ? (state.byStem.get(normalize(note.stem)) || []) : [];
    // Si hay varias notas con el mismo nombre, se copia la ruta para evitar ambigüedad.
    const target = note && sameStem.length > 1
      ? note.path.replace(/\.(md|markdown|txt)$/i, "")
      : (note ? note.stem : path);
    const text = `[[${target}]]`;
    navigator.clipboard?.writeText(text).then(
      () => toast("Enlace copiado: " + text),
      () => toast("No se pudo copiar al portapapeles.", "error")
    );
  }

  function openInObsidian() {
    if (!capabilities().obsidian) { toast("Abrir en Obsidian solo está disponible para carpetas reales.", "error"); return; }
    const path = state.currentPath;
    if (!path) { toast("Abre una nota primero."); return; }
    const vault = encodeURIComponent(state.vaultName);
    const file = encodeURIComponent(path.replace(/\.(md|markdown|txt)$/i, ""));
    const uri = `obsidian://open?vault=${vault}&file=${file}`;
    window.location.href = uri;
    toast("Si Obsidian no reacciona, abre esta carpeta como bóveda en la app.");
  }

  async function reloadNoteFromDisk() {
    if (state.saving) return;
    const path = state.currentPath;
    const record = state.files.get(path);
    if (!path || !record || !record.handle) return;
    if (state.editing && state.dirty && !window.confirm("Hay cambios sin guardar. ¿Cargar la versión del disco y descartarlos?")) return;
    try {
      const file = await record.handle.getFile();
      const text = await file.text();
      replaceNote(path, text, file.lastModified);
      state.externalChange = false;
      state.dirty = false;
      renderNoteView(path);
      toast("Nota actualizada desde el disco.");
    } catch (error) {
      console.error(error);
      toast("No se pudo leer la nota del disco.", "error");
    }
  }

  async function reloadVault() {
    if (state.saving) return;
    if (!capabilities().reload) { toast("Recargar solo está disponible al abrir una carpeta real.", "error"); return; }
    if (!state.rootHandle) { toast("Vuelve a abrir la carpeta para recargar."); return; }
    if (state.editing && state.dirty && !window.confirm("Hay cambios sin guardar. ¿Recargar de todos modos?")) return;
    const current = state.currentPath;
    const editing = state.editing;
    const vaultId = state.vaultId;
    const vaultName = state.vaultName;
    const rootHandle = state.rootHandle;
    try {
      resetState();
      state.mode = "fs";
      state.rootHandle = rootHandle;
      state.vaultId = vaultId;
      state.vaultName = vaultName;
      setBusy(true);
      $("#view").innerHTML = loadingView("Recargando desde el disco…");
      await walkDirectory(rootHandle);
      await buildIndex();
      syncModeUi();
      renderTree();
      startObserver();
      state.historyReady = true;
      $("#vaultStats").textContent = `${fmtNumber(state.notes.size)} notas`;
      if (current && state.notes.has(current)) {
        openNote(current, { history: false });
        if (editing) {
          state.editing = true;
          renderNoteView(current);
        }
      } else {
        setView({ name: "home" }, { history: false });
      }
      setBusy(false);
      toast("Biblioteca recargada: " + fmtNumber(state.notes.size) + " notas.");
    } catch (error) {
      console.error(error);
      setBusy(false);
      toast("No se pudo recargar. Reabre la carpeta.", "error");
    }
  }

  async function createNote() {
    if (!capabilities().create) {
      toast("Crear notas requiere abrir la carpeta con Chrome o Edge.", "error");
      return;
    }
    if (!confirmDiscard()) return;
    const name = window.prompt("Nombre de la nota nueva:", "Nueva nota");
    if (!name) return;
    const clean = name.replace(/[\\/:*?"<>|]/g, "-").replace(/^\.+$/, "").trim();
    if (!clean) return;
    const folder = state.view.name === "folder" ? state.view.folder : (state.currentPath ? dirname(state.currentPath) : "");
    const displayTitle = clean.replace(/\.md$/i, "").trim() || clean;
    const fileName = clean.toLowerCase().endsWith(".md") ? clean : `${clean}.md`;
    const newPath = folder ? `${folder}/${fileName}` : fileName;
    const normalizedNew = normalize(newPath);
    const duplicate = Array.from(state.files.keys()).some((path) => normalize(path) === normalizedNew);
    if (duplicate) {
      toast("Ya existe una nota con ese nombre en esa carpeta.", "error");
      return;
    }
    try {
      let directory = state.rootHandle;
      for (const part of folder.split("/").filter(Boolean)) {
        directory = await directory.getDirectoryHandle(part, { create: true });
      }
      // No se usa create:true hasta comprobar que el nombre no existe ya en disco.
      let exists = false;
      try {
        await directory.getFileHandle(fileName);
        exists = true;
      } catch (error) {
        if (!error || error.name !== "NotFoundError") throw error;
      }
      if (exists) {
        toast("Ya existe un archivo con ese nombre en el disco.", "error");
        return;
      }
      const handle = await directory.getFileHandle(fileName, { create: true });
      let permission = await handle.queryPermission({ mode: "readwrite" });
      if (permission !== "granted") permission = await handle.requestPermission({ mode: "readwrite" });
      if (permission !== "granted") { toast("Sin permiso para crear la nota.", "error"); return; }
      const content = `# ${displayTitle}\n\n`;
      const outcome = await enqueueWrite(newPath, async () => {
        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();
        const file = await handle.getFile();
        return { mtime: file.lastModified || Date.now(), size: file.size };
      });
      state.files.set(newPath, { path: newPath, name: fileName, handle, extension: ".md", mtime: outcome.mtime, size: outcome.size });
      replaceNote(newPath, content, outcome.mtime);
      renderTree();
      openNote(newPath, { history: true, guard: false });
      state.editing = true;
      state.dirty = false;
      renderNoteView(newPath);
      toast("Nota creada.");
    } catch (error) {
      console.error(error);
      toast("No se pudo crear la nota: " + (error.message || error.name), "error");
    }
  }

  /* --------------------------- búsqueda y listas --------------------------- */

  function parseSearchQuery(query) {
    const terms = [];
    const exclude = [];
    const tags = [];
    const paths = [];
    const tokens = String(query || "").match(/"[^"]+"|\S+/g) || [];
    for (const raw of tokens) {
      let token = raw.replace(/^"|"$/g, "").trim();
      if (!token) continue;
      if (token.startsWith("-") && token.length > 1) {
        exclude.push(normalize(token.slice(1)));
      } else if (/^tag:/i.test(token)) {
        const value = normalize(token.slice(4));
        if (value) tags.push(value.replace(/^#/, ""));
      } else if (/^path:/i.test(token)) {
        const value = normalize(token.slice(5));
        if (value) paths.push(value);
      } else {
        const value = normalize(token);
        if (value.length > 1) terms.push(value);
      }
    }
    return { terms, exclude, tags, paths };
  }

  function searchNotes(query) {
    const { terms, exclude, tags, paths } = parseSearchQuery(query);
    if (!terms.length && !tags.length && !paths.length) return [];
    const results = [];
    for (const note of state.notes.values()) {
      const title = normalize(note.title);
      const path = normalize(note.path);
      const body = note.bodyNorm || "";
      if (exclude.some((term) => title.includes(term) || path.includes(term) || body.includes(term))) continue;
      if (tags.length) {
        const noteTags = note.tags.map(normalize);
        if (!tags.every((tag) => noteTags.some((item) => item === tag || item.startsWith(`${tag}/`)))) continue;
      }
      if (paths.length && !paths.every((piece) => path.includes(piece))) continue;
      let score = (tags.length || paths.length) ? 1 : 0;
      let matches = 0;
      let all = true;
      for (const term of terms) {
        let termScore = 0;
        if (title.includes(term)) termScore += 14;
        if (path.includes(term)) termScore += 3;
        const count = countOccurrences(body, term);
        if (count > 0) { termScore += Math.min(12, count); matches += count; }
        if (!termScore) { all = false; break; }
        score += termScore;
      }
      if (!all || score <= 0) continue;
      results.push({ note, score, matches });
    }
    return results.sort((a, b) => b.score - a.score || b.matches - a.matches).slice(0, 80);
  }

  function renderSearchView() {
    const query = state.query.trim();
    const view = $("#view");
    const { terms } = parseSearchQuery(query);
    const results = query ? searchNotes(query) : [];
    const filters = [];
    if (terms.length) filters.push(`términos: ${terms.join(" · ")}`);
    if (/tag:/i.test(query)) filters.push("filtro por etiqueta");
    if (/path:/i.test(query)) filters.push("filtro por ruta");
    if (/(^|\s)-/.test(query)) filters.push("términos excluidos");
    view.innerHTML = `<div class="list-view">
      <div class="list-head">
        <h1>${query ? `Resultados para «${escapeHtml(query)}»` : "Buscar"}</h1>
        <p>${query ? `${results.length} notas encontradas. La búsqueda ignora acentos y mayúsculas.${filters.length ? ` (${escapeHtml(filters.join(" · "))})` : ""}` : "Escribe en el buscador de la izquierda o pulsa Ctrl K. Admite tag:tema, path:carpeta y -palabra."}</p>
      </div>
      ${query
        ? `<div class="result-list">${results.length ? results.map(({ note }) => `<button class="result" data-note="${escapeHtml(note.path)}">
            <div class="result-top"><strong>${highlightText(note.title, terms)}</strong><em>${escapeHtml(dirname(note.path) || "Raíz")}</em></div>
            <p>${snippetText(note.body, terms)}</p>
          </button>`).join("") : `<p class="empty-mini">No hay coincidencias. Prueba con menos palabras o revisa la ortografía.</p>`}</div>`
        : `<div class="card-grid">${state.recent.slice(0, 8).map((path) => noteCard(path)).join("") || `<p class="empty-mini">Todavía no hay notas recientes.</p>`}</div>`}
    </div>`;
  }

  function renderTagsView() {
    const tags = Array.from(state.tags.entries()).sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0], "es"));
    const tagNotes = Array.from(state.notes.values()).filter((note) => note.tags.length);
    $("#view").innerHTML = `<div class="list-view">
      <div class="list-head">
        <h1>Etiquetas</h1>
        <p>${fmtNumber(tags.length)} etiquetas en ${fmtNumber(tagNotes.length)} notas. Úsalas para agrupar sin mover archivos.</p>
      </div>
      <div class="tag-cloud">
        ${tags.length ? tags.map(([tag, paths]) => `<button data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}<b>${paths.size}</b></button>`).join("") : `<p class="empty-mini">Todavía no hay etiquetas. Añade <code>#tema</code> en cualquier nota.</p>`}
      </div>
      <div class="section-title"><h2>Notas con etiquetas</h2><span>${tagNotes.length}</span></div>
      <div class="card-grid">${tagNotes.slice(0, 60).map((note) => noteCard(note.path, { subtitle: note.tags.slice(0, 3).map((tag) => "#" + tag).join(" · ") })).join("")}</div>
    </div>`;
    document.title = `Etiquetas · ${state.vaultName}`;
  }

  function renderTagView(tag) {
    const paths = Array.from(state.tags.get(tag) || []).filter((path) => state.notes.has(path));
    $("#view").innerHTML = `<div class="list-view">
      <div class="list-head">
        <h1>#${escapeHtml(tag)}</h1>
        <p>${paths.length} ${paths.length === 1 ? "nota usa" : "notas usan"} esta etiqueta.</p>
      </div>
      <div class="card-grid">${paths.map((path) => noteCard(path)).join("") || `<p class="empty-mini">No hay notas con esta etiqueta.</p>`}</div>
    </div>`;
  }

  function renderFolderView(folder) {
    const prefix = folder ? `${folder}/` : "";
    const direct = [];
    const subfolders = new Map();
    for (const path of state.notes.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest.includes("/")) direct.push(path);
      else {
        const child = rest.split("/")[0];
        subfolders.set(child, (subfolders.get(child) || 0) + 1);
      }
    }
    $("#view").innerHTML = `<div class="list-view">
      <div class="list-head">
        <h1>${escapeHtml(folder || state.vaultName)}</h1>
        <p>${direct.length} notas directas · ${Array.from(subfolders.values()).reduce((sum, count) => sum + count, 0)} en subcarpetas.</p>
      </div>
      ${subfolders.size ? `<div class="section-title"><h2>Subcarpetas</h2><span>${subfolders.size}</span></div>
      <div class="card-grid">${Array.from(subfolders.entries()).sort((a, b) => a[0].localeCompare(b[0], "es")).map(([name, count]) => `<button class="note-card" data-folder="${escapeHtml(prefix + name)}"><strong>${escapeHtml(name)}</strong><span>${count} notas</span></button>`).join("")}</div>` : ""}
      <div class="section-title"><h2>Notas</h2><span>${direct.length}</span></div>
      <div class="card-grid">${direct.sort((a, b) => basename(a).localeCompare(basename(b), "es")).map((path) => noteCard(path)).join("") || `<p class="empty-mini">Esta carpeta no tiene notas directas.</p>`}</div>
    </div>`;
  }

  function renderListView(title, description, paths, kind) {
    const valid = paths.filter((path) => state.notes.has(path));
    $("#view").innerHTML = `<div class="list-view">
      <div class="list-head"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>
      <div class="card-grid">${valid.length ? valid.map((path) => noteCard(path)).join("") : `<p class="empty-mini">Todavía no hay notas aquí.</p>`}</div>
      ${kind === "favorites" && valid.length ? `<p class="empty-mini" style="margin-top:18px">Los favoritos se guardan solo en este navegador.</p>` : ""}
    </div>`;
  }

  function renderBrokenView() {
    const broken = brokenLinks();
    const byNote = new Map();
    for (const item of broken) {
      if (!byNote.has(item.from)) byNote.set(item.from, []);
      const list = byNote.get(item.from);
      if (!list.includes(item.target)) list.push(item.target);
    }
    const missingAttachments = [];
    for (const note of state.notes.values()) {
      for (const match of note.body.matchAll(/!\[\[([^\]\n]+?)\]\]/g)) {
        const target = match[1].split("|")[0].trim();
        if (IMAGE_EXT.has(extname(target)) && !attachmentPath(target)) missingAttachments.push({ from: note.path, target });
      }
    }
    $("#view").innerHTML = `<div class="list-view">
      <div class="list-head">
        <h1>Enlaces por revisar</h1>
        <p>${broken.length} enlaces internos sin destino y ${missingAttachments.length} imágenes que no están en la carpeta. Son referencias antiguas: no se cambiaron a ciegas.</p>
      </div>
      <div class="section-title"><h2>Enlaces internos sin destino</h2><span>${byNote.size} notas</span></div>
      <div class="result-list">${byNote.size ? Array.from(byNote.entries()).map(([path, targets]) => `<div class="result" style="cursor:default">
        <div class="result-top"><strong>${escapeHtml(state.notes.get(path)?.title || basename(path))}</strong><em>${escapeHtml(dirname(path) || "Raíz")}</em></div>
        <p>${targets.map((target) => `<span class="chip">${escapeHtml(target)}</span>`).join(" ")}</p>
        <button class="ghost-btn small" data-note="${escapeHtml(path)}" style="margin-top:8px">Abrir nota</button>
      </div>`).join("") : `<p class="empty-mini">Todos los enlaces tienen destino.</p>`}</div>
      <div class="section-title"><h2>Imágenes faltantes</h2><span>${missingAttachments.length}</span></div>
      ${missingAttachments.length ? `<div class="result-list">${missingAttachments.map((item) => `<div class="result" style="cursor:default"><div class="result-top"><strong>${escapeHtml(basename(item.target))}</strong><em>${escapeHtml(item.from)}</em></div><p>La nota sigue funcionando, pero la imagen no se encuentra en la carpeta.</p></div>`).join("")}</div>` : `<p class="empty-mini">No faltan imágenes incrustadas.</p>`}
    </div>`;
  }

  /* ---------------------------------- grafo --------------------------------- */

  function graphData() {
    const nameCounts = new Map();
    const folders = new Map();
    for (const note of state.notes.values()) {
      const name = stem(basename(note.path)) || note.title;
      nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
      const folder = note.path.includes("/") ? note.path.split("/")[0] : "Raíz";
      folders.set(folder, (folders.get(folder) || 0) + 1);
    }
    const folderNames = Array.from(folders.keys()).sort((a, b) => a.localeCompare(b, "es"));
    const palette = ["#bfa9ff", "#70dddb", "#ffbd87", "#ff91b5", "#a9d68a", "#88b9ff", "#f1d67a", "#dd9df0"];
    const groups = folderNames.map((name, index) => ({
      name, count: folders.get(name), color: palette[index % palette.length], index
    }));
    const byFolder = new Map(groups.map((group) => [group.name, group]));
    const nodes = Array.from(state.notes.values()).map((note) => {
      const name = stem(basename(note.path)) || note.title;
      return {
        id: note.path,
        label: nameCounts.get(name) > 1 ? `${name} · ${basename(dirname(note.path)) || "Raíz"}` : name,
        group: byFolder.get(note.path.includes("/") ? note.path.split("/")[0] : "Raíz"),
        degree: 0,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        fixed: false
      };
    });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const edges = [];
    const seen = new Set();
    for (const note of state.notes.values()) {
      for (const link of note.links) {
        if (link.embed || !link.resolved || !state.notes.has(link.resolved)) continue;
        if (link.resolved === note.path) continue;
        const key = [note.path, link.resolved].sort().join("→");
        if (seen.has(key)) continue;
        seen.add(key);
        const source = byId.get(note.path);
        const target = byId.get(link.resolved);
        if (!source || !target) continue;
        source.degree += 1;
        target.degree += 1;
        edges.push({ source, target });
      }
    }
    return { nodes, edges, groups };
  }

  function renderGraph() {
    const view = $("#view");
    if (!state.notes.size) return setView({ name: "home" }, { history: false });
    const { nodes: graphNodes, edges: graphEdges, groups } = graphData();
    view.innerHTML = `<div class="graph-view">
      <div class="graph-head">
        <div><h1>Universo de notas</h1><p>${fmtNumber(graphNodes.length)} notas · ${fmtNumber(graphEdges.length)} conexiones · ${fmtNumber(groups.length)} constelaciones. Arrastra planetas; acerca para ver nombres. En 3D, arrastra el fondo para girar.</p></div>
        <div class="graph-actions" role="group" aria-label="Controles del grafo">
          <button type="button" data-graph="view" aria-label="Cambiar a vista 3D" title="Alternar entre vista 2D y 3D (V)">Vista 3D</button>
          <button type="button" data-graph="spin" aria-pressed="false" disabled title="Girar la vista 3D automáticamente (O)">Órbita</button>
          <button type="button" data-graph="atmosphere" aria-pressed="true" title="Activar o desactivar estrellas y destellos">Estrellas</button>
          <button type="button" data-graph="reset" title="Reencuadrar el grafo (0)">Centrar</button>
          <button type="button" data-graph="fullscreen" aria-label="Pantalla completa del grafo" aria-pressed="false" title="Pantalla completa del grafo (F)">⛶ Pantalla completa</button>
          <button type="button" data-graph="random">Nota al azar</button>
        </div>
      </div>
      <div class="graph-toolbar">
        <label class="graph-search-label"><span class="visually-hidden">Encontrar nota en el grafo</span><input id="graphSearch" type="search" autocomplete="off" placeholder="Encontrar nota…" aria-label="Encontrar nota en el grafo"></label>
        <div class="graph-legend" role="group" aria-label="Resaltar carpeta">
          ${groups.map((group) => `<button type="button" class="graph-legend-item" data-graph-folder="${escapeHtml(group.name)}" aria-pressed="false"><span class="graph-legend-dot" style="--folder-color:${group.color}"></span>${escapeHtml(group.name)} <small>${group.count}</small></button>`).join("")}
        </div>
      </div>
      <div class="graph-canvas-wrap">
        <canvas id="graphCanvas" tabindex="0" aria-label="Grafo interactivo en 2D. Arrastra un nodo para moverlo y ver cómo lo siguen sus conexiones. Usa las flechas para desplazarte, más y menos para acercar, y V para cambiar a la vista 3D.">Grafo interactivo de conexiones entre notas.</canvas>
        <div class="graph-hud" aria-hidden="true">
          <span class="graph-mode" data-graph-mode>2D</span>
          <span data-graph-hint>Arrastra un planeta · rueda para acercar</span>
        </div>
      </div>
    </div>`;

    const canvas = $("#graphCanvas");
    const graphRoot = $(".graph-view", view);
    const graphTip = $("#graphTip");
    const tipParent = graphTip?.parentElement;
    const wrap = canvas.parentElement;
    const ctx = canvas.getContext("2d");
    const nodes = graphNodes;
    const edges = graphEdges;
    const connected = new Map(nodes.map((node) => [node.id, new Set()]));
    for (const edge of edges) {
      connected.get(edge.source.id).add(edge.target.id);
      connected.get(edge.target.id).add(edge.source.id);
    }
    const viewButton = $('[data-graph="view"]');
    const spinButton = $('[data-graph="spin"]');
    const atmosphereButton = $('[data-graph="atmosphere"]');
    const fullscreenButton = $('[data-graph="fullscreen"]');
    const graphSearch = $("#graphSearch");
    const modeLabel = $("[data-graph-mode]");
    const hintLabel = $("[data-graph-hint]");
    const transform = { k: 1, x: 0, y: 0 };
    const camera = { yaw: -0.55, pitch: 0.22, focal: 1500 };
    const FOCAL = camera.focal;
    const pointers = new Map();
    const cleanups = [];

    let viewMode = "2d";
    let width = 0;
    let height = 0;
    let hover = null;
    let panning = false;
    let orbiting = false;
    let dragging = null;
    let pinch = null;
    let moved = 0;
    let last = { x: 0, y: 0 };
    let alpha = 1;
    let fitted = false;
    let autoSpin = false;
    let seeded3d = false;
    let raf = 0;
    let destroyed = false;
    let lastFrame = 0;
    let accumulator = 0;
    let lastLabelCount = 0;
    let selectedGroup = null;
    let selectedNode = null;
    let atmosphere = true;
    let visible = !document.hidden;
    let lastDecorFrame = 0;
    let beforeFullscreen = null;
    const stars = Array.from({ length: 82 }, (_, index) => ({
      x: (Math.sin(index * 127.1 + 2) * 43758.5453) % 1,
      y: (Math.sin(index * 83.3 + 4) * 23567.117) % 1,
      size: index % 13 === 0 ? 1.6 : 0.6 + (index % 3) * 0.24,
      phase: index * 3.77
    })).map((star) => ({ ...star, x: Math.abs(star.x), y: Math.abs(star.y) }));

    const STEP = 1000 / 60;
    const reduce = reduceMotion();

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      width = Math.max(320, rect.width);
      height = Math.max(360, rect.height);
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const radius = Math.min(width, height) * 0.34;
    nodes.forEach((node, index) => {
      const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2;
      node.x = Math.cos(angle) * radius + (Math.random() - 0.5) * 40;
      node.y = Math.sin(angle) * radius + (Math.random() - 0.5) * 40;
      node.z = 0;
      node.vx = 0;
      node.vy = 0;
      node.vz = 0;
      node.fixed = false;
    });

    const seed3d = () => {
      if (seeded3d) return;
      seeded3d = true;
      const spread = Math.min(width, height) * 0.42;
      nodes.forEach((node, index) => {
        const h = Math.abs(Math.sin((index + 1) * 12.9898) * 43758.5453) % 1;
        node.z = (h - 0.5) * spread * 1.4;
        node.vz = 0;
      });
      alpha = Math.max(alpha, 0.85);
    };

    const projectNode = (node) => {
      if (viewMode === "2d") return { x: node.x, y: node.y, scale: 1, depth: 0 };
      const p = projectPoint(node, { yaw: camera.yaw, pitch: camera.pitch, focal: FOCAL });
      return { x: p.x, y: p.y, scale: p.scale, depth: p.depth };
    };

    const layout = () => nodes.map((node) => {
      const p = projectNode(node);
      return {
        node,
        x: width / 2 + transform.x + p.x * transform.k,
        y: height / 2 + transform.y + p.y * transform.k,
        scale: p.scale * transform.k,
        persp: p.scale,
        depth: p.depth
      };
    });

    const fitView = () => {
      if (!nodes.length) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const node of nodes) {
        const p = projectNode(node);
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      const pad = Math.max(48, Math.min(120, Math.min(width, height) * 0.12));
      const spanX = Math.max(1, maxX - minX);
      const spanY = Math.max(1, maxY - minY);
      transform.k = clamp(Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY), 0.22, 2.8);
      transform.x = -((minX + maxX) / 2) * transform.k;
      transform.y = -((minY + maxY) / 2) * transform.k;
    };

    const simulate = () => {
      if (alpha > 0.004) alpha *= 0.985;
      const is3d = viewMode === "3d";
      const dragNode = dragging ? dragging.node : null;
      const damping = is3d ? 0.88 : 0.86;
      const springK = (dragNode ? 0.008 : 0.0035) * alpha;

      for (let i = 0; i < nodes.length; i += 1) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j += 1) {
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let dz = is3d ? a.z - b.z : 0;
          let d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < 1) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            dz = is3d ? Math.random() - 0.5 : 0;
            d2 = 1;
          }
          const force = Math.min(5, ((is3d ? 5600 : 4800) / (d2 + 180)) * alpha);
          const distance = Math.sqrt(d2) || 1;
          const fx = (dx / distance) * force;
          const fy = (dy / distance) * force;
          const fz = (dz / distance) * force;
          a.vx += fx; a.vy += fy; a.vz += fz;
          b.vx -= fx; b.vy -= fy; b.vz -= fz;
        }
      }

      for (const edge of edges) {
        const dx = edge.target.x - edge.source.x;
        const dy = edge.target.y - edge.source.y;
        const dz = is3d ? edge.target.z - edge.source.z : 0;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        const desired = is3d ? 145 : 132;
        const force = (distance - desired) * springK;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        const fz = (dz / distance) * force;
        if (!edge.source.fixed) { edge.source.vx += fx; edge.source.vy += fy; edge.source.vz += fz; }
        if (!edge.target.fixed) { edge.target.vx -= fx; edge.target.vy -= fy; edge.target.vz -= fz; }
      }

      if (dragNode) {
        const pull = 0.0018 * alpha;
        for (const edge of edges) {
          if (edge.source !== dragNode && edge.target !== dragNode) continue;
          const other = edge.source === dragNode ? edge.target : edge.source;
          if (other.fixed) continue;
          other.vx += (dragNode.x - other.x) * pull;
          other.vy += (dragNode.y - other.y) * pull;
          if (is3d) other.vz += (dragNode.z - other.z) * pull;
        }
      }

      for (const node of nodes) {
        if (node.fixed) {
          node.vx = 0; node.vy = 0; node.vz = 0;
          continue;
        }
        const angle = (node.group.index / Math.max(1, groups.length)) * Math.PI * 2 - Math.PI / 2;
        const orbit = groups.length < 2 ? 0 : Math.min(width, height) * 0.32;
        node.vx += (Math.cos(angle) * orbit - node.x) * 0.0012 * alpha;
        node.vy += (Math.sin(angle) * orbit - node.y) * 0.0012 * alpha;
        if (is3d) node.vz += -node.z * 0.0003 * alpha;
        node.vx *= damping;
        node.vy *= damping;
        node.vz *= damping;
        node.vx = clamp(node.vx, -40, 40);
        node.vy = clamp(node.vy, -40, 40);
        node.vz = clamp(node.vz, -40, 40);
        node.x += node.vx;
        node.y += node.vy;
        if (is3d) node.z += node.vz;
      }
    };

    const nodeRadius = (node, item, active = false) => {
      const base = 3.2 + Math.sqrt(node.degree) * 1.25;
      return Math.max(1.2, base * item.scale) * (active ? 1.5 : 1);
    };

    const roundRect = (x, y, w, h, radius) => {
      const r = Math.min(radius, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    };

    const draw = () => {
      if (!canvas.isConnected) return;
      ctx.clearRect(0, 0, width, height);
      // El lienzo es nocturno en ambos temas; el texto conserva contraste estable.
      const text = "#f5f3ff";
      const panelSolid = "#151b32";
      const is3d = viewMode === "3d";
      const items = layout();
      const byId = new Map(items.map((item) => [item.node.id, item]));
      const groupCenters = new Map();
      for (const item of items) {
        const center = groupCenters.get(item.node.group) || { x: 0, y: 0, count: 0 };
        center.x += item.x;
        center.y += item.y;
        center.count += 1;
        groupCenters.set(item.node.group, center);
      }
      const focusNode = hover || selectedNode;
      const neighbors = focusNode && connected.get(focusNode.id);
      const isRelevant = (node) => focusNode
        ? node === focusNode || neighbors.has(node.id)
        : !selectedGroup || node.group === selectedGroup;

      if (atmosphere) {
        const time = performance.now();
        // Una sola capa fija al lienzo: ni notas ni datos salen del navegador.
        for (const star of stars) {
          const glow = reduce ? 0.48 : 0.42 + Math.sin(time * 0.00075 + star.phase) * 0.16;
          ctx.fillStyle = `rgba(214,226,255,${glow})`;
          ctx.beginPath();
          ctx.arc(star.x * width, star.y * height, star.size, 0, Math.PI * 2);
          ctx.fill();
        }
        for (const group of groups.slice().sort((a, b) => b.count - a.count).slice(0, 20)) {
          const center = groupCenters.get(group);
          if (!center) continue;
          const x = center.x / center.count;
          const y = center.y / center.count;
          const size = Math.min(175, 75 + Math.sqrt(center.count) * 19);
          const haze = ctx.createRadialGradient(x, y, 0, x, y, size);
          haze.addColorStop(0, group.color + "25");
          haze.addColorStop(1, group.color + "00");
          ctx.fillStyle = haze;
          ctx.beginPath();
          ctx.arc(x, y, size, 0, Math.PI * 2);
          ctx.fill();
        }
        // Destello fugaz muy ocasional; no requiere sprites ni temporizadores extra.
        if (!reduce && visible) {
          const period = 12500;
          const progress = (time % period) / period;
          if (progress < 0.052) {
            const x = (0.08 + progress * 7) * width;
            const y = (0.12 + progress * 4) * height;
            const trail = ctx.createLinearGradient(x - 54, y - 30, x, y);
            trail.addColorStop(0, "rgba(170,210,255,0)");
            trail.addColorStop(1, `rgba(208,232,255,${Math.sin(progress / 0.052 * Math.PI) * 0.62})`);
            ctx.strokeStyle = trail;
            ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(x - 54, y - 30); ctx.lineTo(x, y); ctx.stroke();
          }
        }
      }

      let minPersp = Infinity;
      let maxPersp = -Infinity;
      for (const item of items) {
        minPersp = Math.min(minPersp, item.persp);
        maxPersp = Math.max(maxPersp, item.persp);
      }
      const depthMix = (value) => (maxPersp > minPersp ? (value - minPersp) / (maxPersp - minPersp) : 1);

      ctx.lineCap = "round";
      for (const edge of edges) {
        const a = byId.get(edge.source.id);
        const b = byId.get(edge.target.id);
        if (!a || !b) continue;
        const active = focusNode && (edge.source === focusNode || edge.target === focusNode);
        const inGroup = !selectedGroup || (edge.source.group === selectedGroup && edge.target.group === selectedGroup);
        const baseAlpha = is3d
          ? 0.1 + 0.42 * ((depthMix(a.persp) + depthMix(b.persp)) / 2)
          : 0.4;
        ctx.globalAlpha = active ? 0.92 : ((focusNode || selectedGroup) && !inGroup ? baseAlpha * 0.15 : (focusNode ? baseAlpha * 0.32 : baseAlpha));
        ctx.strokeStyle = active ? focusNode.group.color : "#798ab6";
        ctx.lineWidth = active
          ? Math.max(1.2, 1.8 * transform.k)
          : Math.max(0.5, transform.k * (is3d ? 0.7 + depthMix((a.persp + b.persp) / 2) * 0.6 : 1));
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      const ordered = is3d ? items.slice().sort((a, b) => b.depth - a.depth) : items;
      for (const item of ordered) {
        const node = item.node;
        const isHover = focusNode === node;
        const r = nodeRadius(node, item, isHover);
        const fade = is3d ? 0.55 + 0.45 * depthMix(item.persp) : 1;
        ctx.globalAlpha = (isRelevant(node) ? 0.97 : 0.2) * fade;
        if (atmosphere && (node.degree || isHover)) {
          ctx.save();
          ctx.globalAlpha *= 0.35;
          ctx.shadowColor = node.group.color;
          ctx.shadowBlur = Math.min(26, 8 + r * 1.4);
          ctx.fillStyle = node.group.color;
          ctx.beginPath(); ctx.arc(item.x, item.y, r + 1.5, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }
        ctx.beginPath();
        ctx.arc(item.x, item.y, r, 0, Math.PI * 2);
        ctx.fillStyle = node.group.color;
        ctx.fill();
        if (isHover) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = text;
          ctx.lineWidth = 1.4;
          ctx.stroke();
          ctx.globalAlpha = 0.28;
          ctx.strokeStyle = node.group.color;
          ctx.lineWidth = 5;
          ctx.beginPath();
          ctx.arc(item.x, item.y, r + 4, 0, Math.PI * 2);
          ctx.stroke();
        }
        if (dragging && dragging.node === node) {
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = text;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(item.x, item.y, r + 5, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

      const labelCandidates = items.slice().sort((a, b) => {
        const aActive = focusNode === a.node || (dragging && dragging.node === a.node);
        const bActive = focusNode === b.node || (dragging && dragging.node === b.node);
        if (aActive !== bActive) return aActive ? -1 : 1;
        const byDegree = b.node.degree - a.node.degree;
        if (byDegree) return byDegree;
        return is3d ? b.persp - a.persp : 0;
      });
      const boxes = [];
      let labelCount = 0;
      const chipPad = 6;
      const chipHeight = 20;
      ctx.textBaseline = "middle";
      for (const item of labelCandidates) {
        if (labelCount >= 600) break;
        const node = item.node;
        const active = focusNode === node || Boolean(dragging && dragging.node === node);
        const zoomScale = is3d ? item.scale : transform.k;
        if (!active && (zoomScale < 0.22 || !isRelevant(node))) continue;
        if (item.x < -60 || item.x > width + 60 || item.y < -30 || item.y > height + 30) continue;
        const label = node.label.length > 34 ? node.label.slice(0, 31) + "…" : node.label;
        const r = nodeRadius(node, item, active);
        ctx.font = `${active ? 13 : 12}px Inter, system-ui, sans-serif`;
        const labelWidth = ctx.measureText(label).width;
        const gap = r + 6;
        let lx = item.x + gap;
        let align = "left";
        if (lx + labelWidth + chipPad > width - 8) {
          lx = item.x - gap;
          align = "right";
        }
        if (align === "right" && lx - labelWidth - chipPad < 8) {
          align = "left";
          lx = clamp(item.x + gap, 8 + chipPad, Math.max(8 + chipPad, width - 8 - chipPad - labelWidth));
        }
        const ly = clamp(item.y, chipHeight / 2 + 4, height - chipHeight / 2 - 4);
        const chipW = labelWidth + chipPad * 2;
        const box = {
          x: align === "right" ? lx - labelWidth - chipPad : lx - chipPad,
          y: ly - chipHeight / 2,
          w: chipW,
          h: chipHeight
        };
        const collides = boxes.some((other) => (
          box.x < other.x + other.w + 3 && box.x + box.w + 3 > other.x &&
          box.y < other.y + other.h + 2 && box.y + box.h + 2 > other.y
        ));
        if (!active && collides) continue;
        boxes.push(box);
        roundRect(box.x, box.y, box.w, box.h, 6);
        ctx.globalAlpha = active ? 0.98 : 0.92;
        ctx.fillStyle = panelSolid;
        ctx.fill();
        ctx.globalAlpha = active ? 1 : 0.9;
        ctx.strokeStyle = active ? node.group.color : "#465071";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = text;
        ctx.textAlign = align;
        ctx.fillText(label, lx, ly);
        labelCount += 1;
      }
      ctx.textAlign = "left";
      ctx.globalAlpha = 1;
      lastLabelCount = labelCount;

      if (nodes.length < 2) {
        ctx.fillStyle = text;
        ctx.globalAlpha = 0.6;
        ctx.font = "12px Inter, system-ui, sans-serif";
        ctx.fillText("Aún no hay enlaces entre notas.", 16, 26);
        ctx.globalAlpha = 1;
      }
    };

    const syncModeUi = () => {
      const is3d = viewMode === "3d";
      if (viewButton) {
        viewButton.textContent = is3d ? "Vista 2D" : "Vista 3D";
        viewButton.setAttribute("aria-label", is3d ? "Cambiar a vista 2D" : "Cambiar a vista 3D");
      }
      if (spinButton) {
        spinButton.disabled = !is3d || reduce;
        spinButton.title = reduce ? "Órbita desactivada por la preferencia de movimiento reducido" : "Girar la vista 3D automáticamente (O)";
        spinButton.setAttribute("aria-pressed", String(is3d && autoSpin));
      }
      if (modeLabel) modeLabel.textContent = is3d ? "3D" : "2D";
      if (hintLabel) {
        hintLabel.textContent = is3d
          ? "Fondo: girar · Shift: mover · rueda: acercar"
          : "Arrastra un planeta · rueda para acercar";
      }
      canvas.setAttribute("aria-label", is3d
        ? "Grafo interactivo en 3D. Arrastra un nodo para moverlo y ver cómo lo siguen sus conexiones. Arrastra el fondo para girar la cámara, usa las flechas para orbitar, más y menos para acercar, y V para volver a la vista 2D."
        : "Grafo interactivo en 2D. Arrastra un nodo para moverlo y ver cómo lo siguen sus conexiones. Usa las flechas para desplazarte, más y menos para acercar, y V para cambiar a la vista 3D.");
    };

    const setMode = (next) => {
      const target = next || (viewMode === "2d" ? "3d" : "2d");
      if (target === viewMode) return;
      if (dragging) {
        dragging.node.fixed = false;
        dragging = null;
      }
      panning = false;
      orbiting = false;
      viewMode = target;
      if (viewMode === "3d") seed3d();
      else autoSpin = false;
      alpha = Math.max(alpha, 0.78);
      fitted = true;
      syncModeUi();
      fitView();
      draw();
    };

    const toggleSpin = () => {
      if (viewMode !== "3d" || reduce) return;
      autoSpin = !autoSpin;
      if (autoSpin) alpha = Math.max(alpha, 0.2);
      syncModeUi();
      draw();
    };

    const resetView = () => {
      if (viewMode === "3d") {
        camera.yaw = -0.55;
        camera.pitch = 0.22;
      }
      for (const node of nodes) node.fixed = false;
      dragging = null;
      panning = false;
      orbiting = false;
      alpha = 0.9;
      fitted = false;
      if (reduce) {
        for (let i = 0; i < 140; i += 1) simulate();
        alpha = 0;
        fitted = true;
      }
      fitView();
      draw();
    };

    const syncFullscreen = () => {
      const active = document.fullscreenElement === graphRoot;
      if (graphTip && tipParent) {
        if (active) graphRoot.appendChild(graphTip);
        else tipParent.appendChild(graphTip);
      }
      fullscreenButton.setAttribute("aria-pressed", String(active));
      fullscreenButton.setAttribute("aria-label", active ? "Salir de pantalla completa" : "Pantalla completa del grafo");
      fullscreenButton.textContent = active ? "⛶ Salir" : "⛶ Pantalla completa";
      requestAnimationFrame(() => {
        if (destroyed || !canvas.isConnected) return;
        resize();
        if (active) fitView();
        else if (beforeFullscreen) {
          Object.assign(transform, beforeFullscreen);
          beforeFullscreen = null;
        }
        draw();
      });
    };

    const toggleFullscreen = async () => {
      try {
        if (document.fullscreenElement === graphRoot) {
          await document.exitFullscreen();
        } else if (!document.fullscreenElement && graphRoot.requestFullscreen) {
          beforeFullscreen = { ...transform };
          await graphRoot.requestFullscreen();
        } else {
          toast("La pantalla completa no está disponible en este navegador.", "warn");
        }
      } catch {
        beforeFullscreen = null;
        toast("El navegador no permitió abrir la pantalla completa.", "warn");
      }
    };

    const tick = (now) => {
      if (!canvas.isConnected || destroyed) return;
      if (!lastFrame) lastFrame = now;
      const delta = Math.min(80, Math.max(0, now - lastFrame));
      lastFrame = now;
      if (!visible) {
        accumulator = 0;
        raf = requestAnimationFrame(tick);
        return;
      }
      const active = alpha > 0.004 || dragging || panning || orbiting || (viewMode === "3d" && autoSpin);
      if (active) {
        if (viewMode === "3d" && autoSpin && !dragging) {
          camera.yaw += 0.0032 * (delta / STEP);
        }
        accumulator += delta;
        let steps = 0;
        while (accumulator >= STEP && steps < 3) {
          simulate();
          accumulator -= STEP;
          steps += 1;
        }
        if (dragging) alpha = Math.max(alpha, 0.7);
        if (!fitted && alpha < 0.45) {
          fitted = true;
          fitView();
        }
        draw();
      } else {
        accumulator = 0;
        // Limita los repintados de estrellas a 20 fps; no anima con movimiento reducido.
        if (atmosphere && !reduce && nodes.length <= 350 && now - lastDecorFrame >= 50) {
          lastDecorFrame = now;
          draw();
        }
      }
      raf = requestAnimationFrame(tick);
    };

    const localPoint = (event) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const findNode = (point) => {
      let best = null;
      let bestDistance = Infinity;
      for (const item of layout()) {
        const distance = Math.hypot(item.x - point.x, item.y - point.y);
        const hit = (3.2 + Math.sqrt(item.node.degree) * 1.25) * item.scale + 9;
        if (distance <= hit && distance < bestDistance) {
          best = item.node;
          bestDistance = distance;
        }
      }
      return best;
    };

    const screenDeltaToWorld = (dx, dy, scale) => {
      const a = dx / (transform.k * Math.max(0.05, scale));
      const b = dy / (transform.k * Math.max(0.05, scale));
      if (viewMode === "2d") return { x: a, y: b, z: 0 };
      const cy = Math.cos(camera.yaw);
      const sy = Math.sin(camera.yaw);
      const cp = Math.cos(camera.pitch);
      const sp = Math.sin(camera.pitch);
      return {
        x: a * cy + b * sp * sy,
        y: b * cp,
        z: a * sy - b * sp * cy
      };
    };

    const showTip = (node, event) => {
      const tip = $("#graphTip");
      if (!tip) return;
      tip.hidden = false;
      tip.textContent = `${node.label} · ${node.group.name} · ${node.degree} ${node.degree === 1 ? "enlace" : "enlaces"}`;
      tip.style.left = event.clientX + 12 + "px";
      tip.style.top = event.clientY - 28 + "px";
    };

    const hideTip = () => {
      const tip = $("#graphTip");
      if (tip) tip.hidden = true;
    };

    const onPointerDown = (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture?.(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      moved = 0;
      if (pointers.size === 1) {
        const point = localPoint(event);
        const node = findNode(point);
        if (node) {
          const p = projectNode(node);
          dragging = {
            node,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            nodeX: node.x,
            nodeY: node.y,
            nodeZ: node.z,
            scale: p.scale,
            lastX: event.clientX,
            lastY: event.clientY,
            lastTime: performance.now(),
            vx: 0,
            vy: 0
          };
          node.fixed = true;
          node.vx = 0;
          node.vy = 0;
          node.vz = 0;
          hover = node;
          alpha = Math.max(alpha, 0.72);
          canvas.style.cursor = "grabbing";
          hideTip();
          draw();
        } else if (viewMode === "3d" && !event.shiftKey) {
          orbiting = true;
          last = { x: event.clientX, y: event.clientY };
          canvas.style.cursor = "grabbing";
        } else {
          panning = true;
          last = { x: event.clientX, y: event.clientY };
          canvas.style.cursor = "grabbing";
        }
      } else if (pointers.size === 2) {
        if (dragging) {
          dragging.node.fixed = false;
          dragging = null;
        }
        panning = false;
        orbiting = false;
        const [a, b] = Array.from(pointers.values());
        pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), k: transform.k };
      }
      event.preventDefault();
    };

    const onPointerMove = (event) => {
      const previous = pointers.get(event.pointerId);
      if (previous) {
        moved += Math.hypot(event.clientX - previous.x, event.clientY - previous.y);
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }
      if (pointers.size === 2 && pinch) {
        const [a, b] = Array.from(pointers.values());
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch.distance > 0) transform.k = clamp(pinch.k * (distance / pinch.distance), 0.18, 5);
        draw();
        return;
      }
      if (dragging && event.pointerId === dragging.pointerId) {
        const delta = screenDeltaToWorld(
          event.clientX - dragging.startX,
          event.clientY - dragging.startY,
          dragging.scale
        );
        dragging.node.x = dragging.nodeX + delta.x;
        dragging.node.y = dragging.nodeY + delta.y;
        dragging.node.z = dragging.nodeZ + delta.z;
        const now = performance.now();
        const elapsed = Math.max(8, now - dragging.lastTime);
        dragging.vx = ((event.clientX - dragging.lastX) / elapsed) * 16;
        dragging.vy = ((event.clientY - dragging.lastY) / elapsed) * 16;
        dragging.lastX = event.clientX;
        dragging.lastY = event.clientY;
        dragging.lastTime = now;
        alpha = Math.max(alpha, 0.72);
        hideTip();
        return;
      }
      if (orbiting) {
        camera.yaw += (event.clientX - last.x) * 0.006;
        camera.pitch = clamp(camera.pitch + (event.clientY - last.y) * 0.006, -1.25, 1.25);
        last = { x: event.clientX, y: event.clientY };
        draw();
        return;
      }
      if (panning) {
        transform.x += event.clientX - last.x;
        transform.y += event.clientY - last.y;
        last = { x: event.clientX, y: event.clientY };
        draw();
        return;
      }
      const node = findNode(localPoint(event));
      if (node) {
        hover = node;
        showTip(node, event);
        canvas.style.cursor = "pointer";
      } else {
        hover = null;
        hideTip();
        canvas.style.cursor = "grab";
      }
      draw();
    };

    const focusSearch = () => {
      const query = normalize(graphSearch.value.trim());
      selectedNode = query ? nodes.find((node) => normalize(node.label).includes(query) || normalize(node.id).includes(query)) || null : null;
      graphSearch.setCustomValidity("");
      graphSearch.setAttribute("aria-label", selectedNode
        ? `Encontrar nota en el grafo. Encontrada: ${selectedNode.label}`
        : "Encontrar nota en el grafo");
      if (selectedNode) {
        const point = projectNode(selectedNode);
        transform.k = Math.max(transform.k, 0.85);
        transform.x = -point.x * transform.k;
        transform.y = -point.y * transform.k;
      }
      draw();
    };

    const onPointerUp = (event) => {
      const wasDragging = dragging && dragging.pointerId === event.pointerId;
      pointers.delete(event.pointerId);
      canvas.releasePointerCapture?.(event.pointerId);
      if (pointers.size < 2) pinch = null;
      if (wasDragging) {
        const node = dragging.node;
        node.fixed = false;
        if (event.type === "pointercancel" || reduce) {
          node.vx = 0; node.vy = 0; node.vz = 0;
        } else {
          const fling = screenDeltaToWorld(
            clamp(dragging.vx, -18, 18),
            clamp(dragging.vy, -18, 18),
            dragging.scale
          );
          node.vx = clamp(fling.x, -22, 22);
          node.vy = clamp(fling.y, -22, 22);
          node.vz = clamp(fling.z, -22, 22);
        }
        const shouldOpen = event.type !== "pointercancel" && moved < 8;
        dragging = null;
        alpha = Math.max(alpha, 0.88);
        hover = node;
        hideTip();
        canvas.style.cursor = "grab";
        if (shouldOpen) openNote(node.id);
      } else if (pointers.size === 0) {
        panning = false;
        orbiting = false;
        canvas.style.cursor = "grab";
      }
    };

    const onPointerLeave = () => {
      hover = null;
      hideTip();
      if (pointers.size === 0) {
        panning = false;
        orbiting = false;
      }
      draw();
    };

    const zoomBy = (factor) => {
      transform.k = clamp(transform.k * factor, 0.18, 5);
      draw();
    };

    const onWheel = (event) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0015);
      const next = clamp(transform.k * factor, 0.18, 5);
      if (viewMode === "2d") {
        const rect = canvas.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        const worldX = (px - width / 2 - transform.x) / transform.k;
        const worldY = (py - height / 2 - transform.y) / transform.k;
        transform.k = next;
        transform.x = px - width / 2 - worldX * next;
        transform.y = py - height / 2 - worldY * next;
      } else {
        transform.k = next;
      }
      draw();
    };

    const onKeyDown = (event) => {
      const key = event.key;
      if (key === "v" || key === "V") {
        setMode();
      } else if (key === "f" || key === "F") {
        toggleFullscreen();
      } else if ((key === "o" || key === "O") && viewMode === "3d") {
        toggleSpin();
      } else if (key === "0") {
        resetView();
      } else if (key === "+" || key === "=") {
        zoomBy(1.15);
      } else if (key === "-" || key === "_") {
        zoomBy(0.87);
      } else if (key.startsWith("Arrow")) {
        if (viewMode === "3d") {
          if (key === "ArrowLeft") camera.yaw -= 0.08;
          if (key === "ArrowRight") camera.yaw += 0.08;
          if (key === "ArrowUp") camera.pitch = clamp(camera.pitch - 0.08, -1.25, 1.25);
          if (key === "ArrowDown") camera.pitch = clamp(camera.pitch + 0.08, -1.25, 1.25);
        } else {
          const step = 36;
          if (key === "ArrowLeft") transform.x -= step;
          if (key === "ArrowRight") transform.x += step;
          if (key === "ArrowUp") transform.y -= step;
          if (key === "ArrowDown") transform.y += step;
        }
        draw();
      } else {
        return;
      }
      event.preventDefault();
    };

    const add = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      cleanups.push(() => target.removeEventListener(type, handler, options));
    };

    add(canvas, "pointerdown", onPointerDown);
    add(canvas, "pointermove", onPointerMove);
    add(canvas, "pointerup", onPointerUp);
    add(canvas, "pointercancel", onPointerUp);
    add(canvas, "pointerleave", onPointerLeave);
    add(canvas, "wheel", onWheel, { passive: false });
    add(canvas, "keydown", onKeyDown);
    add(graphSearch, "input", focusSearch);
    add(graphSearch, "keydown", (event) => {
      if (event.key === "Enter" && selectedNode) {
        event.preventDefault();
        openNote(selectedNode.id);
      } else if (event.key === "Escape") {
        graphSearch.value = "";
        focusSearch();
        canvas.focus({ preventScroll: true });
      }
    });

    $$("[data-graph-folder]", view).forEach((button) => {
      add(button, "click", () => {
        const group = groups.find((item) => item.name === button.dataset.graphFolder);
        selectedGroup = selectedGroup === group ? null : group;
        $$("[data-graph-folder]", view).forEach((item) => {
          item.setAttribute("aria-pressed", String(Boolean(selectedGroup && item.dataset.graphFolder === selectedGroup.name)));
        });
        draw();
      });
    });

    const onResize = () => { resize(); draw(); };
    add(window, "resize", onResize);
    add(document, "fullscreenchange", syncFullscreen);
    add(document, "keydown", (event) => {
      if (event.key === "Escape" && document.fullscreenElement === graphRoot) {
        event.preventDefault();
        document.exitFullscreen().catch(() => {});
      }
    });
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
    if (resizeObserver) {
      resizeObserver.observe(wrap);
      cleanups.push(() => resizeObserver.disconnect());
    }
    add(document, "visibilitychange", () => {
      visible = !document.hidden;
      lastFrame = 0;
      if (visible) draw();
    });

    $$("[data-graph]").forEach((button) => {
      add(button, "click", () => {
        const action = button.dataset.graph;
        if (action === "reset") resetView();
        else if (action === "random") openRandomNote();
        else if (action === "view") setMode();
        else if (action === "spin") toggleSpin();
        else if (action === "fullscreen") toggleFullscreen();
        else if (action === "atmosphere") {
          atmosphere = !atmosphere;
          atmosphereButton.setAttribute("aria-pressed", String(atmosphere));
          draw();
        }
      });
    });

    syncModeUi();

    if (reduce) {
      for (let i = 0; i < 180; i += 1) simulate();
      alpha = 0;
      fitted = true;
      fitView();
      draw();
    }
    raf = requestAnimationFrame(tick);

    const cleanup = () => {
      destroyed = true;
      if (document.fullscreenElement === graphRoot) document.exitFullscreen().catch(() => {});
      if (graphTip && tipParent) tipParent.appendChild(graphTip);
      cancelAnimationFrame(raf);
      for (const remove of cleanups) remove();
      hideTip();
      canvas.style.cursor = "";
    };
    if (state.graph && state.graph.cleanup) state.graph.cleanup();
    state.graph = {
      nodes,
      edges,
      groups,
      cleanup,
      redraw: draw,
      setMode,
      reset: resetView,
      camera,
      transform,
      screenNodes: () => layout().map((item) => ({
        id: item.node.id,
        label: item.node.label,
        degree: item.node.degree,
        x: item.x,
        y: item.y
      })),
      get viewMode() { return viewMode; },
      get labelCount() { return lastLabelCount; }
    };
  }

  function openRandomNote() {
    const paths = Array.from(state.notes.keys());
    if (!paths.length) return;
    openNote(paths[Math.floor(Math.random() * paths.length)]);
  }

  /* ------------------------------ migas y paleta ----------------------------- */

  function updateBreadcrumbs() {
    const crumbs = $("#breadcrumbs");
    if (!crumbs) return;
    const view = state.view;
    let parts = [];
    if (view.name === "note" && state.currentPath) parts = state.currentPath.split("/");
    else if (view.name === "folder" && view.folder) parts = view.folder.split("/");
    const vaultName = state.vaultName || "Biblioteca";
    let html = `<button data-folder="">${escapeHtml(vaultName)}</button>`;
    for (let i = 0; i < parts.length; i += 1) {
      const path = parts.slice(0, i + 1).join("/");
      const isLast = i === parts.length - 1;
      html += `<span class="sep">/</span>`;
      if (view.name === "note" && isLast) html += `<span class="current">${escapeHtml(stem(parts[i]))}</span>`;
      else html += `<button data-folder="${escapeHtml(path)}">${escapeHtml(parts[i])}</button>`;
    }
    if (view.name === "search") html += `<span class="sep">/</span><span class="current">Búsqueda</span>`;
    if (view.name === "tags") html += `<span class="sep">/</span><span class="current">Etiquetas</span>`;
    if (view.name === "tag") html += `<span class="sep">/</span><span class="current">#${escapeHtml(view.tag)}</span>`;
    if (view.name === "graph") html += `<span class="sep">/</span><span class="current">Grafo</span>`;
    if (view.name === "favorites") html += `<span class="sep">/</span><span class="current">Favoritos</span>`;
    if (view.name === "recent") html += `<span class="sep">/</span><span class="current">Recientes</span>`;
    if (view.name === "broken") html += `<span class="sep">/</span><span class="current">Enlaces por revisar</span>`;
    crumbs.innerHTML = html;
  }

  function palettePool(query) {
    const all = Array.from(state.notes.values());
    const recentOrder = new Map(state.recent.map((path, index) => [path, index]));
    const needle = normalize(query.trim());
    let list = all;
    if (needle) {
      list = all.filter((note) => normalize(note.title).includes(needle) || normalize(note.path).includes(needle) || normalize(note.stem).includes(needle));
      list.sort((a, b) => {
        const aStarts = normalize(a.title).startsWith(needle) ? 0 : 1;
        const bStarts = normalize(b.title).startsWith(needle) ? 0 : 1;
        return aStarts - bStarts || a.title.localeCompare(b.title, "es");
      });
    } else {
      list = all.slice().sort((a, b) => {
        const aRecent = recentOrder.has(a.path) ? recentOrder.get(a.path) : 999;
        const bRecent = recentOrder.has(b.path) ? recentOrder.get(b.path) : 999;
        return aRecent - bRecent || b.title.localeCompare(a.title, "es");
      });
    }
    return list.slice(0, 40);
  }

  function openPalette() {
    if (!state.notes.size) { toast("Abre una carpeta primero."); return; }
    const modal = $("#palette");
    state.paletteLastFocus = document.activeElement;
    modal.hidden = false;
    const input = $("#paletteInput");
    input.value = "";
    state.paletteIndex = 0;
    renderPalette("");
    setTimeout(() => input.focus(), 10);
  }

  function closePalette() {
    const modal = $("#palette");
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    if (state.paletteLastFocus && state.paletteLastFocus.focus) state.paletteLastFocus.focus();
    state.paletteLastFocus = null;
  }

  function renderPalette(query) {
    const items = palettePool(query);
    state.paletteItems = items;
    if (state.paletteIndex >= items.length) state.paletteIndex = Math.max(0, items.length - 1);
    $("#paletteResults").innerHTML = items.length ? items.map((note, index) => `
      <button class="palette-item${index === state.paletteIndex ? " active" : ""}" data-palette-index="${index}" role="option" aria-selected="${index === state.paletteIndex}">
        <span class="palette-title">${highlightText(note.title, [normalize(query)])}</span>
        <span class="palette-path">${escapeHtml(dirname(note.path) || "Raíz")}</span>
      </button>`).join("") : `<p class="empty-mini" style="padding:14px">Sin resultados.</p>`;
    const active = $(".palette-item.active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  function choosePalette(index) {
    const note = state.paletteItems[index];
    if (!note) return;
    closePalette();
    openNote(note.path);
  }

  /* -------------------------------- eventos -------------------------------- */

  function bindEvents() {
    $("#openVault").addEventListener("click", () => openDirectoryPicker());
    const reopen = $("#reopenVault");
    reopen.textContent = "Reabrir última";
    reopen.addEventListener("click", reopenSaved);
    $("#fallbackPicker").addEventListener("change", (event) => {
      const files = Array.from(event.target.files || []);
      // Permite volver a elegir la misma carpeta en el selector de respaldo.
      event.target.value = "";
      filesFromInput(files);
    });
    $("#themeToggle").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));
    $("#randomNote").addEventListener("click", openRandomNote);
    $("#openPalette").addEventListener("click", openPalette);
    $("#newNote").addEventListener("click", createNote);
    $("#reloadVault").addEventListener("click", reloadVault);
    $("#menuBtn").addEventListener("click", () => document.body.classList.add("sidebar-open"));
    $("#toggleSidebar").addEventListener("click", () => document.body.classList.remove("sidebar-open"));
    $("#inspectorToggle")?.addEventListener("click", () => document.body.classList.toggle("inspector-open"));
    $("#scrim").addEventListener("click", () => document.body.classList.remove("sidebar-open", "inspector-open"));
    $("#collapseTree").addEventListener("click", () => {
      if (state.openFolders.size) state.openFolders.clear();
      else folderPaths().forEach((path) => state.openFolders.add(path));
      renderTree();
    });

    $("#searchInput").addEventListener("input", debounce((event) => {
      const next = event.target.value;
      if (state.view.name !== "search") {
        if (!confirmDiscard()) {
          event.target.value = state.query;
          return;
        }
        state.query = next;
        setView({ name: "search" }, { guard: false });
      } else {
        state.query = next;
        updateBreadcrumbs();
        pushHistory();
        renderSearchView();
      }
    }, 180));

    $$(".nav-btn").forEach((button) => {
      button.addEventListener("click", () => setView({ name: button.dataset.view }));
    });

    $("#paletteInput").addEventListener("input", (event) => {
      state.paletteIndex = 0;
      renderPalette(event.target.value);
    });

    $("#paletteInput").addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        state.paletteIndex = Math.min(state.paletteItems.length - 1, state.paletteIndex + 1);
        renderPalette(event.target.value);
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        state.paletteIndex = Math.max(0, state.paletteIndex - 1);
        renderPalette(event.target.value);
      }
      if (event.key === "Enter") {
        event.preventDefault();
        choosePalette(state.paletteIndex);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closePalette();
      }
    });

    $("#palette").addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const focusables = $$("input, button:not([disabled])", $("#palette"));
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });

    $("#palette").addEventListener("click", (event) => {
      if (event.target === $("#palette")) closePalette();
      const item = event.target.closest("[data-palette-index]");
      if (item) choosePalette(Number(item.dataset.paletteIndex));
    });

    $("#fileTree").addEventListener("toggle", (event) => {
      const details = event.target.closest(".tree-folder");
      if (!details) return;
      const path = details.dataset.folder;
      if (details.open) state.openFolders.add(path);
      else state.openFolders.delete(path);
    }, true);

    $("#viewerClose").addEventListener("click", closeViewer);
    $("#attachmentViewer").addEventListener("click", (event) => {
      if (event.target === $("#attachmentViewer")) closeViewer();
    });
    $("#attachmentViewer").addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const focusables = $$("#attachmentViewer a[href], #attachmentViewer button:not([disabled])");
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });

    document.addEventListener("click", handleDelegatedClick);
    document.addEventListener("keydown", handleKeys);
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("focus", checkExternalChange);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkExternalChange();
    });
    window.addEventListener("beforeunload", (event) => {
      if (state.editing && state.dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
  }

  function handleDelegatedClick(event) {
    const target = event.target;
    if (!target.closest(".action-menu")) $$(".action-menu[open]").forEach((menu) => menu.removeAttribute("open"));

    const attach = target.closest("[data-attach]");
    if (attach) {
      event.preventDefault();
      openAttachment(attach.dataset.attach);
      return;
    }

    const wikiEl = target.closest("[data-wiki]");
    if (wikiEl) {
      event.preventDefault();
      const resolved = resolveLink(wikiEl.dataset.wiki, state.currentPath);
      if (resolved) {
        const anchor = wikiEl.dataset.anchor;
        if (openNote(resolved) && anchor) setTimeout(() => scrollToAnchor(anchor), 60);
      } else {
        toast("Esa nota no existe en la carpeta.", "error");
      }
      return;
    }

    const noteEl = target.closest("[data-note]");
    if (noteEl) {
      event.preventDefault();
      const anchor = noteEl.dataset.anchor;
      if (openNote(noteEl.dataset.note) && anchor) setTimeout(() => scrollToAnchor(anchor), 60);
      return;
    }

    const tagEl = target.closest("[data-tag]");
    if (tagEl) {
      event.preventDefault();
      setView({ name: "tag", tag: tagEl.dataset.tag });
      return;
    }

    const editAction = target.closest("[data-edit-save], [data-edit-cancel], [data-edit-preview]");
    if (editAction) {
      if (editAction.hasAttribute("data-edit-save")) saveCurrentNote();
      if (editAction.hasAttribute("data-edit-cancel")) {
        if (state.saving) { toast("Espera a que termine el guardado.", "warn"); return; }
        if (!state.dirty || window.confirm("¿Descartar los cambios sin guardar?")) {
          state.editing = false;
          state.dirty = false;
          renderNoteView(state.currentPath);
        }
      }
      if (editAction.hasAttribute("data-edit-preview")) {
        state.preview = !state.preview;
        editAction.classList.toggle("on", state.preview);
        const preview = $("#editorPreview");
        if (preview) {
          preview.hidden = !state.preview;
          if (state.preview) {
            const draftNote = parseNote(state.currentPath, $("#noteEditor").value, state.notes.get(state.currentPath)?.mtime);
            preview.innerHTML = renderMarkdown(draftNote.body, draftNote);
          }
        }
        $(".editor-panes")?.classList.toggle("split", state.preview);
      }
      return;
    }

    const anchorButton = target.closest("[data-anchor]");
    if (anchorButton) {
      event.preventDefault();
      scrollToAnchor(anchorButton.dataset.anchor);
      return;
    }

    const treeFile = target.closest("[data-path]");
    if (treeFile) {
      event.preventDefault();
      const path = treeFile.dataset.path;
      if (state.notes.has(path)) openNote(path);
      else openAttachment(path);
      return;
    }

    const folderEl = target.closest("[data-folder]");
    if (folderEl) {
      if (target.closest("summary")) return;
      event.preventDefault();
      setView({ name: "folder", folder: folderEl.dataset.folder });
      return;
    }

    const hashLink = target.closest('a[href^="#"]');
    if (hashLink) {
      const id = hashLink.getAttribute("href").slice(1);
      if (id && !id.startsWith("/")) { event.preventDefault(); scrollToAnchor(id); return; }
    }

    const action = target.closest("[data-action]");
    if (action) {
      event.preventDefault();
      const name = action.dataset.action;
      const caps = capabilities();
      if (name === "random") openRandomNote();
      if (name === "focus-search") { setView({ name: "search" }); $("#searchInput").focus(); }
      if (name === "graph") setView({ name: "graph" });
      if (name === "reopen") openDirectoryPicker();
      if (name === "favorite") toggleFavorite();
      if (name === "edit") {
        const note = state.notes.get(state.currentPath);
        if (!caps.edit) { toast("El editor no está disponible en la demostración.", "error"); return; }
        if (!note || note.tooLarge || note.readError) {
          toast("Esta nota no se leyó completa; edítala en Obsidian para no sobrescribirla.", "error");
          return;
        }
        state.editing = true;
        state.dirty = false;
        renderNoteView(state.currentPath);
      }
      if (name === "copy-link") copyNoteLink();
      if (name === "open-obsidian") openInObsidian();
      if (name === "reveal") toast(state.currentPath || "Sin nota abierta");
      if (name === "print") setTimeout(() => window.print(), 80);
      if (name === "broken") setView({ name: "broken" });
      if (name === "tags") setView({ name: "tags" });
      if (name === "reload-note") reloadNoteFromDisk();
      const menu = action.closest("details");
      if (menu) menu.removeAttribute("open");
      return;
    }
  }

  function handleKeys(event) {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (event.key === "Escape") {
      if (state.saving) return;
      if (closeViewer()) return;
      if (!$("#palette").hidden) { closePalette(); return; }
      if (state.editing) {
        if (!state.dirty || window.confirm("¿Descartar los cambios sin guardar?")) {
          state.editing = false;
          state.dirty = false;
          renderNoteView(state.currentPath);
        }
        return;
      }
      document.body.classList.remove("sidebar-open", "inspector-open");
      return;
    }
    if (mod && key === "k") {
      event.preventDefault();
      if ($("#palette").hidden) openPalette(); else closePalette();
      return;
    }
    if (mod && key === "s" && state.editing) {
      event.preventDefault();
      saveCurrentNote();
      return;
    }
    if (mod && key === "e" && state.currentPath && !state.editing) {
      event.preventDefault();
      const note = state.notes.get(state.currentPath);
      if (!capabilities().edit) { toast("El editor no está disponible en la demostración.", "error"); return; }
      if (!note || note.tooLarge || note.readError) {
        toast("Esta nota no se leyó completa; edítala en Obsidian para no sobrescribirla.", "error");
        return;
      }
      state.editing = true;
      state.dirty = false;
      renderNoteView(state.currentPath);
      return;
    }
    if (event.key === "/" && !mod && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) {
      event.preventDefault();
      $("#searchInput").focus();
    }
  }

  function scrollToAnchor(anchor) {
    const id = String(anchor).trim();
    if (!id) return;
    const element = document.getElementById(id) || document.getElementById(slugify(id));
    if (element) {
      element.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
      element.style.transition = "background .4s";
      element.style.background = "var(--accent-soft)";
      setTimeout(() => { element.style.background = ""; }, 1100);
    } else {
      toast("No encontré esa sección en la nota.", "error");
    }
  }

  /* -------------------------- cambios en el disco -------------------------- */

  let lastFocusCheck = 0;
  async function checkExternalChange() {
    if (state.mode !== "fs" || !state.currentPath) return;
    if (Date.now() - lastFocusCheck < 4000) return;
    lastFocusCheck = Date.now();
    const record = state.files.get(state.currentPath);
    const note = state.notes.get(state.currentPath);
    if (!record || !record.handle || !note || !note.mtime) return;
    try {
      const file = await record.handle.getFile();
      if (file.lastModified && file.lastModified > note.mtime + 1500) {
        state.externalChange = true;
        if (!state.editing) renderNoteView(state.currentPath);
        toast("La nota abierta cambió en el disco. Puedes cargar la versión nueva.", "warn");
      }
    } catch { /* archivo movido o permiso retirado */ }
  }

  function startObserver() {
    if (!("FileSystemObserver" in window) || state.mode !== "fs" || !state.rootHandle) return;
    try {
      state.observer = new FileSystemObserver(debounce(() => {
        toast("Se detectaron cambios en la carpeta. Pulsa ↻ para recargar la bóveda.", "warn");
      }, 900));
      state.observer.observe(state.rootHandle, { recursive: true });
    } catch { state.observer = null; }
  }

  /* -------------------------------- demo ----------------------------------- */

  async function openDemo() {
    if (!confirmDiscard()) return;
    try {
      resetState();
      state.mode = "demo";
      state.vaultId = "demo";
      state.vaultName = "Demostración";
      setBusy(true);
      $("#view").innerHTML = loadingView("Cargando la demostración…");
      const manifest = await (await fetch("demo/manifest.json", { cache: "no-store" })).json();
      state.vaultName = manifest.vault || "Demostración";
      for (const item of manifest.files) {
        const response = await fetch("demo/" + item.path, { cache: "no-store" });
        if (!response.ok) throw new Error(`No se pudo cargar ${item.path}`);
        const text = await response.text();
        const file = new File([text], basename(item.path), { type: "text/markdown" });
        state.files.set(item.path, { path: item.path, name: basename(item.path), file, extension: extname(item.path), mtime: Date.now(), size: file.size });
      }
      await finishOpen();
    } catch (error) {
      console.error(error);
      setBusy(false);
      toast("No se pudo cargar la demostración. Abre la app con el servidor local.", "error");
    }
  }

  /* -------------------------------- inicio --------------------------------- */

  function init() {
    settings = migrateSettings(store.load());
    const preferred = document.documentElement.dataset.theme || settings.theme
      || (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    applyTheme(preferred);
    bindEvents();
    idb.get("handles", "lastHandle").then((handle) => {
      if (!handle) return;
      state.savedHandle = handle;
      const button = $("#reopenVault");
      if (button) {
        button.textContent = `Reabrir ${handle.name}`;
        button.hidden = false;
      }
    }).catch(() => {});
    renderTree();
    renderHomeView();
    updateBreadcrumbs();
    syncModeUi();
    if (new URLSearchParams(location.search).has("demo")) openDemo();
    if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
    window.__obsidianWeb = { state, openNote, setView, openDirectoryPicker, openDemo, reloadVault, syncModeUi };
  }

  init();
})();
