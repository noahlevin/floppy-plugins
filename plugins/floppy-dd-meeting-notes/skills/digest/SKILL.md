---
name: digest
description: Produce a grounded "what changed on <entity> this week" digest for a person, company, or project — a recency-ranked rundown of new/updated facts and new source material. Grounded ONLY in Floppy/Atlas memory; every change cites a real assertion or source-artifact id, and the digest says so plainly when Floppy has no changes. Runs in Cowork. Tenant comes from the connected Atlas bearer.
trigger: invoked when the operator asks "what changed on <entity>", "what's new with <entity> this week", "catch me up on <entity>", or "recent activity on <entity>" — the subject comes from the argument, resolved against Floppy memory
---

# digest — Floppy grounded recent-changes digest

Claude Code is the brain for this skill. Do not spawn a Node LLM subprocess.
The Node code in this directory is only deterministic helpers and a CLI
fallback that renders the skeleton headlessly.

This is a read-only skill: it produces a digest inline in the session. It does
not draft, send, or write anything outbound.

## Grounding rule (strict)

Use ONLY information returned by the bundled Floppy/Atlas MCP tools (`atlas_*`)
for facts. Do not use prior knowledge, the web, other MCP servers, or local
files for facts about the subject. Every change in the digest must cite a real
`assertionId` (for an updated/new fact) or a real `sourceArtifactId` (for new
source material), taken from the `recentChanges.events[]` Brief returns. If
Floppy has no changes in the window, say so plainly — "No changes since
<since>" — never invent activity. (This restates the plugin-wide contract in
`INSTRUCTIONS.md`.)

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
     "task": "Produce a grounded recent-changes digest for this entity, citing real assertion and source-artifact ids from Atlas memory",
     "entityHints": ["<resolved title or raw name>"],
     "limit": 6
   }
   ```

   Pick the hydrated entity matching the resolved id (else the first
   project-kind, else the first hydrated entity). The grounding for the digest
   is its `recentChanges`: `{ entityId, since, events[] }`, where each event is
   `{ kind: "assertion" | "source_artifact", id, summary/title, observedAt/occurredAt, ... }`.

3. Deepen (optional, for a wider or explicit window).

   When the operator named a window ("this week", "since May 1"), call
   `atlas_read_profile_context` scoped to that window for a deeper event set:

   ```json
   { "entityId": "<resolved id>", "since": "<ISO date>" }
   ```

   Fold its `recentChanges.events[]` in (prefer the richer set). For a recency
   sweep across source material, `atlas_find_source_artifacts` can surface new
   artifacts; cite their real `sourceArtifactId`. Read cited evidence with
   `atlas_read_source_artifact` only if you need to quote a change verbatim.

4. Write the digest yourself.

   Claude Code writes the prose. Rank every change by recency
   (`observedAt`/`occurredAt`, newest first) and group it:

   - **1. Summary** — one or two lines: how much changed in the window and the
     headline shift. If `events[]` is empty, this section is just
     "No changes since <since>." and you stop — do not pad the rest.
   - **2. New & Updated Facts** — the `assertion`-kind events, newest first.
     Each line states the change and cites its real `assertionId`.
   - **3. New Source Material** — the `source_artifact`-kind events, newest
     first. Each line names the artifact and cites its real `sourceArtifactId`.

   SP-147: this skill's style profile (`floppy-digest`) shapes voice. The live
   path inherits it automatically; if you load it explicitly, apply its rules to
   the prose, degrading to base voice on an empty profile.

5. Present inline.

   Print the digest in the session. Do not draft or send anything — this skill
   stops at the digest.

## Failure modes

| Failure | Handling |
|---|---|
| `atlas_search_wiki` returns nothing | Say the subject couldn't be resolved; fall back to the raw name as a hint and continue. |
| `atlas_brief` fails | Stop. Do not produce an ungrounded digest. |
| Brief has no hydrated entity | Say Floppy has nothing on this subject; do not fabricate. |
| `recentChanges.events[]` is empty | Print "No changes since <since>" — never invent activity. |
| `atlas_read_profile_context` fails on the deepen step | Degrade silently to Brief's own `recentChanges`; note it if it materially narrows the window. |

## CLI fallback

The CLI fallback renders the deterministic digest skeleton with real
citations — no LLM, no filesystem read (the subject comes from `--entity`):

```bash
ATLAS_AGENT_BEARER=${ATLAS_AGENT_TOKEN} \
  node skills/digest/bin/run.mjs --entity "Jordan Rivera" --since 7d

# By canonical id, with an explicit ISO window, as JSON:
ATLAS_AGENT_BEARER=${ATLAS_AGENT_TOKEN} \
  node skills/digest/bin/run.mjs --entity person_jordan_rivera --since 2026-05-01 --json
```

It resolves the entity via `/v1/agent/v1/wiki/search`, calls `/v1/agent/v1/brief`,
optionally deepens via `/v1/agent/v1/profiles/<id>/context`, and prints the
recency-ranked digest. The tenant is always the bearer's tenant; `--tenant-slug`
is only ever used for review URLs, never for data scope.
