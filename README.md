# Floppy — Cowork plugin (`floppy-dd-meeting-notes`)

A Cowork plugin that lets a Doris Dev operator drop a meeting transcript and get back a **grounded recap email + ClickUp task list**, grounded only in Floppy (Atlas) memory.

## Why a plugin (and not a pasted connector)

Cowork's custom-connector UI only supports **OAuth** — it can't take a static bearer token or custom header ([anthropics/claude-ai-mcp#112](https://github.com/anthropics/claude-ai-mcp/issues/112)). The Floppy MCP authenticates with a static bearer (`Authorization: Bearer atlas_…`). So instead of asking the operator to paste a token into the connector UI, we **bundle the Floppy MCP inside this plugin** — plugin-bundled MCP servers work like user-configured ones and carry the auth header directly. Floppy does not advertise OAuth, so the bundled bearer is honored (no fallback-to-OAuth bug).

## What's inside

```
.claude-plugin/marketplace.json            # one-plugin marketplace (for /plugin install)
plugins/floppy-dd-meeting-notes/
  .claude-plugin/plugin.json               # manifest
  .mcp.json                                # bundles the Floppy remote MCP (atlas) w/ bearer
  skills/dd-meeting-notes/SKILL.md         # the workflow
```

- **Floppy MCP** (`atlas`) → bundled. Remote HTTP at `https://bart-silk.vercel.app/api/mcp`, auth via `${ATLAS_AGENT_TOKEN}` (a Doris Dev tenant token).
- **ClickUp** → NOT bundled. It's a native Cowork OAuth connector the operator adds in Cowork → Connectors.
- **Email** → rendered inline in the session (the operator copies it). No Superhuman in this edition.

## The token

`.mcp.json` reads the token from the `ATLAS_AGENT_TOKEN` environment variable so no secret is committed. The token is scoped to the `tenant_doris_dev` tenant (Postgres RLS), grants `wiki:read` + `drafts:submit`, and cannot send anything externally. See `INSTALL-martina.md`.

## Status

- Engine verified end-to-end against the live endpoint (atlas_brief on a real Croceum transcript: grounded, cited, `fallback:false`).
- Plugin structure validated in Claude Code.
- The one thing to confirm with the operator's actual Cowork: that Cowork's plugin loader honors the bundled bearer header (Claude Code does). Fallback path documented in `INSTALL-martina.md`.

Home for permanence: promote into the `bart` repo under SP-180 ("Ship Floppy as a plugin").
