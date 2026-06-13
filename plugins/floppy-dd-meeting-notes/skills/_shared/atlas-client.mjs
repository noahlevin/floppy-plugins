/**
 * Shared REST client for the Atlas agent mirror, used by the deterministic CLI
 * fallbacks of the `floppy:*` skill suite.
 *
 * The live Claude Code skill path uses the bundled `atlas` MCP tools directly.
 * This client exists only so each skill's `bin/run.mjs` can exercise the same
 * grounded contract without an LLM.
 *
 * Promoted from `meeting-notes/lib/atlas-client.mjs` (API kept verbatim) and
 * extended with `searchWiki` and `readProfileContext` for the brief/digest read
 * paths. Tenant is ALWAYS derived from the bearer server-side — no method takes
 * a tenant argument.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const AGENT_ROUTE_PREFIX = "/v1/agent";

/**
 * @typedef {object} AtlasClientOptions
 * @property {string} atlasUrl Base Atlas URL. May be an origin or end with `/v1/agent`.
 * @property {string} bearer Tenant-scoped Atlas bearer token.
 * @property {string} [serverlessBearer] Optional Cloud Run identity token.
 * @property {Record<string, string>} [extraHeaders] Optional static headers.
 * @property {typeof fetch} [fetchImpl] Override fetch for tests.
 * @property {number} [timeoutMs] Per-request timeout. Default 30s.
 * @property {(message: string, meta?: object) => void} [log] Optional logger.
 */

/**
 * @typedef {object} BriefRequest
 * @property {string} task
 * @property {string} [transcript]
 * @property {string[]} [entityHints]
 * @property {number} [limit]
 */

/**
 * @typedef {object} SubmitDraftRequest
 * @property {"email_recap" | "clickup_task_batch"} type
 * @property {string} targetEntityId
 * @property {"project" | "entity" | "person"} targetKind
 * @property {string} body
 * @property {string} [subject]
 * @property {string[]} [recipients]
 * @property {{ tasks: Array<object> }} [payload]
 * @property {Array<{ assertion_id?: string, entity_id?: string, source_artifact_id?: string }>} citations
 * @property {string} [idempotencyKey]
 */

/**
 * Construct an Atlas agent REST client.
 * @param {AtlasClientOptions} options
 */
