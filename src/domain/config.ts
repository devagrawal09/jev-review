// Review policy: thresholds, limits, file patterns, and the vocabulary of
// concerns the reviewer screens for. Pure data; no imports.

// Screening signals at or above this probability are followed up.
export const SCREEN_THRESHOLD = 0.7;
// Severity is scored on a 0–3 rubric; the dashboard mirrors this ceiling.
export const SEVERITY_MAX = 3;
// Findings at or above this severity are routed to a reviewer.
export const ROUTE_SEVERITY = 1.5;
// Findings at or above this severity request changes instead of a comment.
export const BLOCKING_SEVERITY = 2;
// Minimum confidence for an evidence-hunk selection to count.
export const MIN_LOCATION_CONFIDENCE = 0.55;

export const MAX_FOLLOW_UPS = 8;
export const MAX_PROFILES = 5;
export const CONCURRENCY = 3;

export const SOURCE_FILE = /(?:\.(?:[cm]?[jt]sx?|ya?ml|toml)$|(?:^|\/)(?:package\.json|Dockerfile|Makefile|\.github\/workflows\/[^/]+\.ya?ml)$)/;
export const TEST_FILE = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:spec|test)\.[cm]?[jt]sx?$/;

export const dimensions = {
  correctness: "The code likely contains incorrect runtime behavior.",
  security: "The code introduces or weakens a security boundary.",
  reliability: "The code can cause a crash, race, leak, deadlock, or poor failure recovery.",
  compatibility: "The code can break a caller, persisted format, protocol, or public behavior.",
  testGap: "Important behavior lacks adequate targeted test evidence.",
} as const;

export type Dimension = keyof typeof dimensions;

export const dimensionMetadata: Array<{ key: Dimension; label: string; short: string }> = [
  { key: "correctness", label: "Correctness", short: "Corr" },
  { key: "security", label: "Security", short: "Sec" },
  { key: "reliability", label: "Reliability", short: "Rel" },
  { key: "compatibility", label: "Compatibility", short: "Compat" },
  { key: "testGap", label: "Test gap", short: "Tests" },
];

export const mechanisms = {
  correctness: {
    condition: "A condition handles the wrong cases",
    state: "State is read, updated, or retained incorrectly",
    dataFlow: "Data is transformed or passed incorrectly",
    asyncControl: "Asynchronous ordering or error handling is incorrect",
    other: "Another concrete correctness mechanism",
    noIssue: "The selected evidence does not support a concrete correctness issue",
  },
  security: {
    authorization: "Authorization or trust boundaries are weakened",
    injection: "Untrusted input can reach an unsafe interpreter or sink",
    exposure: "Sensitive data can be disclosed",
    unsafeDefault: "A default configuration creates avoidable exposure",
    other: "Another concrete security mechanism",
    noIssue: "The selected evidence does not support a concrete security issue",
  },
  reliability: {
    cleanup: "A resource or side effect is not cleaned up",
    concurrency: "Concurrency can race, deadlock, or lose work",
    recovery: "Failure or cancellation recovery is incomplete",
    crash: "A realistic path can throw or terminate unexpectedly",
    other: "Another concrete reliability mechanism",
    noIssue: "The selected evidence does not support a concrete reliability issue",
  },
  compatibility: {
    api: "A public API or type contract changes incompatibly",
    behavior: "Existing callers observe changed behavior",
    dataFormat: "A persisted or exchanged format changes incompatibly",
    protocol: "An external command or protocol contract changes",
    other: "Another concrete compatibility mechanism",
    noIssue: "The selected evidence does not support a concrete compatibility issue",
  },
  testGap: {
    branch: "An important branch lacks targeted coverage",
    failure: "A failure or cancellation path lacks coverage",
    boundary: "A boundary or edge case lacks coverage",
    integration: "An interaction between components lacks coverage",
    other: "Another concrete test gap",
    noIssue: "The selected evidence does not support a concrete test gap",
  },
} as const satisfies Record<Dimension, Record<string, string>>;

export const reviewPriorityRubric = [
  "Routine review is sufficient",
  "A focused review of the changed behavior is useful",
  "Careful review is needed before merge",
  "Specialist or immediate review is needed",
] as const;

export const severityRubric = [
  "No meaningful impact or no supported issue",
  "Minor or narrowly limited impact",
  "Significant correctness, reliability, compatibility, or security impact",
  "Critical security, data-loss, or widespread outage impact",
] as const;

export const owners = {
  security: "Security, authentication, authorization, or data exposure",
  api: "Public APIs, compatibility, schemas, or protocols",
  runtime: "Execution, concurrency, resources, or failure recovery",
  testing: "Coverage strategy, fixtures, or regression testing",
  maintainer: "The owning domain or feature maintainer",
} as const;
