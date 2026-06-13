---
name: follow-up
description: Draft a grounded follow-up email to a person, company, or project — grounded ONLY in Floppy/Atlas memory, anchored on the open commitments and recent activity Floppy holds, with every concrete claim citing a real assertion or source-artifact id. The draft is submitted REVIEW-REQUIRED; it is NEVER auto-sent. Runs in Cowork. Tenant comes from the connected Atlas bearer.
trigger: invoked when the operator asks to "follow up with <person/company>", "draft a follow-up to <entity>", or "send <entity> a check-in" — the subject comes from the argument, resolved against Floppy memory
---

# follow-up — Floppy grounded follow-up email

Claude Code is the brain for this skill. Do not spawn a Node LLM subprocess.
The Node code in this directory is only deterministic helpers and a CLI
fallback that prepares the review-required draft headlessly.

This skill produces an **outbound artifact** — a follow-up email. The artifact
is submitted to Atlas as a **review-required draft only**. Nothing is ever
auto-sent. The operator reviews and sends it themselves outside this skill (per
the plugin `INSTRUCTIONS.md`).

## Grounding rule (strict)

Use ONLY information returned by the bundled Floppy/Atlas MCP tools (`atlas_*`)
for facts. Do not use prior knowledge, the web, other MCP servers, or local
files for facts about the subject. Every concrete claim in the follow-up must
cite a real `assertionId` (from `hydrated[].facts[].assertionId` or
`hydrated[].citations.assertionIds`) or a real `sourceArtifactId`. If Floppy
does not have something, say so plainly — never invent it. (This restates the
plugin-wide contract in `INSTRUCTIONS.md`.)

## Never auto-send (strict)

Outbound actions are submitted ONLY as review-required Atlas drafts via
`atlas_submit_review_required_draft`. Do NOT call any email-send tool. Do NOT
claim the email was sent. The draft lands in the Atlas review queue; a human
approves and sends it. This is the same review-required contract `meeting-notes`
uses for its recap email.

## Tenant & subject

- **Tenant is the connected bearer's tenant.** Never pass a tenant to any
  `atlas_*` tool — it is derived server-side from the Atlas bearer the Cowork
  host configured. The same skill bytes serve any tenant.
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
     "task": "Draft a grounded follow-up email for this entity, citing real assertion ids and open commitments from Atlas memory",
     "entityHints": ["<resolved title or raw name>"],
     "limit": 6
   }
   ```

   Use the returned `hydrated[]` (per-entity profiles: `summary`, `facts[]`,
   `openCommitments[]`, `recentChanges`, `citations`). Pick the hydrated entity
   matching the resolved id (else the first project-kind, else the first
   hydrated entity). The `openCommitments[]` are the "what's owed / next steps"
   spine of the follow-up — anchor the email on them.

3. Write the follow-up yourself.

   Claude Code writes the prose in the operator's voice. Ground every concrete
   claim in a real assertion or source-artifact id from Brief.

   - Open with a short, warm line.
   - Pick up the open threads: each `openCommitment` is a real "what's owed"
     item — name it and cite its assertion id.
   - Reference recent activity (`recentChanges.events[]`) only when grounded.
   - If Brief returns no open commitments, say so directly — do not invent a
     reason to follow up.

   SP-147: this skill's style profile (`floppy-follow-up`) shapes voice. The
   live path inherits it automatically; if you load it explicitly, apply its
   rules to the prose so serious-people vs Doris Dev each get their own voice,
   degrading to base voice on an empty profile.

4. Verify before submitting (SP-145).

   Run the deterministic `atlas_review` verify pass over the draft's citations:

   ```json
   { "mode": "verify", "claims": [{ "text": "<claim>", "assertion_id": "<real id>" }] }
   ```

   Surface any `contradicted` / `uncited` / `not_found` / `wrong_entity`
   verdict as a soft warning to the operator. Verify is advisory — a flagged
   citation does not block the draft, but the operator should see it before
   sending.

5. Submit the review-required draft.

   Call `atlas_submit_review_required_draft`:

   ```json
   {
     "type": "email_recap",
     "targetEntityId": "<resolved entity id>",
     "targetKind": "person | project | entity",
     "subject": "<subject line>",
     "body": "<follow-up body>",
     "recipients": ["<emails when known; omit otherwise>"],
     "citations": [{ "assertion_id": "<real Brief assertion id>" }]
   }
   ```

   `citations` requires at least one real id. Capture `response.draft.id` and
   print the review URL. **Do NOT send the email** — the draft is review-required.

## Failure modes

| Failure | Handling |
|---|---|
| `atlas_search_wiki` returns nothing | Say the subject couldn't be resolved; fall back to the raw name as a hint and continue. |
| `atlas_brief` fails | Stop. Do not draft an ungrounded follow-up. |
| Brief has no hydrated entity | Stop. Say Floppy has nothing on this subject; do not fabricate. |
| Brief has no assertion / source-artifact ids | Stop. The follow-up needs at least one real citation. |
| No open commitments | Continue; the follow-up says there is nothing outstanding on the record. |
| Verify flags a citation | Surface as a soft warning; still submit the draft. |
| Draft submit fails | Report it. Never fall back to sending the email directly. |

## CLI fallback

The CLI fallback prepares the review-required draft deterministically — no LLM,
no filesystem read (the subject comes from `--entity`), and NO email-send path:

```bash
ATLAS_AGENT_BEARER=${ATLAS_AGENT_TOKEN} \
  node skills/follow-up/bin/run.mjs --entity "Jordan Rivera"

# By canonical id, with recipients, as JSON:
ATLAS_AGENT_BEARER=${ATLAS_AGENT_TOKEN} \
  node skills/follow-up/bin/run.mjs --entity person_jordan_rivera \
  --recipients jordan@example.com --json
```

It resolves the entity via `/v1/agent/v1/wiki/search`, calls
`/v1/agent/v1/brief`, runs the verify pass, and submits one review-required
draft via `/v1/agent/v1/drafts/submit`. The tenant is always the bearer's
tenant; `--tenant-slug` is only ever used for review URLs, never for data scope.
The CLI never sends email.
