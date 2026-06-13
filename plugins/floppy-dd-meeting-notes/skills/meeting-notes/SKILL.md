---
name: meeting-notes
description: Claude Code playbook for turning a Croceum meeting transcript into a recap email + ClickUp task list, proposed INLINE in the session for review; then, only on operator approval, teed up as an email draft (Superhuman) and/or pushed to ClickUp. Grounded in Atlas/Floppy memory.
trigger: invoked manually by the demo operator once the Croceum weekly check-in transcript is available — pasted/uploaded into the session, or as a local file in the CLI fallback
---

# meeting-notes - Floppy/Atlas demo

Claude Code is the brain for this skill. Do not spawn a Node LLM subprocess.
The Node code in this directory is only for deterministic parsing/helpers and
the CLI fallback.

The demo flow is **propose inline, then actuate only on approval**. Generate the
recap email and the task list and print them in the session first. Only after the
operator chooses do you create the email draft and/or push tasks to ClickUp.
Nothing auto-sends: Atlas drafts are review-required, the email lands as a draft,
and ClickUp writes go only to the throwaway demo list named by `CLICKUP_DEMO_LIST_ID`.

## Grounding rule (strict)

Use ONLY information returned by the Floppy/Atlas MCP tools (`atlas_*`) for facts,
plus the transcript the operator pasted/uploaded (or, in the CLI fallback, read
from a local file). Do not use prior knowledge, the web, other MCP servers, or
other files for facts about the client. If Floppy doesn't have something, say so —
never invent it. The email and ClickUp tools are output channels, not data
sources; the grounding rule still holds.

## Inputs and environment

- **Transcript (primary path):** the operator pastes the transcript into the
  session or uploads a transcript file. It can be JSON (any Granola-style or
  generic shape) or plain text. There is no required local path — this is what
  makes the skill work in Cowork, where there is no local filesystem.
- **Transcript (CLI fallback only):** `--transcript-file <path>`,
  `--transcript-json <string>`, or `--transcript-stdin` (pipe the transcript in).
  Exactly one is required; there is no hardcoded default file.
- `CLICKUP_DEMO_LIST_ID`: required for the live MCP ClickUp write step.
- `CLICKUP_TASK_PREFIX` (optional): string prepended to every created ClickUp task
  name. For the Doris Dev demo set this to `[AGENT TESTING] ` — the demo list lives
  inside the shared Croceum folder, so the prefix marks tasks as disposable test
  data. Clean them up afterward via `clickup_delete_task`.
- Optional CLI fallback env: `ATLAS_AGENT_BEARER`, `ATLAS_API_URL`,
  `ATLAS_SERVERLESS_BEARER`, `ATLAS_TENANT_SLUG`.

The Croceum project entity id is:
`project_canonical_2069d8fbe8ed625b`.

## Live demo steps

Execute these steps in order.

1. Read transcript.

   Take the transcript the operator pasted or uploaded (a raw string — JSON or
   plain text). Parse it into `{ text, participants, title, occurredAt }` using
   `parseTranscriptText` from `lib/transcript.mjs`. No filesystem read is
   needed, so this works in Cowork.

   Example helper call (transcript passed in via the `TRANSCRIPT_TEXT` env var
   to avoid any local path):

   ```bash
   node --input-type=module -e 'import { parseTranscriptText } from "./skills/meeting-notes/lib/transcript.mjs"; const t = parseTranscriptText(process.env.TRANSCRIPT_TEXT); console.log(JSON.stringify(t, null, 2));'
   ```

   In the CLI fallback only, `readTranscriptFile(path)` still reads a local JSON
   file if you prefer to point at one.

2. Brief.

   Call MCP tool `atlas_brief` with exactly this shape:

   ```json
   {
     "task": "Draft a client recap email + ClickUp task list for this Croceum weekly check-in, grounded in Atlas memory",
     "transcript": "<text from parser>",
     "entityHints": ["Croceum"]
   }
   ```

   Use the returned `hydrated[]`, `index[]`, and `suggestions[]`. Pay special
   attention to the hydrated Croceum Project profile. Its entity id should be
   `project_canonical_2069d8fbe8ed625b`.

3. Generate recap and task list yourself.

   Claude Code writes the content directly. Do not call Node or an LLM CLI to
   generate prose. These are PROPOSALS — you do not actuate anything in this step.

   Recap email:
   - Produce `subject` and markdown `body`.
   - Name participants by resolved display names from Brief when available;
     otherwise use the parsed transcript names.
   - Weave inline references to real Croceum memory from Brief.
   - Ground concrete claims in real assertion ids from
     `hydrated[].citations.assertionIds` and `hydrated[].facts[].assertionId`.
   - If Brief returns no open commitments, say so directly.

   Task list:
   - Each task has `title`, `description`, optional `assignee_email`,
     optional `due_date`, `project_alias: "croceum"`, and optional
     `source_assertion_id`.
   - Tie tasks to real Brief assertion ids when possible.
   - Do not invent tasks beyond transcript actions or Atlas open commitments.

