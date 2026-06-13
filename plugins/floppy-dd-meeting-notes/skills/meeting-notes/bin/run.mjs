#!/usr/bin/env node
/**
 * meeting-notes deterministic CLI fallback.
 *
 * This prepares Atlas review-required drafts only. It does not call an LLM and
 * does not write to ClickUp; the live demo ClickUp path is performed by Claude
 * Code through MCP per SKILL.md.
 */

import process from "node:process";
import { buildMarkdownTaskTable } from "../lib/output-formatter.mjs";
import {
  DEFAULT_BRIEF_TASK,
  prepareMeetingNotesDrafts,
} from "../lib/skill-runner.mjs";

const USAGE = `Usage: meeting-notes [options]

Transcript input (provide exactly one):
  --transcript-file <path>
                        Local transcript JSON file (CLI convenience).
  --transcript-json <string>
                        Pasted/uploaded transcript as a raw string (JSON or
                        plain text). Use this where there is no local FS.
  --transcript-stdin    Read the transcript string from stdin (JSON or text).
                        Example: cat transcript.json | meeting-notes --transcript-stdin

Options:
  --atlas-url <url>     Atlas base URL. Defaults to $ATLAS_API_URL or https://bart-silk.vercel.app.
                        The client calls <url>/v1/agent/v1/brief unless <url> already ends in /v1/agent.
  --bearer <token>      Atlas bearer token. Defaults to $ATLAS_AGENT_BEARER.
  --serverless-bearer <token>
                        Optional Cloud Run identity token.
  --tenant-slug <slug>  Tenant slug for review URLs. Defaults to doris-dev.
  --web-url <url>       Atlas web URL for review links. Defaults to https://bart-silk.vercel.app.
  --limit <n>           Brief hydration limit. Default: 6.
  --json                Emit machine-readable JSON output.
  --help                Show this help.

Exit codes:
  0 — both drafts submitted successfully
  1 — fatal error before draft submission
  2 — partial: one or both draft submissions failed
`;

/**
 * @param {string[]} argv
 */
const parseArgs = (argv) => {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg && arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
};

const flags = parseArgs(process.argv.slice(2));

if (flags.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const transcriptFile =
  (typeof flags["transcript-file"] === "string" && flags["transcript-file"]) ||
  "";
const transcriptJsonFlag =
  (typeof flags["transcript-json"] === "string" && flags["transcript-json"]) ||
  "";
const useStdin = Boolean(flags["transcript-stdin"]);
const atlasUrl =
  (typeof flags["atlas-url"] === "string" && flags["atlas-url"]) ||
  process.env.ATLAS_API_URL ||
  "https://bart-silk.vercel.app";
const bearer =
  (typeof flags.bearer === "string" && flags.bearer) ||
  process.env.ATLAS_AGENT_BEARER ||
  "";
const serverlessBearer =
  (typeof flags["serverless-bearer"] === "string" &&
    flags["serverless-bearer"]) ||
  process.env.ATLAS_SERVERLESS_BEARER ||
  "";
const tenantSlug =
  (typeof flags["tenant-slug"] === "string" && flags["tenant-slug"]) ||
  process.env.ATLAS_TENANT_SLUG ||
  "doris-dev";
const webUrl =
  (typeof flags["web-url"] === "string" && flags["web-url"]) ||
  process.env.ATLAS_WEB_URL ||
  "https://bart-silk.vercel.app";
const limit =
  typeof flags.limit === "string" && Number.isInteger(Number(flags.limit))
    ? Number(flags.limit)
    : 6;
const asJson = Boolean(flags.json);

if (!bearer) {
  process.stderr.write(
    "error: bearer token missing. Pass --bearer or set ATLAS_AGENT_BEARER.\n",
  );
  process.exit(1);
}

const log = (message, meta) => {
  if (asJson) return;
  process.stderr.write(
    `[meeting-notes] ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}\n`,
  );
};

const draftReviewUrl = (id) =>
  `${webUrl.replace(/\/+$/, "")}/t/${encodeURIComponent(
    tenantSlug,
  )}/drafts/${encodeURIComponent(id)}`;

/**
 * Read all of stdin as a UTF-8 string. Used for the pasted-transcript path.
 * @returns {Promise<string>}
 */
const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

try {
  // Resolve the transcript input. Exactly one source is allowed; the
  // pasted/stdin string path takes precedence over a local file.
  let transcriptText;
  if (useStdin) {
    transcriptText = await readStdin();
  } else if (transcriptJsonFlag) {
    transcriptText = transcriptJsonFlag;
  }

  if (typeof transcriptText !== "string" && !transcriptFile) {
    process.stderr.write(
      "error: no transcript provided. Pass --transcript-file <path>, --transcript-json <string>, or pipe via --transcript-stdin.\n",
    );
    process.exit(1);
  }

  const result = await prepareMeetingNotesDrafts({
    ...(typeof transcriptText === "string"
      ? { transcriptText }
      : { transcriptFile }),
    atlasUrl,
    bearer,
    serverlessBearer: serverlessBearer || undefined,
    task: DEFAULT_BRIEF_TASK,
    entityHints: ["Croceum"],
    limit,
    log,
  });

  const emailDraft =
    result.emailDraft && {
      ...result.emailDraft,
      reviewUrl: draftReviewUrl(result.emailDraft.id),
    };
  const taskDraft =
    result.taskDraft && {
      ...result.taskDraft,
      reviewUrl: draftReviewUrl(result.taskDraft.id),
    };

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          transcript: {
            title: result.transcript.title,
            occurredAt: result.transcript.occurredAt,
            participantCount: result.transcript.participants.length,
          },
          emailDraft,
          taskDraft,
          tasks: result.tasks,
          warnings: result.warnings,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write("\nMeeting-notes fallback complete.\n");
    process.stdout.write(`Transcript: ${result.transcript.title}\n`);
    if (result.emailDraft) {
      process.stdout.write(
        `Email draft: ${result.emailDraft.id}  ${draftReviewUrl(
          result.emailDraft.id,
        )}\n`,
      );
    } else {
      process.stdout.write("Email draft: FAILED\n");
    }
    if (result.taskDraft) {
      process.stdout.write(
        `Task-batch draft: ${result.taskDraft.id}  ${draftReviewUrl(
          result.taskDraft.id,
        )}\n`,
      );
    } else {
      process.stdout.write("Task-batch draft: FAILED\n");
    }

    process.stdout.write("\nPrepared ClickUp task list:\n");
    process.stdout.write(`${buildMarkdownTaskTable(result.tasks)}\n`);
    process.stdout.write(
      "\nNote: CLI fallback stops at Atlas drafts. It does not write to ClickUp.\n",
    );

    if (result.warnings.length > 0) {
      process.stdout.write("\nWarnings:\n");
      for (const warning of result.warnings) {
        process.stdout.write(`- ${warning}\n`);
      }
    }
  }

  const partial = !result.emailDraft || !result.taskDraft;
  process.exit(partial ? 2 : 0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}
