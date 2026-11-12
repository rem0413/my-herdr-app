#!/bin/sh
# Prints Codex's `account/rateLimits/read` reply (one JSON-RPC line) and exits.
#
# Starts a short-lived `codex app-server` over stdio; Codex authenticates itself,
# so this script reads no token. Approval policy "never" keeps the probe inert.
#
# Exit: 0 = printed the reply, 127 = codex not found, 1 = no reply in 15 s.
# Override the binary with HERDR_USAGE_CODEX_BIN.

CODEX=$(command -v "${HERDR_USAGE_CODEX_BIN:-codex}" 2>/dev/null) || exit 127

dir=$(mktemp -d "${TMPDIR:-/tmp}/herdr-usage-codex.XXXXXX") || exit 1
trap 'rm -rf "$dir"' EXIT
mkfifo "$dir/in" || exit 1

(cd "$dir" && exec "$CODEX" app-server -c approval_policy=never) <"$dir/in" >"$dir/out" 2>/dev/null &
pid=$!
exec 3>"$dir/in"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"herdr-usage","version":"1.0"}}}' \
  '{"jsonrpc":"2.0","method":"initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read","params":{}}' >&3

i=0
while [ "$i" -lt 75 ]; do
  grep -q '"id":2[,}]' "$dir/out" 2>/dev/null && break
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.2
  i=$((i + 1))
done
exec 3>&-
kill "$pid" 2>/dev/null
wait "$pid" 2>/dev/null

grep -m1 '"id":2[,}]' "$dir/out" || exit 1
