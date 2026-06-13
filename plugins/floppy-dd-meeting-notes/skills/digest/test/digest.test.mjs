import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { normalizeSince, prepareDigest } from "../lib/skill-runner.mjs";
import { groupRecentChanges } from "../lib/recent-changes.mjs";

const CLI_PATH = fileURLToPath(new URL("../bin/run.mjs", import.meta.url));
const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/sample-recent-changes.json", import.meta.url),
);
const PRIORITY_ASSERTION = "assertion_jordan_priority";
const BUDGET_ASSERTION = "assertion_jordan_budget";
const WEEKLY_ARTIFACT = "source_artifact_weekly";
const DEEPER_ARTIFACT = "source_artifact_kickoff_deck";

/**
 * Start a fake Atlas server. Serves wiki search + brief from the fixture; an
 * `emptyBrief` option exercises the no-data degrade path; `emptyChanges`
 * exercises the "no changes" message; `deeper` serves a richer profile-context
 * window to exercise the deepen step.
 * @param {{ emptyBrief?: boolean, emptyChanges?: boolean, deeper?: boolean }} [options]
 */
const startFakeAtlas = async (options = {}) => {
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  /** @type {Array<{ method: string, path: string, auth: string | undefined, body: unknown }>} */
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const body = rawBody ? JSON.parse(rawBody) : null;
    const path = request.url ?? "";
    const method = request.method ?? "GET";
    calls.push({ method, path, auth: request.headers.authorization, body });

    if (!request.headers.authorization?.startsWith("Bearer ")) {
      writeJson(response, 401, { error: "missing_bearer" });
      return;
    }

    if (method === "GET" && path.startsWith("/v1/agent/v1/wiki/search")) {
      writeJson(response, 200, {
        results: [
          {
            kind: "entity",
            id: "person_jordan_rivera",
            title: "Jordan Rivera",
            snippet: "VP of Product at Acme",
            score: 0.97,
          },
        ],
        total: 1,
      });
      return;
    }

    if (method === "POST" && path === "/v1/agent/v1/brief") {
      if (options.emptyBrief) {
        writeJson(response, 200, {
          hydrated: [],
          index: [],
          suggestions: [],
          meta: { resolvedEntityIds: [] },
        });
        return;
      }
      if (options.emptyChanges) {
        const cloned = JSON.parse(JSON.stringify(fixture));
        cloned.hydrated[0].recentChanges = {
          entityId: "person_jordan_rivera",
          since: "2026-06-01T00:00:00.000Z",
          events: [],
        };
        writeJson(response, 200, cloned);
        return;
      }
      writeJson(response, 200, fixture);
      return;
    }

    if (
      options.deeper &&
      method === "GET" &&
      path.startsWith("/v1/agent/v1/profiles/")
    ) {
      // A richer window than Brief returned (3 events) — 4 events, adding a new
      // source artifact. This must replace Brief's set in the rendered digest.
      writeJson(response, 200, {
        context: {
          recentChanges: {
            entityId: "person_jordan_rivera",
            since: "2026-05-01T00:00:00.000Z",
            events: [
              {
                kind: "source_artifact",
                id: DEEPER_ARTIFACT,
                title: "Acme kickoff deck",
                sourceType: "document",
                occurredAt: "2026-05-10T09:00:00.000Z",
                confidence: 0.9,
              },
              {
                kind: "assertion",
                id: PRIORITY_ASSERTION,
                summary: "Current priority is reducing onboarding time.",
                observedAt: "2026-05-28T17:30:00.000Z",
              },
              {
                kind: "source_artifact",
                id: WEEKLY_ARTIFACT,
                title: "Acme weekly sync — May 28",
                occurredAt: "2026-05-28T17:00:00.000Z",
              },
              {
                kind: "assertion",
                id: BUDGET_ASSERTION,
                summary: "Jordan approved the integration phase-2 budget.",
                observedAt: "2026-05-30T12:00:00.000Z",
              },
            ],
          },
        },
      });
      return;
    }

    // Absent style-profile / unmatched routes 404 (degrade-to-empty path).
    writeJson(response, 404, { error: "not_found" });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    calls,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve(undefined)));
      }),
  };
};

