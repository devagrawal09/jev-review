// Git-backed source discovery for complete codebase scans. Tracked and
// untracked, non-ignored JavaScript and TypeScript files are included.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { SOURCE_FILE } from "../domain/config.ts";
import type { SourceFile } from "../domain/types.ts";
import { readRepoFile } from "./repo-file-reader.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

export function repositoryFiles(scope: string): SourceFile[] {
  const realScope = realpathSync(scope);
  const repoRoot = realpathSync(git(realScope, ["rev-parse", "--show-toplevel"]).trim());
  const relativeScope = relative(repoRoot, realScope) || ".";
  const paths = git(repoRoot, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    relativeScope,
  ])
    .split("\n")
    .filter((path) => path.length > 0 && SOURCE_FILE.test(path));

  return paths.flatMap((path) => {
    const content = readRepoFile(repoRoot, path);
    return content === null ? [] : [{ path, content }];
  });
}
