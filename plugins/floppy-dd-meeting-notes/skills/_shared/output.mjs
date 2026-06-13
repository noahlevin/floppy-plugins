/**
 * Shared deterministic formatters for the `floppy:*` skill suite.
 *
 * Claude Code is the brain for the live skill path; these helpers do only
 * mechanical work: citation extraction, idempotency keys, and markdown
 * sections/tables. Generalized from `meeting-notes/lib/output-formatter.mjs`
 * with no skill-specific (Croceum) constants.
 */

import { createHash } from "node:crypto";

/**
 * @typedef {object} BriefEntity
 * @property {string} entityId
 * @property {string} displayName
 * @property {string} [profileKind]
 * @property {string} [summary]
 * @property {Array<Record<string, unknown>>} [facts]
 * @property {Array<Record<string, unknown>>} [openCommitments]
 * @property {{ entityId?: string, since?: string, events?: Array<Record<string, unknown>> }} [recentChanges]
 * @property {{ assertionIds?: string[], sourceArtifactIds?: string[] }} [citations]
 */

/**
 * @typedef {object} BriefResponse
 * @property {BriefEntity[]} hydrated
 * @property {Array<{ entityId: string, displayName: string, hook?: string }>} [index]
 * @property {Array<{ kind?: string, ref?: string, label?: string, why?: string }>} [suggestions]
 * @property {object} [meta]
 */

/**
 * @param {string} value
 */
export const sha256Hex = (value) =>
  createHash("sha256").update(value).digest("hex");

/**
 * Stable draft idempotency key, scoped by skill id + draft type.
 * @param {string} skillId
 * @param {string} draftType
 * @param {object} payload
 */
export const deriveDraftIdempotencyKey = (skillId, draftType, payload) =>
  `${skillId}_${draftType}_${sha256Hex(canonicalJson(payload)).slice(0, 20)}`;

/**
 * Pick the primary hydrated entity for a resolved entity id. Prefers an exact
 * id match, then the first project-kind entity, then the first hydrated entity.
 * No skill-specific entity constants — the target is always supplied by the
 * caller (resolved from `$ARGUMENTS`).
 * @param {BriefResponse} brief
 * @param {string} [targetEntityId]
 * @returns {BriefEntity | null}
 */
export const pickPrimaryEntity = (brief, targetEntityId) => {
  const hydrated = Array.isArray(brief.hydrated) ? brief.hydrated : [];
  if (targetEntityId) {
    const exact = hydrated.find((entity) => entity.entityId === targetEntityId);
    if (exact) return exact;
  }
  return (
    hydrated.find((entity) => entity.profileKind === "project") ??
    hydrated[0] ??
    null
  );
};

/**
 * Extract real assertion IDs from Brief. Prefers the target profile but falls
 * back to any hydrated entity so citation requirements can still be met.
 * @param {BriefResponse} brief
 * @param {string} [targetEntityId]
 * @returns {string[]}
 */
export const extractAssertionIds = (brief, targetEntityId) => {
  const hydrated = Array.isArray(brief.hydrated) ? brief.hydrated : [];
  const preferred = targetEntityId
    ? hydrated.filter((entity) => entity.entityId === targetEntityId)
    : [];
  const scanOrder = [
    ...preferred,
    ...hydrated.filter((entity) => entity.entityId !== targetEntityId),
  ];
  /** @type {string[]} */
  const assertionIds = [];

  for (const entity of scanOrder) {
    for (const id of entity.citations?.assertionIds ?? []) {
      pushUnique(assertionIds, id);
    }
    for (const fact of entity.facts ?? []) {
      pushUnique(assertionIds, stringField(fact, "assertionId", "assertion_id", "id"));
    }
    for (const commitment of entity.openCommitments ?? []) {
      pushUnique(
        assertionIds,
        stringField(commitment, "assertionId", "assertion_id", "id"),
      );
    }
  }

  return assertionIds;
};

/**
 * Extract the source-artifact ids cited by Brief, for "what to read" links.
 * @param {BriefResponse} brief
 * @param {string} [targetEntityId]
 * @returns {string[]}
 */
