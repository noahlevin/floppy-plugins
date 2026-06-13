import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  agentImportEndpoint,
  isAutomationSession,
  parseClaudeCodeJsonl,
  redactLocalSessionText,
} from "../lib/capture.mjs";

const captureScriptPath = fileURLToPath(
  new URL("../lib/capture.mjs", import.meta.url),
);

const fakeAnthropicToken = ["sk", "ant", "x".repeat(20)].join("-");
const fakeOpenAiToken = ["sk", "y".repeat(32)].join("-");
const fakeGithubToken = ["ghp", "z".repeat(24)].join("_");
const fakeAwsAccessKey = ["AK", "IA", "A".repeat(16)].join("");
const fakeBearerToken = `${["Bear", "er"].join("")} ${"b".repeat(24)}`;

test("agentImportEndpoint appends the import path after /v1/agent", () => {
  const endpoint = agentImportEndpoint("https://atlas.example/v1/agent");
  assert.equal(
    endpoint.toString(),
    "https://atlas.example/v1/agent/v1/source-artifacts/imports/coding-agent-session",
  );
});

test("basic redaction replaces fake secrets", () => {
  const raw = [
    fakeAnthropicToken,
    fakeOpenAiToken,
    fakeGithubToken,
    fakeAwsAccessKey,
    fakeBearerToken,
    "EXAMPLE_SECRET=super-secret-value",
  ].join("\n");

  const redacted = redactLocalSessionText(raw);

  assert.equal(redacted.includes(fakeAnthropicToken), false);
  assert.equal(redacted.includes(fakeOpenAiToken), false);
  assert.equal(redacted.includes(fakeGithubToken), false);
  assert.equal(redacted.includes(fakeAwsAccessKey), false);
  assert.equal(redacted.includes(fakeBearerToken), false);
  assert.match(redacted, /\[redacted:anthropic_api_key\]/);
  assert.match(redacted, /\[redacted:openai_api_key\]/);
  assert.match(redacted, /\[redacted:github_token\]/);
  assert.match(redacted, /\[redacted:aws_access_key_id\]/);
  assert.match(redacted, /\[redacted:bearer_token\]/);
  assert.match(redacted, /\[redacted:secret_assignment\]/);
});

test("Claude Code JSONL parses into the coding-agent session import schema", () => {
  const jsonl = [
    JSON.stringify({
      type: "user",
      sessionId: "session-123",
      cwd: "/workspace/example-repo",
      gitBranch: "main",
      timestamp: "2026-06-08T12:00:00.000Z",
      message: {
        content: "Summarize the deployment notes.",
      },
    }),
    JSON.stringify({
      type: "assistant",
      sessionId: "session-123",
      timestamp: "2026-06-08T12:00:01.000Z",
      message: {
        model: "claude-test",
        content: [
          {
            type: "text",
            text: "Here is the summary.",
          },
        ],
      },
    }),
  ].join("\n");

  const parsed = parseClaudeCodeJsonl(jsonl, {
    filePath: "/workspace/example-repo/session-123.jsonl",
    capturedAt: "2026-06-08T12:00:02.000Z",
  });

  assert.equal(parsed.provider, "claude_code");
  assert.equal(parsed.sessionId, "session-123");
  assert.equal(typeof parsed.title, "string");
  assert.ok(parsed.title.length > 0);
  assert.ok(Array.isArray(parsed.actors));
  assert.ok(parsed.actors.length >= 1);
  assert.ok(Array.isArray(parsed.turns));
  assert.ok(parsed.turns.length >= 1);
  assert.equal(parsed.repository.name, "example-repo");
  assert.equal(parsed.repository.path, "/workspace/example-repo");
  assert.equal(parsed.repository.branch, "main");

  for (const actor of parsed.actors) {
    assert.equal(typeof actor.id, "string");
    assert.ok(actor.id.length > 0);
    assert.equal(typeof actor.display, "string");
    assert.ok(actor.display.length > 0);
  }

  for (const turn of parsed.turns) {
    assert.equal(typeof turn.id, "string");
    assert.ok(turn.id.length > 0);
    assert.equal(typeof turn.actorId, "string");
    assert.ok(turn.actorId.length > 0);
    assert.equal(typeof turn.occurredAt, "string");
    assert.ok(!Number.isNaN(Date.parse(turn.occurredAt)));
    assert.equal(typeof turn.text, "string");
    assert.ok(turn.text.length > 0);
  }
});

