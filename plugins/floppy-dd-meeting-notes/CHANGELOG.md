# Changelog

## 0.2.2

- SP-340: Consolidated canonical distribution home to `noahlevin/floppy-plugins` (this repo). Ported v0.2.1 from the bart repo, which previously hosted an embedded split-brain copy. floppy-plugins is now the sole install source.
- No functional changes from 0.2.1.

## 0.2.1

- SP-986: Manifest fix for hooks key in marketplace.json. Capture hooks now correctly installed on plugin add.

## 0.2.0

- Add the `floppy:*` skill suite (SP-162): `floppy:digest`, `floppy:follow-up`, `floppy:agenda`, `floppy:proposal` — all grounded only via Floppy, tenant-from-bearer, entity resolved at runtime (no hardcoding). Joins `floppy:brief` and the `floppy:meeting-notes` reference skill.

## 0.1.0

- Initial Floppy plugin scaffold, manifest, marketplace entry, and documentation.
- `floppy:brief` skill + shared `_shared/` skill library + `test:plugin` wired into `npm run check`.
