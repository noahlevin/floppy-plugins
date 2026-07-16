---
description: Capture the current Claude Code session into Floppy
allowed-tools: Bash
---

Trigger the same fire-and-forget capture path used by the Floppy Stop hook.

Run this Bash command for the current session. If `CLAUDE_TRANSCRIPT_PATH` or `CLAUDE_SESSION_ID` is unavailable, ask for the transcript path and use the transcript file name as the session id.

```bash
printf '{"transcript_path":"%s","session_id":"%s"}' "$CLAUDE_TRANSCRIPT_PATH" "$CLAUDE_SESSION_ID" | "${CLAUDE_PLUGIN_ROOT}"/hooks/stop-capture.sh
```
