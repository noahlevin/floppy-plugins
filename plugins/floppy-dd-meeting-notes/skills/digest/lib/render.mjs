/**
 * Deterministic digest formatter for the floppy:digest CLI fallback.
 *
 * Claude Code is the brain for the live skill path (it writes the prose). This
 * renderer does only mechanical work: it lays out the recent-changes digest
 * skeleton populated with real assertion-id / source-artifact-id citations
 * pulled from the Atlas Brief response. It never invents content — an entity
 * with no changes degrades to an explicit "No changes since <since>" note
 * instead of fabricating activity.
 */

import { renderSection, renderTable, stringField } from "../../_shared/output.mjs";
import { pickPrimaryEntity } from "../../_shared/output.mjs";
import { describeSince, groupRecentChanges } from "./recent-changes.mjs";

/**
 * @typedef {import("../../_shared/output.mjs").BriefResponse} BriefResponse
 */

/**
 * The digest section headings, in order.
 */
export const DIGEST_SECTION_HEADINGS = [
  "1. Summary",
  "2. New & Updated Facts",
  "3. New Source Material",
];

/**
 * Render a recent-changes table for one group of normalized changes.
 * @param {import("./recent-changes.mjs").NormalizedChange[]} changes
 * @param {string} emptyLabel
 * @returns {string}
 */
const renderChangeTable = (changes, emptyLabel) => {
  const rows = changes.map((change) => [
    change.at || "(no date)",
    change.summary,
    change.id ? `\`${change.id}\`` : "(no id)",
  ]);
  return renderTable(["When", "What changed", "Citation"], rows, emptyLabel);
};

/**
 * Render the full recent-changes digest as markdown.
 * @param {{ brief: BriefResponse, subject: { query: string, entityId?: string, displayName?: string }, since?: string }} input
 * @returns {string}
 */
export const renderDigest = (input) => {
  const { brief, subject } = input;
  const target = pickPrimaryEntity(brief, subject.entityId);
  const displayName = subject.displayName ?? target?.displayName ?? subject.query;

  const blocks = [];
  blocks.push(`# What Changed: ${displayName}`);
  blocks.push("");
  blocks.push(
    "_Grounded only in Floppy/Atlas memory. Every change cites a real assertion or source-artifact id._",
  );
  blocks.push("");

  if (!target) {
    blocks.push(
      renderSection(
        DIGEST_SECTION_HEADINGS[0],
        [
          `Floppy returned no hydrated profile for "${subject.query}". Nothing to digest — resolve the entity or widen the search before reporting changes.`,
        ],
        [],
      ),
    );
    return `${blocks.join("\n")}\n`;
  }

  const grouped = groupRecentChanges(target.recentChanges);
  const sinceLabel = describeSince(grouped.since ?? input.since);

  // Section 1 — Summary. A one-line headline of how much changed, or an
  // explicit "no changes" message when the window is empty.
  const summaryLines = [];
  if (grouped.isEmpty) {
    summaryLines.push(`No changes ${sinceLabel}.`);
  } else {
    summaryLines.push(
      `${grouped.all.length} change${
        grouped.all.length === 1 ? "" : "s"
      } ${sinceLabel}: ${grouped.assertions.length} fact${
        grouped.assertions.length === 1 ? "" : "s"
      } and ${grouped.sourceArtifacts.length} source artifact${
        grouped.sourceArtifacts.length === 1 ? "" : "s"
      }. Newest first below.`,
    );
  }
  blocks.push(renderSection(DIGEST_SECTION_HEADINGS[0], summaryLines, []));
  blocks.push("");

  // Section 2 — New & Updated Facts (assertion-kind events, newest first).
  const assertionBlock = [
    renderChangeTable(
      grouped.assertions,
      grouped.isEmpty
        ? `No fact changes ${sinceLabel}`
        : "No fact changes in this window",
    ),
  ];
  blocks.push(
    renderSection(
      DIGEST_SECTION_HEADINGS[1],
      assertionBlock,
      grouped.assertions.map((change) => change.id).filter(Boolean),
    ),
  );
  blocks.push("");

  // Section 3 — New Source Material (source_artifact-kind events, newest first).
  const sourceBlock = [
    renderChangeTable(
      grouped.sourceArtifacts,
      grouped.isEmpty
        ? `No new source material ${sinceLabel}`
        : "No new source material in this window",
    ),
  ];
  blocks.push(
    renderSection(
      DIGEST_SECTION_HEADINGS[2],
      sourceBlock,
      grouped.sourceArtifacts.map((change) => change.id).filter(Boolean),
    ),
  );

  // Footer — the full citation pool so the consumer can verify nothing is
  // fabricated.
  blocks.push("");
  blocks.push("---");
  blocks.push(
    `_All cited ids: ${
      grouped.citationIds.length > 0
        ? grouped.citationIds.map((id) => `\`${id}\``).join(", ")
        : "(none — no changes in this window)"
    }_`,
  );

  return `${blocks.join("\n")}\n`;
};

/**
 * Re-exported so the renderer and runner agree on the "since" phrasing helper.
 * @param {string | undefined} since
 */
export const sinceLabel = (since) => describeSince(since);

/**
 * @param {Record<string, unknown>} event
 * @returns {string | undefined}
 */
export const eventId = (event) =>
  stringField(event, "id", "assertionId", "sourceArtifactId");
