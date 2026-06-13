/**
 * Deterministic recent-changes ranking + grouping for the floppy:digest CLI
 * fallback.
 *
 * Claude Code is the brain for the live skill path (it writes the prose). This
 * module does only mechanical work: it takes the `recentChanges.events[]` Brief
 * returns for the subject entity, ranks them by recency, and splits them into
 * the two grounded groups (assertions vs. source artifacts). It never invents
 * content — an empty event list degrades to an explicit "no changes" message
 * instead of fabricating activity.
 */

import { stringField } from "../../_shared/output.mjs";

/**
 * @typedef {Record<string, unknown>} ChangeEvent
 */

/**
 * @typedef {object} NormalizedChange
 * @property {"assertion" | "source_artifact" | "other"} kind
 * @property {string} id Real assertion id or source-artifact id (the citation).
 * @property {string} at ISO timestamp used for ranking (observedAt/occurredAt).
 * @property {string} summary Human-readable one-liner.
 * @property {ChangeEvent} raw The original event, for the live brain.
 */

/**
 * @typedef {object} GroupedChanges
 * @property {string | undefined} since The window start, if Brief returned one.
 * @property {NormalizedChange[]} all All events, newest first.
 * @property {NormalizedChange[]} assertions Assertion-kind events, newest first.
 * @property {NormalizedChange[]} sourceArtifacts Source-artifact events, newest first.
 * @property {boolean} isEmpty True when there are no events to report.
 * @property {string[]} citationIds Every real id across the events (dedup, order-preserving).
 */

/**
 * Read the recency timestamp for an event. Assertions carry `observedAt`;
 * source artifacts carry `occurredAt`. We accept either on any event so a
 * shape drift on one kind does not silently drop it from the ranking.
 * @param {ChangeEvent} event
 * @returns {string}
 */
const eventTimestamp = (event) =>
  stringField(event, "observedAt", "occurredAt") ?? "";

/**
 * Read the human summary for an event, preferring the assertion summary, then
 * a source-artifact title.
 * @param {ChangeEvent} event
 * @returns {string}
 */
const eventSummary = (event) =>
  stringField(event, "summary", "title", "predicate") ?? "(no summary)";

/**
 * Classify the event kind. Anything that is not an assertion or a source
 * artifact is bucketed as `other` so it still renders (with its real id) rather
 * than being dropped.
 * @param {ChangeEvent} event
 * @returns {"assertion" | "source_artifact" | "other"}
 */
const eventKind = (event) => {
  const kind = stringField(event, "kind");
  if (kind === "assertion") return "assertion";
  if (kind === "source_artifact") return "source_artifact";
  return "other";
};

/**
 * Normalize one raw Brief change event into the shape the renderer consumes.
 * @param {ChangeEvent} event
 * @returns {NormalizedChange}
 */
const normalizeChange = (event) => ({
  kind: eventKind(event),
  id: stringField(event, "id", "assertionId", "sourceArtifactId") ?? "",
  at: eventTimestamp(event),
  summary: eventSummary(event),
  raw: event,
});

/**
 * Rank + group the `recentChanges` payload for a single resolved entity.
 *
 * Ranking is purely by recency (descending ISO timestamp). Grouping splits the
 * ranked list into assertions and source artifacts; an empty event list sets
 * `isEmpty` so the caller can print "No changes since <since>" rather than an
 * empty table.
 *
 * @param {{ since?: string, events?: ChangeEvent[] } | undefined | null} recentChanges
 * @returns {GroupedChanges}
 */
export const groupRecentChanges = (recentChanges) => {
  const rawEvents = Array.isArray(recentChanges?.events)
    ? recentChanges.events
    : [];
  const since =
    recentChanges && typeof recentChanges.since === "string"
      ? recentChanges.since
      : undefined;

  const normalized = rawEvents
    .map(normalizeChange)
    // Newest first. localeCompare on ISO-8601 strings is a correct chronological
    // sort; events with no timestamp sort last (empty string compares lowest).
    .sort((a, b) => b.at.localeCompare(a.at));

  const assertions = normalized.filter((change) => change.kind === "assertion");
  const sourceArtifacts = normalized.filter(
    (change) => change.kind === "source_artifact",
  );

  /** @type {string[]} */
  const citationIds = [];
  for (const change of normalized) {
    if (change.id.length > 0 && !citationIds.includes(change.id)) {
      citationIds.push(change.id);
    }
  }

  return {
    since,
    all: normalized,
    assertions,
    sourceArtifacts,
    isEmpty: normalized.length === 0,
    citationIds,
  };
};

/**
 * Format the "since" window into a short human phrase used in the empty-state
 * message and section subtitle. Falls back to a generic phrase when Brief did
 * not return a window.
 * @param {string | undefined} since
 * @returns {string}
 */
export const describeSince = (since) =>
  since && since.length > 0 ? `since ${since}` : "in the tracked window";
