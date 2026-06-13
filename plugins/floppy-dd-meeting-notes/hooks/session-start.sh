#!/usr/bin/env sh

data_dir="${CLAUDE_PLUGIN_DATA:-}"
plugin_root="${CLAUDE_PLUGIN_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
cache_file="${data_dir%/}/grounding.json"
ttl_seconds=21600

print_cached_context() {
  [ -n "$data_dir" ] || return 0
  [ -f "$cache_file" ] || return 0
  node -e '
const fs = require("node:fs");
try {
  const file = process.argv[1];
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof parsed.context === "string" && parsed.context.trim().length > 0) {
    process.stdout.write(parsed.context.trimEnd() + "\n");
  }
} catch {}
' "$cache_file" 2>/dev/null || true
}

needs_refresh() {
  [ -n "$data_dir" ] || return 1
  [ -f "$cache_file" ] || return 0
  node -e '
const fs = require("node:fs");
const file = process.argv[1];
const ttlSeconds = Number(process.argv[2]);
try {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const refreshedAt = typeof parsed.refreshedAt === "string" ? Date.parse(parsed.refreshedAt) : NaN;
  if (!Number.isFinite(refreshedAt)) process.exit(0);
  process.exit(Date.now() - refreshedAt > ttlSeconds * 1000 ? 0 : 1);
} catch {
  process.exit(0);
}
' "$cache_file" "$ttl_seconds" >/dev/null 2>&1
}

start_refresh() {
  [ -n "$data_dir" ] || return 0
  [ -f "$plugin_root/hooks/lib/grounding-refresh.mjs" ] || return 0
  mkdir -p "$data_dir" 2>/dev/null || true

  if command -v setsid >/dev/null 2>&1; then
    setsid node "$plugin_root/hooks/lib/grounding-refresh.mjs" </dev/null >/dev/null 2>&1 &
  else
    nohup node "$plugin_root/hooks/lib/grounding-refresh.mjs" </dev/null >/dev/null 2>&1 &
  fi
}

print_cached_context
if needs_refresh; then
  start_refresh
fi

exit 0
