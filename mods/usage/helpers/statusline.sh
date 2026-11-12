#!/bin/sh
# Claude Code statusLine command installed by the usage mod.
#
# Claude Code pipes the session JSON to stdin on every status update. For
# Pro/Max/Ultra subscribers it carries `rate_limits`, and for every session its
# `context_window` (both documented in Claude Code's statusline docs). This
# keeps, at most every 10 s, the newest payload with limits and the newest
# payload of each session, then hands stdin to the statusLine that was
# installed before (saved in statusline-prev.sh) and passes its output through.
#
# The payload holds session metadata, limits and token counts, never
# conversation text.

here=$(cd "$(dirname "$0")" && pwd)
dir="${here%/mods/usage/helpers}/data/usage"
input=$(cat)
now=$(date +%s)

# keep <file>: writes {"at":now,"payload":input} unless written in the last 10 s.
keep() {
  last=$(cat "$1.stamp" 2>/dev/null)
  case $last in '' | *[!0-9]*) last=0 ;; esac
  [ $((now - last)) -ge 10 ] || return 0
  mkdir -p "$(dirname "$1")" || return 0
  tmp="$1.$$.tmp"
  if printf '{"at":%s,"payload":%s}\n' "$now" "$input" >"$tmp" 2>/dev/null && mv -f "$tmp" "$1"; then
    printf '%s\n' "$now" >"$1.stamp"
  else
    rm -f "$tmp"
  fi
}

case $input in *'"rate_limits"'*) keep "$dir/claude-statusline.json" ;; esac

sid=$(printf '%s' "$input" | tr -d '\n' | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([0-9A-Za-z-]*\)".*/\1/p')
[ -n "$sid" ] && keep "$dir/sessions/$sid.json"

if [ -s "$dir/statusline-prev.sh" ]; then
  printf '%s' "$input" | sh "$dir/statusline-prev.sh"
fi
exit 0
