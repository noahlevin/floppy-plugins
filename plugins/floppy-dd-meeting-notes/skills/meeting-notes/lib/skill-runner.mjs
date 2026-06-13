/**
 * Deterministic "prepare drafts" runner for the meeting-notes CLI fallback.
 *
 * This intentionally does not call any LLM. In the live demo, Claude Code is
 * the brain and follows SKILL.md through MCP tools. This runner only proves the
 * contracts and gives the operator a basic fallback path that submits review-
 * required Atlas drafts.
 */

import { createAtlasClient } from "./atlas-client.mjs";
import { buildDraftPayloads } from "./output-formatter.mjs";
import {
  buildClickupTaskPrompt,
  buildRecapEmailPrompt,
} from "./prompt-templates.mjs";
import {
  parseTranscriptText,
  readTranscriptFile,
} from "./transcript.mjs";

export const DEFAULT_BRIEF_TASK =
  "Draft a client recap email + ClickUp task list for this Croceum weekly check-in, grounded in Atlas memory";

/** SP-147 — the skill_id this skill loads its per-tenant style-profile under. */
export const MEETING_NOTES_SKILL_ID = "meeting-notes";

/**
 * @typedef {object} PrepareDraftOptions
 * @property {string} [transcriptFile] Local transcript JSON path (CLI path).
 * @property {string} [transcriptText] Raw pasted/uploaded transcript string
 *   (Cowork path — no filesystem read). Takes precedence over transcriptFile.
 * @property {string} [transcriptName] Optional source name/path for title and
 *   date inference when transcriptText is supplied.
 * @property {ReturnType<typeof createAtlasClient> | object} [atlasClient]
 * @property {string} [atlasUrl]
 * @property {string} [bearer]
 * @property {string} [serverlessBearer]
 * @property {typeof fetch} [fetchImpl]
 * @property {string} [task]
 * @property {string[]} [entityHints]
 * @property {number} [limit]
 * @property {boolean} [verify] Run the deterministic atlas_review verify pass
 *   before submitting. Defaults to env MEETING_NOTES_VERIFY !== "off".
 * @property {(message: string, meta?: object) => void} [log]
 */

/**
 * Whether the deterministic verify pass should run. Off only when explicitly
 * disabled, so the safety check degrades cleanly without crashing the run.
 * @param {PrepareDraftOptions} options
 * @returns {boolean}
 */
const verifyEnabled = (options) => {
  if (typeof options.verify === "boolean") return options.verify;
  return (process.env.MEETING_NOTES_VERIFY ?? "").toLowerCase() !== "off";
};

/**
 * Turn a draft's citation array into atlas_review verify claims.
 * @param {string} label
 * @param {{ citations?: Array<{ assertion_id?: string, entity_id?: string, source_artifact_id?: string }> }} draft
 * @returns {Array<{ text: string, assertion_id?: string, entity_id?: string, source_artifact_id?: string }>}
 */
const claimsFromDraft = (label, draft) =>
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
 * @typedef {object} PrepareDraftResult
 * @property {import("./transcript.mjs").ParsedTranscript} transcript
 * @property {object} brief
 * @property {{ id: string, reviewUrl?: string, subject: string } | null} emailDraft
 * @property {{ id: string, reviewUrl?: string, taskCount: number } | null} taskDraft
 * @property {import("./output-formatter.mjs").ClickupTask[]} tasks
 * @property {string[]} warnings
 * @property {{ rules: Array<{ id: string, text: string, source: string, created_at: string }>, compiled: string }} styleProfile
 * @property {{ emailSystem: string, taskSystem: string }} prompts
 */

/**
 * @param {PrepareDraftOptions} options
 * @returns {Promise<PrepareDraftResult>}
 */
