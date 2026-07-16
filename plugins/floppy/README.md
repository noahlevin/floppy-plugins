# Floppy — Cowork / Claude Code plugin (`floppy@floppy`)

The **generic** Floppy plugin. It connects Claude / Cowork / Claude Code to your
Floppy business-memory server for grounded read/write, and captures each agent
session back into Floppy as source evidence. It carries **no** client-specific
meeting-recap / prep / follow-up workflows — those live in separate plugins.

## What's inside

```
plugins/floppy/
  .claude-plugin/plugin.json     # manifest (name: floppy)
  .mcp.json                      # bundles the Floppy remote MCP (atlas), bearer auth
  commands/floppy-capture-session.md   # manually capture the current session
  hooks/
    hooks.json                   # SessionStart (grounding refresh) + Stop (capture)
    session-start.sh             # prints cached grounding, refreshes in background
    stop-capture.sh              # fire-and-forget session capture on Stop
    lib/capture.mjs              # posts the transcript to the coding-agent-session import
    lib/grounding-refresh.mjs    # refreshes cached tenant grounding context
    test/capture.test.mjs        # unit tests for the capture parser/poster
```

## Connection

- **Floppy MCP** (`atlas`) is bundled. Remote HTTP at
  `https://bart-silk.vercel.app/api/mcp`.
- **Cowork / Desktop:** the primary path is OAuth — connect Floppy from the
  Floppy web app's agent-setup page (the MCP advertises OAuth
  protected-resource metadata and returns the correct `WWW-Authenticate`
  challenge). The bundled `.mcp.json` bearer is the fallback.
- **Claude Code CLI:** copy-paste simple — set `ATLAS_AGENT_TOKEN` (a
  tenant-scoped Floppy agent token) in your environment and the bundled
  `.mcp.json` authenticates directly. `ATLAS_MCP_URL` is optional and overrides
  the default endpoint.

## Session capture (source evidence)

On `Stop`, the plugin fires `hooks/lib/capture.mjs`, which reads the session
transcript and POSTs it to Floppy's coding-agent-session import
(`/v1/source-artifacts/imports/coding-agent-session`). Turns are stored as
tenant-scoped **source artifacts / source segments** — not as expanded
telemetry. Duplicate/retried turns are idempotent (no duplicate artifacts or
processing workflows). Run `/floppy-capture-session` to capture on demand.

The hook never fails the host session: all diagnostics go to
`${FLOPPY_CAPTURE_LOG:-$TMPDIR/floppy-capture.log}`.

## Install

```
/plugin marketplace add noahlevin/floppy-plugins
/plugin install floppy@floppy
```

No secrets are committed — `.mcp.json` reads the token from `ATLAS_AGENT_TOKEN`.
