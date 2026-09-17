// Focused checks for the judgment seam: request fidelity to the TypeSafe SDK,
// backend selection, and answer mapping for both backends.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createGateway } from "@ai-sdk/gateway";
import { experimental_evaluate as evaluate } from "ai";
import { rateLimitedFetch, retryAfterMs } from "./gateway-fetch.ts";
import {
  choice as typesafeChoice,
  noul as typesafeNoul,
  score as typesafeScore,
} from "@typesafe-ai/sdk";
import {
  choice,
  gatewayAnswer,
  judgmentBackend,
  noul,
  score,
  typesafeAnswer,
  typesafeQuestion,
  type GatewayResult,
} from "./judgment.ts";

const spec = { question: "Is this wrong?", focus: "runtime behavior", ignore: ["style"] };

const outcomes = {
  true: { what: "A wrong result", examples: ["inverted condition"] },
  false: { what: "Nothing wrong" },
};

const roles = { domain: "Core rules", utility: "Shared helper" };

const rubric = ["No impact", "Minor impact", "Significant impact"] as const;

test("the builders tag questions for the AI SDK", () => {
  assert.deepEqual(noul(spec, outcomes), {
    type: "boolean",
    instructions: spec,
    criteria: outcomes,
  });
  assert.deepEqual(choice(spec, roles), { type: "choice", instructions: spec, criteria: roles });
  assert.deepEqual(score("How bad?", rubric), {
    type: "score",
    instructions: "How bad?",
    criteria: rubric,
  });
});

// The TypeSafe backend must send the same request it sent before this change.
test("TypeSafe questions keep the SDK's own request shape", () => {
  assert.deepEqual(typesafeQuestion(noul(spec, outcomes)), typesafeNoul(spec, outcomes));
  assert.deepEqual(typesafeQuestion(choice(spec, roles)), typesafeChoice(spec, roles));
  assert.deepEqual(typesafeQuestion(score("How bad?", rubric)), typesafeScore("How bad?", rubric));
});

test("backend selection follows keys, then the explicit switch", () => {
  withEnv({ TYPESAFE_API_KEY: "ts" }, () => assert.equal(judgmentBackend(), "typesafe"));
  withEnv({ AI_GATEWAY_API_KEY: "gateway" }, () => assert.equal(judgmentBackend(), "ai-gateway"));
  withEnv({ TYPESAFE_API_KEY: "ts", AI_GATEWAY_API_KEY: "gateway" }, () =>
    assert.equal(judgmentBackend(), "typesafe"),
  );
  withEnv(
    { TYPESAFE_API_KEY: "ts", AI_GATEWAY_API_KEY: "gateway", JUDGE_BACKEND: "ai-gateway" },
    () => assert.equal(judgmentBackend(), "ai-gateway"),
  );
  withEnv(
    { TYPESAFE_API_KEY: "ts", AI_GATEWAY_API_KEY: "gateway", JUDGE_BACKEND: "typesafe" },
    () => assert.equal(judgmentBackend(), "typesafe"),
  );
});

test("backend selection rejects an empty switch, an unknown value, and a missing key", () => {
  withEnv({ AI_GATEWAY_API_KEY: "gateway", JUDGE_BACKEND: "" }, () =>
    assert.equal(judgmentBackend(), "ai-gateway"),
  );
  withEnv({ AI_GATEWAY_API_KEY: "gateway", JUDGE_BACKEND: "gateway" }, () =>
    assert.throws(() => judgmentBackend(), /JUDGE_BACKEND must be/),
  );
  withEnv({ JUDGE_BACKEND: "ai-gateway" }, () =>
    assert.throws(() => judgmentBackend(), /AI_GATEWAY_API_KEY/),
  );
  withEnv({ TYPESAFE_API_KEY: "ts", JUDGE_BACKEND: "ai-gateway" }, () =>
    assert.throws(() => judgmentBackend(), /AI_GATEWAY_API_KEY/),
  );
  withEnv({}, () => assert.throws(() => judgmentBackend(), /AI_GATEWAY_API_KEY/));
});

test("TypeSafe answers flatten without losing the reported confidence", () => {
  assert.deepEqual(typesafeAnswer({ type: "noul", noul: 0.8 }), {
    probability: 0.8,
    choice: "",
    score: 0,
    confidence: 0.8,
  });
  assert.deepEqual(typesafeAnswer({ type: "choice", choice: "domain", confidence: 0.7 }), {
    probability: 0,
    choice: "domain",
    score: 0,
    confidence: 0.7,
  });
  assert.deepEqual(typesafeAnswer({ type: "score", score: 2.5, confidence: 0.6 }), {
    probability: 0,
    choice: "",
    score: 2.5,
    confidence: 0.6,
  });
});

test("gateway answers prefer Jev's confidence over the probability", () => {
  const result: GatewayResult = {
    answers: {
      flag: { type: "boolean", probability: 0.9 },
      role: { type: "choice", choice: "domain", probabilities: { domain: 0.73, utility: 0.27 } },
      impact: { type: "score", score: 2.4, probabilities: { 0: 0.1, 1: 0.2, 2: 0.4, 3: 0.3 } },
    },
    providerMetadata: { typesafe: { confidence: { role: 0.45, impact: 0.62 } } },
  };

  assert.deepEqual(gatewayAnswer(result, "flag"), {
    probability: 0.9,
    choice: "",
    score: 0,
    confidence: 0.9,
  });
  assert.deepEqual(gatewayAnswer(result, "role"), {
    probability: 0,
    choice: "domain",
    score: 0,
    confidence: 0.45,
  });
  assert.deepEqual(gatewayAnswer(result, "impact"), {
    probability: 0,
    choice: "",
    score: 2.4,
    confidence: 0.62,
  });
});

