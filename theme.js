/* Aplica el tema antes de pintar para evitar el destello oscuro (FOUC). */
(function () {
  try {
    var data = JSON.parse(localStorage.getItem("obsidian-web-local-v1")) || {};
    var theme = data.theme;
    if (theme !== "light" && theme !== "dark") {
      theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch (error) {
    /* Sin localStorage se usa el tema oscuro del HTML. */
  }
})();
