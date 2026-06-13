import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const CACHE_FILE = "grounding.json";
const SEARCH_QUERY = "tenant profile current priorities decisions projects people";
const MAX_CONTEXT_LENGTH = 12000;

const jsonRpcPayload = (id, method, params) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

const parseJson = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const parseSseOrJson = (raw) => {
  const json = parseJson(raw);
  if (json !== null) return json;

  const payloads = [];
  let current = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      if (current.length > 0) {
        payloads.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    if (line.startsWith("data:")) {
      current.push(line.slice(5).trimStart());
    }
  }
  if (current.length > 0) payloads.push(current.join("\n"));

  for (const payload of payloads.reverse()) {
    if (payload === "[DONE]") continue;
    const parsed = parseJson(payload);
    if (parsed !== null) return parsed;
  }

  return null;
};

const postJsonRpc = async (url, token, payload) => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: ["Bearer", token].join(" "),
      "content-type": "application/json",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.text();
  if (!response.ok) return null;
  return parseSseOrJson(raw);
};

const textFromToolContent = (content) => {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (
        part !== null &&
        typeof part === "object" &&
        part.type === "text" &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
};

const contextFromToolResponse = (response) => {
  if (response === null || typeof response !== "object") return "";
  const result = response.result;
  if (result === null || typeof result !== "object") return "";

  const structured = result.structuredContent;
  if (structured !== undefined) {
    return JSON.stringify(structured, null, 2);
  }

  const text = textFromToolContent(result.content);
  if (text.trim().length === 0) return "";

  const parsed = parseJson(text);
  return parsed === null ? text : JSON.stringify(parsed, null, 2);
};

const truncate = (value, maxLength) =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;

const main = async () => {
  const mcpUrl = process.env.ATLAS_MCP_URL?.trim();
  const token = process.env.ATLAS_AGENT_TOKEN?.trim();
  const dataDir = process.env.CLAUDE_PLUGIN_DATA?.trim();

  if (!mcpUrl || !token || !dataDir) return;

  await postJsonRpc(
    mcpUrl,
    token,
    jsonRpcPayload(1, "initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "floppy-plugin-session-start",
        version: "0.1.0",
      },
    }),
  );

  const toolResponse = await postJsonRpc(
    mcpUrl,
    token,
    jsonRpcPayload(2, "tools/call", {
      name: "atlas_search_wiki",
      arguments: {
        query: SEARCH_QUERY,
        limit: 5,
      },
    }),
  );

  const contextBody = contextFromToolResponse(toolResponse).trim();
  if (contextBody.length === 0) return;

  const context = [
    "Floppy cached grounding from Atlas memory:",
    truncate(contextBody, MAX_CONTEXT_LENGTH),
  ].join("\n\n");

  await mkdir(dataDir, { recursive: true });
  await writeFile(
    join(dataDir, CACHE_FILE),
    `${JSON.stringify({ context, refreshedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
};

try {
  await main();
} catch {
}
