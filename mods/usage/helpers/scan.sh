#!/bin/sh
# Prints one tab-separated row per model response from the last 31 days of
# Claude Code and Codex session logs. Only numbers, ids and names leave here:
# the logs hold whole conversations.
#
#   C ts session model entrypoint sidechain key input output cacheRead cacheWrite5m cacheWrite1h
#   X ts session model originator threadSource key input output cacheRead cacheWrite prompt kind
#   W message
#
# Claude: assistant messages with usage; one response can be logged several times
# (streaming, resumed sessions), so `key` (message id:request id) is for deduping.
# Codex: `token_usage_record` per response (kind R); older logs only have running
# totals in `token_count` events, emitted as deltas (kind T). Codex reports
# input_tokens including cached ones; `input` here is the uncached part.
#
# Follows CLAUDE_CONFIG_DIR and CODEX_HOME. Needs jq; zstd for compressed Codex logs.

command -v jq >/dev/null 2>&1 || { printf 'W\tjq not found\n'; exit 1; }

claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
codex_home="${CODEX_HOME:-$HOME/.codex}"

if [ -d "$claude_dir" ]; then
  find "$claude_dir/" -name '*.jsonl' -mtime -31 -print0 2>/dev/null \
    | xargs -0 grep -h '"type":"assistant"' 2>/dev/null \
    | jq -R -r 'fromjson? | select(.type == "assistant" and (.message.usage | type) == "object")
        | .message.usage as $u
        | ($u.cache_creation.ephemeral_1h_input_tokens // 0) as $w1h
        | ["C", .timestamp, (.sessionId // ""), (.message.model // "unknown"),
           (.entrypoint // ""), (if .isSidechain then 1 else 0 end),
           ((.message.id // .uuid // "") + ":" + (.requestId // "")),
           ($u.input_tokens // 0), ($u.output_tokens // 0), ($u.cache_read_input_tokens // 0),
           ((($u.cache_creation_input_tokens // 0) - $w1h) | if . < 0 then 0 else . end), $w1h]
        | map(tostring | gsub("[\t\n]"; " ")) | join("\t")'
fi

has_zstd=1
command -v zstd >/dev/null 2>&1 || has_zstd=0
warned=0

for root in "$codex_home/sessions" "$codex_home/archived_sessions"; do
  [ -d "$root" ] || continue
  find "$root/" \( -name 'rollout-*.jsonl' -o -name 'rollout-*.jsonl.zst' \) -mtime -31 2>/dev/null |
  while IFS= read -r f; do
    case $f in
      *.zst)
        if [ "$has_zstd" = 0 ]; then
          [ "$warned" = 0 ] && printf 'W\tzstd not found: compressed Codex logs skipped\n'
          warned=1
          continue
        fi
        zstd -dcq -- "$f" 2>/dev/null ;;
      *) cat -- "$f" ;;
    esac | jq -n -R -r '
      def n: . // 0;
      def row($k; $ts; $s; $u; $key):
        ($u.cached_input_tokens | n) as $cached
        | ["X", $ts, ($s.session // ""), ($s.model // "unknown"), ($s.originator // ""), ($s.thread // ""),
           $key, ((($u.input_tokens | n) - $cached) | if . < 0 then 0 else . end),
           ($u.output_tokens | n), $cached, ($u.cache_write_input_tokens | n), ($u.input_tokens | n), $k]
        | map(tostring | gsub("[\t\n]"; " ")) | join("\t");
      foreach (inputs | fromjson? // empty) as $l ({prev: null};
        .out = null
        | if $l.type == "session_meta" then
            .session = ($l.payload.id // $l.payload.session_id) | .originator = $l.payload.originator
            | .thread = $l.payload.thread_source
          elif $l.type == "turn_context" then .model = $l.payload.model
          elif $l.type == "token_usage_record" then
            .out = row("R"; $l.timestamp; .; $l.payload.usage; ($l.payload.response_id // ""))
          elif $l.type == "event_msg" and $l.payload.type == "token_count" and ($l.payload.info.total_token_usage | type) == "object" then
            $l.payload.info.total_token_usage as $t
            | .prev as $p
            | if $p == null or ($t.total_tokens | n) > ($p.total_tokens | n) then
                .out = row("T"; $l.timestamp; .;
                  (if $p == null then $t else ($t | with_entries(.value = ((.value | n) - ($p[.key] | n)))) end); "")
                | .prev = $t
              else . end
          else . end;
        .out // empty)'
  done
done
exit 0
