---
name: proposal
description: Produce a client-facing proposal artifact for an engagement — grounded ONLY in Floppy/Atlas memory, with verbatim discovery quotes read from real source artifacts. Every concrete claim cites a real assertion or source-artifact id. Noah's proposal voice gates apply (banned-word strip, verbatim-quote rule, one-price-one-paragraph). Runs in Cowork. Tenant comes from the connected Atlas bearer.
trigger: invoked when the operator asks to "draft a proposal for <client>", "write up the <engagement> proposal", or "put together a proposal for <entity>" — the subject comes from the argument, resolved against Floppy memory
---

# proposal — Floppy grounded client proposal

Claude Code is the brain for this skill. Do not spawn a Node LLM subprocess.

This skill produces the proposal **artifact** inline in the session (Cowork). It
does NOT publish to a portal, create artifact rows, grant client access, or
email anyone. Those steps in Noah's local `/proposal` are tenant-specific,
non-Floppy infrastructure (sp-clients, Resend, the admin API) and are out of
scope here — the deliverable is the grounded proposal artifact, nothing
outbound.

## Grounding rule (strict)

Use ONLY information returned by the bundled Floppy/Atlas MCP tools (`atlas_*`)
for facts. Do not use prior knowledge, the web, other MCP servers, or local
files for facts about the client, the discovery, or the engagement. Every
concrete claim must cite a real `assertionId` (from `hydrated[].facts[].assertionId`
or `hydrated[].citations.assertionIds`) or a real `sourceArtifactId`. Every
buyer quote must be read verbatim from a real source artifact via
`atlas_read_source_artifact` — never paraphrase the buyer back at themselves,
never reconstruct a quote from memory. If Floppy does not have something (a
number, a concern, a decision), say so plainly — never invent it. (This
restates the plugin-wide contract in `INSTRUCTIONS.md`.)

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
   { "query": "<client/engagement name from $ARGUMENTS>", "limit": 5 }
   ```

   Take the top `entity`-kind hit (else the top hit). Use its `title` as the
   entity hint and its `id` as the resolved entity id. If search returns
   nothing, say so and fall back to the raw name as a hint.

2. Brief.

   Call `atlas_brief`:

   ```json
   {
     "task": "Produce a client-facing proposal for this engagement, citing real assertion ids from Atlas memory and grounding buyer language in real source artifacts",
     "entityHints": ["<resolved title or raw name>"],
     "limit": 6
   }
   ```

   Use the returned `hydrated[]` (per-entity profiles: `summary`, `facts[]`,
   `openCommitments[]`, `recentChanges`, `citations`), `index[]`, and
   `suggestions[]`. Pick the hydrated entity matching the resolved id (else the
   first project-kind, else the first hydrated entity). The facts are your
   current-state, what-they-asked-for, and concerns material.

3. Read verbatim discovery quotes.

   For any buyer language you want to use (the current-state lede, a FAQ, a
   concern you mirror back), read the cited evidence with
   `atlas_read_source_artifact` — pass the `sourceArtifactId` and, when present,
   the cited `sourceSegmentId`, optionally with `contextBefore` / `contextAfter`
   to confirm the surrounding words. Use the quote **word-for-word**. If you
   cannot find a verbatim source for a claim you want to attribute to a buyer,
   do not attribute it — state it as your own framing or drop it.

4. Write the proposal artifact yourself.

   Claude Code writes the prose. Ground every concrete claim in a real assertion
   or source-artifact id. Lean section set — cut anything that doesn't move the
   buyer:

   - **Hero / headline** — `[VERB] [the client's own words for the work]` (e.g.
     "Let's build <Client>'s forecasting and order-management system"). Client's
     words, not an internal product name. Set realistic expectations — don't
     promise "automated" if Floppy says it's human-in-the-loop.
   - **Executive summary** — the single claim about what we're building, mirrored
     verbatim in "What we're building." No time-bound commitments, no hiring
     conditions.
   - **Current state** — credit the existing process FIRST, then name the
     inflection. Use the client's terms. A verbatim buyer quote here (cited,
     attributed `— <Speaker>, <call/email>, <date>`) is gold.
   - **What we're building / what it does** — the build in product terms;
     client's explicit asks FIRST, infrastructure last. One or two tight
     sentences per capability, not a laundry list.
   - **Business outcomes** — what the build unlocks for the business.
   - **Investment** — if Floppy carries a figure, use it; otherwise one card,
     "To be scoped," + one paragraph on what the number depends on. One price,
     one paragraph, one knob to turn. Clean monthly / clean annual rollup when
     multi-option.
   - **Phasing** — illustrative; open with "the final phasing will be agreed
     when the SOW is locked."
   - **Scope boundaries** — in-scope / out-of-scope.
   - **What you provide** — access / people / agreements, specific and realistic.
   - **FAQs** — 5+ REAL questions only, or cut the section. Two-claim answers,
     one simple paragraph each. Don't volunteer doubt.

5. Voice gates (run before presenting).

   - **Banned words — strip on sight:** "genuinely" (never — the single most
     reliable AI tell), "leverage," "synergy," "circle back," "align on," "move
     the needle," "unlock," "empower," "supercharge," "reimagine," "journey,"
     "thrusts," "layered on," "connective tissue," "HITL," "absolutely,"
     "really," "totally."
   - **Structural strips:** three-example rhythm ("no X, no Y, no Z" → pick the
     strongest); em-dash dramatic reveals (parenthetical em-dashes are fine);
     clever closing taglines; "First… Second…" body structure; numbered
     sub-headers in prose; sycophantic openers; vague claims ("very impactful").
   - **Bold-the-topic, end with a period** in any tight block:
     `<strong>Topic.</strong> Full sentence.` Not a colon, not an em-dash.
   - **One price, one paragraph, one knob to turn** in Investment.
   - **Verbatim quotes only** — every buyer quote word-for-word from Step 3,
     attributed `— <Speaker>, <call/email>, <date>`. Never paraphrase the buyer.
   - **Don't translate plain language up into consultant register** — "we'll
     connect to her existing master sheet," not "integrate with the canonical
     source-of-truth artifact." Not wordy, not pandering, not cloying.

6. Present inline.

   Print the proposal artifact in the session. Append a short "Sources" footer
   listing the assertion ids and source-artifact ids the proposal rests on, and
   note any place where you said "Floppy doesn't carry this." Do not publish,
   create rows, grant access, or email — this skill stops at the artifact.

## Failure modes

| Failure | Handling |
|---|---|
| `atlas_search_wiki` returns nothing | Say the client couldn't be resolved; fall back to the raw name as a hint and continue. |
| `atlas_brief` fails | Stop. Do not produce an ungrounded proposal. |
| Brief has no hydrated entity | Say Floppy has nothing on this engagement; do not fabricate a proposal. |
| Brief has no assertion ids | Render only what's grounded; mark any section without citations as "no grounded facts". |
| Buyer quote has no verbatim source | Do not attribute it to the buyer; state it as your own framing or drop it. |
| No pricing fact in Floppy | Use the single "To be scoped" card + a paragraph on what the number depends on. Never invent a number. |
| A banned word survives a pass | It's a regression — strip it and re-run the voice gate before presenting. |
