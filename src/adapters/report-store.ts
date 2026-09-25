// Filesystem adapter for the saved review report that the dashboard reads.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isReviewReport, type ReviewReport } from "../domain/types.ts";

// Defaults to <repo>/reviews/latest.json. Override with REVIEW_FILE=path.
export function reportPath(): string {
  return process.env.REVIEW_FILE
    ? resolve(process.env.REVIEW_FILE)
    : resolve(import.meta.dirname, "..", "..", "reviews", "latest.json");
}

export type StoredReport =
  | { status: "ok"; savedAt: string; report: ReviewReport }
  | { status: "empty" }
  | { status: "error"; message: string };

export async function readReport(path = reportPath()): Promise<StoredReport> {
  let text: string;
  let savedAt: string;
  try {
    [text, savedAt] = await Promise.all([
      readFile(path, "utf8"),
      stat(path).then((info) => info.mtime.toISOString()),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "empty" };
    return { status: "error", message: "Report could not be read" };
  }

  try {
    const report: unknown = JSON.parse(text);
    if (isReviewReport(report)) return { status: "ok", savedAt, report };
  } catch {}
  return { status: "error", message: "Report is not review output" };
}

// Writes to a unique temp file created with O_EXCL and renames, so readers
// never see a partial report and a planted symlink is never followed.
export async function saveReport(report: ReviewReport, path = reportPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const data = `${JSON.stringify(report, null, 2)}\n`;
  for (let attempt = 0; attempt < 10; attempt++) {
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, data, { flag: "wx" });
    } catch (error) {
      // EEXIST: another process owns the name; retry. Any other failure may
      // have created our temp file, so remove it before surfacing the error.
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      await unlink(temp).catch(() => {});
      throw error;
    }
    try {
      await rename(temp, path);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
    return;
  }
  throw new Error("Could not save report: temp file collisions");
}