test("automation-session detection is conservative", () => {
  assert.equal(
    isAutomationSession({
      env: {},
      parsed: {
        turns: [{ actorId: "user_local", text: "  <SCHEDULED-TASK run" }],
      },
    }),
    true,
  );
  assert.equal(
    isAutomationSession({
      env: { FLOPPY_CAPTURE: "0" },
      parsed: { turns: [{ actorId: "user_local", text: "Human prompt" }] },
    }),
    true,
  );
  assert.equal(
    isAutomationSession({
      env: {},
      parsed: {
        turns: [
          {
            actorId: "user_local",
            text: "Please inspect the literal <scheduled-task marker.",
          },
        ],
      },
    }),
    false,
  );
});

const syntheticTranscriptJsonl = ({
  firstUserText = "Capture this session.",
} = {}) =>
  [
    JSON.stringify({
      type: "user",
      sessionId: "session-stop-hook",
      cwd: "/workspace/example-repo",
      gitBranch: "main",
      timestamp: "2026-06-08T12:00:00.000Z",
      message: { content: firstUserText },
    }),
    JSON.stringify({
      type: "assistant",
      sessionId: "session-stop-hook",
      timestamp: "2026-06-08T12:00:01.000Z",
      message: {
        model: "claude-test",
        content: [{ type: "text", text: "Session captured." }],
      },
    }),
  ].join("\n");

const startMockImportServer = async ({ status = 201, body = "{}" } = {}) => {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: raw,
      });
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    endpoint: `http://127.0.0.1:${port}/v1/agent`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const runCaptureHook = async ({ stdin, env }) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [captureScriptPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(stdin);
  });

