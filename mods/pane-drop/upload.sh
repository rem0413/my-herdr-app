#!/bin/sh
# upload.sh <machine> <dir> <file>: copies file to <dir>/.drop-files/ on machine, prints remote path.
# Never overwrites: a taken name becomes "name 2.ext", "name 3.ext"... (reserved there with noclobber).
# hc exec -i takes at most 8 MB per call, so send 7 MB chunks and append.
set -e
m=$1 dir=$2 f=$3
size=$(wc -c < "$f" | tr -d ' ')
chunk=7340032
dest=$(hc exec --on "$m" -- sh -c '
  mkdir -p "$1" || exit 1
  stem=$2 ext= i=2
  case $2 in ?*.*) stem=${2%.*} ext=.${2##*.} ;; esac
  t="$1/$2"
  set -C
  until : 2>/dev/null > "$t"; do
    [ "$i" -le 1000 ] || { echo "no free name for $2" >&2; exit 1; }
    t="$1/$stem $i$ext" i=$((i + 1))
  done
  printf %s "$t"' sh "$dir/.drop-files" "$(basename "$f")")
i=0
while [ "$i" -eq 0 ] || [ $((i * chunk)) -lt "$size" ]; do
  dd if="$f" bs=$chunk skip=$i count=1 2>/dev/null |
    hc exec --on "$m" -i --timeout 600 -- sh -c 'cat >> "$0"' "$dest" >/dev/null
  i=$((i + 1))
done
[ "$(hc exec --on "$m" -- sh -c 'wc -c < "$0"' "$dest" | tr -d ' ')" = "$size" ] || { echo "size mismatch" >&2; exit 1; }
echo "$dest"
