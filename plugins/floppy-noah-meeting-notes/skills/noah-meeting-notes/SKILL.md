---
name: noah-meeting-notes
description: Turn a Noah meeting transcript into a grounded recap + Todoist task list. The operator pastes or uploads a transcript; the skill grounds it in Floppy memory (atlas_* tools) for the serious-people tenant, proposes the recap + tasks INLINE for review, and only on approval writes the tasks to Todoist (idempotently). Use after one of Noah's client/partner meetings.
---

# Floppy → Noah meeting notes (Cowork)

You are running the Floppy meeting-notes playbook for Noah. **You are the brain; Floppy is the grounding layer.** This is the Cowork edition: the operator works in Cowork, not Claude Code, so there is no local file path and no command-line helper — the transcript arrives by paste or upload.

## Grounding rule (strict)
Use ONLY information returned by the Floppy MCP tools (`atlas_*`) for facts about the people, the accounts/projects, and the commitments. Do NOT use prior knowledge, the web, other connectors, or memory for those facts. The transcript the operator gives you is the only other input. **If Floppy doesn't have something, say so out loud — never invent it.**

**Tenant scope is hard:** this skill is bound to the **`serious-people`** tenant via the `ATLAS_AGENT_TOKEN` the plugin ships with. Never read or cite anything from another tenant. If a transcript is clearly about a different workspace, say so and stop — do not cross tenants.

Channels vs. data: the transcript + `atlas_*` are your **data**. Todoist is an **output channel** only (where approved tasks land). The grounding rule still holds — never pull client facts from Todoist.

## Inputs
- **Transcript** — the operator pastes the transcript text directly into the chat, or uploads a file (`.txt`, `.json`, `.vtt`, `.md`). If it's structured JSON (e.g. `[{speaker_name, sentence}, ...]`), flatten it to `Speaker: text` lines yourself. If no transcript is given, ask for one — do not proceed without it.
- **Subject entity** — Noah's meetings span many accounts/people/projects, so there is **no default entity**. Infer the likely subject (client, partner, project) from the transcript's participants + topic, then resolve it with `atlas_search_wiki` before grounding. If you can't resolve a confident subject, ask the operator which entity this meeting is about.
- **Todoist target** — the operator names the target Todoist project (or you use the agreed default project). Confirm before writing.

## Flow — propose inline, actuate only on approval

1. **Read the transcript** → extract the spoken text + participant names.

2. **Ground it.** Call `atlas_brief` with:
   `{ task: "Draft a recap + Todoist task list for this meeting, grounded in Floppy memory", transcript: <text>, entityHints: [<resolved subject + key participant names>] }`.
   Use the hydrated profile(s), the resolved participant entities, the real **assertion IDs**, and the returned **suggestions** (pre-extracted decisions/actions). If `meta.fallback` is `true`, tell the operator grounding ran in degraded mode and proceed with lower confidence. Pull additional detail with `atlas_search_wiki` / `atlas_read_article` only as needed.

3. **Generate two artifacts yourself, in this session:**
   - **Recap** — a tight summary in Noah's voice (see House style below). Name participants by their resolved Floppy display names (never raw emails). Ground concrete claims (numbers, dates, decisions) in real Brief assertion IDs. If there were no new commitments, say so — don't pad.
   - **Todoist task list** — for each open commitment / explicit action item / unclosed decision: `{ content, description, due_string?, project? }`. Each task should trace to a real assertion, not a generic "follow up." Keep titles imperative and specific.

4. **Propose INLINE — do NOT actuate yet.** Print the full recap and the task list right in the chat so the operator can read and react.

5. **Ask the operator what to do:** (a) push the tasks to Todoist · (b) keep the inline proposal only · (c) edit first. Act on ONLY what they choose. (The recap stays inline/copyable — this edition does not send anything on Noah's behalf.)

6. **If Todoist chosen — write with dedup.** First create the grounded audit record, then write tasks with list-then-create dedup so an ordinary re-run doesn't create duplicates (the Todoist-sync-explosion lesson: 4,253 dupes came from skipping dedup entirely).
   - Submit a `task_batch` draft to Floppy via `atlas_submit_review_required_draft` (capture the **draft id**) so there's a grounded, review-required record.
   - **Transport:** Todoist has no Cowork connector or MCP today, so writes go via the **Todoist REST API** using a `TODOIST_API_TOKEN` available to this environment.
     - If `TODOIST_API_TOKEN` is **NOT** available, do NOT fail — tell the operator Todoist auto-write isn't wired yet, leave the task list inline for them to copy, and still record the receipt for what was proposed. (This is the graceful fallback; the rest of the flow continues.)
     - If it **is** available:
       1. **List-then-create dedup (the primary guard):** `GET https://api.todoist.com/api/v1/tasks` (filtered to the target project) → collect existing task `content` (titles). Drop any proposed task whose normalized title already exists. This prevents the common duplicate case (an ordinary re-run of the same transcript).
       2. **Create only net-new tasks:** for each remaining task, `POST https://api.todoist.com/api/v1/tasks` with `Authorization: Bearer ${TODOIST_API_TOKEN}` + `Content-Type: application/json`. Body: `{ "content", "description", "due_string"?, "project_id"? }`. **Note:** Todoist's REST create endpoint has **no idempotency header** — list-then-create is best-effort and does not cover a lost-response retry or two concurrent runs. For hard idempotency (only if a future version needs it), use the **Sync API** instead: `POST /api/v1/sync` with an `item_add` command carrying a **stable command `uuid = sha256(draft_id + ":" + normalized_title)`** — Todoist dedupes Sync commands by `uuid`, so a replay is a no-op. Do NOT invent a REST idempotency header.
       3. **Never** create a task that has no resolved Floppy assertion behind it.
   - Record the outbound receipt with `atlas_record_outbound_receipt` (idempotency key = `sha256(draft_id + sorted(created_task_ids))`) so re-runs are safe at the Floppy layer too.

7. **Print what was created:** the inline recap (always), and the created Todoist task URLs + the Floppy task-draft id (if Todoist was chosen). Nothing auto-sends — Floppy drafts are review-required and Todoist writes go only to the named project.

## House style (recap)
Match Noah's voice: lead with the answer/outcome, not throat-clearing. Short declarative sentences. No corporate register ("circle back", "synergies", "connective tissue"). Name the decision, the owner, the number, the date — concretely. If nothing was decided, say "No new decisions; open threads are …". Bullets for actions, prose for context. Don't pad to length.

## Failure modes
- `atlas_brief` slow (it can take ~15s) — that's expected; wait for it.
- 401 from Floppy → the `ATLAS_AGENT_TOKEN` is missing/expired; tell the operator to re-set it (or reinstall the Floppy plugin with a fresh **serious-people-scoped** token).
- Zero participants resolved → continue but warn (likely a malformed transcript); reference the subject entity instead.
- Zero commitments → say so in the recap; the task list will be empty + flagged.
- Todoist 403/401 → the `TODOIST_API_TOKEN` is missing/invalid; fall back to the inline list and tell the operator.
