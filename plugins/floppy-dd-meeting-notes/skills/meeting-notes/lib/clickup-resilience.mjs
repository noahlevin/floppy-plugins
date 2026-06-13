/**
 * SP-164 — agent-side ClickUp write resilience for the meeting-notes skill.
 *
 * The live skill path is agent-driven: Claude Code is the only ClickUp
 * actuator and calls the `clickup_*` MCP tools itself (see SKILL.md step 7).
 * This module does NOT open its own ClickUp connection and does NOT take
 * server-side ownership of the connection. It is a pure, dependency-injected
 * wrapper: the agent passes in its own MCP-backed `filterTasks` / `createTask`
 * callables, and this helper layers on the resilience the raw MCP calls lack
 * when ClickUp drops mid-write ("ClickUp is offline", seen live 2026-06-04):
 *
 *   - Bounded retry with capped exponential backoff around each transient
 *     ClickUp call (never an unbounded hammer).
 *   - Idempotent hold + replay: dedup against existing list tasks AND against
 *     tasks created earlier in THIS batch, so a reconnect-replay creates each
 *     task exactly once — never duplicates.
 *   - Graceful degradation: on persistent failure the batch never throws; it
 *     returns a structured result (created so far + held remainder + concrete
 *     operator resolution steps) so the caller can still complete the recap +
 *     inline proposal and surface a clear "what to do" to the operator.
 *
 * Zero LLM, zero network of its own. Fully unit-testable with fake callables.
 */

/** Default bounded-retry policy. Tuned to recover from a brief ClickUp blip
 * without hammering: 4 attempts total over ~1.75s of backoff worst case. */
export const DEFAULT_RETRY_POLICY = Object.freeze({
  /** Total attempts per call (1 initial + (maxAttempts-1) retries). */
  maxAttempts: 4,
  /** First backoff delay in ms; doubles each retry up to maxDelayMs. */
  baseDelayMs: 250,
  /** Cap on any single backoff delay. */
  maxDelayMs: 2_000,
  /** Multiplicative jitter range [1-jitter, 1+jitter] applied to each delay. */
  jitter: 0.2,
});

/** Concrete, copy-pasteable steps the operator can take when ClickUp stays
 * down. Surfaced verbatim in the degraded result so the agent never has to
 * improvise resolution guidance. */
export const CLICKUP_RESOLUTION_STEPS = Object.freeze([
  "Reconnect the ClickUp connector in Cowork → Connectors (find ClickUp, click Reconnect / Re-authorize).",
  "If reconnect prompts a login, complete the ClickUp OAuth re-auth and confirm the right ClickUp workspace is selected.",
  "Verify the demo list is reachable in that workspace (open ClickUp and confirm the list id resolves).",
  "Re-run this step once connected — held tasks replay idempotently, so already-created tasks are skipped (no duplicates).",
]);

/**
 * Patterns that identify a transient ClickUp connection drop vs. a permanent,
 * non-retryable error (auth, validation). Connection-shaped failures retry;
 * everything else fails fast so we don't burn the retry budget on a 4xx.
 */
const TRANSIENT_MESSAGE = /(offline|disconnect|connection|econnreset|etimedout|timeout|socket hang up|network|fetch failed|503|502|504|429|temporarily|unavailable)/i;

/**
 * Decide whether an error from a ClickUp call is worth retrying.
 * Honors an explicit `error.retryable` / `error.transient` boolean when the
 * caller sets one; otherwise sniffs the message + any numeric `status`.
 * @param {unknown} error
 * @returns {boolean}
 */
export const isTransientClickupError = (error) => {
  if (error && typeof error === "object") {
    const tagged = /** @type {{ retryable?: unknown, transient?: unknown, status?: unknown, statusCode?: unknown }} */ (
      error
    );
    if (typeof tagged.retryable === "boolean") return tagged.retryable;
    if (typeof tagged.transient === "boolean") return tagged.transient;
    const status = Number(tagged.status ?? tagged.statusCode);
    if (Number.isFinite(status)) {
      // 408/425/429 + 5xx are transient; other 4xx are permanent.
      if (status === 408 || status === 425 || status === 429) return true;
      if (status >= 500) return true;
      if (status >= 400) return false;
    }
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return TRANSIENT_MESSAGE.test(message);
};

/**
 * @param {number} attempt zero-based retry index (0 = first backoff)
 * @param {typeof DEFAULT_RETRY_POLICY} policy
 * @param {() => number} rng
 * @returns {number} delay in ms
 */
const backoffDelay = (attempt, policy, rng) => {
  const raw = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs);
  const jitterFactor = 1 + (rng() * 2 - 1) * policy.jitter;
  return Math.max(0, Math.round(raw * jitterFactor));
};

