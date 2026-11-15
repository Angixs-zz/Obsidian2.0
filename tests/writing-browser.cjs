/* Prueba de integración manual con Chrome de pruebas y Node 22+.
   CDP=http://127.0.0.1:9222 BASE=http://127.0.0.1:8765/ node tests/writing-browser.cjs
   Usa una carpeta OPFS aislada; no abre ni modifica bóvedas del usuario. */
const assert = require("node:assert/strict");
const BASE = process.env.BASE || "http://127.0.0.1:8765/";
const CDP = process.env.CDP || "http://127.0.0.1:9222";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const target = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  let id = 0, passes = 0;
  const pending = new Map(), errors = [];
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  }
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const call = pending.get(message.id); pending.delete(message.id);
      if (message.error) call.reject(new Error(JSON.stringify(message.error))); else call.resolve(message.result);
    }
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
    if (message.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = async (expression) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await delay(70);
    }
    throw new Error(`Timeout: ${expression}`);
  };
  const check = async (name, expression) => {
    assert.ok(await evaluate(expression), name);
    console.log("PASS", name); passes++;
  };
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const type = (text) => evaluate(`(() => {
    const editor = document.querySelector('#noteEditor');
    editor.value = ${JSON.stringify(text)};
    editor.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  const save = () => click("[data-edit-save]");
  const disk = (text) => evaluate(`(async () => {
    const w = await window.testHandle.createWritable(); await w.write(${JSON.stringify(text)}); await w.close();
  })()`);
  try {
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Network.enable");
    await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Network.setBypassServiceWorker", { bypass: true });
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: BASE });
    await wait("Boolean(window.__obsidianWeb && window.ObsidianWriting)");
    const install = async (fresh) => evaluate(`(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('ow-writing-test', {create:true});
      const handle = await dir.getFileHandle('Prueba.md', {create:true});
      if (${fresh}) {
        const w = await handle.createWritable(); await w.write('# Prueba\\n\\nTexto inicial.'); await w.close();
        ObsidianWriting.draftStore(localStorage).clear('writing-test', 'Prueba.md');
      }
      const file = await handle.getFile();
      window.testHandle = handle;
      const s = __obsidianWeb.state;
      s.mode = 'fs'; s.vaultId = 'writing-test'; s.vaultName = 'Prueba aislada'; s.rootHandle = dir;
      s.files.set('Prueba.md', {handle, path:'Prueba.md', name:'Prueba.md', mtime:file.lastModified});
      s.notes.set('Prueba.md', ObsidianCore.parseNote('Prueba.md', await file.text(), file.lastModified));
      s.notes.set('Lectura/Canción.md', ObsidianCore.parseNote('Lectura/Canción.md', '# Canción', 1));
      s.byPath.set('prueba.md', 'Prueba.md');
      s.byPath.set('lectura/cancion.md', 'Lectura/Canción.md');
      s.byPath.set('lectura/cancion', 'Lectura/Canción.md');
      __obsidianWeb.openNote('Prueba.md');
      document.querySelector('[data-action="edit"]').click();
    })()`);
    await install(true);
    await type("# Prueba\n## Ideas\nUna cancion para pensar.\n¿Dónde investigar?\n- [ ] Revisar fuente\n```\n¿Ignorar código?\n```\n");
    await wait("document.querySelector('[data-writing-link]')");
    await check("Mapa navegable y preguntas sin código", "document.querySelectorAll('#writingMap [data-writing-offset]').length === 2 && document.querySelectorAll('#writingPending button').length === 2");
    await click("#writingPending button");
    await check("Pendiente selecciona el texto original", "document.querySelector('#noteEditor').value.slice(document.querySelector('#noteEditor').selectionStart, document.querySelector('#noteEditor').selectionEnd) === '¿Dónde investigar?'");
    await evaluate("document.querySelector('#noteEditor').setSelectionRange(document.querySelector('#noteEditor').value.length, document.querySelector('#noteEditor').value.length)");
    await click("[data-writing-link]");
    await check("Inserción de enlace con ruta completa", "document.querySelector('#noteEditor').value.includes('[[Lectura/Canción]]')");
    await wait("!document.querySelector('[data-writing-link]')");
    await check("Borrador persistido antes de guardar", "ObsidianWriting.draftStore(localStorage).list('writing-test','Prueba.md')[0].text === document.querySelector('#noteEditor').value");
    await check("Escribir no modifica el archivo", "testHandle.getFile().then(f=>f.text()).then(t=>t.includes('Texto inicial.'))");
    await send("Page.reload", { ignoreCache: true });
    await delay(700);
    await wait("Boolean(window.__obsidianWeb && window.ObsidianWriting)");
    await install(false);
    await check("Recuperación ofrecida tras recargar", "document.querySelector('#draftStatus').textContent.includes('anterior distinto')");
    await click("#draftHistory");
    await click("#recoverDraft");
    await check("Historial restaura contenido sin tocar disco", "document.querySelector('#noteEditor').value.includes('[[Lectura/Canción]]') && __obsidianWeb.state.dirty");
    await save();
    await wait("!__obsidianWeb.state.saving");
    await check("Guardar escribe el borrador", "testHandle.getFile().then(f=>f.text()).then(t=>t.includes('[[Lectura/Canción]]'))");
    await type("# Prueba\nVersión navegador.");
    await disk("# Prueba\nVersión externa.");
    await save();
    await wait("Boolean(document.querySelector('#compareDisk'))");
    await check("Conflicto muestra las dos versiones", "document.querySelector('#compareDisk').value.includes('externa') && document.querySelector('#compareDraft').value.includes('navegador')");
    await click("#cancelMerge");
    await wait("!__obsidianWeb.state.saving");
    await check("Cancelar no escribe y conserva borrador", "testHandle.getFile().then(f=>f.text()).then(t=>t.includes('externa') && document.querySelector('#noteEditor').value.includes('navegador'))");
    await save();
    await wait("Boolean(document.querySelector('#mergedText'))");
    await evaluate("document.querySelector('#mergedText').value = '# Prueba\\nVersión combinada.'");
    await click("#saveMerged");
    await wait("!__obsidianWeb.state.saving");
    await check("Combinación explícita guardada", "testHandle.getFile().then(f=>f.text()).then(t=>t.includes('combinada') && !__obsidianWeb.state.dirty)");
    await type("# Prueba\nOtro cambio.");
    await disk("# Prueba\nSegunda externa.");
    await save();
    await wait("Boolean(document.querySelector('#mergedText'))");
    await disk("# Prueba\nTercera externa.");
    await evaluate("document.querySelector('#mergedText').value = '# Prueba\\nMi combinación pendiente.'");
    await click("#saveMerged");
    await wait("!__obsidianWeb.state.saving");
    await check("No sobrescribe un tercer cambio mientras se compara", "testHandle.getFile().then(f=>f.text()).then(t=>t.includes('Tercera externa') && document.querySelector('#noteEditor').value.includes('combinación pendiente'))");
    await save();
    await wait("Boolean(document.querySelector('#useDisk'))");
    await click("#useDisk");
    await wait("!__obsidianWeb.state.saving");
    await check("Cargar disco conserva borrador previo en historial", "document.querySelector('#noteEditor').value.includes('Tercera externa') && ObsidianWriting.draftStore(localStorage).list('writing-test','Prueba.md').some(v=>v.text.includes('combinación pendiente'))");
    await type("# Prueba\nConflicto cancelado con Escape.");
    await disk("# Prueba\nExterna Escape.");
    await save();
    await wait("Boolean(document.querySelector('dialog[open]'))");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await wait("!__obsidianWeb.state.saving");
    await check("Escape cierra comparador sin salir del editor", "__obsidianWeb.state.editing && !document.querySelector('dialog') && document.querySelector('#noteEditor').value.includes('cancelado')");
    await save();
    await wait("Boolean(document.querySelector('#useDisk'))");
    await click("#useDisk");
    await wait("!__obsidianWeb.state.saving");
    await type("# Prueba\nCambio que se enviará.");
    await evaluate(`(() => {
      const record = __obsidianWeb.state.files.get('Prueba.md');
      record.handle = {
        queryPermission: () => Promise.resolve('granted'),
        getFile: () => testHandle.getFile(),
        createWritable: async () => {
          const writable = await testHandle.createWritable();
          return { write: async (text) => {
            await new Promise(resolve => { window.releaseTestWrite = resolve; });
            await writable.write(text);
          }, close: () => writable.close() };
        }
      };
    })()`);
    await save();
    await wait("Boolean(window.releaseTestWrite)");
    await evaluate("__obsidianWeb.setView({name:'home'})");
    await check("Navegación bloqueada durante escritura", "__obsidianWeb.state.view.name === 'note' && Boolean(document.querySelector('#noteEditor'))");
    await type("# Prueba\nTexto escrito durante guardado.");
    await evaluate("window.releaseTestWrite()");
    await wait("!__obsidianWeb.state.saving");
    await check("Escritura concurrente conserva cambios posteriores sin guardar", "testHandle.getFile().then(f=>f.text()).then(t=>t.includes('se enviará') && document.querySelector('#noteEditor').value.includes('durante guardado') && __obsidianWeb.state.dirty)");
    await evaluate(`__obsidianWeb.state.files.get('Prueba.md').handle = {
      queryPermission: () => Promise.resolve('denied'), requestPermission: () => Promise.resolve('denied')
    }`);
    await save();
    await wait("!__obsidianWeb.state.saving");
    await check("Permiso denegado no pierde el borrador", "__obsidianWeb.state.dirty && document.querySelector('#noteEditor').value.includes('durante guardado') && document.querySelector('#editorState').textContent === 'Sin guardar'");
    await evaluate("__obsidianWeb.state.files.get('Prueba.md').handle = testHandle");
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await click("#draftHistory");
    await check("Historial accesible en móvil sin desbordamiento", "document.querySelector('dialog').getBoundingClientRect().right <= innerWidth && document.querySelector('dialog').getBoundingClientRect().left >= 0");
    await click("#closeDrafts");
    await evaluate("__obsidianWeb.syncModeUi()");
    await check("Sin aviso de solo lectura cuando hay escritura", "document.querySelector('#writeNotice').hidden && document.querySelector('#modeBadge').hidden && !document.querySelector('#newNote').disabled");
    // No tocar archivos locales del usuario: solo limpiar el sandbox de esta prueba.
    await evaluate("(async()=>{ __obsidianWeb.state.dirty=false; ObsidianWriting.draftStore(localStorage).clear('writing-test','Prueba.md'); const r=await navigator.storage.getDirectory(); await r.removeEntry('ow-writing-test',{recursive:true}); })()");
    await evaluate("__obsidianWeb.openDemo()");
    await check("Demo mantiene modo de solo lectura", "__obsidianWeb.state.mode === 'demo' && document.querySelector('#newNote').disabled");
    await evaluate("__obsidianWeb.setView({name:'graph'})");
    await check("Grafo sigue disponible después del editor", "Boolean(document.querySelector('#graphCanvas') && __obsidianWeb.state.graph.nodes.length === 4)");
    assert.equal(errors.length, 0, JSON.stringify(errors));
    console.log(`${passes} comprobaciones correctas; sin excepciones.`);
  } finally {
    await send("Page.close").catch(() => {});
    ws.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
