# `_shared` — Floppy skill-suite shared library

Tenant-agnostic, skill-agnostic helpers shared by the `floppy:*` skill suite
(`brief`, and future siblings). Promoted from `meeting-notes/lib/` so the suite
maintains one Atlas client and one set of formatters instead of N divergent
copies.

`_shared` is **not** itself a skill — it has no `SKILL.md`, so the plugin loader
does not register it. It is an import target only.

## What lives here

- `atlas-client.mjs` — thin REST client for the Atlas agent mirror
  (`/v1/agent/v1/*`). Exposes `brief`, `searchWiki`, `readProfileContext`,
  `verify`, `submitReviewRequiredDraft`, `getSkillStyleProfile`,
  `recordOutboundReceipt`. The **tenant is always derived from the bearer
  server-side** — no method takes a tenant argument. Reads degrade cleanly on
  404/503.
- `output.mjs` — deterministic markdown/citation formatters
  (`renderSection`, `renderCitedBullet`, `renderTable`, `extractAssertionIds`,
  `pickPrimaryEntity`, `claimsFromDraft`, idempotency-key helpers). No
  skill-specific entity constants.
- `style-profile.mjs` — SP-147 per-tenant style-profile loader wrapper over
  `getSkillStyleProfile(skillId)`. Each skill declares its own `SKILL_ID`.

## Freeze rule (load-bearing)

**Import from `_shared` read-only. Do NOT edit `_shared` during a skill wave.**

`_shared` is created once (S0) and then frozen for the duration of a wave. The
parallel skill lanes (`brief`, etc.) each own their own `plugin/skills/<name>/`
subtree and import `_shared` without modifying it. This keeps `_shared` from
serializing the lanes or becoming a merge magnet. If a shared change is truly
required mid-wave, land it as its own change and re-freeze before resuming the
lanes.

## Tests

```bash
node --test plugin/skills/_shared/test/*.mjs
```

The repo `npm run check` runs `test:plugin`
(`node --test plugin/skills/*/test/*.mjs`), which includes these tests.
