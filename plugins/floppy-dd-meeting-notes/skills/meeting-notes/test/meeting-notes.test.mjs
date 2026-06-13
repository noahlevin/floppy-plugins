import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { AtlasClientError, createAtlasClient } from "../lib/atlas-client.mjs";
import { CROCEUM_PROJECT_ENTITY_ID } from "../lib/output-formatter.mjs";
import { prepareMeetingNotesDrafts } from "../lib/skill-runner.mjs";
import {
  TENANT_STYLE_RULES_HEADING,
  buildRecapEmailPrompt,
} from "../lib/prompt-templates.mjs";

const CLI_PATH = fileURLToPath(new URL("../bin/run.mjs", import.meta.url));
const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/sample-transcript.json", import.meta.url),
);
const ASSERTION_ID = "assertion_croceum_procurement_notes";
const FACT_ASSERTION_ID = "assertion_croceum_current_priority";

test("meeting-notes CLI fallback submits both draft shapes and dedupes reruns", async () => {
  const atlas = await startFakeAtlas();
  try {
    const first = await runCli(atlas.url);
    assert.equal(first.code, 0, first.stderr);
    const second = await runCli(atlas.url);
    assert.equal(second.code, 0, second.stderr);

    const firstJson = JSON.parse(first.stdout);
    const secondJson = JSON.parse(second.stdout);
    assert.equal(firstJson.emailDraft.id, secondJson.emailDraft.id);
    assert.equal(firstJson.taskDraft.id, secondJson.taskDraft.id);
    assert.equal(atlas.state.drafts.size, 2, "rerun should not create duplicate drafts");

    const briefCalls = atlas.state.calls.filter((call) =>
      call.path.endsWith("/v1/agent/v1/brief"),
    );
    assert.equal(briefCalls.length, 2);
    assert.equal(briefCalls[0].body.task.includes("Croceum weekly check-in"), true);
    assert.equal(briefCalls[0].body.payload.entity_hints[0], "Croceum");
    assert.match(briefCalls[0].body.payload.transcript, /Joyce Huang:/);

    const submitBodies = atlas.state.submitBodies;
    assert.equal(submitBodies.length, 4, "two submits per run");
    const firstRunEmail = submitBodies.find((body) => body.type === "email_recap");
    const firstRunTasks = submitBodies.find(
      (body) => body.type === "clickup_task_batch",
    );
    assert.ok(firstRunEmail);
    assert.ok(firstRunTasks);

    assert.equal(firstRunEmail.targetEntityId, CROCEUM_PROJECT_ENTITY_ID);
    assert.equal(firstRunEmail.targetKind, "project");
    assert.ok(firstRunEmail.subject);
    assert.deepEqual(firstRunEmail.recipients, [
      "eric@example.com",
      "joyce@example.com",
    ]);
    assert.ok(
      firstRunEmail.citations.some(
        (citation) => citation.assertion_id === ASSERTION_ID,
      ),
    );
    assert.equal(typeof firstRunEmail.idempotencyKey, "string");

    assert.equal(firstRunTasks.targetEntityId, CROCEUM_PROJECT_ENTITY_ID);
    assert.equal(firstRunTasks.targetKind, "project");
    assert.ok(
      firstRunTasks.citations.some(
        (citation) => citation.assertion_id === ASSERTION_ID,
      ),
    );
    assert.ok(Array.isArray(firstRunTasks.payload.tasks));
    assert.equal(firstRunTasks.payload.tasks.length, 1);
    assert.equal(firstRunTasks.payload.tasks[0].project_alias, "croceum");
    assert.equal(
      firstRunTasks.payload.tasks[0].source_assertion_id,
      ASSERTION_ID,
    );
    assert.match(firstRunTasks.body, /Source assertion/);
    assert.equal(typeof firstRunTasks.idempotencyKey, "string");
  } finally {
    await atlas.close();
  }
});

