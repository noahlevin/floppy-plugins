import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { prepareBrief } from "../lib/skill-runner.mjs";

const CLI_PATH = fileURLToPath(new URL("../bin/run.mjs", import.meta.url));
const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/sample-brief.json", import.meta.url),
);
const ROLE_ASSERTION = "assertion_jordan_role";
const COMMIT_ASSERTION = "assertion_commit_data_export";

/**
 * Start a fake Atlas server. Serves wiki search + brief from the fixture; an
 * `emptyBrief` option exercises the no-data degrade path.
 * @param {{ emptyBrief?: boolean }} [options]
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
      writeJson(response, 200, fixture);
      return;
    }

    // floppy:brief does not need the style-profile to be served; absence
    // exercises the degrade-to-empty path.
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

test("prepareBrief resolves a name via wiki search, then briefs by hint", async () => {
  const atlas = await startFakeAtlas();
  try {
    const result = await prepareBrief({
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
    // No tenant anywhere.
    assert.doesNotMatch(JSON.stringify(briefCalls[0].body), /tenant/i);
  } finally {
    await atlas.close();
  }
});

test("prepareBrief uses a canonical id directly without searching", async () => {
  const atlas = await startFakeAtlas();
  try {
    const result = await prepareBrief({
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

test("rendered brief has all five sections and real assertion citations", async () => {
  const atlas = await startFakeAtlas();
  try {
    const result = await prepareBrief({
      entity: "Jordan Rivera",
      atlasUrl: atlas.url,
      bearer: "tok-test",
    });
    const md = result.markdown;

    for (const heading of [
      "## 1. About the Subject",
      "## 2. About the Company / Context",
      "## 3. Where Our Worlds Intersect",
      "## 4. Discussion Questions",
      "## 5. Recent Activity & Open Items",
    ]) {
      assert.ok(md.includes(heading), `missing section: ${heading}`);
    }

    // Section 1 cites the role assertion; section 4 cites the commitment.
    assert.match(md, new RegExp(`assertion \`${ROLE_ASSERTION}\``));
    assert.match(md, new RegExp(`assertion \`${COMMIT_ASSERTION}\``));

    // The recent-activity table renders both event kinds.
    assert.match(md, /assertion/);
    assert.match(md, /source_artifact/);
    assert.match(md, /Acme weekly sync/);

    // The footer lists the full grounded assertion pool.
    assert.match(md, /All grounded assertion ids/);
    assert.match(md, new RegExp(ROLE_ASSERTION));

    // No fabricated content marker leaked where we DID have data.
    assert.equal(result.warnings.length, 0);
  } finally {
    await atlas.close();
  }
});

test("empty brief degrades gracefully without crashing", async () => {
  const atlas = await startFakeAtlas({ emptyBrief: true });
  try {
    const result = await prepareBrief({
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

test("CLI fallback renders the brief as JSON with citations (no-FS path)", async () => {
  const atlas = await startFakeAtlas();
  try {
    const run = await runCli(atlas.url, [
      "--entity",
      "Jordan Rivera",
      "--json",
    ]);
    assert.equal(run.code, 0, run.stderr);
    const json = JSON.parse(run.stdout);
    assert.equal(json.subject.entityId, "person_jordan_rivera");
    assert.match(json.markdown, /## 1\. About the Subject/);
    assert.match(json.markdown, new RegExp(ROLE_ASSERTION));
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
