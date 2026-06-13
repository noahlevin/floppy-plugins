# floppy:agenda

Client-safe meeting agenda, Floppy-only. Produces an on-screen-for-everyone
agenda for a person, company, or project — grounded strictly in Atlas memory,
with every substantive line tracing to a real `assertionId` / `sourceArtifactId`
and open items pulled from Floppy's open commitments.

- **Meeting framing** — one neutral line on what the meeting is about.
- **Agenda topics** — 3-6 topics, each anchored to a real fact.
- **Open items / what's owed** — `openCommitments[]`, each cited.
- **Recent activity (optional)** — a setup note when it earns its place.

## Client-safe boundary

The agenda is visible to everyone on the call, so it carries **no internal-only
intel** (political dynamics, candid characterizations, private reservations,
internal schedule intel) and **no commercial figures** (fees, dollar amounts,
margin). Litmus test: "would it be a problem if the person being described read
this?" If yes, it stays out. Floppy facts that are sensitive inform a neutral
line; the figure or characterization never lands on the page.

## Tenant & subject

- **Tenant** is the connected Atlas bearer's tenant (derived server-side). The
  same skill bytes serve any tenant — nothing is hardcoded.
- **Subject** comes from the argument and is resolved at runtime via
  `atlas_search_wiki` (or used directly if it's already a canonical id). There
  is no hardcoded entity.

## Scope

This is a SKILL.md-only skill — generative craft, no deterministic transform, so
there is no `bin/` or `lib/`. It produces the agenda **inline in the session**.
Unlike Noah's local `/agenda`, it has **no** portal-publish, email-fan-out, or
calendar/Granola/Gmail sweep — grounding is strictly `atlas_search_wiki` +
`atlas_brief` (+ `atlas_read_source_artifact` for open-item evidence), and the
output is the agenda artifact, nothing outbound.

## Live path

Claude Code is the brain; it follows `SKILL.md` through the bundled `atlas` MCP
and writes the prose. See `SKILL.md` for the ordered steps, the strict grounding
rule, and the client-safe boundary.
