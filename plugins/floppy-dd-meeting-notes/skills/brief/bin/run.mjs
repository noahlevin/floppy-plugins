#!/usr/bin/env node
/**
 * floppy:brief deterministic CLI fallback.
 *
 * Resolves a subject entity from --entity (name or id), calls the Atlas Brief
 * REST mirror, and renders the 5-section relationship brief with real
 * assertion-id citations. It does NOT call an LLM — the live skill path is
 * driven by Claude Code through the bundled `atlas` MCP per SKILL.md.
 *
 * There is no filesystem read: the subject comes from the argument, so this
 * works in Cowork.
 */

import process from "node:process";
import { DEFAULT_BRIEF_TASK, prepareBrief } from "../lib/skill-runner.mjs";

const USAGE = `Usage: floppy-brief --entity <name|id> [options]

Required:
  --entity <name|id>    Subject to brief. A name is resolved via wiki search;
                        a canonical id (e.g. project_..., person_...) is used
                        directly. No hardcoded entity.

Options:
  --since <iso>         Recency window for the "Recent Activity" section.
  --limit <n>           Brief hydration limit. Default: 6.
  --atlas-url <url>     Atlas base URL. Defaults to $ATLAS_API_URL or
                        https://bart-silk.vercel.app. The client calls
                        <url>/v1/agent/v1/* unless <url> already ends in /v1/agent.
  --bearer <token>      Atlas bearer token. Defaults to $ATLAS_AGENT_BEARER.
  --serverless-bearer <token>
                        Optional Cloud Run identity token.
  --tenant-slug <slug>  Tenant slug for review URLs only (never for data scope;
                        data scope is always the bearer's tenant). Default: doris-dev.
  --json                Emit machine-readable JSON output.
  --help                Show this help.

Exit codes:
  0 — brief rendered (may include warnings)
  1 — fatal error
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
  (typeof flags.entity === "string" && flags.entity) || "";
const since = typeof flags.since === "string" ? flags.since : undefined;
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
const limit =
  typeof flags.limit === "string" && Number.isInteger(Number(flags.limit))
    ? Number(flags.limit)
    : 6;
const asJson = Boolean(flags.json);

if (!entity) {
  process.stderr.write(
    "error: --entity is required. Pass --entity <name|id>.\n",
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
    `[floppy-brief] ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}\n`,
  );
};

try {
  const result = await prepareBrief({
    entity,
    ...(since ? { since } : {}),
    atlasUrl,
    bearer,
    serverlessBearer: serverlessBearer || undefined,
    task: DEFAULT_BRIEF_TASK,
    limit,
    log,
  });

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          subject: result.subject,
          resolvedEntityIds: result.resolvedEntityIds,
          markdown: result.markdown,
          warnings: result.warnings,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${result.markdown}\n`);
    if (result.warnings.length > 0) {
      process.stdout.write("\nWarnings:\n");
      for (const warning of result.warnings) {
        process.stdout.write(`- ${warning}\n`);
      }
    }
    process.stdout.write(
      "\nNote: CLI fallback renders a deterministic skeleton. The live skill writes the prose grounded in the same Atlas facts.\n",
    );
  }

  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}
