# `skills/meeting-notes`

Claude Code playbook and deterministic fallback for the Floppy/Atlas Croceum
meeting-notes demo.

In the live path, Claude Code takes the transcript the operator pasted or
uploaded (a raw string — JSON or plain text; no local file needed, so it works
in Cowork), calls Atlas MCP Brief, writes the recap and tasks itself, submits
review-required Atlas drafts, writes deduped ClickUp tasks to the throwaway demo
list, and records an Atlas receipt.

The Node code here does not call an LLM. It provides:

- `lib/transcript.mjs`: defensive transcript parser. `parseTranscriptText`
  parses a pasted/uploaded string (JSON or plain text) with no FS read;
  `parseTranscriptJson` parses an already-parsed object; `readTranscriptFile`
  reads a local JSON file (CLI only).
- `lib/output-formatter.mjs`: deterministic helper functions for citations,
  markdown task tables, draft payloads, and idempotency keys.
- `lib/atlas-client.mjs`: tiny REST client for `/v1/agent/v1/*`.
- `lib/skill-runner.mjs`: deterministic "prepare drafts" fallback.
- `bin/run.mjs`: CLI fallback that submits both Atlas drafts and stops before
  ClickUp.

## Live operator path

Read `SKILL.md`. Required env:

```bash
export CLICKUP_DEMO_LIST_ID=<throwaway ClickUp list id>
```

Nothing auto-sends email. Atlas drafts are review-required. ClickUp writes are
only for the configured demo list.

## CLI fallback

Provide the transcript via a pasted string, stdin, or a local file (exactly
one):

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

Defaults:

- `ATLAS_API_URL=https://bart-silk.vercel.app`
- `ATLAS_TENANT_SLUG=doris-dev`

Exit codes:

- `0`: both drafts submitted.
- `2`: partial draft submission failure.
- `1`: fatal read/Brief/config failure.

## Tests

```bash
node --test skills/meeting-notes/test/*.mjs
```

The tests use a synthetic transcript fixture and a fake Atlas server. They do
not read or commit the real Croceum transcript.
