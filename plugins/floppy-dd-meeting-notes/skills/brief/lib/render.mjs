/**
 * Deterministic 5-section relationship-brief formatter for the floppy:brief CLI
 * fallback.
 *
 * Claude Code is the brain for the live skill path (it writes the prose). This
 * renderer does only mechanical work: it lays out the brief skeleton populated
 * with real facts and assertion-id citations pulled from the Atlas Brief
 * response. It never invents content — empty sections degrade to an explicit
 * "no grounded facts" note instead of fabricating.
 */

import {
  extractAssertionIds,
  pickPrimaryEntity,
  renderCitedBullet,
  renderSection,
  renderTable,
  stringField,
} from "../../_shared/output.mjs";

/**
 * @typedef {import("../../_shared/output.mjs").BriefResponse} BriefResponse
 * @typedef {import("../../_shared/output.mjs").BriefEntity} BriefEntity
 */

/**
 * The five section headings, in order. Modeled on Noah's /meeting-prep brief
 * but Floppy-only (no calendar/email/Granola).
 */
export const BRIEF_SECTION_HEADINGS = [
  "1. About the Subject",
  "2. About the Company / Context",
  "3. Where Our Worlds Intersect",
  "4. Discussion Questions",
  "5. Recent Activity & Open Items",
];

/**
 * Render the full 5-section brief as markdown.
 * @param {{ brief: BriefResponse, subject: { query: string, entityId?: string, displayName?: string }, since?: string }} input
 * @returns {string}
 */
