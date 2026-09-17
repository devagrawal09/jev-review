// Change-review judgments. Every call is narrow and receives patch evidence.
import { ask, choice, noul, score } from "../adapters/judgment.ts";
import {
  BLOCKING_SEVERITY,
  type Dimension,
  dimensions,
  mechanisms,
  MIN_LOCATION_CONFIDENCE,
  owners,
  reviewPriorityRubric,
  ROUTE_SEVERITY,
  severityRubric,
} from "../domain/config.ts";
import { parseHunks } from "../domain/patch.ts";
import type { ChangedFile, FileProfile, Finding, Screening, Signal } from "../domain/types.ts";

const changeTypes = {
  behavior: "Adds or changes runtime behavior",
  interface: "Changes an exported API, type, protocol, or data shape",
  infrastructure: "Changes execution, scheduling, build, or operational plumbing",
  observability: "Changes events, logging, monitoring, or diagnostics",
  refactor: "Restructures implementation without intending behavior changes",
  routine: "A small routine change that fits none of the other categories",
};

export async function screenFile(
  file: ChangedFile,
  changedTests: ChangedFile[],
): Promise<Screening<ChangedFile>> {
  const response = await ask({
    state: { file, changedTests },
    questions: {
      correctness: noul(
        {
          question: "Does file.patch directly support that this change likely introduces incorrect runtime behavior?",
          inspect: "file.patch",
          focus: "Concrete behavior, state, data-flow, or async errors introduced by added or modified lines",
          ignore: ["Style preferences", "Naming concerns", "Unsupported speculation"],
        },
        {
          true: {
            what: "The patch contains a realistic path to a wrong runtime result",
            examples: ["A condition now handles the opposite case", "A value is written to the wrong field"],
          },
          false: {
            what: "The patch is correct, non-behavioral, or lacks direct evidence of a bug",
            examples: ["Formatting only", "A refactor that preserves data flow"],
          },
        },
      ),
      security: noul(
        {
          question: "Does file.patch directly support that this change introduces or weakens a security boundary?",
          inspect: "file.patch",
          focus: "Authorization, injection, secret exposure, trust boundaries, and unsafe defaults",
        },
        {
          true: {
            what: "The patch creates a concrete path around a security control or into an unsafe sink",
            examples: ["An authorization check is removed", "Untrusted input reaches command execution"],
          },
          false: {
            what: "No security boundary is weakened by the patch",
            not_for: "Code that merely uses security-related names",
          },
        },
      ),
      reliability: noul(
        {
          question: "Does file.patch directly support that this change can crash, race, leak, deadlock, or recover poorly?",
          inspect: "file.patch",
          focus: "Realistic resource, concurrency, cancellation, and failure paths",
        },
        {
          true: {
            what: "A changed path can lose work, leak resources, hang, crash, or leave inconsistent state",
            examples: ["Cleanup is skipped after failure", "Concurrent work updates shared state unsafely"],
          },
          false: { what: "The patch preserves safe lifecycle and failure handling" },
        },
      ),
      compatibility: noul(
        {
          question: "Does file.patch directly support that this change can break an existing caller, format, protocol, or public behavior?",
          inspect: "file.patch",
          focus: "Externally observed contracts rather than internal implementation details",
        },
        {
          true: {
            what: "An existing consumer can fail because a contract changed without a safe migration",
            examples: ["A required field is removed", "A persisted value changes meaning"],
          },
          false: { what: "The changed contract remains compatible or is entirely internal" },
        },
      ),
      testGap: noul(
        {
          question: "Does file.patch change important behavior without adequate targeted evidence in changedTests?",
          compare: ["file.patch", "changedTests"],
          focus: "New branches, boundaries, failure paths, and component interactions",
        },
        {
          true: {
            what: "Important changed behavior has no targeted changed test",
            examples: ["A new failure branch has no assertion", "A protocol change lacks a compatibility test"],
          },
          false: {
            what: "Changed tests exercise the important behavior, or the patch is non-behavioral",
            examples: ["A focused regression test covers the branch", "Documentation-only change"],
          },
        },
      ),
    },
  });

  return {
    file,
    probabilities: {
      correctness: response.answers.correctness.probability,
      security: response.answers.security.probability,
      reliability: response.answers.reliability.probability,
      compatibility: response.answers.compatibility.probability,
      testGap: response.answers.testGap.probability,
    },
  };
}

