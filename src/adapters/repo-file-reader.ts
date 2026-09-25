// Symlink/TOCTOU-safe reads of git-reported repository paths. Shared by the
// change scan (git.ts) and the full codebase scan (repository-files.ts) so
// the containment, special-file, and mid-read identity checks cannot diverge
// between the two.
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

// Reads a git-reported path only when it is a regular file inside repoRoot.
// Symlinks (O_NOFOLLOW), non-regular files, and escapes resolve to null;
// unexpected I/O failures throw so scans never silently lose input.
export function readRepoFile(repoRoot: string, path: string): string | null {
  const absolute = resolve(repoRoot, path);
  if (!absolute.startsWith(repoRoot + sep)) return null;
  let fd: number;
  try {
    // O_NONBLOCK: a listed path swapped for a FIFO must not block open.
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isBenignOpenError(error)) return null;
    throw error;
  }
  let file: { dev: number; ino: number; size: number } | null = null;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const real = realpathSync(absolute);
    if (real !== absolute && !real.startsWith(repoRoot + sep)) return null;
    file = { dev: stat.dev, ino: stat.ino, size: stat.size };
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
    if (file) assertSameFile(absolute, file);
  }
}

// Ancestor swaps between open and read are a live-mutation race, not review
// input; fail loudly rather than misattribute content to the reported path.
function assertSameFile(absolute: string, file: { dev: number; ino: number; size: number }): void {
  let current: { dev: number; ino: number; size: number } | null = null;
  try {
    const stat = statSync(absolute);
    if (stat.isFile()) current = { dev: stat.dev, ino: stat.ino, size: stat.size };
  } catch (error) {
    if (!isBenignOpenError(error)) throw error;
  }
  if (!current || current.dev !== file.dev || current.ino !== file.ino || current.size !== file.size) {
    throw new Error(`File changed during read: ${absolute}`);
  }
}

// Symlink encountered (ELOOP), vanished path (ENOENT), or a special file that
// is not openable: expected races against a live worktree, safe to skip.
function isBenignOpenError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ELOOP" || code === "ENOENT" || code === "ENXIO" || code === "ENODEV";
}
