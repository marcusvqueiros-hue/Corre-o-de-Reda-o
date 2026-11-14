#!/usr/bin/env bash
# Testa migrations + RLS num Postgres TEMPORÁRIO (não toca em nenhum projeto Supabase).
# Uso: npm run test:rls            (inicia um cluster local descartável)
#      DATABASE_URL=... npm run test:rls   (usa um Postgres vazio já existente, ex.: serviço do CI)
set -euo pipefail
cd "$(dirname "$0")/.."

run_sql() { psql -v ON_ERROR_STOP=1 -q "$@"; }

apply_all() {
  local url="$1"
  run_sql "$url" -f supabase/tests/00_auth_shim.sql
  for f in supabase/migrations/*.sql; do echo "-> $f"; run_sql "$url" -f "$f"; done
  run_sql "$url" -f supabase/tests/10_rls.sql 2>&1
}

if [[ -n "${DATABASE_URL:-}" ]]; then
  apply_all "$DATABASE_URL"; exit 0
fi

PGBIN="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)"
PORT="${PGPORT_TEST:-54329}"
DIR="$(mktemp -d)"; chmod 755 "$DIR"
if [[ "$(id -u)" == "0" ]]; then RUN=(su postgres -c); chown postgres "$DIR"; else RUN=(bash -c); fi
cleanup() { "${RUN[@]}" "$PGBIN/pg_ctl -D $DIR/data -m immediate stop >/dev/null 2>&1 || true"; rm -rf "$DIR"; }
trap cleanup EXIT

"${RUN[@]}" "$PGBIN/initdb -D $DIR/data -A trust -U postgres >/dev/null"
if ! "${RUN[@]}" "$PGBIN/pg_ctl -D $DIR/data -o \"-c listen_addresses=127.0.0.1 -c port=$PORT -c unix_socket_directories=''\" -w -l $DIR/log start >/dev/null"; then
  echo "Falha ao iniciar o Postgres temporário:" >&2; cat "$DIR/log" >&2; exit 1
fi
apply_all "host=127.0.0.1 port=$PORT user=postgres dbname=postgres"
