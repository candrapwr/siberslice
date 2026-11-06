// Restore run deliverables from S3 back to local disk (mirror of migrate-s3).
// Shared by the admin endpoint and the migrate-s3-local CLI.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deleteRunObjects, getObjectBuffer } from "./s3-store.js";

/**
 * Download every manifest entry of one run into `runFolder` and strip its `s3` key.
 * Returns the number of files written. Does not mutate `run` beyond removing `s3`.
 * @param run session run entry (must carry run.s3 manifest with {key} entries + prefix)
 */
export async function restoreRunToLocal(run, runFolder) {
  const manifest = run?.s3;
  if (!manifest) return { files: 0, keys: [] };
  const jobs = [];
  for (const [relative, value] of Object.entries(manifest)) {
    if (!value || typeof value.key !== "string") continue;
    // Skip anything unsafe as a path; manifest keys come from our own uploads.
    const segments = relative.split("/").filter((s) => s && s !== "." && s !== "..");
    if (!segments.length) continue;
    const absolute = join(runFolder, ...segments);
    if (!absolute.startsWith(`${runFolder}${process.platform === "win32" ? "\\" : "/"}`)) continue;
    jobs.push({ key: value.key, absolute });
  }
  const downloadOne = async ({ key, absolute }) => {
    const body = await getObjectBuffer(key);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, body);
  };
  // Small pool, same idea as uploads.
  const pool = 8;
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const current = jobs[cursor++];
      await downloadOne(current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(pool, jobs.length) }, worker));
  const keys = jobs.map(({ key }) => key);
  delete run.s3;
  return { files: jobs.length, keys };
}

/**
 * Restore every S3-backed run of a session. Returns { runs, files, keys }.
 */
export async function restoreSessionToLocal(sessionValue, sessionFolder, { purgeRemote = false } = {}) {
  const runs = Array.isArray(sessionValue.runs) ? sessionValue.runs : [];
  let restoredRuns = 0;
  let files = 0;
  const keys = [];
  for (const run of runs) {
    if (!run?.s3 || typeof run.runId !== "string") continue;
    const result = await restoreRunToLocal(run, join(sessionFolder, "runs", run.runId), { purgeRemote });
    restoredRuns += 1;
    files += result.files;
    keys.push(...result.keys);
  }
  if (purgeRemote && keys.length) await deleteRunObjects(keys);
  return { runs: restoredRuns, files, keys };
}
