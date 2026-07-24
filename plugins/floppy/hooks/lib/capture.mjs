import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";

const LOG_PREFIX = "[floppy-capture]";
const SCHEDULED_TASK_PREFIX = "<scheduled-task";

// Diagnostics go to stderr so the host session's stdout stays untouched. The
// hook must never fail the host session, so logging is best-effort too.
const logToStderr = (...parts) => {
  try {
    console.error(LOG_PREFIX, ...parts);
  } catch {
    // Nothing left to do if stderr itself is unavailable.
  }
};

export const IMPORT_PATH = "/v1/source-artifacts/imports/coding-agent-session";
export const AGENT_RELATIVE_IMPORT_PATH =
  "/source-artifacts/imports/coding-agent-session";

// Must match the bundled .mcp.json server URL so a token-only install
// captures sessions against the same deployment it reads from.
export const DEFAULT_MCP_URL = "https://bart-silk.vercel.app/api/mcp";

export class CodingAgentLocalSessionParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodingAgentLocalSessionParseError";
  }
}

export const parseStopHookInput = (raw) => {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logToStderr(
      `stop-hook payload was not valid JSON (${raw.length} bytes); skipping capture.`,
    );
    return {};
  }
  if (!isRecord(parsed)) {
    logToStderr("stop-hook payload was not a JSON object; skipping capture.");
    return {};
  }
  return {
    transcriptPath:
      stringValue(parsed.transcript_path) ?? stringValue(parsed.transcriptPath),
    sessionId: stringValue(parsed.session_id) ?? stringValue(parsed.sessionId),
  };
};

export const deriveAgentEndpointFromMcpUrl = (rawMcpUrl) => {
  const trimmed = rawMcpUrl?.trim();
  if (!trimmed) return undefined;

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }

  if (!["http:", "https:"].includes(url.protocol)) return undefined;
  if (url.username !== "" || url.password !== "") return undefined;

  const pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith("/mcp")) return undefined;

  url.pathname = `${pathname.slice(0, -"/mcp".length)}/v1/agent`;
  url.search = "";
  url.hash = "";
  return url.toString();
};

export const resolveAgentEndpoint = (env = process.env) => {
  const explicit = stringValue(env.ATLAS_AGENT_ENDPOINT);
  if (explicit !== undefined) return explicit;
  // An ATLAS_MCP_URL the user set but that cannot be derived must NOT fall
  // back to the default: their reads point elsewhere, so silently uploading
  // to the default deployment would be wrong. Skip capture instead.
  const mcpUrl = stringValue(env.ATLAS_MCP_URL);
  if (mcpUrl !== undefined) return deriveAgentEndpointFromMcpUrl(mcpUrl);
  return deriveAgentEndpointFromMcpUrl(DEFAULT_MCP_URL);
};