/**
 * @param {http.ServerResponse} response
 * @param {number} status
 * @param {object} body
 */
const writeJson = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

test("groupRecentChanges ranks newest-first and splits the two kinds", () => {
  const grouped = groupRecentChanges({
    since: "2026-05-25T00:00:00.000Z",
    events: [
      { kind: "assertion", id: "a_old", observedAt: "2026-05-26T00:00:00.000Z", summary: "old" },
      { kind: "source_artifact", id: "s_new", occurredAt: "2026-05-30T00:00:00.000Z", title: "new" },
      { kind: "assertion", id: "a_mid", observedAt: "2026-05-28T00:00:00.000Z", summary: "mid" },
    ],
  });
  assert.equal(grouped.isEmpty, false);
  // Newest first across all kinds.
  assert.deepEqual(
    grouped.all.map((change) => change.id),
    ["s_new", "a_mid", "a_old"],
  );
  assert.deepEqual(
    grouped.assertions.map((change) => change.id),
    ["a_mid", "a_old"],
  );
  assert.deepEqual(
    grouped.sourceArtifacts.map((change) => change.id),
    ["s_new"],
  );
  assert.deepEqual(grouped.citationIds, ["s_new", "a_mid", "a_old"]);
});

test("groupRecentChanges treats missing/empty events as not-a-crash empty", () => {
  assert.equal(groupRecentChanges(undefined).isEmpty, true);
  assert.equal(groupRecentChanges(null).isEmpty, true);
  assert.equal(groupRecentChanges({ events: [] }).isEmpty, true);
  assert.deepEqual(groupRecentChanges({}).all, []);
});

test("normalizeSince handles ISO dates and relative Nd windows", () => {
  const now = new Date("2026-06-08T00:00:00.000Z");
  assert.equal(normalizeSince("2026-05-01", now), "2026-05-01");
  assert.equal(normalizeSince("7d", now), "2026-06-01T00:00:00.000Z");
  assert.equal(normalizeSince("garbage", now), undefined);
  assert.equal(normalizeSince(undefined, now), undefined);
});

test("prepareDigest resolves a name via wiki search, then briefs by hint (no tenant)", async () => {
  const atlas = await startFakeAtlas();
  try {
    const result = await prepareDigest({
      entity: "Jordan Rivera",
      atlasUrl: atlas.url,
      bearer: "tok-test",
    });

    assert.equal(result.subject.resolvedVia, "search");
    assert.equal(result.subject.entityId, "person_jordan_rivera");

    const searchCalls = atlas.calls.filter((call) =>
      call.path.startsWith("/v1/agent/v1/wiki/search"),
    );
    assert.equal(searchCalls.length, 1, "name is resolved via wiki search");

    const briefCalls = atlas.calls.filter(
      (call) => call.path === "/v1/agent/v1/brief",
    );
    assert.equal(briefCalls.length, 1);
    assert.deepEqual(briefCalls[0].body.payload.entity_hints, ["Jordan Rivera"]);
    // Tenant is from the bearer only — never in the request payload or path.
    assert.doesNotMatch(JSON.stringify(briefCalls[0].body), /tenant/i);
    for (const call of atlas.calls) {
      assert.doesNotMatch(call.path, /tenant/i);
      assert.ok(call.auth?.startsWith("Bearer "), "every call carries the bearer");
    }
  } finally {
    await atlas.close();
  }
});

test("prepareDigest uses a canonical id directly without searching", async () => {
  const atlas = await startFakeAtlas();
  try {
    const result = await prepareDigest({
      entity: "person_jordan_rivera",
      atlasUrl: atlas.url,
      bearer: "tok-test",
    });
    assert.equal(result.subject.resolvedVia, "id");
    const searchCalls = atlas.calls.filter((call) =>
      call.path.startsWith("/v1/agent/v1/wiki/search"),
    );
    assert.equal(searchCalls.length, 0, "an id should not trigger a search");
  } finally {
    await atlas.close();
  }
});

