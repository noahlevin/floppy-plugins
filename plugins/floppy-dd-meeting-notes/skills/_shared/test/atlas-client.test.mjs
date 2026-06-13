import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";

import { AtlasClientError, createAtlasClient } from "../atlas-client.mjs";

const BEARER = "tok-shared-test";

/**
 * Start a fake Atlas server that records every call and serves canned
 * responses for the routes the shared client touches.
 * @param {{ noStyleProfile?: boolean, failWikiSearch?: boolean, failProfileContext?: boolean }} [options]
 */
const startFakeAtlas = async (options = {}) => {
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

    if (method === "POST" && path === "/v1/agent/v1/brief") {
      writeJson(response, 200, {
        hydrated: [
          {
            entityId: "entity_acme",
            displayName: "Acme",
            profileKind: "project",
            facts: [{ assertionId: "assertion_acme_1", summary: "fact" }],
            citations: { assertionIds: ["assertion_acme_1"], sourceArtifactIds: [] },
          },
        ],
        index: [],
        suggestions: [],
        meta: { resolvedEntityIds: ["entity_acme"] },
      });
      return;
    }

    if (method === "GET" && path.startsWith("/v1/agent/v1/wiki/search")) {
      if (options.failWikiSearch) {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      writeJson(response, 200, {
        results: [
          {
            kind: "entity",
            id: "entity_acme",
            title: "Acme",
            snippet: "Acme is a customer.",
            score: 0.9,
          },
        ],
        total: 1,
      });
      return;
    }

    if (
      method === "GET" &&
      /^\/v1\/agent\/v1\/profiles\/[^/]+\/context/.test(path)
    ) {
      if (options.failProfileContext) {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      writeJson(response, 200, { context: { entity: { id: "entity_acme" } } });
      return;
    }

    if (method === "POST" && path === "/v1/agent/v1/drafts/submit") {
      writeJson(response, 201, {
        draft: { id: "draft_0001", status: "drafted" },
      });
      return;
    }

    if (
      method === "GET" &&
      path.startsWith("/v1/agent/v1/skills/") &&
      path.endsWith("/style-profile")
    ) {
      if (options.noStyleProfile) {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      writeJson(response, 200, {
        skillId: "floppy-brief",
        rules: [
          {
            id: "r1",
            text: "Keep it terse.",
            source: "correction:c1",
            created_at: "2026-06-05T12:00:00.000Z",
          },
        ],
        compiled: "Keep it terse.",
        updatedAt: "2026-06-05T12:00:00.000Z",
      });
      return;
    }

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

/**
 * Assert no call carried a tenant in the body or in the query string.
 * @param {Array<{ path: string, body: unknown }>} calls
 */
const assertNoTenantLeak = (calls) => {
  for (const call of calls) {
    assert.doesNotMatch(
      call.path,
      /tenant/i,
      `tenant must not appear in query: ${call.path}`,
    );
    if (call.body && typeof call.body === "object") {
      const json = JSON.stringify(call.body);
      assert.doesNotMatch(
        json,
        /tenant/i,
        `tenant must not appear in body: ${json}`,
      );
    }
  }
};

test("brief() POSTs /v1/agent/v1/brief with bearer and no tenant", async () => {
  const atlas = await startFakeAtlas();
  try {
    const client = createAtlasClient({ atlasUrl: atlas.url, bearer: BEARER });
    const result = await client.brief({
      task: "prep",
      entityHints: ["Acme"],
      limit: 6,
    });
    assert.ok(Array.isArray(result.hydrated));
    const briefCalls = atlas.calls.filter(
      (call) => call.path === "/v1/agent/v1/brief",
    );
    assert.equal(briefCalls.length, 1);
    assert.equal(briefCalls[0].method, "POST");
    assert.equal(briefCalls[0].auth, `Bearer ${BEARER}`);
    assert.deepEqual(briefCalls[0].body.payload.entity_hints, ["Acme"]);
    assertNoTenantLeak(atlas.calls);
  } finally {
    await atlas.close();
  }
});

test("searchWiki() GETs /v1/agent/v1/wiki/search?q=... with bearer", async () => {
  const atlas = await startFakeAtlas();
  try {
    const client = createAtlasClient({ atlasUrl: atlas.url, bearer: BEARER });
    const result = await client.searchWiki("Acme", { limit: 5 });
    assert.equal(result.results[0].id, "entity_acme");
    const searchCalls = atlas.calls.filter((call) =>
      call.path.startsWith("/v1/agent/v1/wiki/search"),
    );
    assert.equal(searchCalls.length, 1);
    assert.equal(searchCalls[0].method, "GET");
    assert.equal(searchCalls[0].auth, `Bearer ${BEARER}`);
    assert.match(searchCalls[0].path, /[?&]q=Acme/);
    assert.match(searchCalls[0].path, /[?&]limit=5/);
    assertNoTenantLeak(atlas.calls);
  } finally {
    await atlas.close();
  }
});

test("readProfileContext() GETs /v1/agent/v1/profiles/:id/context with since", async () => {
  const atlas = await startFakeAtlas();
  try {
    const client = createAtlasClient({ atlasUrl: atlas.url, bearer: BEARER });
    const result = await client.readProfileContext("entity_acme", {
      since: "2026-06-01T00:00:00.000Z",
    });
    assert.ok(result && result.context);
    const ctxCalls = atlas.calls.filter((call) =>
      call.path.startsWith("/v1/agent/v1/profiles/entity_acme/context"),
    );
    assert.equal(ctxCalls.length, 1);
    assert.equal(ctxCalls[0].method, "GET");
    assert.equal(ctxCalls[0].auth, `Bearer ${BEARER}`);
    assert.match(ctxCalls[0].path, /[?&]since=/);
    assertNoTenantLeak(atlas.calls);
  } finally {
    await atlas.close();
  }
});

test("submitReviewRequiredDraft() POSTs /v1/agent/v1/drafts/submit with bearer", async () => {
  const atlas = await startFakeAtlas();
  try {
    const client = createAtlasClient({ atlasUrl: atlas.url, bearer: BEARER });
    const response = await client.submitReviewRequiredDraft({
      type: "email_recap",
      targetEntityId: "entity_acme",
      targetKind: "project",
      body: "hello",
      citations: [{ assertion_id: "assertion_acme_1" }],
    });
    assert.equal(response.draft.id, "draft_0001");
    const submitCalls = atlas.calls.filter(
      (call) => call.path === "/v1/agent/v1/drafts/submit",
    );
    assert.equal(submitCalls.length, 1);
    assert.equal(submitCalls[0].method, "POST");
    assert.equal(submitCalls[0].auth, `Bearer ${BEARER}`);
    assertNoTenantLeak(atlas.calls);
  } finally {
    await atlas.close();
  }
});

test("getSkillStyleProfile() returns rules on 200", async () => {
  const atlas = await startFakeAtlas();
  try {
    const client = createAtlasClient({ atlasUrl: atlas.url, bearer: BEARER });
    const profile = await client.getSkillStyleProfile("floppy-brief");
    assert.equal(profile.rules.length, 1);
    assert.equal(profile.compiled, "Keep it terse.");
    const calls = atlas.calls.filter((call) =>
      call.path.endsWith("/style-profile"),
    );
    assert.equal(calls[0].auth, `Bearer ${BEARER}`);
    assertNoTenantLeak(atlas.calls);
  } finally {
    await atlas.close();
  }
});

test("getSkillStyleProfile() degrades to empty profile on 404", async () => {
  const atlas = await startFakeAtlas({ noStyleProfile: true });
  try {
    const client = createAtlasClient({ atlasUrl: atlas.url, bearer: BEARER });
    const profile = await client.getSkillStyleProfile("floppy-brief");
    assert.deepEqual(profile, {
      skillId: "floppy-brief",
      rules: [],
      compiled: "",
      updatedAt: null,
    });
  } finally {
    await atlas.close();
  }
});

test("searchWiki() degrades to empty envelope on 404", async () => {
  const atlas = await startFakeAtlas({ failWikiSearch: true });
  try {
    const client = createAtlasClient({ atlasUrl: atlas.url, bearer: BEARER });
    const empty = await client.searchWiki("Acme");
    assert.deepEqual(empty, { results: [], total: 0 });
  } finally {
    await atlas.close();
  }
});

test("readProfileContext() surfaces a 404 as an AtlasClientError", async () => {
  const atlas = await startFakeAtlas({ failProfileContext: true });
  try {
    const client = createAtlasClient({ atlasUrl: atlas.url, bearer: BEARER });
    await assert.rejects(
      () => client.readProfileContext("entity_missing"),
      (error) => {
        assert.ok(error instanceof AtlasClientError);
        assert.equal(error.status, 404);
        return true;
      },
    );
  } finally {
    await atlas.close();
  }
});

test("constructor rejects missing bearer / atlasUrl", () => {
  assert.throws(() => createAtlasClient({ atlasUrl: "", bearer: "x" }), TypeError);
  assert.throws(() => createAtlasClient({ atlasUrl: "http://x", bearer: "" }), TypeError);
});
