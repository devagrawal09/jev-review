// Codebase-scan judgments. These ask whether an issue exists in complete
// source, rather than whether a patch introduced one.
import { ask, choice, noul, score } from "../adapters/judgment.ts";
import { basename, dirname } from "node:path";
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
import type { FileProfile, Finding, Screening, Signal, SourceFile } from "../domain/types.ts";

const REGION_LINES = 80;
const SCREEN_REGION_LINES = 160;
const MAX_RELATED_TESTS = 4;
const MAX_TEST_SNIPPET_CHARS = 1_800;

const fileRoles = {
  entrypoint: "Application, command, route, or public package entry point",
  boundary: "Authentication, validation, serialization, or external-system boundary",
  domain: "Core business rules, state transitions, or domain behavior",
  persistence: "Database, cache, filesystem, migration, or durable state",
  infrastructure: "Runtime, scheduling, networking, build, or operational plumbing",
  utility: "Shared helper, adapter, formatting, or low-level utility",
};

export async function screenSourceFile(
  file: SourceFile,
  testFiles: SourceFile[],
): Promise<Screening<SourceFile>> {
  const relatedTests = selectRelatedTests(file, testFiles);
  const results: Array<Record<Dimension, number>> = [];

  for (const region of sourceRegions(file.content, SCREEN_REGION_LINES)) {
    const response = await ask({
      state: {
        file: { path: file.path, startLine: region.startLine, content: region.content },
        relatedTests,
      },
      questions: {
        correctness: noul(
          {
            question: "Does file.content directly support that this code contains incorrect runtime behavior?",
            inspect: "file.content",
            focus: "Concrete behavior, state, data-flow, or async errors reachable in realistic use",
            ignore: ["Style preferences", "Naming concerns", "Missing context with no concrete failure path"],
          },
          {
            true: {
              what: "The source contains a realistic path to a wrong runtime result",
              examples: ["A condition handles the opposite case", "State is updated under the wrong key"],
            },
            false: {
              what: "The implementation is coherent or no concrete incorrect path is supported",
              not_for: "Unusual code that is still internally consistent",
            },
          },
        ),
        security: noul(
          {
            question: "Does file.content directly support that this code weakens a security boundary?",
            inspect: "file.content",
            focus: "Authorization, injection, secret exposure, trust boundaries, and unsafe defaults",
          },
          {
            true: {
              what: "The source contains a concrete path around a control or into an unsafe sink",
              examples: ["A privileged action lacks authorization", "Untrusted input reaches command execution"],
            },
            false: {
              what: "No concrete security weakness is supported by this file",
              not_for: "Code that merely handles credentials or permissions safely",
            },
          },
        ),
        reliability: noul(
          {
            question: "Does file.content directly support that this code can crash, race, leak, deadlock, or recover poorly?",
            inspect: "file.content",
            focus: "Realistic resource, concurrency, cancellation, and failure paths",
          },
          {
            true: {
              what: "A reachable path can lose work, leak resources, hang, crash, or leave inconsistent state",
              examples: ["Cleanup is skipped after failure", "Concurrent work mutates shared state unsafely"],
            },
            false: { what: "Lifecycle and failure handling appear safe, or no concrete failure path is supported" },
          },
        ),
        compatibility: noul(
          {
            question: "Does file.content directly support an internal inconsistency that can break a caller, format, protocol, or documented behavior?",
            inspect: "file.content",
            focus: "Contradictions visible in this source, not guesses about unknown historical versions",
          },
          {
            true: {
              what: "The source contains conflicting contracts or a concrete caller-facing mismatch",
              examples: ["A parser and serializer disagree on a required field", "An exported type contradicts runtime behavior"],
            },
            false: {
              what: "The visible contracts are internally consistent",
              not_for: "Speculation that an API may once have behaved differently",
            },
          },
        ),
        testGap: noul(
          {
            question: "Does file.content contain important behavior without adequate targeted evidence in relatedTests?",
            compare: ["file.content", "relatedTests"],
            focus: "Critical branches, boundaries, failure paths, and component interactions",
            caution: "A filename mismatch alone is not enough; identify behavior that specifically needs a test",
          },
          {
            true: {
              what: "Important behavior is present and the related tests do not exercise it",
              examples: ["An error-recovery branch has no assertion", "Authorization behavior lacks a denial test"],
            },
            false: {
              what: "Related tests cover the important behavior, or this file has no behavior needing direct tests",
              examples: ["A focused test covers the boundary", "A declarative constants module"],
            },
          },
        ),
      },
    });

    results.push({
      correctness: response.answers.correctness.probability,
      security: response.answers.security.probability,
      reliability: response.answers.reliability.probability,
      compatibility: response.answers.compatibility.probability,
      testGap: response.answers.testGap.probability,
    });
  }

  return {
    file,
    probabilities: {
      correctness: Math.max(...results.map((result) => result.correctness)),
      security: Math.max(...results.map((result) => result.security)),
      reliability: Math.max(...results.map((result) => result.reliability)),
      compatibility: Math.max(...results.map((result) => result.compatibility)),
      testGap: Math.max(...results.map((result) => result.testGap)),
    },
  };
}

