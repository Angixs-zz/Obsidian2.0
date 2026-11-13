#!/usr/bin/env bash
# Lanzador para macOS: doble clic abre Obsidian Web.
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/Abrir Obsidian Web.sh" "$@"
