import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { buildFollowUpDraft } from "../lib/draft.mjs";
import { prepareFollowUp } from "../lib/skill-runner.mjs";

const CLI_PATH = fileURLToPath(new URL("../bin/run.mjs", import.meta.url));
const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/sample-brief.json", import.meta.url),
);
const ROLE_ASSERTION = "assertion_jordan_role";
const COMMIT_ASSERTION = "assertion_commit_data_export";
const ENTITY_ID = "person_jordan_rivera";

/**
 * Start a fake Atlas server. Serves wiki search + brief from the fixture, the
 * deterministic verify pass, and review-required draft submission with
 * idempotency-key dedup. Records every call so tests can assert ordering, the
 * absence of any email-send route, and that no tenant is ever passed.
 * @param {{
 *   emptyBrief?: boolean,
 *   unresolvedVerify?: boolean,
 *   rejectDraft?: boolean,
 *   styleProfileRules?: string[],
 * }} [options]
 */
const startFakeAtlas = async (options = {}) => {
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  const state = {
    /** @type {Array<{ method: string, path: string, auth: string | undefined, body: any }>} */
    calls: [],
    /** @type {any[]} */
    submitBodies: [],
    /** @type {Map<string, any>} */
    drafts: new Map(),
    counter: 0,
  };

  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const body = rawBody ? JSON.parse(rawBody) : null;
    const path = request.url ?? "";
    const method = request.method ?? "GET";
    state.calls.push({ method, path, auth: request.headers.authorization, body });

    if (!request.headers.authorization?.startsWith("Bearer ")) {
      writeJson(response, 401, { error: "missing_bearer" });
      return;
    }

    // SP-147 — style-profile read. Absent option falls through to 404,
    // exercising the degrade-to-empty path.
    if (
      method === "GET" &&
      path.startsWith("/v1/agent/v1/skills/") &&
      path.endsWith("/style-profile")
    ) {
      if (!options.styleProfileRules) {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      const skillId = decodeURIComponent(
        path.slice("/v1/agent/v1/skills/".length, -"/style-profile".length),
      );
      const rules = options.styleProfileRules.map((text, index) => ({
        id: `style_rule_${index + 1}`,
        text,
        source: `correction:c${index + 1}`,
        created_at: "2026-06-05T12:00:00.000Z",
      }));
      writeJson(response, 200, {
        skillId,
        rules,
        compiled: options.styleProfileRules.join("\n"),
        updatedAt: "2026-06-05T12:00:00.000Z",
      });
      return;
    }

    if (method === "GET" && path.startsWith("/v1/agent/v1/wiki/search")) {
      writeJson(response, 200, {
        results: [
          {
            kind: "entity",
            id: ENTITY_ID,
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

    if (method === "POST" && path === "/v1/agent/v1/review") {
      assert.equal(body.mode, "verify");
      assert.ok(Array.isArray(body.claims) && body.claims.length > 0);
      writeJson(response, 200, buildVerify(body.claims, options));
      return;
    }

    if (method === "POST" && path === "/v1/agent/v1/drafts/submit") {
      state.submitBodies.push(body);
      const validation = validateDraft(body);
      if (validation) {
        writeJson(response, 400, { error: validation });
        return;
      }
      if (options.rejectDraft) {
        writeJson(response, 422, { error: "draft_rejected_for_test" });
        return;
      }
      for (const existing of state.drafts.values()) {
        if (existing.idempotencyKey === body.idempotencyKey) {
          writeJson(response, 201, { draft: existing, deduped: true });
          return;
        }
      }
      state.counter += 1;
      const draft = {
        id: `draft_${String(state.counter).padStart(4, "0")}`,
        status: "drafted",
        approval_policy: "review_required",
        idempotencyKey: body.idempotencyKey,
        draft_payload: body,
      };
      state.drafts.set(draft.id, draft);
      writeJson(response, 201, { draft });
      return;
    }

    writeJson(response, 404, { error: "not_found" });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    state,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve(undefined)));
      }),
  };
};

/**
 * Deterministic verify response. By default every citation is `supported`;
 * with `unresolvedVerify`, the first claim is reported `contradicted`.
 * @param {Array<{ text: string, assertion_id?: string }>} claims
 * @param {{ unresolvedVerify?: boolean }} options
 */
const buildVerify = (claims, options) => {
  const results = claims.map((claim, index) => {
    if (options.unresolvedVerify && index === 0) {
      return {
        claim: claim.text,
        verdict: "contradicted",
        assertion_id: claim.assertion_id ?? null,
        detail: "Assertion status is superseded.",
      };
    }
    return {
      claim: claim.text,
      verdict: "supported",
      assertion_id: claim.assertion_id ?? null,
    };
  });
  const summary = {
    supported: results.filter((r) => r.verdict === "supported").length,
    uncited: 0,
    contradicted: results.filter((r) => r.verdict === "contradicted").length,
    not_found: 0,
    wrong_entity: 0,
  };
  return {
    mode: "verify",
    ok: summary.contradicted === 0 && summary.uncited === 0,
    results,
    summary,
  };
};

/**
 * Validate the review-required draft shape: a follow-up email_recap that
 * targets the resolved entity and carries at least one real citation id.
 * @param {any} body
 */
const validateDraft = (body) => {
  if (!body || typeof body !== "object") return "missing_body";
  if (body.type !== "email_recap") return "invalid_type";
  if (typeof body.targetEntityId !== "string" || body.targetEntityId.length === 0) {
    return "invalid_targetEntityId";
  }
  if (!["project", "entity", "person"].includes(body.targetKind)) {
    return "invalid_targetKind";
  }
  if (typeof body.body !== "string" || body.body.length === 0) {
    return "invalid_body";
  }
  if (
    !Array.isArray(body.citations) ||
    body.citations.length === 0 ||
    !body.citations.every(
      (citation) =>
        citation &&
        ((typeof citation.assertion_id === "string" &&
          citation.assertion_id.length > 0) ||
          (typeof citation.source_artifact_id === "string" &&
            citation.source_artifact_id.length > 0)),
    )
  ) {
    return "invalid_citations";
  }
  if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.length === 0) {
    return "missing_idempotencyKey";
  }
  return null;
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

test("buildFollowUpDraft carries at least one real citation and is grounded in open commitments", async () => {
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  const { draft, assertionIds, commitments } = buildFollowUpDraft({
    brief: fixture,
    subject: { query: "Jordan Rivera", entityId: ENTITY_ID, displayName: "Jordan Rivera" },
  });

  assert.equal(draft.type, "email_recap");
  assert.equal(draft.targetEntityId, ENTITY_ID);
  assert.equal(draft.targetKind, "person");
  assert.ok(draft.citations.length >= 1, "draft must carry >= 1 citation");
  assert.ok(
    draft.citations.some((c) => c.assertion_id === ROLE_ASSERTION),
    "citations cite real assertion ids",
  );
  // Open commitments drive the "what's owed" spine.
  assert.ok(commitments.length >= 1);
  assert.match(draft.body, /data-export requirements doc/);
  assert.match(draft.body, new RegExp(`assertion ${COMMIT_ASSERTION}`));
  assert.ok(assertionIds.includes(COMMIT_ASSERTION));
  assert.equal(typeof draft.idempotencyKey, "string");
});

test("buildFollowUpDraft throws when Brief returns no citable ids", () => {
  assert.throws(
    () =>
      buildFollowUpDraft({
        brief: { hydrated: [], index: [], suggestions: [] },
        subject: { query: "Nobody Known" },
      }),
    /no hydrated profile/i,
  );
});

test("prepareFollowUp resolves a name via wiki search and never passes a tenant", async () => {
  const atlas = await startFakeAtlas();
  try {
    const result = await prepareFollowUp({
      entity: "Jordan Rivera",
      atlasUrl: atlas.url,
      bearer: "tok-test",
    });

    assert.equal(result.subject.resolvedVia, "search");
    assert.equal(result.subject.entityId, ENTITY_ID);

    const searchCalls = atlas.state.calls.filter((call) =>
      call.path.startsWith("/v1/agent/v1/wiki/search"),
    );
    assert.equal(searchCalls.length, 1, "name resolves via wiki search");

    const briefCalls = atlas.state.calls.filter(
      (call) => call.path === "/v1/agent/v1/brief",
    );
    assert.equal(briefCalls.length, 1);
    // Tenant is ALWAYS derived from the bearer — never sent in any payload.
    for (const call of atlas.state.calls) {
      assert.doesNotMatch(JSON.stringify(call.body ?? {}), /tenant/i);
    }
  } finally {
    await atlas.close();
  }
});

test("prepareFollowUp uses a canonical id directly without searching", async () => {
  const atlas = await startFakeAtlas();
  try {
    const result = await prepareFollowUp({
      entity: ENTITY_ID,
      atlasUrl: atlas.url,
      bearer: "tok-test",
    });
    assert.equal(result.subject.resolvedVia, "id");
    const searchCalls = atlas.state.calls.filter((call) =>
      call.path.startsWith("/v1/agent/v1/wiki/search"),
    );
    assert.equal(searchCalls.length, 0, "an id should not trigger a search");
  } finally {
    await atlas.close();
  }
});

test("prepareFollowUp runs the verify pass BEFORE submitting the review-required draft", async () => {
  const atlas = await startFakeAtlas();
  try {
    const result = await prepareFollowUp({
      entity: "Jordan Rivera",
      atlasUrl: atlas.url,
      bearer: "tok-test",
    });

    const reviewCalls = atlas.state.calls.filter((call) =>
      call.path.endsWith("/v1/agent/v1/review"),
    );
    assert.equal(reviewCalls.length, 1, "verify runs once");
    assert.equal(reviewCalls[0].body.mode, "verify");
    assert.ok(reviewCalls[0].body.claims.length > 0);

    const reviewIndex = atlas.state.calls.findIndex((call) =>
      call.path.endsWith("/v1/agent/v1/review"),
    );
    const submitIndex = atlas.state.calls.findIndex((call) =>
      call.path.endsWith("/v1/agent/v1/drafts/submit"),
    );
    assert.ok(reviewIndex !== -1 && submitIndex !== -1);
    assert.ok(reviewIndex < submitIndex, "verify must run before submit");

    // The submitted draft is review-required and carries a real citation.
    assert.ok(result.submittedDraft);
    assert.equal(atlas.state.submitBodies.length, 1);
    assert.ok(atlas.state.submitBodies[0].citations.length >= 1);
    assert.equal(
      result.warnings.filter((w) => w.startsWith("Verify flagged")).length,
      0,
    );
  } finally {
    await atlas.close();
  }
});

test("prepareFollowUp surfaces a soft warning on an unresolved citation but still submits", async () => {
  const atlas = await startFakeAtlas({ unresolvedVerify: true });
  try {
    const result = await prepareFollowUp({
      entity: "Jordan Rivera",
      atlasUrl: atlas.url,
      bearer: "tok-test",
    });
    assert.ok(result.submittedDraft, "draft still submits — verify is advisory");
    assert.match(
      result.warnings.join("\n"),
      /Verify flagged a citation as contradicted/,
    );
  } finally {
    await atlas.close();
  }
});

test("prepareFollowUp skips the verify pass when disabled, and still submits", async () => {
  const atlas = await startFakeAtlas();
  try {
    const result = await prepareFollowUp({
      entity: "Jordan Rivera",
      atlasUrl: atlas.url,
      bearer: "tok-test",
      verify: false,
    });
    const reviewCalls = atlas.state.calls.filter((call) =>
      call.path.endsWith("/v1/agent/v1/review"),
    );
    assert.equal(reviewCalls.length, 0, "verify is gated off");
    assert.ok(result.submittedDraft);
  } finally {
    await atlas.close();
  }
});

test("the only outbound write is a review-required draft — there is NO email-send path", async () => {
  const atlas = await startFakeAtlas();
  try {
    await prepareFollowUp({
      entity: "Jordan Rivera",
      atlasUrl: atlas.url,
      bearer: "tok-test",
      recipients: ["jordan@example.com"],
    });

    // Every submitted draft is the review-required Atlas draft. No call ever
    // hits a send/email route, and nothing claims to send.
    const submitCalls = atlas.state.calls.filter((call) =>
      call.path.endsWith("/v1/agent/v1/drafts/submit"),
    );
    assert.equal(submitCalls.length, 1);
    for (const call of atlas.state.calls) {
      assert.doesNotMatch(call.path, /send|email|outbox|deliver/i);
    }
    // The skill source carries no send/transport calls.
    const runnerSrc = await readFile(
      fileURLToPath(new URL("../lib/skill-runner.mjs", import.meta.url)),
      "utf8",
    );
    const draftSrc = await readFile(
      fileURLToPath(new URL("../lib/draft.mjs", import.meta.url)),
      "utf8",
    );
    const binSrc = await readFile(
      fileURLToPath(new URL("../bin/run.mjs", import.meta.url)),
      "utf8",
    );
    for (const src of [runnerSrc, draftSrc, binSrc]) {
      assert.doesNotMatch(src, /send_draft|sendMail|sendEmail|send_gmail|createTransport|nodemailer|smtp/i);
    }
  } finally {
    await atlas.close();
  }
});

test("rerun dedups the draft via the idempotency key (no duplicate drafts)", async () => {
  const atlas = await startFakeAtlas();
  try {
    const first = await prepareFollowUp({
      entity: "Jordan Rivera",
      atlasUrl: atlas.url,
      bearer: "tok-test",
    });
    const second = await prepareFollowUp({
      entity: "Jordan Rivera",
      atlasUrl: atlas.url,
      bearer: "tok-test",
    });

    assert.ok(first.submittedDraft && second.submittedDraft);
    assert.equal(
      first.submittedDraft.id,
      second.submittedDraft.id,
      "rerun returns the same draft id",
    );
    assert.equal(atlas.state.drafts.size, 1, "rerun creates no duplicate draft");
    assert.equal(
      atlas.state.submitBodies[0].idempotencyKey,
      atlas.state.submitBodies[1].idempotencyKey,
      "idempotency key is stable across reruns",
    );
  } finally {
    await atlas.close();
  }
});

test("SP-147 style profile is loaded and surfaced; absent profile degrades to empty", async () => {
  const withRules = await startFakeAtlas({
    styleProfileRules: ["Use a warmer tone.", "Lead with the ask."],
  });
  try {
    const result = await prepareFollowUp({
      entity: "Jordan Rivera",
      atlasUrl: withRules.url,
      bearer: "tok-test",
    });
    assert.equal(result.styleProfile.rules.length, 2);
    assert.equal(
      result.styleProfile.compiled,
      "Use a warmer tone.\nLead with the ask.",
    );
    const styleCalls = withRules.state.calls.filter((call) =>
      call.path.endsWith("/style-profile"),
    );
    assert.equal(styleCalls.length, 1);
    assert.match(
      styleCalls[0].path,
      /\/v1\/agent\/v1\/skills\/floppy-follow-up\/style-profile$/,
    );
  } finally {
    await withRules.close();
  }

  const noRules = await startFakeAtlas();
  try {
    const result = await prepareFollowUp({
      entity: "Jordan Rivera",
      atlasUrl: noRules.url,
      bearer: "tok-test",
    });
    assert.equal(result.styleProfile.rules.length, 0);
    assert.equal(result.styleProfile.compiled, "");
    assert.ok(result.submittedDraft, "empty profile does not block the run");
  } finally {
    await noRules.close();
  }
});

test("empty brief throws — no ungrounded follow-up is ever submitted", async () => {
  const atlas = await startFakeAtlas({ emptyBrief: true });
  try {
    await assert.rejects(
      () =>
        prepareFollowUp({
          entity: "Nobody Known",
          atlasUrl: atlas.url,
          bearer: "tok-test",
        }),
      /no hydrated profile/i,
    );
    const submitCalls = atlas.state.calls.filter((call) =>
      call.path.endsWith("/v1/agent/v1/drafts/submit"),
    );
    assert.equal(submitCalls.length, 0, "nothing is submitted without grounding");
  } finally {
    await atlas.close();
  }
});

test("CLI fallback submits a review-required draft and prints its review URL (no-FS path)", async () => {
  const atlas = await startFakeAtlas();
  try {
    const run = await runCli(atlas.url, ["--entity", "Jordan Rivera", "--json"]);
    assert.equal(run.code, 0, run.stderr);
    const json = JSON.parse(run.stdout);
    assert.equal(json.subject.entityId, ENTITY_ID);
    assert.equal(json.draft.type, "email_recap");
    assert.ok(json.draft.citations.length >= 1);
    assert.ok(json.submittedDraft.id);
    assert.match(json.submittedDraft.reviewUrl, /\/t\/doris-dev\/drafts\//);

    const submitCalls = atlas.state.calls.filter((call) =>
      call.path.endsWith("/v1/agent/v1/drafts/submit"),
    );
    assert.equal(submitCalls.length, 1);
  } finally {
    await atlas.close();
  }
});

test("CLI fallback exits 2 when the draft submission fails", async () => {
  const atlas = await startFakeAtlas({ rejectDraft: true });
  try {
    const run = await runCli(atlas.url, ["--entity", "Jordan Rivera", "--json"]);
    assert.equal(run.code, 2);
    const json = JSON.parse(run.stdout);
    assert.equal(json.submittedDraft, null);
    assert.match(json.warnings.join("\n"), /draft submission failed/i);
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
