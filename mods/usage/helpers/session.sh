#!/bin/sh
# Prints one line of numbers about an agent's session, or the Claude plan name.
#
#   session.sh claude <transcript.jsonl>  ->  calls=N compactions=N
#   session.sh codex <pid>                ->  tokens=N window=N calls=N model=M
#   session.sh plan                       ->  Claude's seat tier or billing type
#
# Session files hold whole conversations; only numbers and names leave here.
# `plan` reads two fields of ~/.claude.json (never a token).
# Exit: 0 = printed, 1 = nothing found (never a guess).

claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

case "$1" in
  claude)
    f=$2
    case $f in "$claude_dir"/projects/*.jsonl) ;; *) exit 1 ;; esac
    [ -f "$f" ] || exit 1
    # Prompts are user lines that aren't tool results, meta lines or subagent turns.
    grep -h -e '"type":"user"' -e '"subtype":"compact_boundary"' "$f" 2>/dev/null | jq -R -s -r '
      [split("\n")[] | fromjson? // empty] as $l
      | ($l | map(select(.type == "user" and (.isSidechain | not) and (.isMeta | not) and (.isCompactSummary | not)
          and ((.message.content | type) == "string" or ((.message.content | type) == "array"
            and (.message.content | all(.type != "tool_result")))))) | length) as $calls
      | ($l | map(select(.subtype == "compact_boundary")) | length) as $compactions
      | "calls=\($calls) compactions=\($compactions)"'
    ;;
  codex)
    pid=$2
    case $pid in '' | *[!0-9]*) exit 1 ;; esac
    # The terminal's codex holds its rollout open, itself or through a child app-server.
    file=
    for p in "$pid" $(pgrep -P "$pid" 2>/dev/null); do
      for f in $(lsof -nP -Fn -p "$p" 2>/dev/null | sed -n 's/^n//p' | grep '/sessions/.*/rollout-.*\.jsonl$'); do
        if [ -z "$file" ] || [ "$f" -nt "$file" ]; then file=$f; fi
      done
    done
    [ -n "$file" ] || exit 1
    jq -R -s -r '
      [split("\n")[] | fromjson? // empty] as $l
      | ($l | map(select(.type == "event_msg" and .payload.type == "token_count" and .payload.info != null)) | last) as $t
      | ($l | map(select(.type == "turn_context")) | last | .payload.model // "") as $model
      | ($l | map(select(.type == "event_msg" and (.payload.type == "task_started" or .payload.type == "turn_started"))) | length) as $calls
      | if $t == null then empty else
          "tokens=\($t.payload.info.last_token_usage.total_tokens // 0) window=\($t.payload.info.model_context_window // 0) calls=\($calls) model=\($model)"
        end' "$file" | grep . || exit 1
    ;;
  plan)
    f="$HOME/.claude.json"
    [ -n "${CLAUDE_CONFIG_DIR:-}" ] && f="$CLAUDE_CONFIG_DIR/.claude.json"
    [ -f "$f" ] || exit 1
    jq -r '.oauthAccount | (.seatTier // .subscriptionType // empty)' "$f" 2>/dev/null | grep . || exit 1
    ;;
  *)
    exit 1
    ;;
esac
