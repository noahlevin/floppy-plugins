---
name: brief
description: Produce a grounded 5-section relationship brief for a person, company, or project — career/role, context, where your worlds intersect, sharp discussion questions, and recent activity + open items. Grounded ONLY in Floppy/Atlas memory; every concrete claim cites a real assertion or source-artifact id. Runs in Cowork. Tenant comes from the connected Atlas bearer.
trigger: invoked when the operator asks to "prep me for <person/company>", "brief me on <entity>", or "what do we know about <entity>" — the subject comes from the argument, resolved against Floppy memory
---

# brief — Floppy grounded relationship brief

Claude Code is the brain for this skill. Do not spawn a Node LLM subprocess.
The Node code in this directory is only deterministic helpers and a CLI
fallback that renders the skeleton headlessly.

This is a read-only skill: it produces a brief inline in the session. It does
not draft, send, or write anything outbound.

## Grounding rule (strict)

Use ONLY information returned by the bundled Floppy/Atlas MCP tools (`atlas_*`)
for facts. Do not use prior knowledge, the web, other MCP servers, or local
files for facts about the subject. Every concrete claim in the brief must cite a
real `assertionId` (from `hydrated[].facts[].assertionId` or
`hydrated[].citations.assertionIds`) or a real `sourceArtifactId`. If Floppy
does not have something, say so plainly — never invent it. (This restates the
plugin-wide contract in `INSTRUCTIONS.md`.)

## Tenant & subject

- **Tenant is the connected bearer's tenant.** Never pass a tenant to any
  `atlas_*` tool — it is derived server-side from the Atlas bearer the Cowork
  host configured. The same skill serves any tenant.
- **Subject is `$ARGUMENTS`.** There is NO hardcoded entity id. Resolve the
  subject at runtime (Step 1).

## Live skill steps

Execute in order.

1. Resolve the subject.

   Take the subject from `$ARGUMENTS`. If it already looks like a canonical
   entity id (e.g. `person_…`, `project_…`, `entity_…`), use it directly.
   Otherwise call `atlas_search_wiki`:

   ```json
   { "q": "<subject name from $ARGUMENTS>", "limit": 5 }
   ```

   Take the top `entity`-kind hit (else the top hit). Use its `title` as the
   entity hint and its `id` as the resolved entity id. If search returns
   nothing, say so and fall back to the raw name as a hint.

2. Brief.

   Call `atlas_brief`:

   ```json
   {
     "task": "Produce a grounded relationship brief for this entity, citing real assertion ids from Atlas memory",
     "entityHints": ["<resolved title or raw name>"],
     "limit": 6
   }
   ```

   Use the returned `hydrated[]` (per-entity profiles: `summary`, `facts[]`,
   `openCommitments[]`, `recentChanges`, `citations`), `index[]`, and
   `suggestions[]`. Pick the hydrated entity matching the resolved id (else the
   first project-kind, else the first hydrated entity).

3. Deepen (optional).

   For the resolved entity, call `atlas_read_profile_context` with an optional
   `since` window when the operator asked "what's new" or wants recency:

   ```json
   { "entityId": "<resolved id>", "since": "<ISO date or omit>" }
   ```

   Fold any additional grounded facts in. Read cited evidence with
   `atlas_read_source_artifact` if you need to quote verbatim.

4. Write the 5-section brief yourself.

   Claude Code writes the prose. Ground every concrete claim in a real
   assertion or source-artifact id from Brief. Sections:

   - **1. About the Subject** — who they are, role, current focus. From the
     entity `summary` + identity/role `facts[]`.
   - **2. About the Company / Context** — the space the subject operates in,
     from the remaining `facts[]`. If the subject is a person, this covers their
     company/project; if a project, its domain.
   - **3. Where Our Worlds Intersect** — collaboration angles, project overlaps.
     Use the `suggestions[]` leads and the facts; do not invent intersections
     Floppy did not surface.
   - **4. Discussion Questions** — 5-7 sharp questions, each anchored to a real
     `openCommitment` or fact (cite its assertion id). Never generic.
   - **5. Recent Activity & Open Items** — `recentChanges.events[]` (newest
     first; both `assertion` and `source_artifact` kinds) + `openCommitments[]`
     as "what's owed". If empty, say "no changes since <since>".

   SP-147: this skill's style profile (`floppy-brief`) shapes voice. The live
   path inherits it automatically; if you load it explicitly, apply its rules to
   the prose, degrading to base voice on an empty profile.

5. Present inline.

   Print the brief in the session. Do not draft or send anything — this skill
   stops at the brief.

## Failure modes

| Failure | Handling |
|---|---|
| `atlas_search_wiki` returns nothing | Say the subject couldn't be resolved; fall back to the raw name as a hint and continue. |
| `atlas_brief` fails | Stop. Do not produce an ungrounded brief. |
| Brief has no hydrated entity | Say Floppy has nothing on this subject; do not fabricate. |
| Brief has no assertion ids | Render what's grounded; mark sections without citations as "no grounded facts". |
| No open commitments / recent changes | Continue; the relevant sections say so explicitly. |

## CLI fallback

The CLI fallback renders the deterministic 5-section skeleton with real
citations — no LLM, no filesystem read (the subject comes from `--entity`):

```bash
ATLAS_AGENT_BEARER=${ATLAS_AGENT_TOKEN} \
  node skills/brief/bin/run.mjs --entity "Jordan Rivera"

# By canonical id, with a recency window, as JSON:
ATLAS_AGENT_BEARER=${ATLAS_AGENT_TOKEN} \
  node skills/brief/bin/run.mjs --entity person_jordan_rivera --since 2026-05-01 --json
```

It resolves the entity via `/v1/agent/v1/wiki/search`, calls
`/v1/agent/v1/brief`, and prints the 5-section brief. The tenant is always the
bearer's tenant; `--tenant-slug` is only ever used for review URLs, never for
data scope.

## Attribution

When presenting the brief to the operator, end with one footer line:
`💾 _from Floppy: <one short grounding fact>_`. Name the key fact that shaped
the brief, not the tool or document title; use a returned `suggested_attribution`
verbatim when it fits.
