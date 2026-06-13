#!/usr/bin/env node
/**
 * floppy:follow-up deterministic CLI fallback.
 *
 * Resolves a subject entity from --entity / --person (name or id), calls the
 * Atlas Brief REST mirror, builds a grounded follow-up draft, runs the SP-145
 * verify pass over its citations, and submits it as a REVIEW-REQUIRED Atlas
 * draft. It does NOT call an LLM and NEVER sends email — the live skill path is
 * driven by Claude Code through the bundled `atlas` MCP per SKILL.md, and the
 * only outbound write here is a review-required draft.
 *
 * There is no filesystem read: the subject comes from the argument, so this
 * works in Cowork.
 */

import process from "node:process";
import {
  DEFAULT_FOLLOW_UP_TASK,
  prepareFollowUp,
} from "../lib/skill-runner.mjs";

const USAGE = `Usage: floppy-follow-up --entity <name|id> [options]

Required (provide one):
  --entity <name|id>    Subject to follow up with. A name is resolved via wiki
                        search; a canonical id (e.g. person_..., project_...) is
                        used directly. No hardcoded entity.
  --person <name|id>    Alias for --entity.

Options:
  --recipients <csv>    Comma-separated recipient emails for the draft.
  --limit <n>           Brief hydration limit. Default: 6.
  --atlas-url <url>     Atlas base URL. Defaults to $ATLAS_API_URL or
                        https://bart-silk.vercel.app. The client calls
                        <url>/v1/agent/v1/* unless <url> already ends in /v1/agent.
  --bearer <token>      Atlas bearer token. Defaults to $ATLAS_AGENT_BEARER.
  --serverless-bearer <token>
                        Optional Cloud Run identity token.
  --tenant-slug <slug>  Tenant slug for review URLs only (never for data scope;
                        data scope is always the bearer's tenant). Default: doris-dev.
  --web-url <url>       Atlas web URL for review links. Defaults to https://bart-silk.vercel.app.
  --json                Emit machine-readable JSON output.
  --help                Show this help.

This NEVER sends email. The only outbound write is a review-required Atlas draft.

Exit codes:
  0 — follow-up draft submitted (may include verify warnings)
  1 — fatal error before draft submission
  2 — draft submission failed
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

const entity =
  (typeof flags.entity === "string" && flags.entity) ||
  (typeof flags.person === "string" && flags.person) ||
  "";
const recipients =
  typeof flags.recipients === "string"
    ? flags.recipients
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    : undefined;
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

if (!entity) {
  process.stderr.write(
    "error: --entity is required. Pass --entity <name|id> (or --person).\n",
  );
  process.exit(1);
}

if (!bearer) {
  process.stderr.write(
    "error: bearer token missing. Pass --bearer or set ATLAS_AGENT_BEARER.\n",
  );
  process.exit(1);
}

const log = (message, meta) => {
  if (asJson) return;
  process.stderr.write(
    `[floppy-follow-up] ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}\n`,
  );
};

const draftReviewUrl = (id) =>
  `${webUrl.replace(/\/+$/, "")}/t/${encodeURIComponent(
    tenantSlug,
  )}/drafts/${encodeURIComponent(id)}`;

try {
  const result = await prepareFollowUp({
    entity,
    ...(recipients ? { recipients } : {}),
    atlasUrl,
    bearer,
    serverlessBearer: serverlessBearer || undefined,
    task: DEFAULT_FOLLOW_UP_TASK,
    limit,
    log,
  });

  const submittedDraft =
    result.submittedDraft && {
      ...result.submittedDraft,
      reviewUrl: draftReviewUrl(result.submittedDraft.id),
    };

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          subject: result.subject,
          resolvedEntityIds: result.resolvedEntityIds,
          draft: {
            type: result.draft.type,
            subject: result.draft.subject,
            body: result.draft.body,
            targetEntityId: result.draft.targetEntityId,
            targetKind: result.draft.targetKind,
            recipients: result.draft.recipients,
            citations: result.draft.citations,
          },
          submittedDraft,
          warnings: result.warnings,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write("\nFollow-up fallback complete.\n");
    process.stdout.write(`Subject line: ${result.draft.subject}\n`);
    if (result.submittedDraft) {
      process.stdout.write(
        `Review-required draft: ${result.submittedDraft.id}  ${draftReviewUrl(
          result.submittedDraft.id,
        )}\n`,
      );
    } else {
      process.stdout.write("Review-required draft: FAILED\n");
    }
    process.stdout.write("\nDraft body:\n");
    process.stdout.write(`${result.draft.body}\n`);
    process.stdout.write(
      "\nNote: CLI fallback stops at a review-required Atlas draft. It NEVER sends email.\n",
    );
    if (result.warnings.length > 0) {
      process.stdout.write("\nWarnings:\n");
      for (const warning of result.warnings) {
        process.stdout.write(`- ${warning}\n`);
      }
    }
  }

  process.exit(result.submittedDraft ? 0 : 2);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}