export const renderBrief = (input) => {
  const { brief, subject } = input;
  const target = pickPrimaryEntity(brief, subject.entityId);
  const displayName = subject.displayName ?? target?.displayName ?? subject.query;

  const blocks = [];
  blocks.push(`# Relationship Brief: ${displayName}`);
  blocks.push("");
  blocks.push(
    "_Grounded only in Floppy/Atlas memory. Every claim cites a real assertion id._",
  );
  blocks.push("");

  if (!target) {
    blocks.push(
      renderSection(
        BRIEF_SECTION_HEADINGS[0],
        [
          `Floppy returned no hydrated profile for "${subject.query}". Nothing to brief — resolve the entity or widen the search before drafting.`,
        ],
        [],
      ),
    );
    return `${blocks.join("\n")}\n`;
  }

  const facts = Array.isArray(target.facts) ? target.facts : [];
  const commitments = Array.isArray(target.openCommitments)
    ? target.openCommitments
    : [];
  const events = Array.isArray(target.recentChanges?.events)
    ? target.recentChanges.events
    : [];
  const allAssertionIds = extractAssertionIds(brief, target.entityId);

  // Section 1 — About the Subject. Person/identity-leaning facts plus the
  // entity summary.
  const aboutLines = [];
  if (target.summary) aboutLines.push(target.summary);
  const aboutCites = [];
  for (const fact of facts.slice(0, 6)) {
    const assertionId = stringField(fact, "assertionId", "assertion_id", "id");
    const summary = stringField(fact, "summary", "predicate");
    if (summary) {
      aboutLines.push(renderCitedBullet(summary, assertionId));
      if (assertionId) aboutCites.push(assertionId);
    }
  }
  blocks.push(renderSection(BRIEF_SECTION_HEADINGS[0], aboutLines, aboutCites));
  blocks.push("");

  // Section 2 — About the Company / Context. Same fact pool framed as context;
  // the live skill differentiates person vs. company. Deterministically we
  // surface the profileKind + display name and any remaining facts.
  const contextLines = [
    `Profile kind: \`${target.profileKind ?? "entity"}\`. Display name: ${target.displayName}.`,
  ];
  const contextCites = [];
  for (const fact of facts.slice(6, 12)) {
    const assertionId = stringField(fact, "assertionId", "assertion_id", "id");
    const summary = stringField(fact, "summary", "predicate");
    if (summary) {
      contextLines.push(renderCitedBullet(summary, assertionId));
      if (assertionId) contextCites.push(assertionId);
    }
  }
  blocks.push(
    renderSection(BRIEF_SECTION_HEADINGS[1], contextLines, contextCites),
  );
  blocks.push("");

  // Section 3 — Where Our Worlds Intersect. The deterministic fallback cannot
  // synthesize collaboration angles; it points the live brain at the grounded
  // material and lists the suggestion leads Brief returned (related context).
  const intersectLines = [];
  const suggestions = Array.isArray(brief.suggestions) ? brief.suggestions : [];
  if (suggestions.length === 0) {
    intersectLines.push(
      "Floppy returned no related-context leads. The live skill synthesizes intersection angles from the facts above; the deterministic fallback does not invent them.",
    );
  } else {
    for (const suggestion of suggestions.slice(0, 6)) {
      const label = stringField(
        /** @type {Record<string, unknown>} */ (suggestion),
        "label",
        "ref",
      );
      const why = stringField(
        /** @type {Record<string, unknown>} */ (suggestion),
        "why",
      );
      if (label) {
        intersectLines.push(`- ${label}${why ? ` — ${why}` : ""}`);
      }
    }
  }
  blocks.push(renderSection(BRIEF_SECTION_HEADINGS[2], intersectLines, []));
  blocks.push("");

  // Section 4 — Discussion Questions. Deterministically derived from open
  // commitments (each is a real "what's owed" thread to raise), citing the
  // commitment's assertion id.
  const questionLines = [];
  const questionCites = [];
  if (commitments.length === 0) {
    questionLines.push(
      "Floppy returned no open commitments to anchor questions. The live skill writes sharp questions from the facts above.",
    );
  } else {
    for (const commitment of commitments.slice(0, 7)) {
      const assertionId = stringField(
        commitment,
        "assertionId",
        "assertion_id",
        "id",
      );
      const summary = stringField(commitment, "summary", "title", "text");
      if (summary) {
        questionLines.push(
          renderCitedBullet(`Where does this stand: ${summary}`, assertionId),
        );
        if (assertionId) questionCites.push(assertionId);
      }
    }
  }
  blocks.push(
    renderSection(BRIEF_SECTION_HEADINGS[3], questionLines, questionCites),
  );
  blocks.push("");

  // Section 5 — Recent Activity & Open Items. A table over recentChanges
  // events (assertion + source_artifact kinds), newest first.
  const sortedEvents = [...events].sort((a, b) => {
    const aAt = stringField(a, "observedAt", "occurredAt") ?? "";
    const bAt = stringField(b, "observedAt", "occurredAt") ?? "";
    return bAt.localeCompare(aAt);
  });
  const rows = sortedEvents.slice(0, 12).map((event) => {
    const at = stringField(event, "observedAt", "occurredAt") ?? "";
    const kind = stringField(event, "kind") ?? "";
    const summary =
      stringField(event, "summary", "title", "predicate") ?? "(no summary)";
    const id = stringField(event, "id") ?? "";
    return [at, kind, summary, id];
  });
  const recentBlock = [
    renderTable(["When", "Kind", "Summary", "Id"], rows, "No recent changes"),
  ];
  if (target.recentChanges?.since) {
    recentBlock.unshift(`_Changes since ${target.recentChanges.since}._`, "");
  }
  blocks.push(
    renderSection(BRIEF_SECTION_HEADINGS[4], recentBlock, []),
  );

  // Footer — the full citation pool so the consumer can verify nothing is
  // fabricated.
  blocks.push("");
  blocks.push("---");
  blocks.push(
    `_All grounded assertion ids: ${
      allAssertionIds.length > 0
        ? allAssertionIds.map((id) => `\`${id}\``).join(", ")
        : "(none returned)"
    }_`,
  );

  return `${blocks.join("\n")}\n`;
};
