/**
 * Deterministic helpers for meeting-notes draft preparation.
 *
 * Claude Code is the demo brain. These helpers do only mechanical work:
 * citation extraction, idempotency keys, markdown tables, and low-fidelity CLI
 * fallback draft payloads.
 */

import { createHash } from "node:crypto";

export const CROCEUM_PROJECT_ENTITY_ID = "project_canonical_2069d8fbe8ed625b";

/**
 * @typedef {import("./transcript.mjs").ParsedTranscript} ParsedTranscript
 */

/**
 * @typedef {object} ClickupTask
 * @property {string} title
 * @property {string} description
 * @property {string} [assignee_email]
 * @property {string} [due_date]
 * @property {"croceum"} project_alias
 * @property {string} [source_assertion_id]
 */

/**
 * @typedef {object} BriefEntity
 * @property {string} entityId
 * @property {string} displayName
 * @property {string} [profileKind]
 * @property {string} [summary]
 * @property {Array<Record<string, unknown>>} [facts]
 * @property {Array<Record<string, unknown>>} [openCommitments]
 * @property {{ assertionIds?: string[], sourceArtifactIds?: string[] }} [citations]
 */

/**
 * @typedef {object} BriefResponse
 * @property {BriefEntity[]} hydrated
 * @property {Array<{ entityId: string, displayName: string, hook?: string }>} [index]
 * @property {Array<{ kind: string, ref: string, label: string, why: string }>} [suggestions]
 * @property {object} [meta]
 */

/**
 * @param {string} value
 */
export const sha256Hex = (value) =>
  createHash("sha256").update(value).digest("hex");

/**
 * Stable draft idempotency key.
 * @param {string} draftType
 * @param {object} payload
 */
export const deriveDraftIdempotencyKey = (draftType, payload) =>
  `meeting_notes_${draftType}_${sha256Hex(canonicalJson(payload)).slice(0, 20)}`;

/**
 * Receipt idempotency key: sha of task draft id plus sorted created task ids.
 * @param {string} taskDraftId
 * @param {string[]} taskIds
 */
export const deriveReceiptIdempotencyKey = (taskDraftId, taskIds) => {
  const sortedIds = [...taskIds].sort();
  return sha256Hex(`${taskDraftId}${sortedIds.join("")}`);
};

/**
 * @param {BriefResponse} brief
 */
export const pickCroceumProject = (brief) => {
  const hydrated = Array.isArray(brief.hydrated) ? brief.hydrated : [];
  return (
    hydrated.find((entity) => entity.entityId === CROCEUM_PROJECT_ENTITY_ID) ??
    hydrated.find(
      (entity) =>
        /croceum/i.test(entity.displayName ?? "") &&
        (entity.profileKind === "project" || /project/i.test(entity.displayName ?? "")),
    ) ??
    hydrated.find((entity) => entity.profileKind === "project") ??
    hydrated[0] ??
    null
  );
};

/**
 * Extract real assertion IDs from Brief. Prefers the selected Croceum profile
 * but falls back to any hydrated entity so draft validation can still pass.
 * @param {BriefResponse} brief
 * @param {string} [targetEntityId]
 */
