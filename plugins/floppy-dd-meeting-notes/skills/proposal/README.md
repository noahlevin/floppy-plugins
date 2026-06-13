# floppy:proposal

Client-facing proposal artifact, Floppy-only. Produces a lean, editorial-shaped
proposal for an engagement — grounded strictly in Atlas memory, with every
concrete claim citing a real `assertionId` / `sourceArtifactId` and every buyer
quote read **verbatim** from a real source artifact.

Default section set (cut anything that doesn't move the buyer):

- **Hero** — `[VERB] [the client's own words]`, realistic expectations.
- **Executive summary** — the single claim, mirrored verbatim downstream.
- **Current state** — credit the existing process, then the inflection; a cited
  verbatim buyer quote where it lands.
- **What we're building / what it does** — product terms; client asks first.
- **Business outcomes** — what the build unlocks.
- **Investment** — one price, one paragraph, one knob; "To be scoped" if Floppy
  carries no figure.
- **Phasing · Scope boundaries · What you provide · FAQs** — lean, real, cited.

## Voice gates

Noah's proposal voice gates run before presenting: banned-word strip
("genuinely," "leverage," "unlock," "HITL," …), structural strips (three-example
rhythm, em-dash reveals, clever taglines), bold-the-topic-then-period in tight
blocks, one-price-one-paragraph in Investment, and the verbatim-quote rule —
every buyer quote word-for-word from a source artifact, attributed, never
paraphrased.

## Scope (resolved fork)

This is a SKILL.md-only skill — generative craft, no deterministic transform, so
there is no `bin/` or `lib/`. It produces the **proposal artifact inline** and
stops there. The portal-publish, artifact-row, client-access-grant, and
email-fan-out gates from Noah's local `/proposal` are **dropped** — they are
tenant-specific, non-Floppy infrastructure (sp-clients, the admin API, Resend)
and would break the "grounded only via Floppy / runs in Cowork" contract.
Grounding is strictly `atlas_search_wiki` + `atlas_brief` +
`atlas_read_source_artifact`.

## Tenant & subject

- **Tenant** is the connected Atlas bearer's tenant (derived server-side). The
  same skill bytes serve any tenant — nothing is hardcoded.
- **Subject** comes from the argument and is resolved at runtime via
  `atlas_search_wiki` (or used directly if it's already a canonical id). There
  is no hardcoded entity.

## Live path

Claude Code is the brain; it follows `SKILL.md` through the bundled `atlas` MCP
and writes the prose. See `SKILL.md` for the ordered steps, the strict grounding
rule, the verbatim-quote rule, and the voice gates.
