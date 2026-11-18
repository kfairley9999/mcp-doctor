#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
DOC=(node packages/cli/dist/main.js)
NODE="$(command -v node)"

printf '\n$ mcp-doctor lint examples/broken.json --client claude-desktop --no-env\n'
sleep 0.4
"${DOC[@]}" lint examples/broken.json --client claude-desktop --no-env || true
sleep 0.8

printf '\n$ mcp-doctor convert examples/cursor.json --from cursor --to windsurf\n'
sleep 0.4
"${DOC[@]}" convert examples/cursor.json --from cursor --to windsurf
sleep 0.8

TMP="$(mktemp)"
cat >"$TMP" <<EOF
{
  "mcpServers": {
    "fixture": {
      "command": "${NODE}",
      "args": ["${PWD}/fixtures/servers/stdio-ok.mjs"]
    }
  }
}
EOF

printf '\n$ mcp-doctor doctor --file %s --client cursor --timeout 4000\n' "$TMP"
sleep 0.4
"${DOC[@]}" doctor --file "$TMP" --client cursor --timeout 4000 --home /tmp
sleep 0.6
rm -f "$TMP"
printf '\n'