export const agentImportEndpoint = (rawEndpoint) => {
  let url;
  try {
    url = new URL(rawEndpoint);
  } catch {
    throw new Error("ATLAS_AGENT_ENDPOINT must be a URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("ATLAS_AGENT_ENDPOINT must use http or https.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("ATLAS_AGENT_ENDPOINT must not include credentials.");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("ATLAS_AGENT_ENDPOINT must not include query or hash.");
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith(IMPORT_PATH)) return url;
  if (pathname.length === 0) {
    throw new Error("ATLAS_AGENT_ENDPOINT must include a path.");
  }

  url.pathname = pathname.endsWith("/v1")
    ? `${pathname}${AGENT_RELATIVE_IMPORT_PATH}`
    : `${pathname}${IMPORT_PATH}`;
  return url;
};

export const parseClaudeCodeJsonl = (raw, options = {}) =>
  parseClaudeCodeLines(parseJsonLines(raw), options);

export const isAutomationSession = ({ env = process.env, parsed } = {}) => {
  try {
    if (env?.FLOPPY_CAPTURE === "0") return true;

    return (
      firstUserLocalText(parsed)
        ?.trim()
        .toLowerCase()
        .startsWith(SCHEDULED_TASK_PREFIX) === true
    );
  } catch {
    return false;
  }
};

export const parseClaudeCodeLines = (lines, options = {}) => {
  const sessionId =
    firstString(lines.map((line) => line.value.sessionId)) ??
    sessionIdFromFilePath(options.filePath) ??
    "claude-code-local-session";
  const capturedAt =
    options.capturedAt ?? lastTimestamp(lines) ?? new Date(0).toISOString();
  const firstOccurredAt = firstTimestamp(lines) ?? capturedAt;
  const cwd = firstString(lines.map((line) => line.value.cwd));
  const gitBranch = firstString(lines.map((line) => line.value.gitBranch));
  const customTitle = firstString(
    lines.map((line) => {
      const value = line.value.customTitle;
      return typeof value === "string" ? value : undefined;
    }),
  );
  const callNames = new Map();
  const drafts = [];

  for (const line of lines) {
    const record = line.value;
    const type = stringValue(record.type);
    const occurredAt = timestampFor(record, firstOccurredAt, line.lineNumber);
    const message = objectValue(record.message);
    if (type === "user") {
      const draftsBeforeRecord = drafts.length;
      const content = message?.content;
      if (typeof content === "string") {
        pushTextTurn(drafts, {
          actorId: "user_local",
          idPrefix: `claude-user-${line.lineNumber}`,
          kind: "message",
          occurredAt,
          providerMetadata: { uuid: stringValue(record.uuid) },
          text: content,
        });
        continue;
      }
      if (Array.isArray(content)) {
        for (const [index, part] of content.entries()) {
          const partObject = objectValue(part);
          if (partObject === null) continue;
          const partType = stringValue(partObject.type);
          if (partType === "text") {
            pushTextTurn(drafts, {
              actorId: "user_local",
              idPrefix: `claude-user-${line.lineNumber}-${index}`,
              kind: "message",
              occurredAt,
              providerMetadata: { uuid: stringValue(record.uuid) },
              text: textFromUnknown(partObject.text),
            });
            continue;
          }
          if (partType === "tool_result") {
            const toolUseId = stringValue(partObject.tool_use_id);
            const toolName =
              toolUseId === undefined ? undefined : callNames.get(toolUseId);
            pushTextTurn(drafts, {
              actorId: "tool_claude_code",
              idPrefix: `claude-tool-result-${line.lineNumber}-${index}`,
              kind: "tool_result",
              occurredAt,
              providerMetadata: {
                toolUseId,
                uuid: stringValue(record.uuid),
              },
              text: toolText("Tool result", toolName, partObject.content),
              toolName: toolName ?? null,
            });
          }
        }
      }
      if (
        drafts.length === draftsBeforeRecord &&
        isRecord(record.toolUseResult)
      ) {
        pushTextTurn(drafts, {
          actorId: "tool_claude_code",
          idPrefix: `claude-tool-result-${line.lineNumber}`,
          kind: "tool_result",
          occurredAt,
          providerMetadata: { uuid: stringValue(record.uuid) },
          text: toolText("Tool result", undefined, record.toolUseResult),
        });
      }
      continue;
    }

    if (type === "assistant" && message !== null) {
      const content = message.content;
      if (!Array.isArray(content)) {
        pushTextTurn(drafts, {
          actorId: "agent_claude_code",
          idPrefix: `claude-assistant-${line.lineNumber}`,
          kind: "message",
          occurredAt,
          providerMetadata: {
            model: stringValue(message.model),
            uuid: stringValue(record.uuid),
          },
          text: textFromUnknown(content),
        });
        continue;
      }
      for (const [index, part] of content.entries()) {
        const partObject = objectValue(part);
        if (partObject === null) continue;
        const partType = stringValue(partObject.type);
        if (partType === "text") {
          pushTextTurn(drafts, {
            actorId: "agent_claude_code",
            idPrefix: `claude-assistant-${line.lineNumber}-${index}`,
            kind: "message",
            occurredAt,
            providerMetadata: {
              model: stringValue(message.model),
              uuid: stringValue(record.uuid),
            },
            text: textFromUnknown(partObject.text),
          });
          continue;
        }
        if (partType === "tool_use") {
          const toolUseId = stringValue(partObject.id);
          const toolName = stringValue(partObject.name);
          if (toolUseId !== undefined && toolName !== undefined) {
            callNames.set(toolUseId, toolName);
          }
          pushTextTurn(drafts, {
            actorId: "agent_claude_code",
            idPrefix: `claude-tool-call-${line.lineNumber}-${index}`,
            kind: "tool_call",
            occurredAt,
            providerMetadata: {
              toolUseId,
              uuid: stringValue(record.uuid),
            },
            text: toolText("Tool call", toolName, partObject.input),
            toolName: toolName ?? null,
          });
        }
      }
    }
  }

  return finishLocalSessionImport({
    actors: [
      {
        id: "user_local",
        display: "Local user",
        actorKind: "human",
      },
      {
        id: "agent_claude_code",
        display: "Claude Code",
        actorKind: "coding_agent",
      },
      {
        id: "tool_claude_code",
        display: "Claude Code tool output",
        actorKind: "tool",
      },
    ],
    capturedAt,
    drafts,
    filePath: options.filePath,
    firstOccurredAt,
    provider: "claude_code",
    redaction: options.redaction ?? "basic",
    repository: repositoryFrom(cwd, gitBranch),
    sessionId,
    sourceSystem: "claude_code",
    title: customTitle ?? titleFor("Claude Code session", sessionId, drafts),
  });
};

const finishLocalSessionImport = ({
  actors,
  capturedAt,
  drafts,
  filePath,
  firstOccurredAt,
  provider,
  redaction,
  repository,
  sessionId,
  sourceSystem,
  title,
}) => {
  if (drafts.length === 0) {
    throw new CodingAgentLocalSessionParseError(
      `${sourceSystem} local session did not contain any importable user, assistant, or tool turns.`,
    );
  }
  const redactionRecorder = localSessionRedactionRecorder(redaction);
  const turns = drafts.map(({ idPrefix, ...turn }, index) => ({
    ...turn,
    id: `${idPrefix}-${index + 1}`,
    text: redactLocalSessionText(turn.text, redactionRecorder),
  }));
  const redactedTitle = redactLocalSessionText(title, redactionRecorder);
  const redactionSummary = redactionRecorder.summary();
  return {
    provider,
    sourceSystem,
    sessionId,
    title: redactedTitle,
    startedAt: firstOccurredAt,
    endedAt: turns[turns.length - 1]?.occurredAt ?? firstOccurredAt,
    capturedAt,
    actors,
    turns,
    ...(repository === undefined ? {} : { repository }),
    providerMetadata: {
      localImport: {
        fileName:
          filePath === undefined || filePath.trim().length === 0
            ? null
            : basename(filePath),
        parser: "coding-agent-local-session-import@2026-05-31",
        redaction: redactionSummary,
        sourceSystem,
      },
    },
  };
};

const localSessionRedactionRecorder = (mode) => {
  const counts = new Map();
  return {
    mode,
    record: (kind) => counts.set(kind, (counts.get(kind) ?? 0) + 1),
    summary: () => {
      const categories = [...counts.entries()]
        .map(([kind, count]) => ({ kind, count }))
        .sort((left, right) => left.kind.localeCompare(right.kind));
      const replacementCount = categories.reduce(
        (total, category) => total + category.count,
        0,
      );
      return {
        mode,
        replacementCount,
        categories,
      };
    },
  };
};

export const redactLocalSessionText = (
  value,
  recorder = localSessionRedactionRecorder("basic"),
) => {
  if (recorder.mode === "off") return value;

  let redacted = value.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    () => {
      recorder.record("private_key_block");
      return "[redacted:private_key_block]";
    },
  );

  redacted = redacted.replace(
    /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Z0-9_]*(?:\s*[:=]\s*|["']?\s*:\s*["']?))([^\s"',;]+)/gi,
    (_match, prefix) => {
      recorder.record("secret_assignment");
      return `${prefix}[redacted:secret_assignment]`;
    },
  );

  redacted = redactFullMatches(
    redacted,
    new RegExp(`\\b${["sk", "ant"].join("-")}-[A-Za-z0-9_-]{16,}\\b`, "g"),
    "anthropic_api_key",
    recorder,
  );
  redacted = redactFullMatches(
    redacted,
    new RegExp(`\\b${["sk", "proj"].join("-")}-[A-Za-z0-9_-]{16,}\\b`, "g"),
    "openai_api_key",
    recorder,
  );
  redacted = redactFullMatches(
    redacted,
    new RegExp(`\\b${["sk", "[A-Za-z0-9]{20,}\\b"].join("-")}`, "g"),
    "openai_api_key",
    recorder,
  );
  redacted = redactFullMatches(
    redacted,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    "github_token",
    recorder,
  );
  redacted = redactFullMatches(
    redacted,
    new RegExp(`\\bxox[baprs]-[A-Za-z0-9-]{20,}\\b`, "g"),
    "slack_token",
    recorder,
  );
  redacted = redactFullMatches(
    redacted,
    new RegExp(`\\b(?:${["AK", "IA"].join("")}|${["AS", "IA"].join("")})[A-Z0-9]{16}\\b`, "g"),
    "aws_access_key_id",
    recorder,
  );
  redacted = redacted.replace(/\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/g, () => {
    recorder.record("bearer_token");
    return "Bearer [redacted:bearer_token]";
  });

  return redacted;
};