export const extractSourceArtifactIds = (brief, targetEntityId) => {
  const hydrated = Array.isArray(brief.hydrated) ? brief.hydrated : [];
  const preferred = targetEntityId
    ? hydrated.filter((entity) => entity.entityId === targetEntityId)
    : [];
  const scanOrder = [
    ...preferred,
    ...hydrated.filter((entity) => entity.entityId !== targetEntityId),
  ];
  /** @type {string[]} */
  const ids = [];
  for (const entity of scanOrder) {
    for (const id of entity.citations?.sourceArtifactIds ?? []) {
      pushUnique(ids, id);
    }
    for (const fact of entity.facts ?? []) {
      for (const id of /** @type {string[]} */ (fact.sourceArtifactIds ?? [])) {
        pushUnique(ids, id);
      }
    }
  }
  return ids;
};

/**
 * Render a markdown `## ` section: a heading, optional body lines, and an
 * optional trailing citation footnote line.
 * @param {string} heading
 * @param {string[]} bodyLines
 * @param {string[]} [assertionIds]
 * @returns {string}
 */
export const renderSection = (heading, bodyLines, assertionIds = []) => {
  const lines = [`## ${heading}`, ""];
  if (bodyLines.length === 0) {
    lines.push("_No grounded facts returned by Floppy for this section._");
  } else {
    lines.push(...bodyLines);
  }
  const cites = (assertionIds ?? []).filter(
    (id) => typeof id === "string" && id.length > 0,
  );
  if (cites.length > 0) {
    lines.push("");
    lines.push(`_Citations: ${cites.map((id) => `\`${id}\``).join(", ")}_`);
  }
  return lines.join("\n");
};

/**
 * Render a markdown bullet that cites a real assertion id inline.
 * @param {string} text
 * @param {string} [assertionId]
 * @returns {string}
 */
export const renderCitedBullet = (text, assertionId) => {
  const clean = collapseWhitespace(text);
  return assertionId && assertionId.length > 0
    ? `- ${clean} _(assertion \`${assertionId}\`)_`
    : `- ${clean}`;
};

/**
 * Render a simple markdown table. `rows` is an array of cell-arrays.
 * @param {string[]} headers
 * @param {string[][]} rows
 * @param {string} [emptyLabel]
 * @returns {string}
 */
export const renderTable = (headers, rows, emptyLabel = "No rows") => {
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];
  if (rows.length === 0) {
    lines.push(`| ${emptyLabel} |${" |".repeat(Math.max(headers.length - 1, 0))}`);
    return lines.join("\n");
  }
  for (const row of rows) {
    lines.push(`| ${row.map((cell) => tableCell(cell)).join(" | ")} |`);
  }
  return lines.join("\n");
};

/**
 * Turn a draft's citation array into atlas_review verify claims.
 * @param {string} label
 * @param {{ citations?: Array<{ assertion_id?: string, entity_id?: string, source_artifact_id?: string }> }} draft
 * @returns {Array<{ text: string, assertion_id?: string, entity_id?: string, source_artifact_id?: string }>}
 */
export const claimsFromDraft = (label, draft) =>
  (draft.citations ?? [])
    .filter(
      (citation) =>
        citation &&
        (citation.assertion_id || citation.entity_id || citation.source_artifact_id),
    )
    .map((citation, index) => ({
      text: `${label} citation ${index + 1}`,
      ...(citation.assertion_id ? { assertion_id: citation.assertion_id } : {}),
      ...(citation.entity_id ? { entity_id: citation.entity_id } : {}),
      ...(citation.source_artifact_id
        ? { source_artifact_id: citation.source_artifact_id }
        : {}),
    }));

/**
 * Read the first non-empty string field on a record, by key preference order.
 * @param {Record<string, unknown>} record
 * @param  {...string} keys
 * @returns {string | undefined}
 */
export const stringField = (record, ...keys) => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
};

/**
 * @param {string[]} values
 * @param {string | undefined} value
 */
const pushUnique = (values, value) => {
  if (typeof value !== "string" || value.length === 0) return;
  if (!values.includes(value)) values.push(value);
};

/**
 * @param {string} value
 */
const collapseWhitespace = (value) =>
  String(value).replace(/\s+/g, " ").trim();

/**
 * @param {string} value
 */
const tableCell = (value) =>
  String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/**
 * Deterministic JSON stringify with sorted object keys.
 * @param {unknown} value
 */
const canonicalJson = (value) => JSON.stringify(sortKeys(value));

/**
 * @param {unknown} value
 * @returns {unknown}
 */
const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeys(record[key])]),
    );
  }
  return value;
};