test("gateway answers fall back to the top probability when confidence is absent", () => {
  const result: GatewayResult = {
    answers: {
      role: { type: "choice", choice: "domain", probabilities: { domain: 0.73, utility: 0.27 } },
    },
  };

  assert.deepEqual(gatewayAnswer(result, "role"), {
    probability: 0,
    choice: "domain",
    score: 0,
    confidence: 0.73,
  });
});

function withEnv(values: Record<string, string>, run: () => void): void {
  const names = ["JUDGE_BACKEND", "TYPESAFE_API_KEY", "AI_GATEWAY_API_KEY"];
  const before = new Map(names.map((name) => [name, process.env[name]]));

  for (const name of names) delete process.env[name];

  for (const [name, value] of Object.entries(values)) process.env[name] = value;

  try {
    run();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("Gateway retry headers support seconds, dates, milliseconds, and invalid values", () => {
  const now = Date.UTC(2026, 8, 17);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "2" }), now), 2_000);
  assert.equal(
    retryAfterMs(new Headers({ "retry-after": new Date(now + 5_000).toUTCString() }), now),
    5_000,
  );
  assert.equal(retryAfterMs(new Headers({ "retry-after-ms": "125", "retry-after": "2" })), 125);

  for (const value of ["", "-1", "garbage"]) {
    assert.equal(retryAfterMs(new Headers({ "retry-after": value })), undefined);
  }
});

test("Gateway retries the same request after 2s, 4s, then stays at 8s", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  t.mock.method(console, "error", () => {});
  const calls: number[] = [];

  const send = rateLimitedFetch(async (_input, init) => {
    assert.equal(init?.body, "original request");
    calls.push(Date.now());

    return new Response(null, { status: calls.length < 8 ? 429 : 200 });
  });

  const result = send("https://example.test", { body: "original request" });
  await setImmediate();
  t.mock.timers.tick(1_999);
  await setImmediate();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(calls.length, 2);
  t.mock.timers.tick(4_000);
  await setImmediate();

  for (let index = 0; index < 5; index++) {
    t.mock.timers.tick(7_999);
    await setImmediate();
    assert.equal(calls.length, 3 + index);
    t.mock.timers.tick(1);
    await setImmediate();
  }

  assert.equal((await result).status, 200);
  assert.deepEqual(calls, [1_000, 3_000, 7_000, 15_000, 23_000, 31_000, 39_000, 47_000]);
});

test("Gateway cooldown pauses other callers and staggers their recovery", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  t.mock.method(console, "error", () => {});
  const calls: number[] = [];

  const send = rateLimitedFetch(async () => {
    calls.push(Date.now());

    return new Response(null, {
      status: calls.length === 1 ? 429 : 200,
      headers: { "retry-after": "3" },
    });
  });

  const first = send("https://example.test");
  await setImmediate();
  const second = send("https://example.test");
  t.mock.timers.tick(2_999);
  await setImmediate();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(calls.length, 2);
  t.mock.timers.tick(250);
  await Promise.all([first, second]);
  assert.deepEqual(calls, [1_000, 4_000, 4_250]);
});

test("Gateway evaluation survives more than eight rate limits and model outages", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  t.mock.method(console, "error", () => {});
  let calls = 0;

  const gateway = createGateway({
    apiKey: "test",
    fetch: rateLimitedFetch(async () => {
      calls++;

      if (calls <= 10) return new Response(null, { status: 429, headers: { "retry-after": "0" } });

      if (calls <= 13) return new Response(null, { status: 503, headers: { "retry-after": "0" } });

      return Response.json({ answers: { flag: { type: "boolean", probability: 1 } } });
    }),
  });

  const result = evaluate({
    model: gateway.evaluationModel("typesafe-ai/jev"),
    state: "test",
    questions: { flag: noul("Is this a test?") },
  });

  for (let index = 0; index < 16; index++) {
    await setImmediate();
    t.mock.timers.tick(250);
  }

  assert.equal((await result).answers.flag.probability, 1);
  assert.equal(calls, 14);
});

test("Gateway passes other HTTP errors through and allows cooldown cancellation", async (t) => {
  t.mock.method(console, "error", () => {});

  for (const status of [400, 401, 402, 403, 500]) {
    let calls = 0;

    const send = rateLimitedFetch(async () => {
      calls++;

      return new Response(null, { status });
    });

    assert.equal((await send("https://example.test")).status, status);
    assert.equal(calls, 1);
  }

  const controller = new AbortController();
  const send = rateLimitedFetch(
    async () => new Response(null, { status: 429, headers: { "retry-after": "60" } }),
  );
  const result = assert.rejects(send("https://example.test", { signal: controller.signal }), {
    name: "AbortError",
  });
  await setImmediate();
  controller.abort();
  await result;
});

test("Gateway honors long server cooldowns without failing or retrying early", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  t.mock.method(console, "error", () => {});
  let calls = 0;

  const send = rateLimitedFetch(async () => {
    calls++;

    return new Response(null, {
      status: calls === 1 ? 503 : 200,
      headers: { "retry-after": "601" },
    });
  });

  const result = send("https://example.test");
  await setImmediate();
  t.mock.timers.tick(600_000);
  await setImmediate();
  assert.equal(calls, 1);
  t.mock.timers.tick(1_000);
  assert.equal((await result).status, 200);
  assert.equal(calls, 2);
});
