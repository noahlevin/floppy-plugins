/**
 * Deterministic "prepare relationship brief" runner for the floppy:brief CLI
 * fallback.
 *
 * This intentionally does not call any LLM. In the live skill, Claude Code is
 * the brain and follows SKILL.md through the bundled `atlas` MCP. This runner
 * only proves the contract headlessly: resolve the subject entity from
 * `$ARGUMENTS` via wiki search, call `atlas_brief`, and render the 5-section
 * brief with real assertion-id citations.
 *
 * The subject entity is ALWAYS supplied by the caller (resolved from the
 * argument). There is no hardcoded entity id — that anti-pattern stays in the
 * single-tenant meeting-notes demo.
 */

import { createAtlasClient } from "../../_shared/atlas-client.mjs";
import { loadStyleProfile } from "../../_shared/style-profile.mjs";
import { renderBrief } from "./render.mjs";

export const DEFAULT_BRIEF_TASK =
  "Produce a grounded relationship brief for this entity, citing real assertion ids from Atlas memory";

/** SP-147 — the skill_id this skill loads its per-tenant style-profile under. */
export const BRIEF_SKILL_ID = "floppy-brief";

/**
 * @typedef {object} BriefRunOptions
 * @property {string} entity Subject name or entity id (from $ARGUMENTS).
 * @property {string} [since] Optional ISO recency window for recent changes.
 * @property {ReturnType<typeof createAtlasClient> | object} [atlasClient]
 * @property {string} [atlasUrl]
 * @property {string} [bearer]
 * @property {string} [serverlessBearer]
 * @property {typeof fetch} [fetchImpl]
 * @property {string} [task]
 * @property {number} [limit]
 * @property {(message: string, meta?: object) => void} [log]
 */

/**
 * @typedef {object} BriefRunResult
 * @property {{ query: string, entityId?: string, displayName?: string, resolvedVia: "id" | "search" | "unresolved" }} subject
 * @property {object} brief
 * @property {string} markdown
 * @property {string[]} resolvedEntityIds
 * @property {{ rules: Array<{ id: string, text: string, source: string, created_at: string }>, compiled: string }} styleProfile
 * @property {string[]} warnings
 */

/**
 * Heuristic: a value already looks like an entity id if it carries the
 * canonical `<kind>_<...>` shape (e.g. `project_canonical_...`, `person_...`,
 * `entity_...`). Anything else is treated as a search query.
 * @param {string} value
 * @returns {boolean}
 */
const looksLikeEntityId = (value) =>
  /^(project|person|entity|meeting)_[a-z0-9_]+$/i.test(value.trim());

/**
 * @param {BriefRunOptions} options
 * @returns {Promise<BriefRunResult>}
 */
export const prepareBrief = async (options) => {
  const log = options.log ?? (() => {});
  const warnings = /** @type {string[]} */ ([]);
  const entityArg = typeof options.entity === "string" ? options.entity.trim() : "";
  if (entityArg.length === 0) {
    throw new Error("No subject entity provided: pass --entity <name|id>");
  }

  const atlas = /** @type {ReturnType<typeof createAtlasClient>} */ (
    options.atlasClient ??
      createAtlasClient({
        atlasUrl: options.atlasUrl ?? "",
        bearer: options.bearer ?? "",
        serverlessBearer: options.serverlessBearer,
        fetchImpl: options.fetchImpl,
        log,
      })
  );

  // 1. Resolve the subject. If the argument already looks like an entity id,
  // use it directly; otherwise search the wiki and take the top hit.
  /** @type {BriefRunResult["subject"]} */
  let subject;
  /** @type {string[]} */
  let entityHints;
  if (looksLikeEntityId(entityArg)) {
    subject = { query: entityArg, entityId: entityArg, resolvedVia: "id" };
    entityHints = [entityArg];
  } else {
    log("resolving_entity", { query: entityArg });
    const search = await atlas.searchWiki(entityArg, { limit: 5 });
    const top = search.results.find((hit) => hit.kind === "entity") ?? search.results[0];
    if (top) {
      subject = {
        query: entityArg,
        entityId: top.id,
        displayName: top.title,
        resolvedVia: "search",
      };
      entityHints = [top.title || entityArg];
    } else {
      warnings.push(
        `Wiki search returned no hits for "${entityArg}"; falling back to the raw name as an entity hint.`,
      );
      subject = { query: entityArg, resolvedVia: "unresolved" };
      entityHints = [entityArg];
    }
  }

  // 2. Brief. The tenant is derived from the bearer server-side.
  log("calling_atlas_brief", { entityHints });
  const brief = await atlas.brief({
    task: options.task ?? DEFAULT_BRIEF_TASK,
    entityHints,
    limit: options.limit ?? 6,
  });

  const resolvedEntityIds = Array.isArray(
    /** @type {any} */ (brief).meta?.resolvedEntityIds,
  )
    ? /** @type {string[]} */ (/** @type {any} */ (brief).meta.resolvedEntityIds)
    : [];

  // If we resolved via search but Brief returned a different canonical id for
  // the same subject, prefer Brief's id for section selection.
  if (subject.resolvedVia !== "id" && resolvedEntityIds.length > 0 && !subject.entityId) {
    subject = { ...subject, entityId: resolvedEntityIds[0] };
  }

  // 3. SP-147 — load this skill's per-tenant style profile (live skill injects
  // it into prose generation; the deterministic fallback just surfaces it).
  const styleProfile = await loadStyleProfile(atlas, BRIEF_SKILL_ID, log);

  // 4. Render the 5-section brief with real citations.
  const markdown = renderBrief({
    brief: /** @type {any} */ (brief),
    subject,
    ...(options.since ? { since: options.since } : {}),
  });

  const hydrated = Array.isArray(/** @type {any} */ (brief).hydrated)
    ? /** @type {any} */ (brief).hydrated
    : [];
  if (hydrated.length === 0) {
    warnings.push(
      `Floppy returned no hydrated profile for "${entityArg}". The brief degrades to an explicit no-data note.`,
    );
  }

  return {
    subject,
    brief: /** @type {object} */ (brief),
    markdown,
    resolvedEntityIds,
    styleProfile: { rules: styleProfile.rules, compiled: styleProfile.compiled },
    warnings,
  };
};
