// Git adapter: discovers the source files the current branch commits relative to
// main and returns each one with a unified diff. The comparison runs from the
// merge base with main to HEAD, so only committed branch work is reported;
// unstaged, staged-but-uncommitted, and untracked files are excluded.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { SOURCE_FILE } from "../domain/config.ts";
import type { ChangedFile } from "../domain/types.ts";

const BASE_REFS = ["main", "origin/main"];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

function lines(output: string): string[] {
  return output.split("\n").filter(Boolean);
}

function resolves(repoRoot: string, ref: string): boolean {
  try {
    git(repoRoot, ["rev-parse", "--verify", "--quiet", ref + "^{commit}"]);
    return true;
  } catch {
    return false;
  }
}

// The point main and the current branch last shared, which is what `git diff
// main...HEAD` uses as its left side.
function branchBase(repoRoot: string): string {
  const base = BASE_REFS.find((ref) => resolves(repoRoot, ref));
  if (!base) {
    throw new Error("No base branch found; expected one of " + BASE_REFS.join(", "));
  }
  return git(repoRoot, ["merge-base", base, "HEAD"]).trim();
}

export function changedFiles(scope: string): ChangedFile[] {
  const realScope = realpathSync(scope);
  const repoRoot = git(realScope, ["rev-parse", "--show-toplevel"]).trim();
  const relativeScope = relative(repoRoot, realScope) || ".";
  const base = branchBase(repoRoot);

  const paths = lines(
    git(repoRoot, [
      "diff",
      base,
      "HEAD",
      "--name-only",
      "--diff-filter=ACMRTUXB",
      "--",
      relativeScope,
    ]),
  ).filter((path) => SOURCE_FILE.test(path));

  return paths.map((path) => ({
    path,
    patch: git(repoRoot, ["diff", base, "HEAD", "--unified=3", "--", path]),
  }));
}