export const createAtlasClient = (options) => {
  if (!options || typeof options !== "object") {
    throw new TypeError("atlas client options are required");
  }
  if (typeof options.atlasUrl !== "string" || options.atlasUrl.length === 0) {
    throw new TypeError("atlasUrl is required");
  }
  if (typeof options.bearer !== "string" || options.bearer.length === 0) {
    throw new TypeError("bearer is required");
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = options.log ?? (() => {});
  const baseUrl = normalizeAtlasBaseUrl(options.atlasUrl);
  const serverlessBearer =
    typeof options.serverlessBearer === "string" && options.serverlessBearer.length > 0
      ? options.serverlessBearer
      : undefined;
  const extraHeaders =
    options.extraHeaders && typeof options.extraHeaders === "object"
      ? options.extraHeaders
      : {};

  /**
   * @param {"GET"|"POST"} method
   * @param {string} path Path below the agent prefix, e.g. `/v1/brief`.
   * @param {object} [body]
   */
  const request = async (method, path, body) => {
    const url = `${baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    /** @type {Record<string, string>} */
    const headers = {
      ...extraHeaders,
      Authorization: `Bearer ${options.bearer}`,
      Accept: "application/json",
      ...(serverlessBearer === undefined
        ? {}
        : { "X-Serverless-Authorization": `Bearer ${serverlessBearer}` }),
    };
    /** @type {RequestInit} */
    const init = {
      method,
      headers,
      signal: controller.signal,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      clearTimeout(timer);
      const message = error instanceof Error ? error.message : String(error);
      log("atlas_request_failed", { method, path, error: message });
      throw new AtlasClientError(
        `Atlas ${method} ${path} failed: ${message}`,
        { method, path, cause: error },
      );
    }
    clearTimeout(timer);

    const text = await response.text();
    /** @type {unknown} */
    let json = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    log("atlas_request_ok", { method, path, status: response.status });

    if (!response.ok) {
      const errorBody =
        json && typeof json === "object" && json !== null ? json : { raw: text };
      throw new AtlasClientError(
        `Atlas ${method} ${path} responded ${response.status}`,
        { method, path, status: response.status, body: errorBody },
      );
    }

    return json;
  };

  return {
    /**
     * Call the Atlas Brief REST mirror. The tenant is derived from the bearer
     * server-side — never pass a tenant here.
     * @param {BriefRequest} brief
     */
    async brief(brief) {
      return await request("POST", "/v1/brief", {
        task: brief.task,
        payload: {
          transcript: brief.transcript ?? "",
          entity_hints: brief.entityHints ?? [],
        },
        limit: brief.limit,
      });
    },

    /**
     * Resolve an unknown entity name to wiki hits. The tenant is derived from
     * the bearer server-side. Returns the parsed `{ results, total }` envelope.
     *
     * Degrades cleanly: a 404 / 503 / network error resolves to an EMPTY
     * envelope (`{ results: [], total: 0 }`) so a missing search route does not
     * crash the run.
     * @param {string} query
     * @param {{ limit?: number }} [opts]
     * @returns {Promise<{ results: Array<{ kind: string, id: string, title: string, snippet: string, score: number, sourceArtifactId?: string }>, total: number }>}
     */
    async searchWiki(query, opts = {}) {
      const empty = { results: [], total: 0 };
      const params = new URLSearchParams({ q: query });
      if (typeof opts.limit === "number" && Number.isInteger(opts.limit)) {
        params.set("limit", String(opts.limit));
      }
      try {
        const json = await request("GET", `/v1/wiki/search?${params.toString()}`);
        if (!json || typeof json !== "object") return empty;
        const result = /** @type {any} */ (json);
        return {
          results: Array.isArray(result.results) ? result.results : [],
          total: typeof result.total === "number" ? result.total : 0,
        };
      } catch (error) {
        const status = error instanceof AtlasClientError ? error.status : undefined;
        log("search_wiki_degraded", { status });
        return empty;
      }
    },

    /**
     * Deep single-entity read with an optional `since` window. The tenant is
     * derived from the bearer server-side. Returns the parsed `{ context }`
     * envelope.
     * @param {string} entityId
     * @param {{ since?: string, q?: string, limit?: number }} [opts]
     * @returns {Promise<{ context: object } | null>}
     */
    async readProfileContext(entityId, opts = {}) {
      const params = new URLSearchParams();
      if (typeof opts.since === "string" && opts.since.length > 0) {
        params.set("since", opts.since);
      }
      if (typeof opts.q === "string" && opts.q.length > 0) {
        params.set("q", opts.q);
      }
      if (typeof opts.limit === "number" && Number.isInteger(opts.limit)) {
        params.set("limit", String(opts.limit));
      }
      const query = params.toString();
      const json = await request(
        "GET",
        `/v1/profiles/${encodeURIComponent(entityId)}/context${
          query.length > 0 ? `?${query}` : ""
        }`,
      );
      if (!json || typeof json !== "object") return null;
      return /** @type {{ context: object }} */ (json);
    },

    /**
     * Run the DETERMINISTIC `atlas_review` verify mode (no LLM) on a set of
     * claims seeded from a draft's citations. Returns the deterministic
     * `{ ok, results, summary }` envelope.
     * @param {{ claims: Array<{ text: string, assertion_id?: string, entity_id?: string, source_artifact_id?: string }> }} input
     */
    async verify(input) {
      return await request("POST", "/v1/review", {
        mode: "verify",
        claims: input.claims,
      });
    },

    /**
     * Submit one review-required draft to Atlas.
     * @param {SubmitDraftRequest} draft
     */
    async submitReviewRequiredDraft(draft) {
      return await request("POST", "/v1/drafts/submit", draft);
    },

    /**
     * SP-147 — fetch this skill's per-tenant style-profile. The tenant is
     * derived from the bearer server-side. Returns the parsed
     * `{ skillId, rules, compiled, updatedAt }` envelope.
     *
     * Degrades cleanly: a 404 / 503 / network error resolves to an EMPTY
     * profile (`{ skillId, rules: [], compiled: "", updatedAt: null }`) so the
     * skill falls back to today's behavior instead of crashing the run.
     * @param {string} skillId
     * @returns {Promise<{ skillId: string, rules: Array<{ id: string, text: string, source: string, created_at: string }>, compiled: string, updatedAt: string | null }>}
     */
    async getSkillStyleProfile(skillId) {
      const empty = { skillId, rules: [], compiled: "", updatedAt: null };
      try {
        const json = await request(
          "GET",
          `/v1/skills/${encodeURIComponent(skillId)}/style-profile`,
        );
        if (!json || typeof json !== "object") return empty;
        const result = /** @type {any} */ (json);
        return {
          skillId: typeof result.skillId === "string" ? result.skillId : skillId,
          rules: Array.isArray(result.rules) ? result.rules : [],
          compiled: typeof result.compiled === "string" ? result.compiled : "",
          updatedAt:
            typeof result.updatedAt === "string" ? result.updatedAt : null,
        };
      } catch (error) {
        const status = error instanceof AtlasClientError ? error.status : undefined;
        log("style_profile_degraded", { skillId, status });
        return empty;
      }
    },

    /**
     * REST analogue for the receipt tool. The live skill normally uses MCP.
     * @param {string} draftId
     * @param {{ listId: string, results: Array<object>, idempotencyKey: string }} receipt
     */
    async recordOutboundReceipt(draftId, receipt) {
      return await request(
        "POST",
        `/v1/drafts/${encodeURIComponent(draftId)}/receipt`,
        {
          list_id: receipt.listId,
          results: receipt.results,
          idempotency_key: receipt.idempotencyKey,
        },
      );
    },
  };
};

/**
 * @param {string} atlasUrl
 */
const normalizeAtlasBaseUrl = (atlasUrl) => {
  const trimmed = atlasUrl.replace(/\/+$/, "");
  if (trimmed.endsWith(AGENT_ROUTE_PREFIX)) return trimmed;
  return `${trimmed}${AGENT_ROUTE_PREFIX}`;
};

/**
 * Error thrown by the Atlas client. Carries route metadata for tests and CLI
 * diagnostics.
 */
export class AtlasClientError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   method?: string,
   *   path?: string,
   *   status?: number,
   *   body?: object,
   *   cause?: unknown,
   * }} meta
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = "AtlasClientError";
    this.method = meta.method;
    this.path = meta.path;
    this.status = meta.status;
    this.body = meta.body;
    if (meta.cause !== undefined) this.cause = meta.cause;
  }
}