export async function profileFile(
  file: ChangedFile,
  screeningProbabilities: Record<Dimension, number>,
): Promise<FileProfile> {
  const response = await ask({
    state: { file, screeningProbabilities },
    questions: {
      category: choice(
        { question: "Which category best describes file.patch?", focus: "Primary purpose of the change" },
        changeTypes,
      ),
      reviewPriority: score(
        "Rate how closely a human should review file.patch, considering the code and screeningProbabilities.",
        [...reviewPriorityRubric],
      ),
    },
  });

  return {
    file: file.path,
    category: response.answers.category.choice,
    categoryConfidence: response.answers.category.confidence,
    reviewPriority: response.answers.reviewPriority.score,
    reviewPriorityConfidence: response.answers.reviewPriority.confidence,
  };
}

export async function locateSignal(
  signal: Signal<ChangedFile>,
): Promise<Finding<ChangedFile> | null> {
  const hunks = parseHunks(signal.file.patch);
  if (hunks.length === 0) return null;

  const suspectedConcern = {
    dimension: signal.dimension,
    definition: dimensions[signal.dimension],
  };
  const location = await ask({
    state: {
      file: signal.file.path,
      suspectedConcern: { ...suspectedConcern, screeningProbability: signal.probability },
      candidateHunks: hunks,
    },
    questions: {
      evidence: choice(
        {
          question: "Which candidate hunk provides the strongest direct evidence for suspectedConcern?",
          fallback: "Select noMatch when no hunk provides sufficient evidence",
        },
        {
          ...Object.fromEntries(
            hunks.map((hunk) => [hunk.id, "Candidate beginning at changed-file line " + hunk.startLine]),
          ),
          noMatch: "No candidate hunk directly supports the suspected concern",
        },
      ),
    },
  });

  const selected = location.answers.evidence;
  if (selected.choice === "noMatch" || selected.confidence < MIN_LOCATION_CONFIDENCE) return null;
  const hunk = hunks.find((candidate) => candidate.id === selected.choice);
  if (!hunk) return null;

  const classification = await ask({
    state: { file: signal.file.path, suspectedConcern, selectedEvidence: hunk },
    questions: {
      mechanism: choice(
        "Which mechanism best describes the suspected concern supported by selectedEvidence?",
        mechanisms[signal.dimension],
      ),
    },
  });
  const mechanism = classification.answers.mechanism;
  if (mechanism.choice === "noIssue") return null;

  const impact = await ask({
    state: { file: signal.file.path, suspectedConcern, selectedEvidence: hunk },
    questions: {
      severity: score(
        "Assuming selectedEvidence exhibits suspectedConcern, rate the likely production impact.",
        [...severityRubric],
      ),
    },
  });

  const severity = impact.answers.severity;
  let owner: string | null = null;
  let ownerConfidence: number | null = null;
  if (severity.score >= ROUTE_SEVERITY) {
    const routing = await ask({
      state: {
        file: signal.file.path,
        concern: {
          dimension: signal.dimension,
          mechanism: mechanism.choice,
          severity: severity.score,
        },
        selectedEvidence: hunk,
      },
      questions: {
        owner: choice("Which reviewer is best suited to investigate this concern?", owners),
      },
    });
    owner = routing.answers.owner.choice;
    ownerConfidence = routing.answers.owner.confidence;
  }

  return {
    ...signal,
    line: hunk.startLine,
    locationConfidence: selected.confidence,
    mechanism: mechanism.choice,
    mechanismConfidence: mechanism.confidence,
    severity: severity.score,
    severityConfidence: severity.confidence,
    owner,
    ownerConfidence,
    action: severity.score >= BLOCKING_SEVERITY ? "request_changes" : "comment",
  };
}
