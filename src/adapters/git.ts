// Git adapter: discovers changed source files under a scope and returns each
// one with a unified diff. Untracked files are rendered as all-additions.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { SOURCE_FILE } from "../domain/config.ts";
import { patchForNewFile } from "../domain/patch.ts";
import type { ChangedFile } from "../domain/types.ts";
import { readRepoFile } from "./repo-file-reader.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

function lines(output: string): string[] {
  return output.split("\n").filter(Boolean);
}

export function changedFiles(scope: string): ChangedFile[] {
  const realScope = realpathSync(scope);
  const repoRoot = realpathSync(git(realScope, ["rev-parse", "--show-toplevel"]).trim());
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

  return paths.flatMap((path) => {
    if (!untrackedSet.has(path)) {
      return [{ path, patch: git(repoRoot, ["diff", "HEAD", "--unified=3", "--", path]) }];
    }
    const content = readRepoFile(repoRoot, path);
    return content === null ? [] : [{ path, patch: patchForNewFile(content) }];
  });
}
