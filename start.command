#!/bin/sh
# macOS: double-click in Finder to start.
cd "$(dirname "$0")" || exit 1
exec node server.js "$@"
