# floppy:brief

Grounded relationship brief, Floppy-only. Produces a 5-section brief for a
person, company, or project — grounded strictly in Atlas memory, with every
concrete claim citing a real `assertionId` / `sourceArtifactId`.

- **About the Subject** — role, current focus.
- **About the Company / Context** — the space they operate in.
- **Where Our Worlds Intersect** — collaboration angles from Brief's
  related-context leads.
- **Discussion Questions** — sharp, each anchored to a real commitment/fact.
- **Recent Activity & Open Items** — `recentChanges` events + open commitments.

Unlike Noah's `/meeting-prep`, this does **no** calendar / Gmail / Granola
sweep. Grounding is strictly `atlas_search_wiki` + `atlas_brief` +
`atlas_read_profile_context`.

## Tenant & subject

- **Tenant** is the connected Atlas bearer's tenant (derived server-side). The
  same skill bytes serve any tenant — nothing is hardcoded.
- **Subject** comes from the argument and is resolved at runtime via
  `atlas_search_wiki` (or used directly if it's already a canonical id). There
  is no hardcoded entity.

## Live path

Claude Code is the brain; it follows `SKILL.md` through the bundled `atlas` MCP
and writes the prose. See `SKILL.md` for the ordered steps and the strict
grounding rule.

## CLI fallback (deterministic, no LLM)

```bash
ATLAS_AGENT_BEARER=${ATLAS_AGENT_TOKEN} \
  node skills/brief/bin/run.mjs --entity "Jordan Rivera"
```

Options: `--entity <name|id>` (required), `--since <iso>`, `--limit <n>`,
`--json`, `--tenant-slug <slug>` (review-URL rendering only — never data scope).

The CLI takes the subject from `--entity` (no filesystem read), so it works in
Cowork.

## Tests

```bash
node --test plugin/skills/brief/test/*.mjs
```

Covered: name → wiki-search resolution; canonical-id passthrough; all five
sections render with populated assertion-id citations; empty-brief degrades
gracefully; CLI no-FS JSON path.