const redactFullMatches = (value, pattern, kind, recorder) =>
  value.replace(pattern, () => {
    recorder.record(kind);
    return `[redacted:${kind}]`;
  });

const parseJsonLines = (raw) => {
  const lines = raw.split(/\r?\n/);
  const parsed = [];
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let value;
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw new CodingAgentLocalSessionParseError(
        `Invalid JSONL on line ${index + 1}.`,
      );
    }
    if (!isRecord(value)) {
      throw new CodingAgentLocalSessionParseError(
        `Expected a JSON object on line ${index + 1}.`,
      );
    }
    parsed.push({ lineNumber: index + 1, value });
  }
  if (parsed.length === 0) {
    throw new CodingAgentLocalSessionParseError("Local session file is empty.");
  }
  return parsed;
};

const pushTextTurn = (drafts, turn) => {
  const text = textFromUnknown(turn.text).trim();
  if (text.length === 0) return;
  drafts.push({
    ...turn,
    text,
  });
};

const textFromUnknown = (value) => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => textFromUnknown(item))
      .filter((text) => text.trim().length > 0)
      .join("\n\n");
  }
  const object = objectValue(value);
  if (object === null) return "";
  const type = stringValue(object.type);
  if (
    (type === "text" ||
      type === "input_text" ||
      type === "output_text" ||
      type === "tool_result") &&
    object.text !== undefined
  ) {
    return textFromUnknown(object.text);
  }
  if (type === "tool_result" && object.content !== undefined) {
    return textFromUnknown(object.content);
  }
  return stableJson(object);
};