export const prepareMeetingNotesDrafts = async (options = {}) => {
  const log = options.log ?? (() => {});
  const warnings = /** @type {string[]} */ ([]);
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

  // Two input paths: a pasted/uploaded string (Cowork — no FS) takes
  // precedence; otherwise read a local transcript JSON file (CLI). Exactly one
  // is required — there is no hardcoded default file anymore.
  let transcript;
  if (typeof options.transcriptText === "string") {
    log("parsing_transcript_text", {
      length: options.transcriptText.length,
    });
    transcript = parseTranscriptText(options.transcriptText, {
      filePath: options.transcriptName,
    });
  } else if (typeof options.transcriptFile === "string") {
    log("reading_transcript", { transcriptFile: options.transcriptFile });
    transcript = await readTranscriptFile(options.transcriptFile);
  } else {
    throw new Error(
      "No transcript provided: pass transcriptText (pasted/uploaded) or transcriptFile (local path)",
    );
  }

  log("calling_atlas_brief", {
    title: transcript.title,
    participantCount: transcript.participants.length,
  });
  const brief = await atlas.brief({
    task: options.task ?? DEFAULT_BRIEF_TASK,
    transcript: transcript.text,
    entityHints: options.entityHints ?? ["Croceum"],
    limit: options.limit ?? 6,
  });

  const { emailDraft, taskDraft, tasks } = buildDraftPayloads({
    transcript,
    brief: /** @type {any} */ (brief),
  });

  // SP-147 — load this skill's per-tenant style-profile BEFORE assembling the
  // prompts, then inject the tenant style rules into the SYSTEM prompts. The
  // client read degrades to an empty profile on 404/503/error, so prompt
  // assembly falls back to today's unchanged base prompts.
  log("loading_style_profile", { skillId: MEETING_NOTES_SKILL_ID });
  const styleProfile = await atlas.getSkillStyleProfile(MEETING_NOTES_SKILL_ID);
  if (styleProfile.rules.length > 0) {
    log("style_profile_loaded", { ruleCount: styleProfile.rules.length });
  }
  const prompts = {
    emailSystem: buildRecapEmailPrompt({ styleProfile }),
    taskSystem: buildClickupTaskPrompt({ styleProfile }),
  };

  // SP-145 — deterministic fact-check BEFORE submitting. Seed verify claims
  // from the drafts' citations; surface contradicted/uncited as warnings. The
  // pass is zero-LLM and gated so it degrades cleanly when disabled or failing.
  if (verifyEnabled(options)) {
    const verifyClaims = [
      ...claimsFromDraft("Email", emailDraft),
      ...claimsFromDraft("Tasks", taskDraft),
    ];
    log("running_verify", { claimCount: verifyClaims.length });
    warnings.push(...(await runVerifyPass(atlas, verifyClaims, log)));
  }

  /** @type {PrepareDraftResult["emailDraft"]} */
  let emailResult = null;
  try {
    const response = /** @type {{ draft?: { id?: string } }} */ (
      await atlas.submitReviewRequiredDraft(emailDraft)
    );
    const id = response.draft?.id;
    if (!id) throw new Error("Atlas email draft response did not include draft.id");
    emailResult = { id, subject: emailDraft.subject };
    log("email_draft_submitted", { id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Email draft submission failed: ${message}`);
  }

  /** @type {PrepareDraftResult["taskDraft"]} */
  let taskResult = null;
  try {
    const response = /** @type {{ draft?: { id?: string } }} */ (
      await atlas.submitReviewRequiredDraft(taskDraft)
    );
    const id = response.draft?.id;
    if (!id) throw new Error("Atlas task draft response did not include draft.id");
    taskResult = { id, taskCount: tasks.length };
    log("task_draft_submitted", { id, taskCount: tasks.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Task draft submission failed: ${message}`);
  }

  return {
    transcript,
    brief: /** @type {object} */ (brief),
    emailDraft: emailResult,
    taskDraft: taskResult,
    tasks,
    warnings,
    styleProfile: { rules: styleProfile.rules, compiled: styleProfile.compiled },
    prompts,
  };
};
