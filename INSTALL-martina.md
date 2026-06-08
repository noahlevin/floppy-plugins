# Onboarding Martina — Floppy meeting-notes in Cowork

Goal: Martina drops a meeting transcript into Cowork and gets a recap email + ClickUp tasks, grounded in Floppy. Guided (Noah on the call).

---

## 0. Prerequisites (confirm before the session) — human dependencies

- [ ] **Martina has Cowork access** (signed in, can install plugins / add connectors).
- [ ] **A Doris Dev Floppy token** — a `tenant_doris_dev` bearer (`atlas_…`). For the UAT you can reuse the known-good Doris Dev token; **better: mint a dedicated one for Martina** so it's independently revocable (tenant-admin → agent tokens). Keep it out of email/Slack — hand it over in a password manager or paste it directly into her Cowork.
- [ ] **Martina's ClickUp** — she can authorize the ClickUp connector, and you've agreed the target list (use the `[AGENT TESTING]` demo list for the UAT).
- [ ] **A sample transcript** ready to paste (e.g. the 2026-05-28 Croceum weekly check-in).

---

## 1. Connect ClickUp (native Cowork connector)

Cowork → **Connectors** → **ClickUp** → Connect → authorize her workspace. This is standard OAuth; no token handling.

## 2. Install the Floppy plugin

Two ways, pick one:

**A. From the plugin folder (simplest for guided setup)**
1. Get her the `floppy-cowork-plugin` folder (zip or shared drive).
2. In Cowork: add it as a plugin / marketplace (`/plugin marketplace add <path>` → `/plugin install floppy-dd-meeting-notes@floppy`).
3. Provide the token: set `ATLAS_AGENT_TOKEN` to the Doris Dev bearer. If Cowork doesn't expose env vars to her, edit the installed copy's `.mcp.json` and replace `${ATLAS_AGENT_TOKEN}` with the literal `Bearer atlas_…` value (one line).

**B. Publish the plugin** to a Floppy marketplace she can install from (productized path — SP-180).

After install, confirm the `atlas` MCP shows connected and `atlas_*` tools are available.

## 3. Run the workflow

1. Martina opens the **dd-meeting-notes** skill (or just says "turn this meeting into a recap + ClickUp tasks").
2. She **pastes or uploads the transcript**.
3. The skill grounds it via Floppy (`atlas_brief` — takes ~15s) and **prints the recap email + task list inline**.
4. She reviews, then approves pushing the tasks to ClickUp (email she copies from the chat).
5. Tasks land in the named ClickUp list; nothing sends externally.

---

## Troubleshooting

- **`atlas` MCP won't connect / 401** → token missing or expired. Re-set `ATLAS_AGENT_TOKEN` (or re-paste the literal `Bearer atlas_…` in `.mcp.json`).
- **Cowork's plugin loader refuses the bundled bearer header** (the one residual unknown — Cowork may treat plugin MCP auth differently than Claude Code). Fallback that's guaranteed to work today:
  - Run the same flow in **Claude Code**:
    `claude mcp add --transport http atlas https://bart-silk.vercel.app/api/mcp --header "Authorization: Bearer atlas_…"`
    then connect ClickUp + run the skill. (Contradicts "must be Cowork," but unblocks the demo if needed.)
- **ClickUp tools missing** → reconnect the ClickUp connector in Cowork → Connectors.
- **Grounding looks thin / `fallback:true`** → Floppy's live grounding model didn't run; output is degraded but real. Note it and continue.

## Security note

The Doris Dev token grants read of the Doris Dev wiki + submit of review-required drafts, RLS-scoped to that tenant only — it cannot send email or cross tenants. Still, treat the token as a secret: don't commit it, prefer a dedicated revocable token over a shared one, rotate after the UAT if it was pasted into a file.