test("rendered digest ranks events with real citations across both groups", async () => {
  const atlas = await startFakeAtlas();
  try {
    const result = await prepareDigest({
      entity: "Jordan Rivera",
      atlasUrl: atlas.url,
      bearer: "tok-test",
    });
    const md = result.markdown;

    for (const heading of [
      "## 1. Summary",
      "## 2. New & Updated Facts",
      "## 3. New Source Material",
    ]) {
      assert.ok(md.includes(heading), `missing section: ${heading}`);
    }

    // Real assertion + source-artifact citations render.
    assert.match(md, new RegExp(`\`${PRIORITY_ASSERTION}\``));
    assert.match(md, new RegExp(`\`${BUDGET_ASSERTION}\``));
    assert.match(md, new RegExp(`\`${WEEKLY_ARTIFACT}\``));

    // Ranking: the budget assertion (May 30) is newer than the priority
    // assertion (May 28), so it appears first in the facts section.
    const budgetIndex = md.indexOf(BUDGET_ASSERTION);
    const priorityIndex = md.indexOf(PRIORITY_ASSERTION);
    assert.ok(budgetIndex > -1 && priorityIndex > -1);
    assert.ok(
      budgetIndex < priorityIndex,
      "newer fact must rank above older fact",
    );

    // The change counts are surfaced for the caller.
    assert.equal(result.changes.assertionCount, 2);
    assert.equal(result.changes.sourceArtifactCount, 1);
    assert.equal(result.changes.eventCount, 3);
    assert.equal(result.warnings.length, 0);
  } finally {
    await atlas.close();
  }
});

test("--since deepen folds in a richer profile-context window", async () => {
  const atlas = await startFakeAtlas({ deeper: true });
  try {
    const result = await prepareDigest({
      entity: "Jordan Rivera",
      since: "2026-05-01",
      atlasUrl: atlas.url,
      bearer: "tok-test",
    });

    const contextCalls = atlas.calls.filter((call) =>
      call.path.startsWith("/v1/agent/v1/profiles/"),
    );
    assert.equal(contextCalls.length, 1, "since triggers a profile-context read");
    assert.match(contextCalls[0].path, /since=2026-05-01/);

    // The deeper artifact (only in profile-context) appears in the digest.
    assert.match(result.markdown, new RegExp(`\`${DEEPER_ARTIFACT}\``));
    assert.equal(result.changes.eventCount, 4, "deeper window replaces Brief's 3 events");
    assert.equal(result.changes.sourceArtifactCount, 2);
  } finally {
    await atlas.close();
  }
});

test("empty recent changes degrades to a no-changes message", async () => {
  const atlas = await startFakeAtlas({ emptyChanges: true });
  try {
    const result = await prepareDigest({
      entity: "Jordan Rivera",
      atlasUrl: atlas.url,
      bearer: "tok-test",
    });
    assert.match(result.markdown, /No changes since 2026-06-01/i);
    assert.equal(result.changes.eventCount, 0);
    assert.ok(result.warnings.some((w) => /no recent changes/i.test(w)));
  } finally {
    await atlas.close();
  }
});

test("empty brief degrades gracefully without crashing", async () => {
  const atlas = await startFakeAtlas({ emptyBrief: true });
  try {
    const result = await prepareDigest({
      entity: "Nobody Known",
      atlasUrl: atlas.url,
      bearer: "tok-test",
    });
    assert.match(result.markdown, /no hydrated profile/i);
    assert.ok(result.warnings.length > 0);
  } finally {
    await atlas.close();
  }
});

test("CLI fallback renders the digest as JSON with citations (no-FS path)", async () => {
  const atlas = await startFakeAtlas();
  try {
    const run = await runCli(atlas.url, ["--entity", "Jordan Rivera", "--json"]);
    assert.equal(run.code, 0, run.stderr);
    const json = JSON.parse(run.stdout);
    assert.equal(json.subject.entityId, "person_jordan_rivera");
    assert.match(json.markdown, /## 1\. Summary/);
    assert.match(json.markdown, new RegExp(PRIORITY_ASSERTION));
    assert.equal(json.changes.eventCount, 3);
  } finally {
    await atlas.close();
  }
});

/**
 * @param {string} atlasUrl
 * @param {string[]} extraArgs
 */
const runCli = async (atlasUrl, extraArgs) => {
  const child = spawn(process.execPath, [
    CLI_PATH,
    "--atlas-url",
    atlasUrl,
    "--bearer",
    "tok-test",
    ...extraArgs,
  ]);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
};
