#!/bin/sh
# transfer.sh up    <machine> <localsrc>  <remotedir>          <statusfile>
# transfer.sh down  <machine> <remotesrc> <localdir>           <statusfile>
# transfer.sh cross <srcmachine> <src>    <destmachine>:<dir>  <statusfile>
# Copies a file or folder via `hc exec`: tar on the sending side, 7 MiB chunks (hc exec caps
# stdin/stdout at ~8 MB per call), extract next to the destination, then mv into place.
# up/cross never overwrite; down picks "name 2.ext", "name 3.ext"... cross goes through a local temp.
# Status file (rewritten atomically): state=running|done|failed|cancelled, bytes, total, dest, msg.
mode=$1 m=$2 src=$3 destdir=$4 status=$5
chunk=7340032
state=running bytes=0 total=0 dest= msg=
L= x= stmp= dtar= ddir= dm=$m
base=0 div=1 # progress: bytes = (base + moved) / div

put() {
  printf 'state=%s\nbytes=%s\ntotal=%s\ndest=%s\nmsg=%s\n' "$state" "$bytes" "$total" "$dest" "$msg" > "$status.tmp" &&
    mv -f "$status.tmp" "$status"
}

# remote rm via hc exec takes seconds; once cancelled, `hc kill` sends KILL ~1s after the hangup,
# so hand the remote part to a detached terminal that outlives this one.
cleanup() {
  [ -n "$L" ] && rm -rf "$L"
  [ -n "$x" ] && rm -rf "$x"
  bg=
  [ "$state" = cancelled ] && bg="hc run --bg --no-parent --rm --"
  [ -n "$stmp" ] && $bg hc exec --on "$m" -- rm -f "$stmp" >/dev/null 2>&1
  [ -n "$dtar$ddir" ] && $bg hc exec --on "$dm" -- rm -rf ${dtar:+"$dtar"} ${ddir:+"$ddir"} >/dev/null 2>&1
  L= x= stmp= dtar= ddir=
}

fail() {
  msg=$(printf '%s' "$1" | tr '\n' ' ')
  state=failed
  exit 1
}

# fail with the last line of the captured stderr (hc's JSON error reduced to its message), or a fallback
err() {
  e=$(tail -n 1 "$L/err" 2>/dev/null | sed 's/^{"error".*"message":"\([^"]*\)".*/\1/')
  fail "${e:-$1}"
}

progress() {
  bytes=$(($1 * chunk)); [ "$bytes" -gt "$total" ] && bytes=$total
  bytes=$(((base + bytes) / div))
  put
}

# status first, then cleanup; ignore further signals while cleaning up
trap 'trap "" HUP INT TERM; [ "$state" = running ] && state=failed msg=interrupted; put; cleanup' EXIT
trap 'state=cancelled; exit 130' HUP INT TERM

