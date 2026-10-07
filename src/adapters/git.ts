// Git adapter: discovers changed source files under a scope and returns each
// one with a unified diff. Untracked files are rendered as all-additions.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { SOURCE_FILE } from "../domain/config.ts";
import { patchForNewFile } from "../domain/patch.ts";
import type { ChangedFile } from "../domain/types.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

function lines(output: string): string[] {
  return output.split("\n").filter(Boolean);
}

// Neutralize policy-styled comment blocks so attacker-controlled prose cannot
// masquerade as review policy inside the model state.
export function sanitizePatch(patch: string): string {
  return patch.replace(
    /((?:\/\/|#|\/\*+|\*)\s*(?:#{1,6}\s*)?(?:review|merge|approval|security)\s+policy\b)[^\n]*/gi,
    "$1 [content neutralized by input hardening]",
  );
}

export function changedFiles(scope: string): ChangedFile[] {
  const realScope = realpathSync(scope);
  const repoRoot = git(realScope, ["rev-parse", "--show-toplevel"]).trim();
  const relativeScope = relative(repoRoot, realScope) || ".";

  const tracked = lines(
    git(repoRoot, [
      "diff",
      "HEAD",
      "--name-only",
      "--diff-filter=ACMRTUXB",
      "--",
      relativeScope,
    ]),
  );
  const untracked = lines(
    git(repoRoot, ["ls-files", "--others", "--exclude-standard", "--", relativeScope]),
  );

  const untrackedSet = new Set(untracked);
  const paths = [...new Set([...tracked, ...untracked])].filter((path) =>
    SOURCE_FILE.test(path),
  );

  return paths.map((path) => ({
    path,
    patch: untrackedSet.has(path)
      ? sanitizePatch(patchForNewFile(readFileSync(resolve(repoRoot, path), "utf8")))
      : sanitizePatch(git(repoRoot, ["diff", "HEAD", "--unified=3", "--", path])),
  }));
}