const toolText = (label, toolName, value) => {
  const body = textFromUnknown(value).trim();
  const header =
    toolName === undefined || toolName.length === 0
      ? label
      : `${label}: ${toolName}`;
  return body.length === 0 ? header : `${header}\n${body}`;
};

const timestampFor = (record, fallback, lineNumber) => {
  const direct =
    stringValue(record.timestamp) ??
    stringValue(record.started_at) ??
    stringValue(objectValue(record.payload)?.timestamp);
  const parsed = direct === undefined ? Number.NaN : Date.parse(direct);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  const fallbackMs = Date.parse(fallback);
  return new Date(
    (Number.isNaN(fallbackMs) ? 0 : fallbackMs) + lineNumber,
  ).toISOString();
};

const firstTimestamp = (lines) => {
  for (const line of lines) {
    const timestamp = timestampFor(line.value, "", 0);
    if (Date.parse(timestamp) > 0) return timestamp;
  }
  return undefined;
};

const lastTimestamp = (lines) => {
  for (const line of [...lines].reverse()) {
    const timestamp = timestampFor(line.value, "", 0);
    if (Date.parse(timestamp) > 0) return timestamp;
  }
  return undefined;
};

const firstString = (values) => {
  for (const value of values) {
    const string = stringValue(value);
    if (string !== undefined) return string;
  }
  return undefined;
};

