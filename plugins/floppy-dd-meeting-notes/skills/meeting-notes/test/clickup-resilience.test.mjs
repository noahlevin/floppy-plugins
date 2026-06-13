import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLICKUP_RESOLUTION_STEPS,
  DEFAULT_RETRY_POLICY,
  isTransientClickupError,
  withClickupRetry,
  writeClickupTasksResilient,
} from "../lib/clickup-resilience.mjs";

/** A sleep that records calls and resolves immediately (no real waiting). */
const recordingSleep = () => {
  /** @type {number[]} */
  const delays = [];
  return {
    delays,
    sleep: async (ms) => {
      delays.push(ms);
    },
  };
};

/** Deterministic jitter source so backoff is exactly the base curve. */
const noJitter = () => 0.5;

const task = (name, extra = {}) => ({ name, markdown_description: `desc ${name}`, ...extra });

test("isTransientClickupError: connection drops retry, auth/validation do not", () => {
  assert.equal(isTransientClickupError(new Error("ClickUp is offline")), true);
  assert.equal(isTransientClickupError(new Error("connection reset")), true);
  assert.equal(isTransientClickupError(new Error("socket hang up")), true);
  assert.equal(isTransientClickupError({ status: 503, message: "unavailable" }), true);
  assert.equal(isTransientClickupError({ status: 429, message: "rate limited" }), true);
  // Permanent:
  assert.equal(isTransientClickupError({ status: 401, message: "unauthorized" }), false);
  assert.equal(isTransientClickupError({ status: 400, message: "bad list id" }), false);
  assert.equal(isTransientClickupError(new Error("invalid task name")), false);
  // Explicit override wins:
  assert.equal(isTransientClickupError({ retryable: false, message: "offline" }), false);
});

test("withClickupRetry: recovers after N transient failures, within the cap", async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;
  const value = await withClickupRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("ClickUp is offline");
      return "ok";
    },
    { sleep, rng: noJitter, policy: DEFAULT_RETRY_POLICY },
  );
  assert.equal(value, "ok");
  assert.equal(calls, 3, "two failures then success");
  // Backoff happened twice, capped-exponential, increasing.
  assert.equal(delays.length, 2);
  assert.equal(delays[0], 250);
  assert.equal(delays[1], 500);
  assert.ok(delays[1] > delays[0], "backoff increases");
});

test("withClickupRetry: caps attempts and rethrows the last transient error (no infinite hammer)", async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;
  await assert.rejects(
    () =>
      withClickupRetry(
        async () => {
          calls += 1;
          throw new Error("ClickUp is offline");
        },
        { sleep, rng: noJitter, policy: { maxAttempts: 4, baseDelayMs: 250, maxDelayMs: 2000, jitter: 0 } },
      ),
    /offline/,
  );
  assert.equal(calls, 4, "exactly maxAttempts tries, not unbounded");
  assert.equal(delays.length, 3, "one backoff between each of the 4 attempts");
});

test("withClickupRetry: permanent error fails fast (no retries, no backoff)", async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;
  await assert.rejects(
    () =>
      withClickupRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error("unauthorized"), { status: 401 });
        },
        { sleep, rng: noJitter },
      ),
    /unauthorized/,
  );
  assert.equal(calls, 1, "no retries on a permanent error");
  assert.equal(delays.length, 0);
});

