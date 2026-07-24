#!/usr/bin/env sh

payload="$(cat 2>/dev/null || true)"
plugin_root="${CLAUDE_PLUGIN_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
capture_script="$plugin_root/hooks/lib/capture.mjs"

[ -f "$capture_script" ] || exit 0

# capture.mjs reports failures on stderr with a [floppy-capture] prefix.
# Keep the host session's streams untouched, but append diagnostics to a log
# file so capture failures are observable instead of silently discarded.
log_file="${FLOPPY_CAPTURE_LOG:-${TMPDIR:-/tmp}/floppy-capture.log}"

if command -v setsid >/dev/null 2>&1; then
  (printf '%s' "$payload" | setsid node "$capture_script" >/dev/null 2>>"$log_file") &
else
  (printf '%s' "$payload" | nohup node "$capture_script" >/dev/null 2>>"$log_file") &
fi

exit 0
