---
name: agenda
description: Produce a client-safe meeting agenda for a person, company, or project — a clean, on-screen-for-everyone agenda grounded ONLY in Floppy/Atlas memory. Every substantive line traces to a real assertion or source-artifact id; open items come from Floppy's open commitments. Runs in Cowork. Tenant comes from the connected Atlas bearer.
trigger: invoked when the operator asks to "build an agenda for <meeting/subject>", "agenda for the <client> call", or "what should we cover with <entity>" — the subject comes from the argument, resolved against Floppy memory
---

# agenda — Floppy grounded meeting agenda

Claude Code is the brain for this skill. Do not spawn a Node LLM subprocess.

This is a read-only skill: it produces a client-safe agenda inline in the
session (Cowork). It does not draft, send, publish, or write anything outbound.
There is no portal step, no email step, and no commercial-figure step — those
live in the operator's own tenant infrastructure, not here.

## Grounding rule (strict)

Use ONLY information returned by the bundled Floppy/Atlas MCP tools (`atlas_*`)
for facts. Do not use prior knowledge, the web, other MCP servers, or local
files for facts about the subject. Every substantive line in the agenda must
trace to a real `assertionId` (from `hydrated[].facts[].assertionId` or
`hydrated[].citations.assertionIds`) or a real `sourceArtifactId`. Open items
("what's owed") come from Floppy's `openCommitments[]`, each cited. If Floppy
does not have something, say so plainly — never invent an agenda item. (This
restates the plugin-wide contract in `INSTRUCTIONS.md`.)

## Client-safe boundary (non-negotiable)

The agenda is on-screen for everyone on the call. NEVER surface internal-only
intel: political dynamics, candid characterizations of attendees, a
stakeholder's private reservations about another's ideas, internal trip or
schedule intel, or strategic framing that positions one party against another.
**Litmus test: "would it be a problem if the person being described read this?"
If yes, it stays out.** Translate the actionable substance into neutral
language and drop the politics. **No commercial figures** — fees, dollar
amounts, margin, rates. The agenda audience can exceed the contract signatory
list; not everyone should see the number. If Floppy returns commercial or
internal-sensitive facts, use them only to inform a neutral line — never quote
the figure or the private characterization into the agenda.

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
   { "query": "<subject name from $ARGUMENTS>", "limit": 5 }
   ```

   Take the top `entity`-kind hit (else the top hit). Use its `title` as the
   entity hint and its `id` as the resolved entity id. If search returns
   nothing, say so and fall back to the raw name as a hint.

2. Brief.

   Call `atlas_brief`:

   ```json
   {
     "task": "Produce a client-safe meeting agenda for this entity, citing real assertion ids from Atlas memory; surface open commitments as the open-items section",
     "entityHints": ["<resolved title or raw name>"],
     "limit": 6
   }
   ```

   Use the returned `hydrated[]` (per-entity profiles: `summary`, `facts[]`,
   `openCommitments[]`, `recentChanges`, `citations`), `index[]`, and
   `suggestions[]`. Pick the hydrated entity matching the resolved id (else the
   first project-kind, else the first hydrated entity).

3. Deepen open items (optional).

   The agenda's "open items / what's owed" section is driven by
   `openCommitments[]`. If you need to confirm an item's wording before putting
   it on a client-facing agenda, read its cited evidence with
   `atlas_read_source_artifact` (pass the `sourceArtifactId` and, when present,
   the cited `sourceSegmentId`). Read for accuracy — do not quote
   internal-sensitive material into the agenda.

4. Write the agenda yourself.

   Claude Code writes the prose. Ground every substantive line in a real
   assertion or source-artifact id. Apply the client-safe boundary on every
   line. Sections:

   - **Meeting framing** — one neutral line on what this meeting is about, from
     the entity `summary`. No internal strategy.
   - **Agenda topics** — 3-6 topics to cover, each a short heading + one
     full-sentence line, each anchored to a real fact (cite its assertion id).
     Order by what moves the work forward. Topics are the substance Floppy
     surfaced, restated in neutral, client-safe language.
   - **Open items / what's owed** — `openCommitments[]` as a tight list
     (`<strong>Topic.</strong> Full sentence.`), each cited. If there are no
     open commitments, say "No open items in Floppy as of this brief."
   - **Recent activity (optional)** — a short note from
     `recentChanges.events[]` (newest first) only when it sets up a topic. Skip
     if it adds nothing.

   Voice: full sentences in bullets, no fragments; bold-the-topic-then-period
   pattern in any tight list; no consultant register ("leverage / thrusts /
   connective tissue / HITL"); no clever closing tagline; no deadline pressure
   stamped on anything you're asking the client to produce.

5. Present inline.

   Print the agenda in the session. Append a short "Sources" footer listing the
   assertion ids and source-artifact ids the agenda rests on, so the operator
   can audit grounding. Do not draft, publish, or send anything — this skill
   stops at the agenda.

## Failure modes

| Failure | Handling |
|---|---|
| `atlas_search_wiki` returns nothing | Say the subject couldn't be resolved; fall back to the raw name as a hint and continue. |
| `atlas_brief` fails | Stop. Do not produce an ungrounded agenda. |
| Brief has no hydrated entity | Say Floppy has nothing on this subject; do not fabricate topics. |
| Brief has no assertion ids | Render only what's grounded; mark any section without citations as "no grounded facts". |
| No open commitments | Continue; the open-items section says so explicitly. |
| Floppy returns internal-sensitive / commercial facts | Use them only to inform a neutral line; never quote the figure or private characterization into the client-facing agenda. |
