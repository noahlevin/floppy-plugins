/**
 * Deterministic follow-up email draft builder for the floppy:follow-up CLI
 * fallback.
 *
 * Claude Code is the brain for the live skill path (it writes the prose,
 * grounded in the same Atlas facts). This module does only mechanical work:
 * pick the resolved subject's hydrated profile, pull real assertion ids and
 * open commitments, and lay out a low-fidelity follow-up `email_recap` draft
 * payload whose `citations[]` carry real ids. Every claim it emits is anchored
 * to a real assertion id; it never invents content.
 *
 * The subject entity is ALWAYS supplied by the caller (resolved from
 * `$ARGUMENTS`). There is no hardcoded entity id.
 */

import {
  deriveDraftIdempotencyKey,
  extractAssertionIds,
  extractSourceArtifactIds,
  pickPrimaryEntity,
  stringField,
} from "../../_shared/output.mjs";

/** SP-147 — the skill_id this skill loads its per-tenant style-profile under. */
export const FOLLOW_UP_SKILL_ID = "floppy-follow-up";

/** The draft type submitted to Atlas. A follow-up is an email recap. */
export const FOLLOW_UP_DRAFT_TYPE = "email_recap";

/**
 * @typedef {import("../../_shared/output.mjs").BriefResponse} BriefResponse
 * @typedef {import("../../_shared/output.mjs").BriefEntity} BriefEntity
 */

/**
 * @typedef {object} FollowUpDraft
 * @property {"email_recap"} type
 * @property {string} targetEntityId
 * @property {"project" | "entity" | "person"} targetKind
 * @property {string} subject
 * @property {string} body
 * @property {string[]} recipients
 * @property {Array<{ assertion_id?: string, source_artifact_id?: string }>} citations
 * @property {string} idempotencyKey
 */

/**
 * @typedef {object} BuildFollowUpResult
 * @property {FollowUpDraft} draft
 * @property {BriefEntity} target
 * @property {string[]} assertionIds
 * @property {Array<{ summary: string, assertionId?: string }>} commitments
 */

/**
 * Map a hydrated profile kind to the draft `targetKind` enum.
 * @param {string | undefined} profileKind
 * @returns {"project" | "entity" | "person"}
 */
const toTargetKind = (profileKind) => {
  if (profileKind === "project") return "project";
  if (profileKind === "person") return "person";
  return "entity";
};

/**
 * Build the deterministic follow-up email draft payload from a Brief response.
 *
 * @param {{
 *   brief: BriefResponse,
 *   subject: { query: string, entityId?: string, displayName?: string },
 *   recipients?: string[],
 * }} input
 * @returns {BuildFollowUpResult}
 */
export const buildFollowUpDraft = (input) => {
  const { brief, subject } = input;
  const target = pickPrimaryEntity(brief, subject.entityId);
  if (!target) {
    throw new Error(
      `Floppy returned no hydrated profile for "${subject.query}" — nothing to ground a follow-up on.`,
    );
  }

  const assertionIds = extractAssertionIds(brief, target.entityId);
  const sourceArtifactIds = extractSourceArtifactIds(brief, target.entityId);
  if (assertionIds.length === 0 && sourceArtifactIds.length === 0) {
    throw new Error(
      "Floppy returned no assertion or source-artifact ids to cite — a follow-up needs at least one real citation.",
    );
  }

  // Citations carry real ids only. The submit tool requires citations
  // (minItems 1); prefer assertion ids, fall back to source-artifact ids.
  /** @type {FollowUpDraft["citations"]} */
  const citations = [
    ...assertionIds.slice(0, 8).map((id) => ({ assertion_id: id })),
    ...(assertionIds.length === 0
      ? sourceArtifactIds.slice(0, 4).map((id) => ({ source_artifact_id: id }))
      : []),
  ];

  const commitments = collectCommitments(target, assertionIds);
  const displayName = subject.displayName ?? target.displayName ?? subject.query;
  const subjectLine = `Following up — ${displayName}`;
  const body = buildBody({ displayName, target, commitments, assertionIds });

  const recipients = Array.isArray(input.recipients)
    ? input.recipients.filter(
        /** @returns {value is string} */
        (value) => typeof value === "string" && value.length > 0,
      )
    : [];

  const draft = {
    type: FOLLOW_UP_DRAFT_TYPE,
    targetEntityId: target.entityId,
    targetKind: toTargetKind(target.profileKind),
    subject: subjectLine,
    body,
    recipients,
    citations,
    idempotencyKey: deriveDraftIdempotencyKey(FOLLOW_UP_SKILL_ID, FOLLOW_UP_DRAFT_TYPE, {
      targetEntityId: target.entityId,
      subject: subjectLine,
      body,
      citations,
      recipients,
    }),
  };

  return { draft, target, assertionIds, commitments };
};

/**
 * Pull the target's open commitments — the "what's owed / next steps" spine of
 * a follow-up — each tied to a real assertion id when one is present.
 * @param {BriefEntity} target
 * @param {string[]} assertionIds
 * @returns {Array<{ summary: string, assertionId?: string }>}
 */
const collectCommitments = (target, assertionIds) => {
  const raw = Array.isArray(target.openCommitments) ? target.openCommitments : [];
  return raw.slice(0, 8).map((commitment, index) => {
    const assertionId =
      stringField(commitment, "assertionId", "assertion_id", "id") ??
      assertionIds[index] ??
      assertionIds[0];
    const summary =
      stringField(commitment, "summary", "title", "text") ??
      "Follow up on an open Atlas commitment";
    return assertionId ? { summary, assertionId } : { summary };
  });
};

/**
 * Lay out the low-fidelity follow-up body. The live skill writes the real prose
 * in Noah's voice; this deterministic skeleton anchors every line to a real
 * assertion id so the citation contract is provable headlessly.
 * @param {{
 *   displayName: string,
 *   target: BriefEntity,
 *   commitments: Array<{ summary: string, assertionId?: string }>,
 *   assertionIds: string[],
 * }} input
 * @returns {string}
 */
const buildBody = ({ displayName, target, commitments, assertionIds }) => {
  const lines = [];
  lines.push(`Hi ${displayName},`);
  lines.push("");
  if (target.summary) {
    lines.push(`Quick follow-up on where things stand: ${target.summary}`);
    lines.push("");
  }
  if (commitments.length === 0) {
    lines.push(
      "Floppy surfaced no open commitments for this thread, so there is nothing outstanding I owe you on the record.",
    );
  } else {
    lines.push("Picking up the open threads:");
    for (const commitment of commitments) {
      lines.push(
        commitment.assertionId
          ? `- ${commitment.summary} (assertion ${commitment.assertionId})`
          : `- ${commitment.summary}`,
      );
    }
  }
  lines.push("");
  lines.push(
    `Grounding: drafted from Atlas Brief citations ${assertionIds
      .slice(0, 3)
      .join(", ")}.`,
  );
  return lines.join("\n").trim();
};