export const extractAssertionIds = (brief, targetEntityId) => {
  const hydrated = Array.isArray(brief.hydrated) ? brief.hydrated : [];
  const preferred = targetEntityId
    ? hydrated.filter((entity) => entity.entityId === targetEntityId)
    : [];
  const scanOrder = [...preferred, ...hydrated.filter((entity) => entity.entityId !== targetEntityId)];
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
 * @param {ClickupTask[]} tasks
 */
export const buildMarkdownTaskTable = (tasks) => {
  const lines = [
    "| Task | Assignee | Due | Source assertion |",
    "|---|---|---|---|",
  ];
  if (tasks.length === 0) {
    lines.push("| No ClickUp tasks proposed |  |  |  |");
    return lines.join("\n");
  }
  for (const task of tasks) {
    lines.push(
      [
        tableCell(task.title),
        tableCell(task.assignee_email ?? ""),
        tableCell(task.due_date ?? ""),
        tableCell(task.source_assertion_id ?? ""),
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"),
    );
  }
  return lines.join("\n");
};

/**
 * Build low-fidelity deterministic drafts for the CLI fallback.
 * @param {{ transcript: ParsedTranscript, brief: BriefResponse }} options
 */
export const buildDraftPayloads = ({ transcript, brief }) => {
  const target = pickCroceumProject(brief);
  if (!target) {
    throw new Error("Atlas Brief did not return any hydrated entities");
  }

  const assertionIds = extractAssertionIds(brief, target.entityId);
  if (assertionIds.length === 0) {
    throw new Error("Atlas Brief did not return assertion IDs to cite");
  }

  const citations = assertionIds.slice(0, 8).map((assertionId) => ({
    assertion_id: assertionId,
  }));
  const tasks = deterministicTasks(target, assertionIds);
  const subject = `Recap: ${transcript.title}`;
  const body = deterministicEmailBody({ transcript, target, assertionIds });
  const recipients = transcript.participants
    .map((participant) => participant.email)
    .filter(
      /** @returns {value is string} */
      (value) => typeof value === "string" && value.length > 0,
    );
  const taskBody = buildMarkdownTaskTable(tasks);

  const emailDraft = {
    type: "email_recap",
    targetEntityId: target.entityId,
    targetKind: "project",
    subject,
    body,
    recipients,
    citations,
    idempotencyKey: deriveDraftIdempotencyKey("email_recap", {
      targetEntityId: target.entityId,
      title: transcript.title,
      occurredAt: transcript.occurredAt,
      body,
      citations,
    }),
  };

  const taskDraft = {
    type: "clickup_task_batch",
    targetEntityId: target.entityId,
    targetKind: "project",
    body: taskBody,
    payload: { tasks },
    citations,
    idempotencyKey: deriveDraftIdempotencyKey("clickup_task_batch", {
      targetEntityId: target.entityId,
      title: transcript.title,
      occurredAt: transcript.occurredAt,
      tasks,
      citations,
    }),
  };

  return { emailDraft, taskDraft, tasks, target, assertionIds };
};

/**
 * @param {{ transcript: ParsedTranscript, target: BriefEntity, assertionIds: string[] }} options
 */
const deterministicEmailBody = ({ transcript, target, assertionIds }) => {
  const participants = transcript.participants.map((participant) => participant.name);
  const commitments = Array.isArray(target.openCommitments)
    ? target.openCommitments
    : [];
  const lines = [];
  lines.push(`Meeting: ${transcript.title}`);
  if (transcript.occurredAt) lines.push(`Occurred: ${transcript.occurredAt}`);
  if (participants.length > 0) lines.push(`Participants: ${participants.join(", ")}`);
  lines.push("");
  if (target.summary) {
    lines.push(`Atlas context for ${target.displayName}: ${target.summary}`);
    lines.push("");
  }
  if (commitments.length === 0) {
    lines.push("No open commitments were returned by Atlas Brief for this project.");
  } else {
    lines.push("Open commitments from Atlas memory:");
    for (const commitment of commitments.slice(0, 6)) {
      const assertionId =
        stringField(commitment, "assertionId", "assertion_id", "id") ??
        assertionIds[0];
      lines.push(
        `- ${commitmentText(commitment)} (assertion ${assertionId})`,
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

/**
 * @param {BriefEntity} target
 * @param {string[]} assertionIds
 * @returns {ClickupTask[]}
 */
const deterministicTasks = (target, assertionIds) => {
  const commitments = Array.isArray(target.openCommitments)
    ? target.openCommitments
    : [];
  return commitments.slice(0, 12).map((commitment, index) => {
    const assertionId =
      stringField(commitment, "assertionId", "assertion_id", "id") ??
      assertionIds[index] ??
      assertionIds[0];
    return {
      title: taskTitle(commitment),
      description:
        `${commitmentText(commitment)}\n\n` +
        `Prepared from Atlas Brief for ${target.displayName}. ` +
        `Source assertion: ${assertionId}.`,
      ...optionalStringProp(
        "assignee_email",
        stringField(commitment, "assigneeEmail", "assignee_email", "ownerEmail"),
      ),
      ...optionalStringProp(
        "due_date",
        stringField(commitment, "dueDate", "due_date"),
      ),
      project_alias: "croceum",
      source_assertion_id: assertionId,
    };
  });
};

/**
 * @param {Record<string, unknown>} commitment
 */
const taskTitle = (commitment) => {
  const text = commitmentText(commitment);
  return text.length > 90 ? `${text.slice(0, 87)}...` : text;
};

/**
 * @param {Record<string, unknown>} commitment
 */
const commitmentText = (commitment) =>
  stringField(commitment, "summary", "title", "description", "text") ??
  "Follow up on open Atlas commitment";

/**
 * @param {string[]} values
 * @param {string | undefined}
 */
const pushUnique = (values, value) => {
  if (typeof value !== "string" || value.length === 0) return;
  if (!values.includes(value)) values.push(value);
};

/**
 * @param {Record<string, unknown>} record
 * @param  {...string} keys
 */
const stringField = (record, ...keys) => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
};

/**
 * @param {string} key
 * @param {string | undefined} value
 */
const optionalStringProp = (key, value) =>
  typeof value === "string" && value.length > 0 ? { [key]: value } : {};

/**
 * @param {string} value
 */
const tableCell = (value) => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

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
