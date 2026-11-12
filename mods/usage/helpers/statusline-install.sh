#!/bin/sh
# Connects Claude Code's statusLine to the usage mod, chaining whatever was there.
#
# Usage: statusline-install.sh status|install|uninstall
#   status    prints "installed" or "missing"
#   install   saves the current statusLine command to statusline-prev.sh, backs up
#             settings.json, and points statusLine at helpers/statusline.sh
#   uninstall puts the saved command back (or removes statusLine if there was none)
#
# Only the statusLine key of settings.json changes. Follows CLAUDE_CONFIG_DIR.

set -u
here=$(cd "$(dirname "$0")" && pwd)
dir="${here%/mods/usage/helpers}/data/usage"
settings="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
ours="sh '$here/statusline.sh'"
prev="$dir/statusline-prev.sh"

command -v jq >/dev/null 2>&1 || { echo "jq not found" >&2; exit 2; }

current() {
  [ -f "$settings" ] || return 0
  jq -r '.statusLine.command // empty' "$settings"
}

# Writes through symlinks: settings.json may be linked from a dotfiles repo.
write_settings() {
  tmp="$dir/.settings.$$"
  if [ -f "$settings" ]; then jq "$@" "$settings" >"$tmp"; else printf '{}' | jq "$@" >"$tmp"; fi \
    || { rm -f "$tmp"; exit 1; }
  cat "$tmp" >"$settings"
  rm -f "$tmp"
}

case $here in *"'"*) echo "unsupported path: $here" >&2; exit 2 ;; esac
mkdir -p "$dir" "$(dirname "$settings")" || exit 1
cmd=$(current) || { echo "settings.json is not valid JSON" >&2; exit 1; }

case "${1:-status}" in
  status)
    if [ "$cmd" = "$ours" ]; then echo installed; else echo missing; fi
    ;;
  install)
    [ "$cmd" = "$ours" ] && { echo installed; exit 0; }
    [ -f "$settings" ] && cp "$settings" "$dir/settings.json.bak-$(date +%Y%m%d%H%M%S)"
    if [ -n "$cmd" ]; then printf '%s\n' "$cmd" >"$prev"; else rm -f "$prev"; fi
    write_settings --arg c "$ours" '.statusLine = ((.statusLine // {}) + {type: "command", command: $c})'
    echo installed
    ;;
  uninstall)
    [ "$cmd" = "$ours" ] || { echo missing; exit 0; }
    if [ -s "$prev" ]; then
      write_settings --arg c "$(cat "$prev")" '.statusLine.command = $c'
    else
      write_settings 'del(.statusLine)'
    fi
    rm -f "$prev"
    echo missing
    ;;
  *)
    echo "usage: $0 status|install|uninstall" >&2
    exit 2
    ;;
esac
