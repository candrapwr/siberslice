import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { config, s3Configured } from "../config/env.js";
import { readSession, sessionIdPattern, writeSession } from "../server/session-store.js";
import { runKeyPrefix, uploadRun } from "../server/s3-store.js";

const purgeLocal = process.argv.includes("--purge-local");

async function listFiles(dir, prefix = "") {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile()) out.push(prefix ? `${prefix}/${entry.name}` : entry.name);
    else if (entry.isDirectory()) out.push(...await listFiles(join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name));
  }
  return out;
}

async function runDeliverables(runFolder) {
  const files = [];
  for (const name of ["sheet.png", "sheet-transparent.png", "assets.zip"]) {
    try {
      const info = await stat(join(runFolder, name));
      if (info.isFile()) files.push(name);
    } catch { /* missing optional file */ }
  }
  for (const name of await listFiles(join(runFolder, "assets"))) {
    files.push(`assets/${name}`);
  }
  return files;
}

async function main() {
  if (!s3Configured()) {
    console.error("S3 belum dikonfigurasi. Isi SIBERSLICE_S3_BUCKET, SIBERSLICE_S3_ACCESS_KEY, SIBERSLICE_S3_SECRET_KEY (dan ENDPOINT/REGION bila perlu) di .env.");
    process.exit(1);
  }
  const sessionsDir = join(config.dataDir, "sessions");
  const sessionIds = (await readdir(sessionsDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && sessionIdPattern.test(entry.name))
    .map((entry) => entry.name);
  console.log(`Migrasi S3 → bucket ${config.s3.bucket}, prefix ${config.s3.prefix}/ (${sessionIds.length} session)`);

  let migratedRuns = 0;
  let uploadedFiles = 0;
  let skippedSessions = 0;
  for (const sessionId of sessionIds) {
    const session = await readSession(sessionId);
    if (!session) { console.warn(`  ${sessionId}: session.json hilang/rusak, dilewati`); skippedSessions += 1; continue; }
    const runs = Array.isArray(session.value.runs) ? session.value.runs : [];
    let changed = false;
    for (const run of runs) {
      if (!run || run.status !== "complete" || !sessionIdPattern.test(run.runId ?? "") || run.s3) continue;
      const runFolder = join(session.folder, "runs", run.runId);
      const files = await runDeliverables(runFolder);
      if (files.length === 0) { console.warn(`  ${sessionId}/${run.runId}: tidak ada file lokal untuk dimigrasi, dilewati`); continue; }
      const manifest = await uploadRun({ sessionId, runId: run.runId, runDir: runFolder, files });
      manifest.prefix = runKeyPrefix(sessionId, run.runId);
      run.s3 = manifest;
      uploadedFiles += files.length;
      migratedRuns += 1;
      changed = true;
      console.log(`  ${sessionId.slice(0, 8)}/${run.runId.slice(0, 8)}: ${files.length} file diunggah`);
      if (purgeLocal) {
        const { rm } = await import("node:fs/promises");
        for (const name of ["sheet.png", "sheet-transparent.png", "assets.zip"]) await rm(join(runFolder, name), { force: true });
        await rm(join(runFolder, "assets"), { recursive: true, force: true });
      }
    }
    if (changed) {
      await writeSession(session.folder, session.value);
    }
  }
  console.log(`Selesai: ${migratedRuns} run dimigrasi (${uploadedFiles} file), ${skippedSessions} session dilewati.`);
}

await main();