4. Propose inline — do NOT actuate yet.

   Print the full recap email (subject + body) and the task list (as a markdown
   table) directly in the session so the operator can read and react to them before
   anything is created.

5. Ask the operator what to do.

   Use `AskUserQuestion`:
   - (a) Create the email draft in Superhuman
   - (b) Push the tasks to ClickUp
   - (c) Both
   - (d) Neither — keep the inline proposal only

   Act on ONLY what they choose. If they pick (d), stop here.

6. If email chosen — tee up the recap as an email draft in the operator's email app (NOT Atlas Outbox).

   Call the email MCP `create_or_update_draft` (demo:
   `mcp__superhuman-mail-seriouspeople__create_or_update_draft`; in production, the
   operator's connected email MCP):

   ```json
   {
     "type": "new",
     "subject": "<subject>",
     "body": "<recap rendered as simple HTML>",
     "to": ["<participant emails when known; omit to let the operator fill recipients>"]
   }
   ```

   Use `body` (HTML), NOT `instructions`, so the recap is saved exactly as you wrote it —
   grounded, not AI-rewritten. Capture the returned `draft_id` and `open_url`. The draft
   lands in the operator's email app → Drafts for human review/send. Nothing is sent.

7. If ClickUp chosen — write the tasks (resilient to connection drops).

   First confirm the ClickUp MCP is connected (the `clickup_*` tools are available).
   If it is NOT connected, tell the operator to reconnect it (`/mcp` → clickup →
   Reconnect) or copy the inline task list by hand, and skip the rest of this step —
   do not fail the email or the proposal.

   **SP-164 — connection-drop resilience.** ClickUp drops intermittently mid-write
   ("ClickUp is offline", seen live 2026-06-04). Drive the actual writes through the
   deterministic resilience contract in `lib/clickup-resilience.mjs` so a blip does
   not lose tasks, create duplicates, or block the rest of the flow. You remain the
   ONLY actuator — the helper wraps the `clickup_*` MCP calls you pass into it; it
   opens no connection of its own. The contract:

   - **Bounded retry + backoff:** each `clickup_filter_tasks` / `clickup_create_task`
     call retries on connection-shaped failures (offline, timeout, 5xx, 429) with
     capped exponential backoff, up to a small attempt cap. It does NOT hammer, and
     it fails fast on permanent errors (auth, 4xx validation).
   - **Idempotent hold + replay:** dedup runs against the existing list AND tasks
     created earlier in the batch, so re-running after a reconnect creates each task
     exactly once — never duplicates. If the dedup read itself is unreachable, the
     WHOLE batch is held (never blind-created), so a later replay can't double-write.
   - **Graceful degradation:** on a persistent drop the batch never throws. It
     returns `{ status: "degraded", created, held, warnings, resolutionSteps }`.
     Surface the created tasks, tell the operator exactly which tasks are HELD (not
     lost), and print the `resolutionSteps` verbatim:
       1. Reconnect the ClickUp connector in **Cowork → Connectors** (Reconnect / Re-authorize).
       2. Complete the ClickUp OAuth re-auth if prompted; confirm the right workspace.
       3. Verify the demo list is reachable in that workspace.
       4. Re-run step 7 once connected — held tasks replay idempotently (no duplicates).
     The recap email and the inline proposal still stand regardless — never block them
     on a ClickUp drop.

   If connected:

   a. Submit the task-batch draft to Floppy first. Build a markdown table of the
      tasks for human review, then call `atlas_submit_review_required_draft`:

      ```json
      {
        "type": "clickup_task_batch",
        "targetEntityId": "project_canonical_2069d8fbe8ed625b",
        "targetKind": "project",
        "body": "<markdown task table>",
        "payload": {
          "tasks": [
            {
              "title": "<task title>",
              "description": "<task description>",
              "assignee_email": "<optional email>",
              "due_date": "<optional YYYY-MM-DD>",
              "project_alias": "croceum",
              "source_assertion_id": "<real Brief assertion id when available>"
            }
          ]
        },
        "citations": [{ "assertion_id": "<real Brief assertion id>" }]
      }
      ```

      Capture this draft id from `response.draft.id`. Call it `TASK_DRAFT_ID`.

   b. Write the tasks through the resilient batch writer. Apply `CLICKUP_TASK_PREFIX`
      (if set) to each task `name` FIRST so dedup compares prefixed names. Then call
      `writeClickupTasksResilient` from `lib/clickup-resilience.mjs`, passing your own
      MCP-backed actuators so you stay the only actuator:

      ```bash
      node --input-type=module -e '
        import { writeClickupTasksResilient } from "./skills/meeting-notes/lib/clickup-resilience.mjs";
        // filterTasks → your clickup_filter_tasks({ list_ids:[LIST], include_closed:true }) → tasks[]
        // createTask  → your clickup_create_task({ list_id:LIST, name, markdown_description, due_date })
        //               → { externalId: id, title, url }
        const result = await writeClickupTasksResilient({
          listId: process.env.CLICKUP_DEMO_LIST_ID,
          tasks: PROPOSED_TASKS,   // [{ name, markdown_description, due_date }]
          filterTasks, createTask,
        });
        console.log(JSON.stringify(result, null, 2));
      '
      ```

      The helper dedups (trimmed, case-insensitive, against the existing list + this
      batch), retries connection-shaped failures with capped backoff, and degrades
      gracefully. Read `result.status`:
        - `"completed"` → use `result.created` (`{ externalId, title, url }`) for the receipt.
        - `"degraded"` → ClickUp dropped. Print `result.warnings` + `result.resolutionSteps`,
          tell the operator which `result.held` tasks are queued, record the receipt for
          `result.created` only, and continue — do NOT fail the email or the proposal.

   d. Record the receipt for the tasks that WERE created (`result.created`). Derive
      `idempotencyKey` as the SHA-256 of: `TASK_DRAFT_ID + sorted created ClickUp task
      ids` (use `deriveReceiptIdempotencyKey` from `lib/output-formatter.mjs`). On a
      degraded run, record only `result.created` — the held tasks get their own receipt
      on the next (idempotent) replay. Call `atlas_record_outbound_receipt`:

      ```json
      {
        "draftId": "<TASK_DRAFT_ID>",
        "listId": "<CLICKUP_DEMO_LIST_ID>",
        "results": [
          {
            "externalId": "<clickup task id>",
            "title": "<task title>",
            "url": "<clickup task url>"
          }
        ],
        "idempotencyKey": "<sha256>"
      }
      ```

8. Print what was created.

   Print only the links for the channels the operator chose:

   ```text
   Email draft: <open_url from create_or_update_draft>   (operator's email app → Drafts)
   Task draft:  https://bart-silk.vercel.app/t/doris-dev/drafts/<task draft id>
   ClickUp:     <created task url>
   ```

## Failure modes

| Failure | Handling |
|---|---|
| Transcript parse fails | Stop and show the parse error plus the path used. |
| `atlas_brief` fails | Stop. Do not propose ungrounded content. |
| Brief has no Croceum project | Stop unless another hydrated entity is clearly the Croceum Project. |
| Brief has no assertion ids | Stop. The proposal needs at least one real citation. |
| No open commitments | Continue; recap says no open commitments, task list can be empty. |
| Operator picks "neither" | Keep the inline proposal only. Create nothing. |
| Email draft create fails | Report it. Continue to ClickUp if that was also chosen — the channels are independent. |
| ClickUp MCP not connected | Tell the operator to reconnect (`/mcp` → clickup) or copy the inline list. Do not fail the email or the proposal. |
| `CLICKUP_DEMO_LIST_ID` missing | Skip the ClickUp write and print the missing-env warning. |
| Task draft submit fails | Skip the ClickUp write (the receipt must attach to `TASK_DRAFT_ID`) and report it. |
| ClickUp dedupe finds matching titles | Skip those creates and include only created tasks in the receipt (the resilient writer does this automatically via `result.skippedDuplicates`). |
| ClickUp create fails after some creates | The resilient writer returns `status:"degraded"` with `created` + `held`. Record the receipt for `result.created` if `TASK_DRAFT_ID` exists, print `result.warnings` + `result.resolutionSteps`, name the held tasks, and continue. |
| ClickUp drops mid-write / "ClickUp is offline" (SP-164) | Handled by `writeClickupTasksResilient`: bounded retry with backoff, then graceful degradation. Surface `result.resolutionSteps` (reconnect in Cowork → Connectors, re-auth, check workspace) and tell the operator the held tasks replay idempotently on re-run. Never block the recap or proposal. |
| Dedup read (`clickup_filter_tasks`) unreachable | The resilient writer holds the WHOLE batch (`status:"degraded"`, `clickupReachable:false`) rather than blind-creating, so a later replay can't double-write. Surface the resolution steps. |
| ClickUp comes back and operator re-runs | Replay is idempotent — dedup against the now-populated list means each task is created exactly once, no duplicates. |
| Receipt call dedupes | Treat as success and still print the links. |

## CLI fallback

The CLI fallback prepares deterministic drafts only. Provide the transcript via
a pasted string, stdin, or a local file (exactly one):

```bash
# Pasted/uploaded string (no local FS needed):
ATLAS_AGENT_BEARER=... \
  node skills/meeting-notes/bin/run.mjs --transcript-json "$TRANSCRIPT"

# Piped over stdin:
cat transcript.json | ATLAS_AGENT_BEARER=... \
  node skills/meeting-notes/bin/run.mjs --transcript-stdin

# Local file:
ATLAS_AGENT_BEARER=... \
  node skills/meeting-notes/bin/run.mjs --transcript-file ./transcript.json
```

It calls `/v1/agent/v1/brief`, submits both review-required drafts, prints the
task list, and exits without writing to ClickUp.

## Attribution

The `💾 _from Floppy: <one short grounding fact>_` footer is only for the
operator-facing summary or chat reply. Do NOT put that footer in the recap email
body, ClickUp task title, ClickUp task description, or any other third-party
deliverable; provenance for those deliverables is carried by receipts.
