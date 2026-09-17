// Shared staged orchestration. Each review mode owns discovery and judgments;
// this module owns concurrency, thresholds, ranking, and report assembly.
import { judgmentBackend } from "../adapters/judgment.ts";
import {
  CONCURRENCY,
  type Dimension,
  dimensionMetadata,
  dimensions,
  MAX_FOLLOW_UPS,
  MAX_PROFILES,
  SCREEN_THRESHOLD,
  SEVERITY_MAX,
} from "../domain/config.ts";
import type {
  FileProfile,
  Finding,
  ReviewMode,
  ReviewReport,
  Screening,
  Signal,
} from "../domain/types.ts";

export type Log = (message: string) => void;

type Strategy<File extends { path: string }, Context extends { path: string }> = {
  mode: ReviewMode;
  subject: string;
  context: string;
  discover: (scope: string) => { files: File[]; contextFiles: Context[] };
  screen: (file: File, contextFiles: Context[]) => Promise<Screening<File>>;
  profile: (
    file: File,
    probabilities: Record<Dimension, number>,
  ) => Promise<FileProfile>;
  locate: (signal: Signal<File>) => Promise<Finding<File> | null>;
};

export async function runReview<File extends { path: string }, Context extends { path: string }>(
  scope: string,
  log: Log,
  strategy: Strategy<File, Context>,
): Promise<ReviewReport> {
  const judgment = judgmentBackend();
  log("judgment backend: " + judgment);
  const { files, contextFiles } = strategy.discover(scope);
  if (files.length === 0) {
    throw new Error(
      "No " + strategy.subject + " JavaScript or TypeScript files found under " + scope,
    );
  }

  log("Screening " + files.length + " " + strategy.subject + " files with " + contextFiles.length + " " + strategy.context + " files as context...");
  const matrix = await mapLimit(files, CONCURRENCY, async (file) => {
    log("  screen " + file.path);
    try {
      return await strategy.screen(file, contextFiles);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error("Screening " + file.path + " failed: " + message, { cause: error });
    }
  });

  const signals = matrix
    .flatMap(({ file, probabilities }) =>
      (Object.entries(probabilities) as [Dimension, number][]).map(
        ([dimension, probability]): Signal<File> => ({ file, dimension, probability }),
      ),
    )
    .filter((signal) => signal.probability >= SCREEN_THRESHOLD)
    .sort((a, b) => b.probability - a.probability);

  const profileCandidates = [...matrix]
    .sort((a, b) => maxProbability(b) - maxProbability(a))
    .slice(0, MAX_PROFILES);
  log("Profiling " + profileCandidates.length + " files...");
  const profiles = await mapLimit(profileCandidates, CONCURRENCY, ({ file, probabilities }) => {
    log("  profile " + file.path);
    return strategy.profile(file, probabilities);
  });

  const followUps = signals.slice(0, MAX_FOLLOW_UPS);
  log("Following " + followUps.length + " of " + signals.length + " signals at or above " + SCREEN_THRESHOLD + "...");
  const located = await mapLimit(followUps, CONCURRENCY, (signal) => {
    log("  inspect " + signal.file.path + " [" + signal.dimension + "=" + signal.probability.toFixed(2) + "]");
    return strategy.locate(signal);
  });

  const findings = located
    .filter((finding): finding is Finding<File> => finding !== null)
    .sort((a, b) => b.severity - a.severity);

  return {
    mode: strategy.mode,
    scope,
    dimensions: dimensionMetadata,
    config: {
      screenThreshold: SCREEN_THRESHOLD,
      severityMax: SEVERITY_MAX,
      maxFollowUps: MAX_FOLLOW_UPS,
      maxProfiles: MAX_PROFILES,
      judgment,
    },
    screenedFiles: files.length,
    contextFiles: contextFiles.map((file) => file.path),
    matrix: matrix.map(({ file, probabilities }) => ({ file: file.path, ...probabilities })),
    followedSignals: followUps.length,
    profiles,
    workflow: {
      screenedCells: files.length * Object.keys(dimensions).length,
      thresholdSignals: signals.length,
      profiledFiles: profiles.length,
      followedSignals: followUps.length,
      locatedFindings: findings.length,
      routedFindings: findings.filter((finding) => finding.owner !== null).length,
    },
    findings: findings.map(({ file, ...finding }) => ({ file: file.path, ...finding })),
  };
}

function maxProbability<File extends { path: string }>(screening: Screening<File>): number {
  return Math.max(...Object.values(screening.probabilities));
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  callback: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await callback(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
