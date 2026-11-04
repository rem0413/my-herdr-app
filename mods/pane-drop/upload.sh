#!/bin/sh
# upload.sh <machine> <dir> <file>: copies file to <dir>/.drop-files/ on machine, prints remote path.
# hc exec -i takes at most 8 MB per call, so send 7 MB chunks and append.
set -e
m=$1 dir=$2 f=$3
dest="$dir/.drop-files/$(basename "$f")"
size=$(wc -c < "$f" | tr -d ' ')
chunk=7340032
hc exec --on "$m" -- mkdir -p "$dir/.drop-files" >/dev/null
i=0 op='>'
while [ "$i" -eq 0 ] || [ $((i * chunk)) -lt "$size" ]; do
  dd if="$f" bs=$chunk skip=$i count=1 2>/dev/null |
    hc exec --on "$m" -i --timeout 600 -- sh -c "cat $op \"\$0\"" "$dest" >/dev/null
  op='>>' i=$((i + 1))
done
[ "$(hc exec --on "$m" -- sh -c 'wc -c < "$0"' "$dest" | tr -d ' ')" = "$size" ] || { echo "size mismatch" >&2; exit 1; }
echo "$dest"
