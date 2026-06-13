import { readFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_TRANSCRIPT_FILE =
  "/Users/noahlevin/Downloads/2026-05-28_Croceum_DD_Weekly_Check-In.json";

/**
 * @typedef {object} TranscriptParticipant
 * @property {string} name
 * @property {string} [email]
 */

/**
 * @typedef {object} ParsedTranscript
 * @property {string} text
 * @property {TranscriptParticipant[]} participants
 * @property {string} title
 * @property {string} occurredAt
 */

/**
 * Read and parse a local transcript JSON file.
 * @param {string} [filePath]
 * @returns {Promise<ParsedTranscript>}
 */
export const readTranscriptFile = async (filePath = DEFAULT_TRANSCRIPT_FILE) => {
  const raw = await readFile(filePath, "utf8");
  const json = JSON.parse(raw);
  return parseTranscriptJson(json, { filePath });
};

/**
 * Parse a pasted/uploaded transcript provided as a raw string — no filesystem
 * call. The string may be JSON (any shape `parseTranscriptJson` understands) or
 * plain text. This is the Cowork path: Cowork has no local FS, so the operator
 * pastes or uploads the transcript and the string is parsed in-memory.
 *
 * JSON is detected by attempting `JSON.parse`. On parse failure the input is
 * treated as plain-text transcript content and wrapped so the same parser path
 * extracts the text. `options.filePath` is still honored for title/date
 * inference (e.g. when an uploaded file's name is known).
 *
 * @param {string} rawString
 * @param {{ filePath?: string }} [options]
 * @returns {ParsedTranscript}
 */
export const parseTranscriptText = (rawString, options = {}) => {
  if (typeof rawString !== "string") {
    throw new TypeError("parseTranscriptText expects a string");
  }
  const trimmed = rawString.trim();
  if (trimmed.length === 0) {
    throw new Error("Transcript text was empty");
  }

  let json;
  try {
    json = JSON.parse(trimmed);
  } catch {
    // Not JSON — treat the raw string as plain-text transcript content and let
    // parseTranscriptJson's flat-text branch normalize it.
    json = { text: trimmed };
  }
  return parseTranscriptJson(json, options);
};

/**
 * Parse common Granola-style and generic transcript JSON shapes.
 * @param {unknown} json
 * @param {{ filePath?: string }} [options]
 * @returns {ParsedTranscript}
 */
export const parseTranscriptJson = (json, options = {}) => {
  const filePath = options.filePath;
  const container = Array.isArray(json) ? {} : asRecord(json) ?? {};

  const title =
    firstString(
      container.title,
      container.name,
      container.meetingTitle,
      container.meeting_title,
      asRecord(container.meeting)?.title,
      asRecord(container.metadata)?.title,
    ) ?? titleFromPath(filePath);

  const occurredAt =
    normalizeOccurredAt(
      firstString(
        container.occurredAt,
        container.occurred_at,
        container.startedAt,
        container.started_at,
        container.startTime,
        container.start_time,
        container.date,
        container.createdAt,
        container.created_at,
        asRecord(container.meeting)?.occurredAt,
        asRecord(container.metadata)?.occurredAt,
      ),
    ) ??
    inferOccurredAtFromRows(Array.isArray(json) ? json : []) ??
    inferOccurredAtFromPath(filePath) ??
    "";

  const explicitParticipants = collectParticipants(
    firstArray(
      container.participants,
      container.attendees,
      asRecord(container.meeting)?.participants,
      asRecord(container.metadata)?.participants,
    ),
  );

  const rowSource =
    Array.isArray(json)
      ? json
      : firstArray(container.transcript, container.segments, container.turns);

  let text = "";
  let rowParticipants = /** @type {TranscriptParticipant[]} */ ([]);
  if (rowSource) {
    const parsedRows = parseRows(rowSource);
    text = parsedRows.text;
    rowParticipants = parsedRows.participants;
  } else {
    text =
      firstString(
        container.text,
        container.transcript,
        container.transcriptText,
        container.transcript_text,
        container.content,
      ) ?? "";
  }

  const participants = mergeParticipants(explicitParticipants, rowParticipants);
  const normalizedText = text.trim();
  if (normalizedText.length === 0) {
    throw new Error("Transcript JSON did not contain any readable text");
  }

  return {
    text: normalizedText,
    participants,
    title,
    occurredAt,
  };
};

/**
 * @param {unknown[]} rows
 * @returns {{ text: string, participants: TranscriptParticipant[] }}
 */
const parseRows = (rows) => {
  const participants = /** @type {TranscriptParticipant[]} */ ([]);
  const lines = /** @type {Array<{ speaker: string, text: string }>} */ ([]);

  for (const row of rows) {
    if (typeof row === "string") {
      appendTurn(lines, "", row);
      continue;
    }
    const record = asRecord(row);
    if (!record) continue;
    const speaker = normalizeName(
      firstString(
        record.speaker_name,
        record.speakerName,
        record.speaker,
        record.name,
        record.author,
        asRecord(record.participant)?.name,
      ),
    );
    const email = normalizeEmail(
      firstString(
        record.email,
        record.speaker_email,
        record.speakerEmail,
        record.participant_email,
        asRecord(record.participant)?.email,
      ),
    );
    const text = firstString(
      record.text,
      record.sentence,
      record.content,
      record.utterance,
      record.message,
    );
    if (speaker) participants.push({ name: speaker, ...(email ? { email } : {}) });
    if (text) appendTurn(lines, speaker ?? "", text);
  }

  return {
    text: lines
      .map((line) => (line.speaker ? `${line.speaker}: ${line.text}` : line.text))
      .join("\n"),
    participants: mergeParticipants(participants),
  };
};

/**
 * @param {Array<{ speaker: string, text: string }>} lines
 * @param {string} speaker
 * @param {string} text
 */
const appendTurn = (lines, speaker, text) => {
  const normalized = text.trim();
  if (!normalized) return;
  const previous = lines[lines.length - 1];
  if (previous && previous.speaker === speaker) {
    previous.text = `${previous.text} ${normalized}`;
    return;
  }
  lines.push({ speaker, text: normalized });
};

/**
 * @param {...unknown} values
 */
const firstString = (...values) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
};