/**
 * Run `fn` with bounded retry + capped exponential backoff. Retries only
 * transient (connection-shaped) errors; rethrows permanent errors immediately
 * and rethrows the last transient error once the attempt cap is hit. Never
 * loops unbounded.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {object} [options]
 * @param {Partial<typeof DEFAULT_RETRY_POLICY>} [options.policy]
 * @param {(ms: number) => Promise<void>} [options.sleep] Injectable for tests.
 * @param {() => number} [options.rng] Injectable jitter source (default Math.random).
 * @param {(message: string, meta?: object) => void} [options.log]
 * @param {string} [options.label] Human label for log lines.
 * @returns {Promise<T>}
 */
export const withClickupRetry = async (fn, options = {}) => {
  const policy = { ...DEFAULT_RETRY_POLICY, ...(options.policy ?? {}) };
  const sleep =
    options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const rng = options.rng ?? Math.random;
  const log = options.log ?? (() => {});
  const label = options.label ?? "clickup_call";

  let lastError;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const transient = isTransientClickupError(error);
      const hasBudget = attempt < policy.maxAttempts;
      log("clickup_attempt_failed", {
        label,
        attempt,
        maxAttempts: policy.maxAttempts,
        transient,
        willRetry: transient && hasBudget,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!transient || !hasBudget) throw error;
      await sleep(backoffDelay(attempt - 1, policy, rng));
    }
  }
  // Unreachable: the loop returns or throws. Guard for type-checkers.
  throw lastError ?? new Error("clickup retry exhausted");
};

/**
 * Normalize a task title for dedup matching: trimmed + collapsed whitespace +
 * lowercased. The prefix (if any) must already be applied by the caller so
 * dedup compares apples to apples against existing list names.
 * @param {string} name
 * @returns {string}
 */