test("meeting-notes CLI runs verify before submit and passes clean on resolvable citations", async () => {
  const atlas = await startFakeAtlas();
  try {
    const result = await runCli(atlas.url);
    assert.equal(result.code, 0, result.stderr);
    const json = JSON.parse(result.stdout);

    // Verify ran BEFORE the two submits, seeded from draft citations.
    const reviewCalls = atlas.state.calls.filter((call) =>
      call.path.endsWith("/v1/agent/v1/review"),
    );
    assert.equal(reviewCalls.length, 1, "verify runs once per run");
    assert.equal(reviewCalls[0].body.mode, "verify");
    assert.ok(reviewCalls[0].body.claims.length > 0);
    assert.ok(
      reviewCalls[0].body.claims.some(
        (claim) => claim.assertion_id === ASSERTION_ID,
      ),
    );

    const reviewIndex = atlas.state.calls.findIndex((call) =>
      call.path.endsWith("/v1/agent/v1/review"),
    );
    const firstSubmitIndex = atlas.state.calls.findIndex((call) =>
      call.path.endsWith("/v1/agent/v1/drafts/submit"),
    );
    assert.ok(
      reviewIndex < firstSubmitIndex,
      "verify must run before the first submit",
    );

    // Clean happy path: no verify warnings.
    assert.equal(
      json.warnings.filter((w) => w.startsWith("Verify flagged")).length,
      0,
    );
  } finally {
    await atlas.close();
  }
});