test("happy path: all tasks created once, no regression", async () => {
  /** @type {string[]} */
  const created = [];
  const { sleep } = recordingSleep();
  const result = await writeClickupTasksResilient({
    listId: "list_1",
    tasks: [task("[AGENT TESTING] A"), task("[AGENT TESTING] B")],
    filterTasks: async () => [],
    createTask: async (t) => {
      created.push(t.name);
      return { externalId: `ck_${created.length}`, title: t.name, url: `https://clickup/${created.length}` };
    },
    sleep,
    rng: noJitter,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.clickupReachable, true);
  assert.deepEqual(created, ["[AGENT TESTING] A", "[AGENT TESTING] B"]);
  assert.equal(result.created.length, 2);
  assert.equal(result.held.length, 0);
  assert.equal(result.skippedDuplicates.length, 0);
  assert.equal(result.resolutionSteps.length, 0, "no operator steps when healthy");
  assert.equal(result.created[0].externalId, "ck_1");
});

test("dedup against existing list: pre-existing titles are skipped, not recreated", async () => {
  /** @type {string[]} */
  const created = [];
  const result = await writeClickupTasksResilient({
    listId: "list_1",
    tasks: [task("[AGENT TESTING] A"), task("[AGENT TESTING] B")],
    // List already has "A" (different case + extra whitespace to prove normalization).
    filterTasks: async () => [{ name: "[agent testing]   a" }],
    createTask: async (t) => {
      created.push(t.name);
      return { externalId: `ck_${created.length}`, title: t.name };
    },
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(created, ["[AGENT TESTING] B"], "only the new task is created");
  assert.equal(result.skippedDuplicates.length, 1);
  assert.equal(result.skippedDuplicates[0].name, "[AGENT TESTING] A");
});

test("simulated persistent outage on create → graceful degradation, no throw, holds remainder, resolution steps present", async () => {
  /** @type {string[]} */
  const created = [];
  let createCalls = 0;
  const { sleep } = recordingSleep();

  const result = await writeClickupTasksResilient({
    listId: "list_1",
    tasks: [task("[AGENT TESTING] A"), task("[AGENT TESTING] B"), task("[AGENT TESTING] C")],
    filterTasks: async () => [],
    createTask: async (t) => {
      createCalls += 1;
      // First task succeeds; from the second task on, ClickUp is offline forever.
      if (created.length >= 1) throw new Error("ClickUp is offline");
      created.push(t.name);
      return { externalId: "ck_1", title: t.name };
    },
    sleep,
    rng: noJitter,
    // Small cap so the test is fast but still exercises bounded retry.
    policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 4, jitter: 0 },
  });

  // Never threw — recap/proposal flow can still complete.
  assert.equal(result.status, "degraded");
  assert.equal(result.clickupReachable, true, "dedup read succeeded; the write dropped");
  assert.equal(result.created.length, 1, "the one task created before the drop is kept");
  assert.equal(result.created[0].title, "[AGENT TESTING] A");
  // Held the failing task AND everything after it — nothing lost.
  assert.deepEqual(
    result.held.map((t) => t.name),
    ["[AGENT TESTING] B", "[AGENT TESTING] C"],
  );
  // Bounded retry was attempted on the failing create (1 initial + 2 retries = 3).
  assert.equal(createCalls, 1 + 3, "one success + 3 bounded attempts on the failing task");
  // Concrete operator resolution steps are surfaced verbatim.
  assert.deepEqual(result.resolutionSteps, [...CLICKUP_RESOLUTION_STEPS]);
  assert.ok(result.resolutionSteps.some((s) => /Cowork → Connectors/.test(s)));
  assert.ok(result.warnings.join("\n").includes("held for replay"));
});

test("dedup unreachable: whole batch held (not blind-created), degraded, never throws", async () => {
  let createCalls = 0;
  const { sleep } = recordingSleep();
  const result = await writeClickupTasksResilient({
    listId: "list_1",
    tasks: [task("[AGENT TESTING] A"), task("[AGENT TESTING] B")],
    filterTasks: async () => {
      throw new Error("ClickUp is offline");
    },
    createTask: async () => {
      createCalls += 1;
      return { externalId: "x", title: "x" };
    },
    sleep,
    rng: noJitter,
    policy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2, jitter: 0 },
  });

  assert.equal(result.status, "degraded");
  assert.equal(result.clickupReachable, false);
  assert.equal(createCalls, 0, "must NOT blind-create without a dedup read");
  assert.equal(result.created.length, 0);
  assert.equal(result.held.length, 2, "entire batch held, nothing lost");
  assert.deepEqual(result.resolutionSteps, [...CLICKUP_RESOLUTION_STEPS]);
});

test("idempotent replay: re-running after reconnect creates each task exactly once (no duplicates)", async () => {
  // Model a single shared ClickUp list across two runs.
  /** @type {Array<{ name: string }>} */
  const listState = [];
  let outageActive = true;
  const { sleep } = recordingSleep();

  const filterTasks = async () => {
    if (outageActive) throw new Error("ClickUp is offline");
    return listState.map((t) => ({ name: t.name }));
  };
  const createTask = async (t) => {
    if (outageActive) throw new Error("ClickUp is offline");
    listState.push({ name: t.name });
    return { externalId: `ck_${listState.length}`, title: t.name };
  };

  const proposed = [task("[AGENT TESTING] A"), task("[AGENT TESTING] B")];
  const common = { listId: "list_1", filterTasks, createTask, sleep, rng: noJitter, policy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2, jitter: 0 } };

  // Run 1 — outage: nothing written, everything held.
  const run1 = await writeClickupTasksResilient({ ...common, tasks: proposed });
  assert.equal(run1.status, "degraded");
  assert.equal(run1.held.length, 2);
  assert.equal(listState.length, 0, "no tasks written during the outage");

  // Operator reconnects ClickUp.
  outageActive = false;

  // Run 2 — replay the SAME proposed batch against the now-reachable list.
  const run2 = await writeClickupTasksResilient({ ...common, tasks: proposed });
  assert.equal(run2.status, "completed");
  assert.equal(run2.created.length, 2);
  assert.equal(listState.length, 2, "exactly two tasks now exist");

  // Run 3 — replay AGAIN (e.g. operator double-clicks): dedup catches all,
  // zero new tasks created. This is the core idempotency guarantee.
  const run3 = await writeClickupTasksResilient({ ...common, tasks: proposed });
  assert.equal(run3.status, "completed");
  assert.equal(run3.created.length, 0, "no duplicates on a second replay");
  assert.equal(run3.skippedDuplicates.length, 2);
  assert.equal(listState.length, 2, "still exactly two tasks — idempotent");
});