const dedupKey = (name) => String(name ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * @typedef {object} ProposedTask
 * @property {string} name Final task name (prefix already applied by caller).
 * @property {string} [markdown_description]
 * @property {string} [due_date]
 */

/**
 * @typedef {object} CreatedTaskReceipt
 * @property {string} externalId ClickUp task id.
 * @property {string} title
 * @property {string} [url]
 */

/**
 * @typedef {object} ClickupBatchResult
 * @property {"completed" | "degraded"} status
 *   `completed` = every non-duplicate task was created (or all were dupes).
 *   `degraded`  = ClickUp stayed down; some tasks are held, none lost.
 * @property {CreatedTaskReceipt[]} created Tasks created in THIS run.
 * @property {ProposedTask[]} skippedDuplicates Tasks that already existed.
 * @property {ProposedTask[]} held Tasks not yet written (queued for replay).
 * @property {string[]} warnings Human-readable degradation notes.
 * @property {string[]} resolutionSteps Operator steps (empty when completed).
 * @property {boolean} clickupReachable Whether dedup/list read succeeded.
 */

/**
 * Idempotent, bounded-retry ClickUp task batch writer.
 *
 * The agent supplies the actuators (`filterTasks`, `createTask`) — this helper
 * never touches ClickUp directly, preserving the agent-as-sole-actuator rule.
 * On a persistent connection drop it degrades: returns what was created plus
 * the held remainder plus concrete resolution steps, and NEVER throws, so the
 * recap + inline proposal still complete.
 *
 * Idempotency on replay: dedup is computed against existing list tasks AND
 * against tasks already created in this batch, so re-invoking after a reconnect
 * (with the same proposed list against the now-populated ClickUp list) creates
 * each task exactly once.
 *
 * @param {object} args
 * @param {ProposedTask[]} args.tasks Final-named proposed tasks.
 * @param {string} args.listId ClickUp list id.
 * @param {() => Promise<Array<{ name?: string } & Record<string, unknown>>>} args.filterTasks
 *   Agent-backed `clickup_filter_tasks` call for `listId` (include_closed:true).
 * @param {(task: ProposedTask) => Promise<CreatedTaskReceipt>} args.createTask
 *   Agent-backed `clickup_create_task` call returning the created task receipt.
 * @param {Partial<typeof DEFAULT_RETRY_POLICY>} [args.policy]
 * @param {(ms: number) => Promise<void>} [args.sleep] Injectable for tests.
 * @param {() => number} [args.rng] Injectable jitter source.
 * @param {(message: string, meta?: object) => void} [args.log]
 * @returns {Promise<ClickupBatchResult>}
 */
export const writeClickupTasksResilient = async (args) => {
  const {
    tasks = [],
    listId,
    filterTasks,
    createTask,
    policy,
    sleep,
    rng,
    log = () => {},
  } = args ?? {};

  if (typeof filterTasks !== "function" || typeof createTask !== "function") {
    throw new TypeError(
      "writeClickupTasksResilient requires filterTasks and createTask callables",
    );
  }
  if (typeof listId !== "string" || listId.length === 0) {
    throw new TypeError("writeClickupTasksResilient requires a listId");
  }

  const retryOpts = { policy, sleep, rng, log };

  /** @type {ClickupBatchResult} */
  const result = {
    status: "completed",
    created: [],
    skippedDuplicates: [],
    held: [],
    warnings: [],
    resolutionSteps: [],
    clickupReachable: true,
  };

  if (tasks.length === 0) {
    log("clickup_batch_empty", { listId });
    return result;
  }

  // 1) Dedup read (bounded-retry). If it stays down, degrade immediately and
  //    hold the whole batch — we will not blind-create without dedup, since
  //    that risks duplicates on a later replay.
  /** @type {Set<string>} */
  const existing = new Set();
  try {
    const listTasks = await withClickupRetry(() => filterTasks(), {
      ...retryOpts,
      label: "clickup_filter_tasks",
    });
    for (const task of Array.isArray(listTasks) ? listTasks : []) {
      const name = task && typeof task.name === "string" ? task.name : "";
      if (name) existing.add(dedupKey(name));
    }
  } catch (error) {
    result.clickupReachable = false;
    result.status = "degraded";
    result.held = [...tasks];
    result.warnings.push(
      `ClickUp is unreachable — could not read the demo list to dedup, so all ${tasks.length} task(s) are held (not lost). ${errMsg(error)}`,
    );
    result.resolutionSteps = [...CLICKUP_RESOLUTION_STEPS];
    log("clickup_dedup_unreachable", { listId, held: tasks.length });
    return result;
  }

  // 2) Create each non-duplicate task with bounded retry. Dedup against both
  //    the existing list AND tasks created earlier in this batch (idempotent
  //    replay). On the first persistent failure, hold the rest and degrade —
  //    we stop creating so a reconnect-replay doesn't double-write.
  let degraded = false;
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    const key = dedupKey(task.name);
    if (existing.has(key)) {
      result.skippedDuplicates.push(task);
      log("clickup_task_deduped", { name: task.name });
      continue;
    }
    try {
      const receipt = await withClickupRetry(() => createTask(task), {
        ...retryOpts,
        label: "clickup_create_task",
      });
      result.created.push(receipt);
      // Record so later identical titles in the same batch don't double-create.
      existing.add(key);
      log("clickup_task_created", { name: task.name, externalId: receipt.externalId });
    } catch (error) {
      degraded = true;
      // Hold this task and everything after it. Order preserved for clean replay.
      result.held = tasks.slice(index);
      result.warnings.push(
        `ClickUp dropped mid-write after creating ${result.created.length} task(s); ${result.held.length} task(s) held for replay (not lost). ${errMsg(error)}`,
      );
      log("clickup_write_degraded", {
        created: result.created.length,
        held: result.held.length,
      });
      break;
    }
  }

  if (degraded) {
    result.status = "degraded";
    result.resolutionSteps = [...CLICKUP_RESOLUTION_STEPS];
  }

  return result;
};

/**
 * @param {unknown} error
 * @returns {string}
 */
const errMsg = (error) => (error instanceof Error ? error.message : String(error));
