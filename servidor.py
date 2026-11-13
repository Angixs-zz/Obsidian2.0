#!/usr/bin/env python3
"""Servidor local mínimo y endurecido para Obsidian Web.

Sirve únicamente los archivos de la aplicación desde 127.0.0.1.
No expone la bóveda, no escribe en disco y no lista directorios.
"""
from __future__ import annotations

import argparse
import json
import os
import posixpath
import sys
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

BASE = Path(__file__).resolve().parent
APP_NAME = "obsidian-web"
APP_VERSION = "2.1.0"
MAX_PORT = 65535

# Solo estos archivos de la raíz y estas carpetas son públicos.
ROOT_FILES = {
    "index.html",
    "app.js",
    "core.js",
    "theme.js",
    "styles.css",
    "favicon.svg",
    "manifest.webmanifest",
    "sw.js",
    "LEEME.md",
    "CHANGELOG.md",
    "LICENSE",
}
PUBLIC_DIRS = ("demo", "vendor", "icons")

CSP = (
    "default-src 'self'; "
    "img-src 'self' blob: data:; "
    "media-src 'self' blob: data:; "
    "style-src 'self' 'unsafe-inline'; "
    "script-src 'self'; "
    "worker-src 'self'; "
    "connect-src 'self'; "
    "object-src 'none'; "
    "frame-src 'self' blob:; "
    "base-uri 'none'; "
    "form-action 'none'; "
    "manifest-src 'self'; "
    "frame-ancestors 'none'"
)

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".pdf": "application/pdf",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".woff2": "font/woff2",
}


class Handler(SimpleHTTPRequestHandler):
    server_version = "ObsidianWeb"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    verbose = False

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE), **kwargs)

    def version_string(self) -> str:
        return "ObsidianWeb"

    def end_headers(self) -> None:
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, *args) -> None:
        if self.verbose:
            super().log_message(*args)

    def do_POST(self) -> None:  # noqa: N802
        self.send_error(HTTPStatus.METHOD_NOT_ALLOWED, "Solo se permiten GET y HEAD")

    def do_PUT(self) -> None:  # noqa: N802
        self.send_error(HTTPStatus.METHOD_NOT_ALLOWED, "Solo se permiten GET y HEAD")

    def do_DELETE(self) -> None:  # noqa: N802
        self.send_error(HTTPStatus.METHOD_NOT_ALLOWED, "Solo se permiten GET y HEAD")

    def do_HEAD(self) -> None:  # noqa: N802
        self._handle(head=True)

    def do_GET(self) -> None:  # noqa: N802
        self._handle(head=False)

    def _handle(self, head: bool) -> None:
        path = urlsplit(self.path).path
        if path == "/health":
            payload = json.dumps(
                {"app": APP_NAME, "version": APP_VERSION, "status": "ok"},
                ensure_ascii=False,
            ).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            if not head:
                self.wfile.write(payload)
            return

        target = self._resolve(path)
        if target is None:
            self.send_error(HTTPStatus.NOT_FOUND, "Archivo no disponible")
            return
        try:
            data = target.read_bytes()
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "Archivo no disponible")
            return
        content_type = MIME_TYPES.get(target.suffix.lower(), "application/octet-stream")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if not head:
            self.wfile.write(data)

    @staticmethod
    def _resolve(request_path: str) -> Path | None:
        try:
            decoded = unquote(request_path, errors="strict")
        except (UnicodeDecodeError, ValueError):
            return None
        if "\x00" in decoded or "\\" in decoded:
            return None
        if decoded in ("", "/"):
            decoded = "/index.html"
        if decoded.endswith("/"):
            # Sin listados de directorio: /demo/ y /vendor/ no muestran contenido.
            return None
        normalized = posixpath.normpath(decoded)
        if normalized.startswith("../") or normalized == ".." or normalized.startswith("/.."):
            return None
        relative = normalized.lstrip("/")
        if not relative:
            return None
        parts = relative.split("/")
        if any(part.startswith(".") for part in parts):
            return None
        first = parts[0]
        if len(parts) == 1:
            if first not in ROOT_FILES:
                return None
        elif first not in PUBLIC_DIRS:
            return None
        candidate = (BASE / relative).resolve()
        try:
            candidate.relative_to(BASE)
        except ValueError:
            return None
        if not candidate.is_file() or candidate.suffix.lower() not in MIME_TYPES:
            return None
        return candidate


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def parse_port(value: str) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError) as error:
        raise argparse.ArgumentTypeError(f"«{value}» no es un puerto válido.") from error
    if port < 1 or port > MAX_PORT:
        raise argparse.ArgumentTypeError(f"El puerto debe estar entre 1 y {MAX_PORT}.")
    return port


def main() -> int:
    try:
        default_port = parse_port(os.environ.get("PORT", "8765"))
    except argparse.ArgumentTypeError as error:
        print(error, file=sys.stderr)
        return 2
    parser = argparse.ArgumentParser(description="Servidor local de Obsidian Web")
    parser.add_argument("--port", type=parse_port, default=default_port,
                        help="Puerto local (por defecto 8765 o la variable PORT).")
    parser.add_argument("--verbose", action="store_true", help="Muestra cada petición.")
    args = parser.parse_args()
    Handler.verbose = args.verbose

    try:
        server = Server(("127.0.0.1", args.port), Handler)
    except OSError as error:
        if getattr(error, "errno", None) in (98, 48, 10048):
            print(f"El puerto {args.port} ya está ocupado. Prueba con --port 9000 o PORT=9000.", file=sys.stderr)
        else:
            print(f"No se pudo iniciar el servidor: {error}", file=sys.stderr)
        return 1

    print(f"Obsidian Web {APP_VERSION}: http://127.0.0.1:{args.port}/")
    print(f"Salud: http://127.0.0.1:{args.port}/health")
    print("Ctrl+C para detener el servidor.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
