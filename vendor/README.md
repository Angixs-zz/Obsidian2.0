# Dependencias incluidas

Estos archivos se sirven localmente; la aplicación no carga nada desde internet.

| Archivo | Proyecto | Versión | Licencia | SRI (sha384) |
| --- | --- | --- | --- | --- |
| `marked.min.js` | [marked](https://github.com/markedjs/marked) | 12.0.2 | MIT | `sha384-/TQbtLCAerC3jgaim+N78RZSDYV7ryeoBCVqTuzRrFec2akfBkHS7ACQ3PQhvMVi` |
| `purify.min.js` | [DOMPurify](https://github.com/cure53/DOMPurify) | 3.1.6 | Apache-2.0 o MPL-2.0 | `sha384-+VfUPEb0PdtChMwmBcBmykRMDd+v6D/oFmB3rZM/puCMDYcIvF968OimRh4KQY9a` |

Las etiquetas `<script>` de `index.html` incluyen esos hashes con `integrity` y
`crossorigin`. Si actualizas un archivo, recalcula el hash:

```bash
openssl dgst -sha384 -binary vendor/marked.min.js | openssl base64 -A
```

## Texto de atribución

- **marked** — Copyright (c) 2011-2024, Christopher Jeffrey. Licencia MIT.
- **DOMPurify** — Copyright (c) Cure53 and other contributors. Licencias
  Apache-2.0 o MPL-2.0.

Las licencias completas están en los repositorios oficiales y en las cabeceras de
cada archivo cuando el build las incluye.