export async function profileSourceFile(
  file: SourceFile,
  screeningProbabilities: Record<Dimension, number>,
): Promise<FileProfile> {
  const response = await ask({
    state: { file, screeningProbabilities },
    questions: {
      category: choice(
        { question: "Which role best describes this source file?", focus: "Primary runtime responsibility" },
        fileRoles,
      ),
      reviewPriority: score(
        "Rate how closely a human should review this complete file, considering its role and screeningProbabilities.",
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

export async function locateSourceSignal(
  signal: Signal<SourceFile>,
): Promise<Finding<SourceFile> | null> {
  const regions = sourceRegions(signal.file.content);
  if (regions.length === 0) return null;

  const suspectedConcern = {
    dimension: signal.dimension,
    definition: dimensions[signal.dimension],
  };
  const location = await ask({
    state: {
      file: signal.file.path,
      suspectedConcern: { ...suspectedConcern, screeningProbability: signal.probability },
      candidateRegions: regions,
    },
    questions: {
      evidence: choice(
        {
          question: "Which candidate region provides the strongest direct evidence for suspectedConcern?",
          fallback: "Select noMatch when no region provides sufficient evidence",
        },
        {
          ...Object.fromEntries(
            regions.map((region) => [region.id, "Source beginning at line " + region.startLine]),
          ),
          noMatch: "No source region directly supports the suspected concern",
        },
      ),
    },
  });

  const selected = location.answers.evidence;
  if (selected.choice === "noMatch" || selected.confidence < MIN_LOCATION_CONFIDENCE) return null;
  const region = regions.find((candidate) => candidate.id === selected.choice);
  if (!region) return null;

  const classification = await ask({
    state: { file: signal.file.path, suspectedConcern, selectedEvidence: region },
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
    state: { file: signal.file.path, suspectedConcern, selectedEvidence: region },
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
        selectedEvidence: region,
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
    line: region.startLine,
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

function sourceRegions(content: string, linesPerRegion = REGION_LINES) {
  const lines = content.split("\n");
  const count = Math.ceil(lines.length / linesPerRegion);
  return Array.from({ length: count }, (_, index) => ({
    id: "R" + (index + 1),
    startLine: index * linesPerRegion + 1,
    content: lines.slice(index * linesPerRegion, (index + 1) * linesPerRegion).join("\n"),
  }));
}

function selectRelatedTests(file: SourceFile, testFiles: SourceFile[]): SourceFile[] {
  const stem = basename(file.path).replace(/\.[^.]+$/, "");
  const directory = dirname(file.path);
  return testFiles
    .map((test) => ({
      test,
      score: (test.path.includes(stem) ? 2 : 0) + (test.path.startsWith(directory) ? 1 : 0),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.test.path.localeCompare(b.test.path))
    .slice(0, MAX_RELATED_TESTS)
    .map(({ test }) => compactTest(test, stem));
}

function compactTest(test: SourceFile, sourceStem: string): SourceFile {
  const lines = test.content.split("\n");
  const selected = new Set<number>();
  const stem = sourceStem.toLowerCase();

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].toLowerCase();
    if (
      line.includes(stem) ||
      line.includes("describe(") ||
      line.includes("describe.") ||
      line.includes("test(") ||
      line.includes("test.") ||
      line.includes("it(") ||
      line.includes("it.")
    ) {
      for (let nearby = Math.max(0, index - 2); nearby <= Math.min(lines.length - 1, index + 2); nearby++) {
        selected.add(nearby);
      }
    }
  }

  let content = [...selected]
    .sort((a, b) => a - b)
    .map((index) => lines[index])
    .join("\n");
  if (content.length === 0) content = test.content;
  if (content.length > MAX_TEST_SNIPPET_CHARS) {
    const side = Math.floor((MAX_TEST_SNIPPET_CHARS - 7) / 2);
    content = content.slice(0, side) + "\n...\n" + content.slice(-side);
  }

  return { path: test.path, content };
}