[ $# -eq 5 ] || { echo "usage: transfer.sh <up|down|cross> <machine> <src> <destdir> <statusfile>" >&2; trap - EXIT; exit 2; }
put
L=$(mktemp -d "${TMPDIR:-/tmp}/herdr-xfer.XXXXXX") || fail "cannot create temp dir"

src=${src%/}
[ -n "$src" ] || src=/
name=$(basename "$src")
parent=$(dirname "$src")

# free local name: "name", "name 2.ext", "name 3.ext"... (folders and dotfiles: no ext split)
pick() {
  stem=$name ext=
  case $name in ?*.*) [ "$isdir" = 1 ] || { stem=${name%.*} ext=.${name##*.}; } ;; esac
  dest="$destdir/$name" n=2
  while [ -e "$dest" ] || [ -L "$dest" ]; do dest="$destdir/$stem $n$ext" n=$((n + 1)); done
}

# on $dm: fail if $destdir/$name exists, else reserve the upload temp
reserve_remote() {
  dest="$destdir/$name"
  put
  id=".herdr-xfer-$$-$(date +%s)"
  dtar="$destdir/$id.tar" ddir="$destdir/$id"
  hc exec --on "$dm" -- sh -c '
    [ -d "$1" ] || { echo "$1 not found" >&2; exit 1; }
    if [ -e "$1/$2" ] || [ -L "$1/$2" ]; then echo "$2 already exists" >&2; exit 1; fi
    : > "$3"' sh "$destdir" "$name" "$dtar" >/dev/null 2>"$L/err" || { dtar= ddir=; err "remote check failed"; }
}

# local $L/t.tar to $dm, extract, mv into place
send_remote() {
  i=0
  while [ $((i * chunk)) -lt "$total" ]; do
    dd if="$L/t.tar" bs=$chunk skip=$i count=1 2>/dev/null |
      hc exec --on "$dm" -i --timeout 600 -- sh -c 'cat >> "$0"' "$dtar" >/dev/null 2>"$L/err" || err "chunk $i failed"
    i=$((i + 1))
    progress $i
  done
  hc exec --on "$dm" --timeout 600 -- sh -c '
    [ "$(wc -c < "$0" | tr -d " ")" = "$4" ] || { echo "size mismatch" >&2; exit 1; }
    mkdir "$1" && tar -xf "$0" -C "$1" || exit 1
    if [ -e "$2/$3" ] || [ -L "$2/$3" ]; then echo "$3 already exists" >&2; exit 1; fi
    mv "$1/$3" "$2/$3" && rm -rf "$0" "$1"' "$dtar" "$ddir" "$destdir" "$name" "$total" >/dev/null 2>"$L/err" || err "remote extract failed"
  dtar= ddir=
}

# tar $src on $m into a remote temp, then pull it into local $L/t.tar
fetch_remote() {
  out=$(hc exec --on "$m" --timeout 600 -- sh -c '
    [ -e "$1/$2" ] || [ -L "$1/$2" ] || { echo "$1/$2 not found" >&2; exit 1; }
    t=$(mktemp "${TMPDIR:-/tmp}/herdr-xfer.XXXXXX") || exit 1
    echo "$t"
    tar -cf "$t" -C "$1" ./"$2" || { rm -f "$t"; exit 1; }
    wc -c < "$t" | tr -d " "
    [ -d "$1/$2" ] && echo 1 || echo 0' sh "$parent" "$name" 2>"$L/err")
  rc=$?
  stmp=$(printf '%s\n' "$out" | sed -n 1p)
  [ $rc -eq 0 ] || err "remote tar failed"
  total=$(printf '%s\n' "$out" | sed -n 2p)
  isdir=$(printf '%s\n' "$out" | sed -n 3p)
  [ "$mode" = down ] && pick
  put
  : > "$L/t.tar"
  i=0
  while [ $((i * chunk)) -lt "$total" ]; do
    hc exec --on "$m" --timeout 600 -- dd if="$stmp" bs=$chunk skip=$i count=1 2>"$L/err" >> "$L/t.tar" || err "chunk $i failed"
    i=$((i + 1))
    progress $i
  done
  [ "$(wc -c < "$L/t.tar" | tr -d ' ')" = "$total" ] || fail "size mismatch"
  hc exec --on "$m" -- rm -f "$stmp" >/dev/null 2>&1
  stmp=
}

case $mode in
up)
  [ -e "$src" ] || [ -L "$src" ] || fail "$src not found"
  reserve_remote
  tar -cf "$L/t.tar" -C "$parent" ./"$name" 2>"$L/err" || err "tar failed"
  total=$(wc -c < "$L/t.tar" | tr -d ' ')
  put
  send_remote
  ;;
down)
  [ -d "$destdir" ] || fail "$destdir not found"
  fetch_remote
  x=$(mktemp -d "$destdir/.herdr-xfer.XXXXXX") || fail "cannot create temp dir in $destdir"
  tar -xf "$L/t.tar" -C "$x" 2>"$L/err" || err "tar extract failed"
  pick
  mv "$x/$name" "$dest" || fail "cannot move into $dest"
  ;;
cross)
  case $destdir in ?*:?*) ;; *) fail "destination must be <machine>:<dir>" ;; esac
  dm=${destdir%%:*} destdir=${destdir#*:}
  reserve_remote
  div=2
  fetch_remote
  base=$total
  send_remote
  ;;
*) fail "unknown mode $mode" ;;
esac

state=done msg=
exit 0
