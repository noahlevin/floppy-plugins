# floppy:follow-up

Grounded follow-up email, Floppy-only. Drafts a follow-up to a person, company,
or project — grounded strictly in Atlas memory, anchored on the open
commitments and recent activity Floppy holds, with every concrete claim citing
a real `assertionId` / `sourceArtifactId`.

This is an **outbound** skill, so it follows strict rules:

- **Grounded.** Subject resolves from the argument via `atlas_search_wiki`, then
  `atlas_brief` hydrates the profile. Open commitments are the "what's owed"
  spine. Every claim cites a real id; the draft carries at least one citation.
- **Verified.** Before submitting, the SP-145 `atlas_review` verify pass runs
  over the draft's citations and surfaces contradicted/uncited verdicts as soft
  warnings.
- **Review-required, never auto-sent.** The follow-up is submitted as a
  review-required Atlas draft via `atlas_submit_review_required_draft`. There is
  **no email-send path anywhere** — a human reviews and sends it.

## Tenant & subject

- **Tenant** is the connected Atlas bearer's tenant (derived server-side). The
  same skill bytes serve any tenant — nothing is hardcoded.
- **Subject** comes from the argument and is resolved at runtime via
  `atlas_search_wiki` (or used directly if it's already a canonical id).

## Voice (SP-147)

The skill loads its per-tenant style profile under `floppy-follow-up`. The live
path injects it into the prose so serious-people vs Doris Dev each get their own
voice. An empty profile degrades to base behavior.

## Live path

Claude Code is the brain; it follows `SKILL.md` through the bundled `atlas` MCP
and writes the prose. See `SKILL.md` for the ordered steps, the strict grounding
rule, and the never-auto-send rule.

## CLI fallback (deterministic, no LLM, never sends email)

```bash
ATLAS_AGENT_BEARER=${ATLAS_AGENT_TOKEN} \
  node skills/follow-up/bin/run.mjs --entity "Jordan Rivera"
```

Options: `--entity <name|id>` (or `--person`, required), `--recipients <csv>`,
`--limit <n>`, `--json`, `--tenant-slug <slug>` (review-URL rendering only —
never data scope), `--web-url <url>`.

The CLI takes the subject from `--entity` (no filesystem read), so it works in
Cowork. It stops at a review-required Atlas draft.

## Tests

```bash
node --test plugin/skills/follow-up/test/*.mjs
```

Covered: draft carries ≥1 real citation and is grounded in open commitments;
name → wiki-search resolution and canonical-id passthrough; tenant always from
the bearer; the verify pass runs before submit; the review-required draft is
submitted; **no email-send path exists anywhere**; reruns dedup via the
idempotency key; empty brief throws before anything is submitted; CLI no-FS JSON
path.
