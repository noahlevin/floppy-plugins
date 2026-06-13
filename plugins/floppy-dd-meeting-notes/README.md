# Floppy DD Meeting Notes

Floppy is a Claude Code and Cowork plugin for meeting-note workflows backed by Atlas business memory. It bundles the Floppy MCP configuration, soft operating instructions, and self-contained skills.

## Install In Claude Code

From this repository, add the marketplace and install the plugin:

```bash
/plugin marketplace add .
/plugin install floppy-dd-meeting-notes@floppy
```

Set the host environment before using Atlas-backed features:

```bash
export ATLAS_MCP_URL="https://example.com/mcp"
export ATLAS_AGENT_TOKEN="..."
```

`ATLAS_MCP_URL` must point at the hosted Atlas MCP endpoint. `ATLAS_AGENT_TOKEN` must be a personal agent token. Do not store the token in this repository.

## Install In Cowork

Install the `floppy-dd-meeting-notes` plugin from the `floppy` marketplace, then provide the same environment values Cowork expects for remote MCP:

```bash
ATLAS_MCP_URL=https://example.com/mcp
ATLAS_AGENT_TOKEN=...
```

Cowork uses the bundled `.mcp.json`, so no separate Add Connector step is required for the Atlas MCP server.

## Skill Directory Convention

Skills live in self-contained directories:

```text
plugin/skills/<name>/SKILL.md
```

Each skill may include its own `bin/`, `lib/`, `test/`, and fixture files. Skills must have zero workspace dependencies so the plugin can run outside the BART monorepo. New skills are added by dropping a new directory under `plugin/skills/` and bumping the plugin version.

## Skills

All skills are grounded only via Floppy (the bundled `atlas` MCP — `atlas_brief` and friends) and are tenant-parameterized (the tenant comes from the bearer token, so the same skill serves every tenant). The subject entity is resolved at runtime from the invocation arguments via `atlas_search_wiki` — no tenant or entity is hardcoded.

- `floppy:brief` — relationship brief ("prep me for my meeting with X"): a grounded multi-section profile with assertion-level citations.
- `floppy:digest` — recent-changes digest ("what changed on X this week"): ranks `recentChanges` events with citations.
- `floppy:follow-up` — grounded follow-up email draft: submits a **review-required** draft (never auto-sends), runs the citation-verify pass, and applies the tenant's voice profile.
- `floppy:agenda` — client-safe meeting agenda grounded in `atlas_brief` + open commitments (artifact produced in-session).
- `floppy:proposal` — client proposal grounded in `atlas_brief` + verbatim discovery quotes, with the house voice gates (artifact produced in-session).
- `floppy:meeting-notes` — transcript → grounded recap + task drafts (the original reference skill).

## Session Capture Endpoint

Session capture uses `ATLAS_AGENT_ENDPOINT` when set. If unset, it is derived from `ATLAS_MCP_URL` by replacing a trailing `/mcp` path with `/v1/agent` on the same host.

Example:

```text
ATLAS_MCP_URL=https://example.com/mcp
ATLAS_AGENT_ENDPOINT=https://example.com/v1/agent
```

`ATLAS_AGENT_ENDPOINT` is optional for session capture. `ATLAS_AGENT_TOKEN` is still required.

## Dependencies

This plugin is intentionally dependency-free with respect to the BART workspace. Do not import from `apps/` or `packages/` in plugin code.