const firstUserLocalText = (parsed) => {
  if (!isRecord(parsed) || !Array.isArray(parsed.turns)) return undefined;
  const turn = parsed.turns.find(
    (candidate) => isRecord(candidate) && candidate.actorId === "user_local",
  );
  return typeof turn?.text === "string" ? turn.text : undefined;
};

const titleFor = (prefix, sessionId, drafts) => {
  const firstUserText = drafts.find(
    (turn) => turn.actorId === "user_local",
  )?.text;
  if (firstUserText !== undefined && firstUserText.trim().length > 0) {
    return truncate(firstUserText.trim().replace(/\s+/g, " "), 96);
  }
  return `${prefix} ${sessionId}`;
};

const repositoryFrom = (cwd, branch) => {
  if (cwd === undefined && branch === undefined) return undefined;
  return {
    ...(cwd === undefined ? {} : { name: basename(cwd), path: cwd }),
    ...(branch === undefined ? {} : { branch }),
  };
};

const sessionIdFromFilePath = (filePath) => {
  if (filePath === undefined || filePath.trim().length === 0) {
    return undefined;
  }
  const fileName = basename(filePath);
  const extension = extname(fileName);
  return extension.length === 0
    ? fileName
    : fileName.slice(0, -extension.length);
};

const truncate = (value, maxLength) =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;

const stableJson = (value) => {
  if (!isRecord(value)) return String(value ?? "");
  return JSON.stringify(value, null, 2);
};

const stringValue = (value) =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const objectValue = (value) => (isRecord(value) ? value : null);

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const postImport = async ({ endpoint, token, idempotencyKey, body }) => {
  const importUrl = agentImportEndpoint(endpoint);
  const response = await fetch(importUrl, {
    method: "POST",
    headers: {
      authorization: ["Bearer", token].join(" "),
      "content-type": "application/json",
      ...(idempotencyKey === undefined
        ? {}
        : { "idempotency-key": idempotencyKey }),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    const snippet = responseBody.replace(/\s+/g, " ").trim().slice(0, 300);
    logToStderr(
      `import failed: HTTP ${response.status} ${response.statusText}`.trim() +
        (snippet.length === 0 ? "" : ` — ${snippet}`),
    );
    return { ok: false, status: response.status };
  }
  logToStderr(`import succeeded: HTTP ${response.status}`);
  return { ok: true, status: response.status };
};

const captureFromStopHook = async (rawInput, env = process.env) => {
  const token = stringValue(env.ATLAS_AGENT_TOKEN);
  const endpoint = resolveAgentEndpoint(env);
  if (token === undefined || endpoint === undefined) {
    logToStderr(
      "skipping capture: ATLAS_AGENT_TOKEN and/or agent endpoint (ATLAS_AGENT_ENDPOINT or ATLAS_MCP_URL) is not configured.",
    );
    return;
  }

  const { transcriptPath, sessionId } = parseStopHookInput(rawInput);
  if (transcriptPath === undefined) {
    logToStderr(
      "skipping capture: stop-hook payload did not include transcript_path.",
    );
    return;
  }

  const rawTranscript = await readFile(transcriptPath, "utf8");
  const parsed = parseClaudeCodeJsonl(rawTranscript, {
    filePath: transcriptPath,
    redaction: "basic",
  });
  if (isAutomationSession({ env, parsed })) {
    logToStderr("skipping capture: automation/scheduled-task session");
    return;
  }

  await postImport({
    endpoint,
    token,
    idempotencyKey: sessionId ?? parsed.sessionId,
    body: parsed,
  });
};

// `fs/promises` readFile does not accept a numeric file descriptor on
// Node >= 20 (ERR_INVALID_ARG_TYPE), which previously made this hook a
// silent no-op. Stream process.stdin instead — works on every supported
// Node version and tolerates an empty/closed stdin.
const readStdinText = async () => {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
};

const main = async () => {
  const rawInput = await readStdinText();
  await captureFromStopHook(rawInput);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    logToStderr(
      "capture failed:",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  }
  // The Stop hook must never fail the host session, no matter what happened
  // above — failures are reported on stderr only.
  process.exitCode = 0;
}
