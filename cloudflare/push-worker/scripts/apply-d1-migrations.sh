#!/usr/bin/env bash
# D1 schema migrations: retry only transient Cloudflare overload.
# SQL files are designed to be idempotent on this repository.
set -euo pipefail
shopt -s nullglob
migrations_dir="${FDG_D1_MIGRATIONS_DIR:-migrations}"
max_attempts="${FDG_D1_MAX_ATTEMPTS:-6}"
retry_base="${FDG_D1_RETRY_WAIT_SECS:-6}"
pause="${FDG_D1_INTER_MIGRATION_PAUSE_SECS:-3}"
config="${FDG_D1_WRANGLER_CONFIG:-wrangler.generated.jsonc}"
migrations=("$migrations_dir"/*.sql)
if ((${#migrations[@]} == 0)); then
  echo "ERRO: nenhuma migracao D1 em $migrations_dir" >&2
  exit 1
fi
if ! [[ "$max_attempts" =~ ^[1-9][0-9]*$ && "$retry_base" =~ ^[0-9]+$ && "$pause" =~ ^[0-9]+$ ]]; then
  echo "ERRO: configuracao de retry D1 invalida" >&2
  exit 2
fi
for migration in "${migrations[@]}"; do
  attempt=1
  while true; do
    output="$(mktemp)"
    echo "Aplicando $migration (tentativa $attempt/$max_attempts)"
    if npx wrangler d1 execute DB --remote --file="$migration" --config "$config" >"$output" 2>&1; then
      cat "$output"
      rm -f "$output"
      break
    else
      status=$?
    fi
    transient=false
    if grep -Eiq 'D1 DB is overloaded|Requests queued for too long|Too Many Requests|rate limit exceeded|error 429|HTTP 429|Error 1015|database.*temporarily unavailable' "$output"; then
      transient=true
    fi
    cat "$output" >&2
    rm -f "$output"
    if [[ "$transient" != true ]]; then
      echo "ERRO D1 NAO TRANSITORIO: abortar sem retry ($migration, exit=$status)." >&2
      exit "$status"
    fi
    if ((attempt >= max_attempts)); then
      echo "ERRO: sobrecarga D1 persistiu apos $attempt tentativas ($migration)." >&2
      exit "$status"
    fi
    delay=$((retry_base * (2 ** (attempt - 1))))
    if ((delay > 60)); then delay=60; fi
    echo "D1 temporariamente sobrecarregado; nova tentativa apos ${delay}s." >&2
    sleep "$delay"
    attempt=$((attempt+1))
  done
  if ((pause > 0)); then sleep "$pause"; fi
done
echo "D1 schema OK: ${#migrations[@]} arquivos verificados."