test("same-title tasks within one batch are not double-created", async () => {
  /** @type {string[]} */
  const created = [];
  const result = await writeClickupTasksResilient({
    listId: "list_1",
    tasks: [task("[AGENT TESTING] Dup"), task("[AGENT TESTING] Dup"), task("[AGENT TESTING] Unique")],
    filterTasks: async () => [],
    createTask: async (t) => {
      created.push(t.name);
      return { externalId: `ck_${created.length}`, title: t.name };
    },
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(created, ["[AGENT TESTING] Dup", "[AGENT TESTING] Unique"]);
  assert.equal(result.skippedDuplicates.length, 1, "the in-batch duplicate is skipped");
});

test("empty task list is a clean no-op (no ClickUp calls)", async () => {
  let touched = false;
  const result = await writeClickupTasksResilient({
    listId: "list_1",
    tasks: [],
    filterTasks: async () => {
      touched = true;
      return [];
    },
    createTask: async () => {
      touched = true;
      return { externalId: "x", title: "x" };
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.created.length, 0);
  assert.equal(touched, false, "no ClickUp call when there is nothing to write");
});

test("guards: missing actuators or listId throw a clear TypeError", async () => {
  await assert.rejects(
    () => writeClickupTasksResilient({ listId: "l", tasks: [task("A")], createTask: async () => ({}) }),
    /filterTasks and createTask/,
  );
  await assert.rejects(
    () =>
      writeClickupTasksResilient({
        tasks: [task("A")],
        filterTasks: async () => [],
        createTask: async () => ({ externalId: "x", title: "x" }),
      }),
    /listId/,
  );
});