test("stop hook subprocess reads stdin on the current Node and posts the import", async () => {
  const server = await startMockImportServer();
  const workDir = await mkdtemp(join(tmpdir(), "floppy-capture-test-"));
  const transcriptPath = join(workDir, "session-stop-hook.jsonl");
  await writeFile(transcriptPath, syntheticTranscriptJsonl(), "utf8");

  try {
    const result = await runCaptureHook({
      stdin: JSON.stringify({
        transcript_path: transcriptPath,
        session_id: "session-stop-hook",
      }),
      env: {
        ATLAS_AGENT_TOKEN: "test-agent-token",
        ATLAS_AGENT_ENDPOINT: server.endpoint,
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(
      server.requests.length,
      1,
      `expected exactly one import attempt (no silent no-op); stderr: ${result.stderr}`,
    );

    const [request] = server.requests;
    assert.equal(request.method, "POST");
    assert.equal(
      request.url,
      "/v1/agent/v1/source-artifacts/imports/coding-agent-session",
    );
    assert.equal(request.headers.authorization, "Bearer test-agent-token");
    assert.equal(request.headers["idempotency-key"], "session-stop-hook");

    const imported = JSON.parse(request.body);
    assert.equal(imported.provider, "claude_code");
    assert.equal(imported.sessionId, "session-stop-hook");
    assert.ok(Array.isArray(imported.turns));
    assert.ok(imported.turns.length >= 2);
  } finally {
    await server.close();
    await rm(workDir, { force: true, recursive: true });
  }
});

test("stop hook subprocess skips scheduled-task sessions without posting", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "floppy-capture-test-"));
  const transcriptPath = join(workDir, "session-stop-hook.jsonl");
  await writeFile(
    transcriptPath,
    syntheticTranscriptJsonl({
      firstUserText:
        '  <SCHEDULED-TASK name="floppy-intake-listener">\nCollect intake.',
    }),
    "utf8",
  );

  try {
    const result = await runCaptureHook({
      stdin: JSON.stringify({
        transcript_path: transcriptPath,
        session_id: "session-stop-hook",
      }),
      env: {
        ATLAS_AGENT_TOKEN: "test-agent-token",
        ATLAS_AGENT_ENDPOINT: "http://127.0.0.1:9/v1/agent",
      },
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stderr, /\[floppy-capture\]/);
    assert.match(
      result.stderr,
      /skipping capture: automation\/scheduled-task session/,
    );
    assert.doesNotMatch(result.stderr, /import failed|capture failed/);
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
});

test("stop hook subprocess skips when FLOPPY_CAPTURE is explicitly disabled", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "floppy-capture-test-"));
  const transcriptPath = join(workDir, "session-stop-hook.jsonl");
  await writeFile(transcriptPath, syntheticTranscriptJsonl(), "utf8");

  try {
    const result = await runCaptureHook({
      stdin: JSON.stringify({
        transcript_path: transcriptPath,
        session_id: "session-stop-hook",
      }),
      env: {
        ATLAS_AGENT_TOKEN: "test-agent-token",
        ATLAS_AGENT_ENDPOINT: "http://127.0.0.1:9/v1/agent",
        FLOPPY_CAPTURE: "0",
      },
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stderr, /\[floppy-capture\]/);
    assert.match(
      result.stderr,
      /skipping capture: automation\/scheduled-task session/,
    );
    assert.doesNotMatch(result.stderr, /import failed|capture failed/);
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
});

test("stop hook subprocess logs import failures to stderr but still exits 0", async () => {
  const server = await startMockImportServer({
    status: 500,
    body: JSON.stringify({ error: "import_exploded" }),
  });
  const workDir = await mkdtemp(join(tmpdir(), "floppy-capture-test-"));
  const transcriptPath = join(workDir, "session-stop-hook.jsonl");
  await writeFile(transcriptPath, syntheticTranscriptJsonl(), "utf8");

  try {
    const result = await runCaptureHook({
      stdin: JSON.stringify({
        transcript_path: transcriptPath,
        session_id: "session-stop-hook",
      }),
      env: {
        ATLAS_AGENT_TOKEN: "test-agent-token",
        ATLAS_AGENT_ENDPOINT: server.endpoint,
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(server.requests.length, 1);
    assert.match(result.stderr, /\[floppy-capture\]/);
    assert.match(result.stderr, /HTTP 500/);
    assert.match(result.stderr, /import_exploded/);
  } finally {
    await server.close();
    await rm(workDir, { force: true, recursive: true });
  }
});

test("stop hook subprocess logs a skip reason when capture is not configured", async () => {
  const result = await runCaptureHook({
    stdin: JSON.stringify({ transcript_path: "/tmp/does-not-matter.jsonl" }),
    env: {
      ATLAS_AGENT_TOKEN: "",
      ATLAS_AGENT_ENDPOINT: "",
      ATLAS_MCP_URL: "",
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stderr, /\[floppy-capture\]/);
  assert.match(result.stderr, /skipping capture/);
});

test("stop hook subprocess logs unreadable transcript errors but still exits 0", async () => {
  const server = await startMockImportServer();
  try {
    const result = await runCaptureHook({
      stdin: JSON.stringify({
        transcript_path: "/nonexistent/floppy-capture-missing.jsonl",
        session_id: "session-missing",
      }),
      env: {
        ATLAS_AGENT_TOKEN: "test-agent-token",
        ATLAS_AGENT_ENDPOINT: server.endpoint,
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(server.requests.length, 0);
    assert.match(result.stderr, /\[floppy-capture\]/);
    assert.match(result.stderr, /capture failed/);
  } finally {
    await server.close();
  }
});
