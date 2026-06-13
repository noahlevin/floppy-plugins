/**
 * Deterministic "prepare follow-up draft" runner for the floppy:follow-up CLI
 * fallback.
 *
 * This intentionally does not call any LLM and never sends email. In the live
 * skill, Claude Code is the brain and follows SKILL.md through the bundled
 * `atlas` MCP. This runner only proves the contract headlessly:
 *
 *   resolve subject from $ARGUMENTS  →  atlas_brief  →  build a grounded
 *   follow-up draft  →  SP-145 verify pass over its citations  →
 *   atlas_submit_review_required_draft (review-required only).
 *
 * The subject is ALWAYS supplied by the caller (resolved from the argument).
 * There is no hardcoded entity id, and there is NO email-send path anywhere —
 * the only outbound write is a review-required Atlas draft.
 */

import { createAtlasClient } from "../../_shared/atlas-client.mjs";
import { claimsFromDraft } from "../../_shared/output.mjs";
import { loadStyleProfile } from "../../_shared/style-profile.mjs";
import { FOLLOW_UP_SKILL_ID, buildFollowUpDraft } from "./draft.mjs";

export const DEFAULT_FOLLOW_UP_TASK =
  "Draft a grounded follow-up email for this entity, citing real assertion ids and open commitments from Atlas memory";

/**
 * @typedef {object} FollowUpRunOptions
 * @property {string} entity Subject name or entity id (from $ARGUMENTS).
 * @property {string[]} [recipients] Optional recipient emails for the draft.
 * @property {ReturnType<typeof createAtlasClient> | object} [atlasClient]
 * @property {string} [atlasUrl]
 * @property {string} [bearer]
 * @property {string} [serverlessBearer]
 * @property {typeof fetch} [fetchImpl]
 * @property {string} [task]
 * @property {number} [limit]
 * @property {boolean} [verify] Run the deterministic atlas_review verify pass
 *   before submitting. Defaults to env FOLLOW_UP_VERIFY !== "off".
 * @property {(message: string, meta?: object) => void} [log]
 */

/**
 * @typedef {object} FollowUpRunResult
 * @property {{ query: string, entityId?: string, displayName?: string, resolvedVia: "id" | "search" | "unresolved" }} subject
 * @property {object} brief
 * @property {import("./draft.mjs").FollowUpDraft} draft
 * @property {{ id: string } | null} submittedDraft
 * @property {string[]} resolvedEntityIds
 * @property {{ rules: Array<{ id: string, text: string, source: string, created_at: string }>, compiled: string }} styleProfile
 * @property {string[]} warnings
 */

/**
 * Heuristic: a value already looks like an entity id if it carries the
 * canonical `<kind>_<...>` shape (e.g. `project_canonical_...`, `person_...`).
 * Anything else is treated as a search query. Mirrors floppy:brief.
 * @param {string} value
 * @returns {boolean}
 */
const looksLikeEntityId = (value) =>
  /^(project|person|entity|meeting)_[a-z0-9_]+$/i.test(value.trim());

/**
 * Whether the deterministic verify pass should run. Off only when explicitly
 * disabled, so the safety check degrades cleanly without crashing the run.
 * @param {FollowUpRunOptions} options
 * @returns {boolean}
 */
const verifyEnabled = (options) => {
  if (typeof options.verify === "boolean") return options.verify;
  return (process.env.FOLLOW_UP_VERIFY ?? "").toLowerCase() !== "off";
};

/**
 * Run the deterministic verify pass and return human-readable warnings for any
 * contradicted/uncited/not_found/wrong_entity verdict. Never throws — a verify
 * failure degrades to a single soft warning so the draft path still runs.
 * @param {ReturnType<typeof createAtlasClient>} atlas
 * @param {Array<{ text: string }>} claims
 * @param {(message: string, meta?: object) => void} log
 * @returns {Promise<string[]>}
 */
const runVerifyPass = async (atlas, claims, log) => {
  if (claims.length === 0) return [];
  try {
    const result = /** @type {{ ok?: boolean, results?: Array<{ claim: string, verdict: string, detail?: string }>, summary?: object }} */ (
      await atlas.verify({ claims })
    );
    log("verify_complete", { ok: result.ok, summary: result.summary });
    const flagged = (result.results ?? []).filter(
      (entry) => entry.verdict !== "supported",
    );
    return flagged.map(
      (entry) =>
        `Verify flagged a citation as ${entry.verdict}: ${entry.claim}${
          entry.detail ? ` — ${entry.detail}` : ""
        }`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("verify_failed", { error: message });
    return [`Verify pass skipped (degraded): ${message}`];
  }
};

/**
 * @param {FollowUpRunOptions} options
 * @returns {Promise<FollowUpRunResult>}
 */
export const prepareFollowUp = async (options) => {
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

  // 1. Resolve the subject. A canonical id is used directly; a name is
  // resolved via wiki search. Mirrors floppy:brief.
  /** @type {FollowUpRunResult["subject"]} */
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
    task: options.task ?? DEFAULT_FOLLOW_UP_TASK,
    entityHints,
    limit: options.limit ?? 6,
  });

  const resolvedEntityIds = Array.isArray(
    /** @type {any} */ (brief).meta?.resolvedEntityIds,
  )
    ? /** @type {string[]} */ (/** @type {any} */ (brief).meta.resolvedEntityIds)
    : [];
  if (subject.resolvedVia !== "id" && resolvedEntityIds.length > 0 && !subject.entityId) {
    subject = { ...subject, entityId: resolvedEntityIds[0] };
  }

  // 3. SP-147 — load this skill's per-tenant style profile. The live path
  // injects it into the prose; the deterministic fallback surfaces it. Empty
  // profile (404/503/error) degrades to base behavior.
  const styleProfile = await loadStyleProfile(atlas, FOLLOW_UP_SKILL_ID, log);

  // 4. Build the grounded follow-up draft. Throws if Brief returned nothing to
  // cite — a follow-up MUST carry at least one real citation.
  const { draft } = buildFollowUpDraft({
    brief: /** @type {any} */ (brief),
    subject,
    ...(options.recipients ? { recipients: options.recipients } : {}),
  });

  // 5. SP-145 — deterministic fact-check BEFORE submitting. Seed verify claims
  // from the draft's citations; surface contradicted/uncited as soft warnings.
  if (verifyEnabled(options)) {
    const claims = claimsFromDraft("Follow-up", draft);
    log("running_verify", { claimCount: claims.length });
    warnings.push(...(await runVerifyPass(atlas, claims, log)));
  }

  // 6. Submit the review-required draft. This is the ONLY outbound write —
  // there is no email-send path. Idempotency-keyed so reruns dedup.
  /** @type {FollowUpRunResult["submittedDraft"]} */
  let submittedDraft = null;
  try {
    const response = /** @type {{ draft?: { id?: string } }} */ (
      await atlas.submitReviewRequiredDraft(draft)
    );
    const id = response.draft?.id;
    if (!id) throw new Error("Atlas draft response did not include draft.id");
    submittedDraft = { id };
    log("draft_submitted", { id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Follow-up draft submission failed: ${message}`);
  }

  return {
    subject,
    brief: /** @type {object} */ (brief),
    draft,
    submittedDraft,
    resolvedEntityIds,
    styleProfile: { rules: styleProfile.rules, compiled: styleProfile.compiled },
    warnings,
  };
};
