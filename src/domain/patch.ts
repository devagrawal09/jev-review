// Unified-diff helpers shared by the Git adapter and the review workflow.
import type { Hunk } from "./types.ts";

// Splits a unified diff into hunks, tracking the new-file start line of each.
export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: string[] | null = null;
  let startLine = 1;

  const flush = () => {
    if (current) {
      hunks.push({
        id: `hunk_${hunks.length + 1}`,
        startLine,
        patch: current.join("\n"),
      });
    }
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@ ")) {
      flush();
      const match = line.match(/\+(\d+)/);
      startLine = match ? Number(match[1]) : 1;
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }

  flush();
  return hunks;
}
