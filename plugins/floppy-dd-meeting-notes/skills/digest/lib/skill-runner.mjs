/**
 * Deterministic "prepare recent-changes digest" runner for the floppy:digest
 * CLI fallback.
 *
 * This intentionally does not call any LLM. In the live skill, Claude Code is
 * the brain and follows SKILL.md through the bundled `atlas` MCP. This runner
 * only proves the contract headlessly: resolve the subject entity from
 * `$ARGUMENTS` via wiki search, call `atlas_brief` (which returns per-entity
 * `recentChanges`), optionally deepen the window via `atlas_read_profile_context`
 * when a `since` is supplied, and render the digest with real assertion-id /
 * source-artifact-id citations.
 *
 * The subject entity is ALWAYS supplied by the caller (resolved from the
 * argument). There is no hardcoded entity id.
 */

import { createAtlasClient } from "../../_shared/atlas-client.mjs";
import { loadStyleProfile } from "../../_shared/style-profile.mjs";
import { pickPrimaryEntity } from "../../_shared/output.mjs";
import { renderDigest } from "./render.mjs";
import { groupRecentChanges } from "./recent-changes.mjs";

export const DEFAULT_DIGEST_TASK =
  "Produce a grounded recent-changes digest for this entity, citing real assertion and source-artifact ids from Atlas memory";

/** SP-147 — the skill_id this skill loads its per-tenant style-profile under. */
export const DIGEST_SKILL_ID = "floppy-digest";

/**
 * @typedef {object} DigestRunOptions
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
 * @typedef {object} DigestRunResult
 * @property {{ query: string, entityId?: string, displayName?: string, resolvedVia: "id" | "search" | "unresolved" }} subject
 * @property {object} brief
 * @property {string} markdown
 * @property {string[]} resolvedEntityIds
 * @property {{ since?: string, eventCount: number, assertionCount: number, sourceArtifactCount: number, citationIds: string[] }} changes
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
 * Normalize the `--since` shorthand. Accepts an ISO date/datetime (passed
 * through) or a relative `<n>d` window (e.g. `7d`) which is converted to an
 * ISO timestamp `n` days before `now`. Anything else returns undefined so the
 * caller falls back to Brief's own default window.
 * @param {string | undefined} since
 * @param {Date} [now]
 * @returns {string | undefined}
 */
export const normalizeSince = (since, now = new Date()) => {
  if (typeof since !== "string" || since.trim().length === 0) return undefined;
  const trimmed = since.trim();
  const relativeMatch = /^(\d+)d$/i.exec(trimmed);
  if (relativeMatch) {
    const days = Number(relativeMatch[1]);
    const ms = now.getTime() - days * 24 * 60 * 60 * 1000;
    return new Date(ms).toISOString();
  }
  // ISO date or datetime — pass through unchanged if it parses.
  if (!Number.isNaN(Date.parse(trimmed))) return trimmed;
  return undefined;
};

/**
 * @param {DigestRunOptions} options
 * @returns {Promise<DigestRunResult>}
 */
export const prepareDigest = async (options) => {
  const log = options.log ?? (() => {});
  const warnings = /** @type {string[]} */ ([]);
  const entityArg = typeof options.entity === "string" ? options.entity.trim() : "";
  if (entityArg.length === 0) {
    throw new Error("No subject entity provided: pass --entity <name|id>");
  }

  const since = normalizeSince(options.since);
  if (options.since && !since) {
    warnings.push(
      `Could not parse --since "${options.since}"; expected an ISO date or a relative window like "7d". Falling back to Brief's default window.`,
    );
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
  /** @type {DigestRunResult["subject"]} */
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

  // 2. Brief. The tenant is derived from the bearer server-side. Brief returns
  // per-entity `recentChanges` which is the grounding for the digest.
  log("calling_atlas_brief", { entityHints });
  const brief = await atlas.brief({
    task: options.task ?? DEFAULT_DIGEST_TASK,
    entityHints,
    limit: options.limit ?? 6,
  });

  const resolvedEntityIds = Array.isArray(
    /** @type {any} */ (brief).meta?.resolvedEntityIds,
  )
    ? /** @type {string[]} */ (/** @type {any} */ (brief).meta.resolvedEntityIds)
    : [];

  // If we resolved via search but Brief returned a canonical id for the same
  // subject, prefer Brief's id for section selection.
  if (subject.resolvedVia !== "id" && resolvedEntityIds.length > 0 && !subject.entityId) {
    subject = { ...subject, entityId: resolvedEntityIds[0] };
  }

  // 3. Deepen (optional). When a `since` window is supplied, ask Atlas for a
  // deeper profile-context read scoped to that window. The deterministic
  // fallback folds the deeper `recentChanges` into the target profile if the
  // read returns a richer event set; on any failure it degrades silently to
  // Brief's own changes.
  const target = pickPrimaryEntity(brief, subject.entityId);
  if (since && target?.entityId) {
    try {
      const deeper = await atlas.readProfileContext(target.entityId, { since });
      const deeperChanges = /** @type {any} */ (deeper)?.context?.recentChanges;
      const deeperEvents = Array.isArray(deeperChanges?.events)
        ? deeperChanges.events
        : [];
      const currentEvents = Array.isArray(target.recentChanges?.events)
        ? target.recentChanges.events
        : [];
      if (deeperEvents.length > currentEvents.length) {
        target.recentChanges = {
          entityId: target.entityId,
          since,
          events: deeperEvents,
        };
        log("deepened_recent_changes", {
          entityId: target.entityId,
          events: deeperEvents.length,
        });
      } else if (!target.recentChanges?.since) {
        // Annotate the window even when we didn't gain events.
        target.recentChanges = {
          ...(target.recentChanges ?? { entityId: target.entityId, events: currentEvents }),
          since,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("deepen_degraded", { error: message });
      warnings.push(
        `Could not deepen the window via profile context (${message}); using Brief's recent changes.`,
      );
    }
  }

  // 4. SP-147 — load this skill's per-tenant style profile (live skill injects
  // it into prose generation; the deterministic fallback just surfaces it).
  const styleProfile = await loadStyleProfile(atlas, DIGEST_SKILL_ID, log);

  // 5. Render the digest with real citations.
  const markdown = renderDigest({
    brief: /** @type {any} */ (brief),
    subject,
    ...(since ? { since } : {}),
  });

  const grouped = groupRecentChanges(target?.recentChanges);

  const hydrated = Array.isArray(/** @type {any} */ (brief).hydrated)
    ? /** @type {any} */ (brief).hydrated
    : [];
  if (hydrated.length === 0) {
    warnings.push(
      `Floppy returned no hydrated profile for "${entityArg}". The digest degrades to an explicit no-data note.`,
    );
  } else if (grouped.isEmpty) {
    warnings.push(
      `Floppy returned no recent changes for "${entityArg}" in this window. The digest says so explicitly.`,
    );
  }

  return {
    subject,
    brief: /** @type {object} */ (brief),
    markdown,
    resolvedEntityIds,
    changes: {
      ...(grouped.since ? { since: grouped.since } : {}),
      eventCount: grouped.all.length,
      assertionCount: grouped.assertions.length,
      sourceArtifactCount: grouped.sourceArtifacts.length,
      citationIds: grouped.citationIds,
    },
    styleProfile: { rules: styleProfile.rules, compiled: styleProfile.compiled },
    warnings,
  };
};
