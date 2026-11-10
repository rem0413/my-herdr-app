#!/bin/sh
# Update mods listed in mod-sources.json from their upstream repos.
# Usage: ./update-mods.sh [-n] [mod...]   (-n: only report, change nothing; no mod: all)
# ponytail: overwrites local edits to the mod folder; git diff/checkout here is the undo.
set -eu
cd "$(dirname "$0")"
DRY=0; [ "${1:-}" = "-n" ] && { DRY=1; shift; }
SRC=mod-sources.json
[ $# -gt 0 ] || set -- $(jq -r 'keys[]' "$SRC")
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

for m in "$@"; do
  e=$(jq -ec --arg m "$m" '.[$m]' "$SRC") || { echo "$m: not in $SRC"; continue; }
  repo=$(echo "$e" | jq -r .repo); path=$(echo "$e" | jq -r .path)
  ref=$(echo "$e" | jq -r '.ref // "main"'); old=$(echo "$e" | jq -r '.commit // ""')
  new=$(git ls-remote "$repo" "$ref" | cut -f1)
  [ -n "$new" ] || { echo "$m: ref $ref not found in $repo"; continue; }
  [ "$new" = "$old" ] && { echo "$m: up to date (${old%"${old#???????}"})"; continue; }
  echo "$m: ${old:-none} -> $new"
  [ $DRY = 1 ] && continue

  d="$TMP/$m"
  git clone -q --depth 1 --filter=blob:none --sparse -b "$ref" "$repo" "$d"
  git -C "$d" sparse-checkout set "$path"
  [ -f "$d/$path/main.js" ] || { echo "$m: $path/main.js missing upstream, skipped"; continue; }
  mkdir -p "mods/$m"
  # mod.json first so Herdr never docks a stray copy
  cp "$d/$path/mod.json" "mods/$m/" 2>/dev/null || true
  rsync -a --delete --exclude jsconfig.json --exclude '*.d.ts' "$d/$path/" "mods/$m/"
  herdr-app check "mods/$m"
  jq --arg m "$m" --arg c "$new" '.[$m].commit = $c' "$SRC" > "$SRC.tmp" && mv "$SRC.tmp" "$SRC"
done
