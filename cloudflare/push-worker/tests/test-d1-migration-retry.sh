#!/usr/bin/env bash
set -euo pipefail
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/bin" "$root/migrations"
printf 'SELECT 1;\n' >"$root/migrations/0001.sql"
printf 'SELECT 2;\n' >"$root/migrations/0002.sql"
cat > "$root/bin/npx" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
counter="${FDG_TEST_COUNTER:?}"
count=$(cat "$counter" 2>/dev/null || echo 0)
count=$((count+1))
echo "$count" >"$counter"
if [[ "${FDG_TEST_MODE:-}" == "temporary" && $count -eq 1 ]]; then
  echo "D1 DB is overloaded. Requests queued for too long." >&2
  exit 1
fi
if [[ "${FDG_TEST_MODE:-}" == "persistent" ]]; then
  echo "D1 DB is overloaded. Requests queued for too long." >&2
  exit 1
fi
if [[ "${FDG_TEST_MODE:-}" == "fatal" ]]; then
  echo "SQLITE_ERROR: no such table" >&2
  exit 1
fi
echo "mock D1 success"
MOCK
chmod +x "$root/bin/npx"
export PATH="$root/bin:$PATH"
export FDG_D1_MIGRATIONS_DIR="$root/migrations"
export FDG_D1_RETRY_WAIT_SECS=0
export FDG_D1_INTER_MIGRATION_PAUSE_SECS=0
export FDG_D1_WRANGLER_CONFIG=mock-config
export FDG_D1_MAX_ATTEMPTS=3
export FDG_TEST_COUNTER="$root/counter"
script="scripts/apply-d1-migrations.sh"

FDG_TEST_MODE=temporary bash "$script" >"$root/output" 2>&1
grep -q 'D1 schema OK: 2 arquivos verificados' "$root/output"
test "$(cat "$root/counter")" -eq 3

rm -f "$root/counter"
if FDG_TEST_MODE=fatal bash "$script" >"$root/output" 2>&1; then
  echo 'FAIL: SQL syntax error was ignored' >&2
  exit 1
fi
grep -q 'ERRO D1 NAO TRANSITORIO' "$root/output"
test "$(cat "$root/counter")" -eq 1

rm -f "$root/counter"
if FDG_TEST_MODE=persistent bash "$script" >"$root/output" 2>&1; then
  echo 'FAIL: persistent overload must fail safely' >&2
  exit 1
fi
grep -q 'sobrecarga D1 persistiu apos 3 tentativas' "$root/output"
test "$(cat "$root/counter")" -eq 3

echo 'D1 deploy backoff tests: PASS (transient recovered, SQL error stopped, overload bounded)'
