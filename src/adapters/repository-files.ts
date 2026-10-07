// Git-backed source discovery for complete codebase scans. Tracked and
// untracked, non-ignored source and manifest files are included.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { SOURCE_FILE } from "../domain/config.ts";
import type { SourceFile } from "../domain/types.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

export function repositoryFiles(scope: string): SourceFile[] {
  const realScope = realpathSync(scope);
  const repoRoot = git(realScope, ["rev-parse", "--show-toplevel"]).trim();
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
    .filter((path) =>
      path.length > 0 && SOURCE_FILE.test(path) && existsSync(resolve(repoRoot, path)),
    );

  return paths.map((path) => ({
    path,
    content: readFileSync(resolve(repoRoot, path), "utf8"),
  }));
}
