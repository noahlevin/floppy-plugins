# floppy:digest

Grounded "what changed on `<entity>` this week" digest, Floppy-only. Produces a
recency-ranked rundown of recent changes for a person, company, or project —
grounded strictly in Atlas memory, with every change citing a real
`assertionId` (new/updated fact) or `sourceArtifactId` (new source material).

- **Summary** — how much changed in the window, or an explicit "No changes since
  `<since>`" when Floppy has nothing.
- **New & Updated Facts** — `assertion`-kind `recentChanges` events, newest
  first, each citing its assertion id.
- **New Source Material** — `source_artifact`-kind events, newest first, each
  citing its source-artifact id.

Grounding is strictly `atlas_search_wiki` + `atlas_brief` (per-entity
`recentChanges`) + an optional `atlas_read_profile_context` /
`atlas_find_source_artifacts` deepen when a window is named. No calendar / Gmail
/ Granola sweep.

## Tenant & subject

- **Tenant** is the connected Atlas bearer's tenant (derived server-side). The
  same skill bytes serve any tenant — nothing is hardcoded.
- **Subject** comes from the argument and is resolved at runtime via
  `atlas_search_wiki` (or used directly if it's already a canonical id). There
  is no hardcoded entity.

## Live path

Claude Code is the brain; it follows `SKILL.md` through the bundled `atlas` MCP
and writes the prose. See `SKILL.md` for the ordered steps and the strict
grounding rule — every change cites a real id, and the digest says so plainly
when Floppy has no changes.

## CLI fallback (deterministic, no LLM)

```bash
ATLAS_AGENT_BEARER=${ATLAS_AGENT_TOKEN} \
  node skills/digest/bin/run.mjs --entity "Jordan Rivera" --since 7d
```

Options: `--entity <name|id>` (required), `--since <iso|Nd>` (an ISO date or a
relative window like `7d`), `--limit <n>`, `--json`, `--tenant-slug <slug>`
(review-URL rendering only — never data scope).

The CLI takes the subject from `--entity` (no filesystem read), so it works in
Cowork.

## Tests

```bash
node --test plugin/skills/digest/test/*.mjs
```

Covered: recency ranking + assertion/source-artifact grouping; missing/empty
events degrade without crashing; `--since` ISO and `Nd` normalization;
name → wiki-search resolution; canonical-id passthrough; tenant-from-bearer (no
tenant in any request); `--since` deepen folds in a richer profile-context
window; empty-changes "No changes since" message; empty-brief degrade; CLI
no-FS JSON path.
