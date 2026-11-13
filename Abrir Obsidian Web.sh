#!/usr/bin/env bash
# Arranca el servidor local y abre Obsidian Web en el navegador.
# Solo escucha en 127.0.0.1. Usa --stop para detenerlo y --status para comprobarlo.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-8765}"
URL="http://127.0.0.1:${PORT}"
PIDFILE="$DIR/.obsidian-web.pid"
LOG="$DIR/.obsidian-web.log"
OPEN_BROWSER=1

usage() {
  cat <<'EOF'
Uso: ./Abrir Obsidian Web.sh [opciones]

  --port N        Usa otro puerto (también PORT=N).
  --no-open       No abre el navegador.
  --stop          Detiene el servidor iniciado por este lanzador.
  --status        Comprueba si el servidor está vivo.
  -h, --help      Muestra esta ayuda.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      if [ $# -lt 2 ] || [ -z "$2" ]; then
        echo "Falta el número de puerto después de --port." >&2
        exit 2
      fi
      PORT="$2"
      shift 2
      ;;
    --no-open) OPEN_BROWSER=0; shift ;;
    --stop) ACTION="stop"; shift ;;
    --status) ACTION="status"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Opción desconocida: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$PORT" in
  ''|*[!0-9]*) echo "Puerto inválido: «$PORT»." >&2; exit 2 ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "El puerto debe estar entre 1 y 65535." >&2
  exit 2
fi
URL="http://127.0.0.1:${PORT}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Se necesita python3 para servir la aplicación." >&2
  exit 1
fi

health_ok() {
  if command -v curl >/dev/null 2>&1; then
    local body
    body="$(curl -fsS --max-time 2 "${URL}/health" 2>/dev/null || true)"
    case "$body" in
      *'"app": "obsidian-web"'*|*'"app":"obsidian-web"'*) return 0 ;;
      *) return 1 ;;
    esac
  fi
  # Sin curl, python3 ya es un requisito del servidor.
  python3 - "${URL}/health" >/dev/null 2>&1 <<'PY'
import json
import sys
import urllib.request

try:
    with urllib.request.urlopen(sys.argv[1], timeout=2) as response:
        data = json.load(response)
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if data.get("app") == "obsidian-web" else 1)
PY
}

pid_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

pid_is_ours() {
  local pid="$1"
  pid_alive "$pid" || return 1
  if [ -r "/proc/${pid}/cmdline" ]; then
    tr '\0' ' ' < "/proc/${pid}/cmdline" | grep -q "servidor.py" || return 1
    [ "$(readlink "/proc/${pid}/cwd" 2>/dev/null || true)" = "$DIR" ] || return 1
  else
    ps -p "$pid" -o command= 2>/dev/null | grep -q "servidor.py" || return 1
  fi
  return 0
}

read_pid() {
  if [ -f "$PIDFILE" ]; then
    tr -dc '0-9' < "$PIDFILE" 2>/dev/null || true
  fi
}

stop_server() {
  local pid
  pid="$(read_pid)"
  if [ -z "$pid" ]; then
    echo "No hay un PID guardado. Obsidian Web no fue iniciado por este lanzador."
    exit 1
  fi
  if ! pid_is_ours "$pid"; then
    echo "El PID $pid no corresponde a este servidor. No se detuvo nada."
    rm -f "$PIDFILE"
    exit 1
  fi
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pid_alive "$pid" || break
    sleep 0.2
  done
  if pid_alive "$pid"; then
    echo "El servidor no respondió; se envía TERM de nuevo." >&2
    kill -TERM "$pid" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
  echo "Obsidian Web detenido (PID $pid)."
}

if [ "${ACTION:-}" = "stop" ]; then
  stop_server
  exit 0
fi

if [ "${ACTION:-}" = "status" ]; then
  pid="$(read_pid)"
  if health_ok && pid_is_ours "$pid"; then
    echo "Obsidian Web está activo en ${URL} (PID ${pid})."
    exit 0
  fi
  echo "Obsidian Web no está activo en ${URL}."
  exit 1
fi

# Si el PID guardado sigue vivo y responde, se reutiliza.
PID="$(read_pid)"
if pid_is_ours "$PID" && health_ok; then
  echo "Obsidian Web ya está activo en ${URL} (PID ${PID})."
else
  if health_ok; then
    echo "El puerto ${PORT} responde pero no es esta instalación de Obsidian Web." >&2
    echo "Usa otro puerto: PORT=9000 ./Abrir Obsidian Web.sh" >&2
    exit 1
  fi
  rm -f "$PIDFILE"

  # El log vive junto a la app; si la unidad es de solo lectura, se usa /tmp.
  if ! ( : > "$LOG" ) 2>/dev/null; then
    LOG="${TMPDIR:-/tmp}/obsidian-web-${PORT}.log"
  fi

  echo "Iniciando Obsidian Web en ${URL}…"
  nohup python3 "$DIR/servidor.py" --port "$PORT" >> "$LOG" 2>&1 &
  NEW_PID=$!
  echo "$NEW_PID" > "$PIDFILE"

  ready=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if health_ok; then ready=1; break; fi
    if ! pid_alive "$NEW_PID"; then break; fi
    sleep 0.25
  done
  if [ "$ready" -ne 1 ]; then
    echo "El servidor no arrancó. Revisa el registro: $LOG" >&2
    if pid_alive "$NEW_PID"; then kill "$NEW_PID" 2>/dev/null || true; fi
    rm -f "$PIDFILE"
    exit 1
  fi
  echo "Servidor iniciado (PID ${NEW_PID}). Registro: ${LOG}"
  PID="$NEW_PID"
fi

echo "Obsidian Web: ${URL}/"
echo "Para detenerlo: ./Abrir Obsidian Web.sh --stop"

if [ "$OPEN_BROWSER" -eq 1 ]; then
  case "$(uname -s 2>/dev/null || echo Linux)" in
    Darwin) open "$URL/" >/dev/null 2>&1 || true ;;
    MINGW*|MSYS*|CYGWIN*) cmd.exe /c start "" "$URL/" >/dev/null 2>&1 || true ;;
    *) if command -v xdg-open >/dev/null 2>&1; then
         xdg-open "$URL/" >/dev/null 2>&1 || true
       elif command -v gio >/dev/null 2>&1; then
         gio open "$URL/" >/dev/null 2>&1 || true
       else
         echo "Abre ${URL}/ en tu navegador." >&2
       fi ;;
  esac
fi