/**
 * @param {...unknown} values
 */
const firstArray = (...values) => {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return undefined;
};

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
const asRecord = (value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;

/**
 * @param {unknown[] | undefined} values
 */
const collectParticipants = (values) => {
  if (!values) return [];
  const participants = /** @type {TranscriptParticipant[]} */ ([]);
  for (const value of values) {
    if (typeof value === "string") {
      const name = normalizeName(value);
      if (name) participants.push({ name });
      continue;
    }
    const record = asRecord(value);
    if (!record) continue;
    const name = normalizeName(
      firstString(record.name, record.displayName, record.display, record.email),
    );
    const email = normalizeEmail(firstString(record.email, record.mail));
    if (name) participants.push({ name, ...(email ? { email } : {}) });
  }
  return mergeParticipants(participants);
};

/**
 * @param  {...TranscriptParticipant[]} groups
 */
const mergeParticipants = (...groups) => {
  /** @type {TranscriptParticipant[]} */
  const ordered = [];
  /** @type {Map<string, TranscriptParticipant>} */
  const byEmail = new Map();
  /** @type {Map<string, TranscriptParticipant>} */
  const byName = new Map();
  for (const participant of groups.flat()) {
    const name = normalizeName(participant.name);
    if (!name) continue;
    const email = normalizeEmail(participant.email);
    const nameKey = name.toLowerCase();
    const existing = (email ? byEmail.get(email) : undefined) ?? byName.get(nameKey);
    if (existing) {
      if (!existing.email && email) {
        existing.email = email;
        byEmail.set(email, existing);
      }
      continue;
    }
    const next = { name, ...(email ? { email } : {}) };
    ordered.push(next);
    byName.set(nameKey, next);
    if (email) byEmail.set(email, next);
  }
  return ordered;
};

/**
 * @param {string | undefined}
 */
const normalizeName = (value) => {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized || /^unknown speaker$/i.test(normalized)) return undefined;
  return normalized;
};

/**
 * @param {string | undefined}
 */
const normalizeEmail = (value) => {
  const normalized = value?.trim();
  if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return undefined;
  }
  return normalized.toLowerCase();
};

/**
 * @param {string | undefined}
 */
const normalizeOccurredAt = (value) => {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return undefined;
  return new Date(time).toISOString();
};

/**
 * @param {unknown[]} rows
 */
const inferOccurredAtFromRows = (rows) => {
  for (const row of rows) {
    const record = asRecord(row);
    const occurredAt = normalizeOccurredAt(
      firstString(record?.startTime, record?.start_time, record?.timestamp),
    );
    if (occurredAt) return occurredAt;
  }
  return undefined;
};

/**
 * @param {string | undefined}
 */
const inferOccurredAtFromPath = (filePath) => {
  if (!filePath) return undefined;
  const match = path.basename(filePath).match(/(\d{4}-\d{2}-\d{2})/);
  return match ? `${match[1]}T00:00:00.000Z` : undefined;
};

/**
 * @param {string | undefined}
 */
const titleFromPath = (filePath) => {
  if (!filePath) return "Meeting transcript";
  const basename = path.basename(filePath, path.extname(filePath));
  const withoutDate = basename.replace(/^\d{4}-\d{2}-\d{2}[_\s-]*/, "");
  const title = withoutDate.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return title || "Meeting transcript";
};
