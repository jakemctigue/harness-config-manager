#!/bin/sh
# macOS: double-click in Finder to start (first time: right-click > Open).
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js 18+ is required: https://nodejs.org"; read -r _; exit 1; }
exec node server.js "$@"
