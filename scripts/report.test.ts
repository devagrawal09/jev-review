import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { isReviewReport, type ReviewReport } from "../src/domain/types.ts";

const report: ReviewReport = {
  mode: "changes",
  scope: "/repo/example",
  dimensions: [],
  config: { screenThreshold: 0.7, severityMax: 3, maxFollowUps: 8, maxProfiles: 5 },
  screenedFiles: 0,
  contextFiles: [],
  matrix: [],
  followedSignals: 0,
  profiles: [],
  workflow: {
    screenedCells: 0,
    thresholdSignals: 0,
    profiledFiles: 0,
    followedSignals: 0,
    locatedFindings: 0,
    routedFindings: 0,
  },
  findings: [],
};

test("saved reports can omit the judgment backend", () => {
  assert.equal(isReviewReport(JSON.parse(JSON.stringify(report))), true);
  assert.equal(report.config.judgment, undefined);
});

test("dashboard metadata handles both backends, older reports, and cleared state", () => {
  // Only the DOM operations used by metadata are needed; no browser layout is simulated.
  class Element {
    children: Array<Element | string> = [];
    attributes: Record<string, string> = {};
    className = "";
    append(...children: Array<Element | string>) {
      this.children.push(...children);
    }
    replaceChildren() {
      this.children = [];
    }
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    }
    get textContent(): string {
      return this.children
        .map((child) => (child instanceof Element ? child.textContent : child))
        .join("");
    }
  }

  const meta = new Element();

  const context = createContext({
    Node: Element,
    document: {
      getElementById: () => meta,
      createElement: () => new Element(),
      addEventListener() {},
    },
    window: { addEventListener() {} },
    fetch: () => new Promise(() => {}),
  });

  runInContext(
    readFileSync(new URL("../src/dashboard/public/app.js", import.meta.url), "utf8"),
    context,
  );

  for (const judgment of ["typesafe", "ai-gateway", undefined]) {
    context.state = {
      status: "ok",
      savedAt: new Date().toISOString(),
      report: {
        ...report,
        config: { ...report.config, judgment },
      },
    };
    runInContext("renderMeta(state)", context);
    const expected = ["Change review", "example"];

    if (judgment) expected.push(judgment);
    expected.push("just now");
    const items = meta.children.filter((child): child is Element => child instanceof Element);
    assert.deepEqual(
      items.filter((child) => child.className !== "sep").map((child) => child.textContent),
      expected,
    );
    assert.equal(items.filter((child) => child.className === "sep").length, expected.length - 1);
  }

  context.state = { status: "empty" };
  runInContext("renderMeta(state)", context);
  assert.equal(meta.children.length, 0);
});