test("meeting-notes CLI surfaces a warning on an unresolved citation", async () => {
  const atlas = await startFakeAtlas({ unresolvedVerify: true });
  try {
    const result = await runCli(atlas.url);
    // Still exits 0 — verify is advisory-to-the-operator, drafts still submit.
    assert.equal(result.code, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.match(json.warnings.join("\n"), /Verify flagged a citation as contradicted/);
  } finally {
    await atlas.close();
  }
});

test("meeting-notes CLI fallback exits 2 on partial draft submission", async () => {
  const atlas = await startFakeAtlas({ rejectTaskDraft: true });
  try {
    const result = await runCli(atlas.url);
    assert.equal(result.code, 2);
    const json = JSON.parse(result.stdout);
    assert.ok(json.emailDraft);
    assert.equal(json.taskDraft, null);
    assert.match(json.warnings.join("\n"), /Task draft submission failed/);
  } finally {
    await atlas.close();
  }
});

test("SP-147 prompt-templates inject tenant style rules into the SYSTEM prompt", () => {
  const base = buildRecapEmailPrompt();
  const withRules = buildRecapEmailPrompt({
    styleProfile: { compiled: "Use a warmer tone.", rules: [{ text: "Use a warmer tone." }] },
  });
  // With no profile the prompt is unchanged...
  assert.equal(buildRecapEmailPrompt({ styleProfile: { rules: [], compiled: "" } }), base);
  // ...and with rules, the fenced block + rule text are appended.
  assert.notEqual(withRules, base);
  assert.ok(withRules.includes(TENANT_STYLE_RULES_HEADING));
  assert.match(withRules, /Use a warmer tone\./);
  assert.ok(withRules.startsWith(base), "base instructions are preserved");
});

test("SP-147 skill-runner injects a loaded style-profile into the assembled SYSTEM prompts", async () => {
  const atlas = await startFakeAtlas({
    styleProfileRules: ["Use a warmer tone.", "Lead with the wins."],
  });
  try {
    const result = await prepareMeetingNotesDrafts({
      transcriptFile: FIXTURE_PATH,
      atlasUrl: atlas.url,
      bearer: "tok-test",
    });

    // The profile was loaded and surfaced.
    assert.equal(result.styleProfile.rules.length, 2);
    assert.equal(
      result.styleProfile.compiled,
      "Use a warmer tone.\nLead with the wins.",
    );

    // Both SYSTEM prompts contain the fenced block + the rule text.
    for (const systemPrompt of [
      result.prompts.emailSystem,
      result.prompts.taskSystem,
    ]) {
      assert.ok(systemPrompt.includes(TENANT_STYLE_RULES_HEADING));
      assert.match(systemPrompt, /Use a warmer tone\./);
      assert.match(systemPrompt, /Lead with the wins\./);
    }

    // The style read hit the right route, before the drafts submitted.
    const styleCalls = atlas.state.calls.filter((call) =>
      call.path.endsWith("/style-profile"),
    );
    assert.equal(styleCalls.length, 1);
    assert.match(styleCalls[0].path, /\/v1\/agent\/v1\/skills\/meeting-notes\/style-profile$/);
  } finally {
    await atlas.close();
  }
});

test("SP-147 skill-runner degrades to the base prompts when no profile exists (404)", async () => {
  // No styleProfileRules option → the fake atlas 404s the style read.
  const atlas = await startFakeAtlas();
  try {
    const result = await prepareMeetingNotesDrafts({
      transcriptFile: FIXTURE_PATH,
      atlasUrl: atlas.url,
      bearer: "tok-test",
    });

    // Empty profile, unchanged base prompts (no style-rules block).
    assert.equal(result.styleProfile.rules.length, 0);
    assert.equal(result.styleProfile.compiled, "");
    assert.equal(result.prompts.emailSystem, buildRecapEmailPrompt());
    assert.ok(!result.prompts.emailSystem.includes(TENANT_STYLE_RULES_HEADING));
    assert.ok(!result.prompts.taskSystem.includes(TENANT_STYLE_RULES_HEADING));

    // The drafts still submitted — the run is unaffected by the empty profile.
    assert.ok(result.emailDraft);
    assert.ok(result.taskDraft);
  } finally {
    await atlas.close();
  }
});

test("SP-153 skill-runner accepts transcriptText and produces the same drafts as a file, with no FS read", async () => {
  // Drive both paths against the same Atlas fake and assert the submitted draft
  // payloads are identical. The transcriptText run must NOT read the filesystem.
  const rawTranscript = await readFile(FIXTURE_PATH, "utf8");

  const fileAtlas = await startFakeAtlas();
  let fileResult;
  try {
    fileResult = await prepareMeetingNotesDrafts({
      transcriptFile: FIXTURE_PATH,
      atlasUrl: fileAtlas.url,
      bearer: "tok-test",
    });
  } finally {
    await fileAtlas.close();
  }

  // FAIL-LOUD that no FS read happens: also pass a transcriptFile pointing at a
  // path that does NOT exist. If the runner read the file, readTranscriptFile
  // would throw ENOENT; success proves the transcriptText branch was taken and
  // the file was never opened.
  const MISSING_FILE = fileURLToPath(
    new URL("./fixtures/__does_not_exist__.json", import.meta.url),
  );
  await assert.rejects(() => readFile(MISSING_FILE, "utf8"), {
    code: "ENOENT",
  });

  const textAtlas = await startFakeAtlas();
  let textResult;
  try {
    textResult = await prepareMeetingNotesDrafts({
      transcriptText: rawTranscript,
      transcriptName: FIXTURE_PATH,
      transcriptFile: MISSING_FILE,
      atlasUrl: textAtlas.url,
      bearer: "tok-test",
    });
  } finally {
    await textAtlas.close();
  }

  // Same parsed transcript and same submitted draft payloads across both paths.
  assert.deepEqual(textResult.transcript, fileResult.transcript);
  assert.deepEqual(textAtlas.state.submitBodies, fileAtlas.state.submitBodies);
  assert.ok(textResult.emailDraft);
  assert.ok(textResult.taskDraft);
});

test("SP-153 skill-runner throws when neither transcriptText nor transcriptFile is supplied", async () => {
  const atlas = await startFakeAtlas();
  try {
    await assert.rejects(
      () =>
        prepareMeetingNotesDrafts({
          atlasUrl: atlas.url,
          bearer: "tok-test",
        }),
      /No transcript provided/,
    );
  } finally {
    await atlas.close();
  }
});

test("meeting-notes CLI accepts a pasted transcript over stdin (no --transcript-file)", async () => {
  const atlas = await startFakeAtlas();
  try {
    const rawTranscript = await readFile(FIXTURE_PATH, "utf8");
    const result = await runCliStdin(atlas.url, rawTranscript);
    assert.equal(result.code, 0, result.stderr);

    const json = JSON.parse(result.stdout);
    assert.ok(json.emailDraft);
    assert.ok(json.taskDraft);

    const briefCalls = atlas.state.calls.filter((call) =>
      call.path.endsWith("/v1/agent/v1/brief"),
    );
    assert.equal(briefCalls.length, 1);
    assert.match(briefCalls[0].body.payload.transcript, /Joyce Huang:/);
  } finally {
    await atlas.close();
  }
});

test("atlas-client surfaces structured REST errors", async () => {
  const fakeFetch = async () =>
    new Response(JSON.stringify({ error: "boom" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  const client = createAtlasClient({
    atlasUrl: "http://atlas.test",
    bearer: "tok-test",
    fetchImpl: fakeFetch,
  });

  await assert.rejects(
    () =>
      client.brief({
        task: "test",
        transcript: "hello",
        entityHints: ["Croceum"],
      }),
    (error) => {
      assert.ok(error instanceof AtlasClientError);
      assert.equal(error.status, 500);
      assert.equal(error.path, "/v1/brief");
      return true;
    },
  );
});

test("atlas-client accepts a base URL already ending in /v1/agent", async () => {
  let capturedUrl = "";
  const fakeFetch = async (url) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ hydrated: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createAtlasClient({
    atlasUrl: "http://atlas.test/v1/agent",
    bearer: "tok-test",
    fetchImpl: fakeFetch,
  });

  await client.brief({ task: "test", transcript: "hello" });

  assert.equal(capturedUrl, "http://atlas.test/v1/agent/v1/brief");
});

/**
 * @param {{ rejectTaskDraft?: boolean, unresolvedVerify?: boolean, styleProfileRules?: string[] }} [options]
 */
const startFakeAtlas = async (options = {}) => {
  const state = {
    /** @type {Array<{ method: string, path: string, body: any }>} */
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
    state.calls.push({ method, path, body });

    if (!request.headers.authorization?.startsWith("Bearer ")) {
      writeJson(response, 401, { error: "missing_bearer" });
      return;
    }

    // SP-147 — skill style-profile read. Serves seeded rules; absent option
    // falls through to the catch-all 404, exercising the degrade path.
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

    if (method === "POST" && path === "/v1/agent/v1/brief") {
      assert.equal(body.task.includes("Croceum"), true);
      assert.equal(typeof body.payload.transcript, "string");
      assert.deepEqual(body.payload.entity_hints, ["Croceum"]);
      writeJson(response, 200, buildBrief());
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
      if (options.rejectTaskDraft && body.type === "clickup_task_batch") {
        writeJson(response, 422, { error: "task_draft_rejected_for_test" });
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

const buildBrief = () => ({
  hydrated: [
    {
      entityId: CROCEUM_PROJECT_ENTITY_ID,
      displayName: "Croceum Project",
      profileKind: "project",
      summary: "Croceum is the active diligence demo project.",
      facts: [
        {
          assertionId: FACT_ASSERTION_ID,
          summary: "Croceum's current priority is follow-up clarity.",
        },
      ],
      openCommitments: [
        {
          assertionId: ASSERTION_ID,
          summary: "Joyce will review the procurement notes by Friday.",
          assignee_email: "joyce@example.com",
          due_date: "2026-05-29",
        },
      ],
      citations: {
        assertionIds: [ASSERTION_ID, FACT_ASSERTION_ID],
        sourceArtifactIds: ["source_artifact_sample"],
      },
    },
  ],
  index: [
    {
      entityId: "person_joyce",
      displayName: "Joyce Huang",
      hook: "Croceum weekly stakeholder",
    },
  ],
  suggestions: [],
  meta: { fallback: true, resolvedEntityIds: [CROCEUM_PROJECT_ENTITY_ID] },
});

/**
 * Deterministic verify response. By default every citation is `supported`;
 * with `unresolvedVerify`, the first claim is reported `contradicted` so the
 * runner surfaces a warning.
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
 * @param {any} body
 */
const validateDraft = (body) => {
  if (!body || typeof body !== "object") return "missing_body";
  if (!["email_recap", "clickup_task_batch"].includes(body.type)) {
    return "invalid_type";
  }
  if (body.targetEntityId !== CROCEUM_PROJECT_ENTITY_ID) {
    return "invalid_targetEntityId";
  }
  if (body.targetKind !== "project") return "invalid_targetKind";
  if (typeof body.body !== "string" || body.body.length === 0) {
    return "invalid_body";
  }
  if (
    !Array.isArray(body.citations) ||
    body.citations.length === 0 ||
    !body.citations.every(
      (citation) =>
        citation && typeof citation.assertion_id === "string" &&
        citation.assertion_id.length > 0,
    )
  ) {
    return "invalid_citations";
  }
  if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.length === 0) {
    return "missing_idempotencyKey";
  }
  if (body.type === "clickup_task_batch" && !Array.isArray(body.payload?.tasks)) {
    return "missing_payload_tasks";
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

/**
 * @param {string} atlasUrl
 */
const runCli = async (atlasUrl) => {
  const child = spawn(process.execPath, [
    CLI_PATH,
    "--transcript-file",
    FIXTURE_PATH,
    "--atlas-url",
    atlasUrl,
    "--bearer",
    "tok-test",
    "--json",
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

/**
 * Run the CLI with a transcript piped over stdin (the Cowork paste path) and
 * no --transcript-file flag.
 * @param {string} atlasUrl
 * @param {string} transcript
 */
const runCliStdin = async (atlasUrl, transcript) => {
  const child = spawn(process.execPath, [
    CLI_PATH,
    "--transcript-stdin",
    "--atlas-url",
    atlasUrl,
    "--bearer",
    "tok-test",
    "--json",
  ]);

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.stdin.write(transcript);
  child.stdin.end();
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
};
