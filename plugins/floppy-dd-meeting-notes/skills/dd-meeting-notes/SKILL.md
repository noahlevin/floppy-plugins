---
name: dd-meeting-notes
description: Turn a Doris Dev meeting transcript into a grounded recap email + ClickUp task list. The operator pastes or uploads a transcript; the skill grounds it in Floppy memory (atlas_* tools), proposes the email + tasks INLINE for review, and only on approval pushes the tasks to ClickUp. Use after a client meeting (e.g. a Croceum weekly check-in).
---

# Floppy → Doris Dev meeting notes (Cowork)

You are running the Floppy meeting-notes playbook for Doris Dev. **You are the brain; Floppy is the grounding layer.** This is the Cowork edition: the operator works in Cowork, not Claude Code, so there is no local file path and no command-line helper — the transcript arrives by paste or upload.

## Grounding rule (strict)
Use ONLY information returned by the Floppy MCP tools (`atlas_*`) for facts about the client, the project, the people, and the commitments. Do NOT use prior knowledge, the web, other connectors, or memory for client facts. The transcript the operator gives you is the only other input. **If Floppy doesn't have something, say so out loud — never invent it.**

Channels vs. data: the transcript + `atlas_*` are your **data**. ClickUp is an **output channel** only (where approved tasks land). The grounding rule still holds — never pull client facts from ClickUp.

## Inputs
- **Transcript** — the operator pastes the transcript text directly into the chat, or uploads a file (`.txt`, `.json`, `.vtt`, `.md`). If it's structured JSON (e.g. `[{speaker_name, sentence}, ...]`), flatten it to `Speaker: text` lines yourself. If no transcript is given, ask for one — do not proceed without it.
- **Project** — default entity is Croceum (`project_canonical_2069d8fbe8ed625b`). If the transcript is about a different Doris Dev project, resolve it with `atlas_search_wiki` first.
- **ClickUp list** — the operator names the target ClickUp list (or you use the agreed demo list). Confirm before writing. Prefix demo tasks with `[AGENT TESTING] `.

## Flow — propose inline, actuate only on approval

1. **Read the transcript** → extract the spoken text + participant names.

2. **Ground it.** Call `atlas_brief` with:
   `{ task: "Draft a client recap email + ClickUp task list for this Doris Dev meeting, grounded in Floppy memory", transcript: <text>, entityHints: ["Croceum"] }` (swap the hint if it's another project).
   Use the hydrated project profile, the resolved participant entities, the real **assertion IDs**, and the returned **suggestions** (they are pre-extracted decisions/actions). If `meta.fallback` is `true`, tell the operator grounding ran in degraded mode and proceed with lower confidence. Pull additional detail with `atlas_search_wiki` / `atlas_read_article` only as needed.

3. **Generate two artifacts yourself, in this session:**
   - **Recap email** — subject + body. Name participants by their resolved Floppy display names (never raw emails). Ground concrete claims (costs, dates, decisions) in real Brief assertion IDs. If there were no new commitments, say so — don't pad.
   - **ClickUp task list** — for each open commitment / explicit action item / unclosed decision: `{ title, description, owner, due? }`. Each task should trace to a real assertion, not a generic "follow up."

4. **Propose INLINE — do NOT actuate yet.** Print the full recap email (subject + body) and the task list right in the chat so the operator can read and react.

5. **Ask the operator what to do:** (a) push the tasks to ClickUp · (b) keep the inline proposal only · (c) edit first. Act on ONLY what they choose. (Email stays inline/copyable — this edition does not send email.)

6. **If ClickUp chosen:** confirm the ClickUp connector is connected (Cowork → Connectors → ClickUp). Then:
   - Submit a `clickup_task_batch` draft to Floppy via `atlas_submit_review_required_draft` (capture the draft id) so there's a grounded, review-required record.
   - Dedup against the target list (list existing tasks), then create the remaining tasks with the ClickUp connector's create-task tool. Prefix demo tasks with `[AGENT TESTING] `.
   - Record the outbound receipt with `atlas_record_outbound_receipt` (idempotency key = sha256(draft id + sorted created task ids)) so re-runs are safe.
   - If ClickUp is NOT connected, say so and tell the operator to connect it (Cowork → Connectors → ClickUp), or copy the inline task list manually — do not fail the rest of the flow.

7. **Print what was created:** the inline email (always), and the created ClickUp task URLs + the Floppy task-draft id (if ClickUp was chosen). Nothing auto-sends — Floppy drafts are review-required and ClickUp writes go only to the named list.

## Failure modes
- `atlas_brief` slow (it can take ~15s) — that's expected; wait for it.
- 401 from Floppy → the Floppy connection's token is missing/expired; tell the operator to re-set `ATLAS_AGENT_TOKEN` (or reinstall the Floppy plugin with a fresh token).
- Zero participants resolved → continue but warn (likely a malformed transcript); reference the project entity instead.
- Zero commitments → say so in the email; the task list will be empty + flagged.
