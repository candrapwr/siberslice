// Kembalikan hasil dari S3 ke disk lokal (kebalikan dari migrate-s3.js).
// Gunakan: npm run restore:local [-- --session <id>] [--purge-remote]
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { config, s3Configured } from "../config/env.js";
import { readSession, sessionIdPattern, writeSession } from "../server/session-store.js";
import { restoreSessionToLocal } from "../server/restore-local.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { purgeRemote: args.includes("--purge-remote"), sessionId: null };
  const index = args.indexOf("--session");
  if (index >= 0 && args[index + 1]) options.sessionId = args[index + 1];
  return options;
}

async function main() {
  if (!s3Configured()) {
    console.error("S3 belum dikonfigurasi. Isi SIBERSLICE_S3_BUCKET, SIBERSLICE_S3_ACCESS_KEY, SIBERSLICE_S3_SECRET_KEY (dan ENDPOINT/REGION bila perlu) di .env.");
    process.exit(1);
  }
  const { purgeRemote, sessionId } = parseArgs();
  const sessionsDir = join(config.dataDir, "sessions");
  const sessionIds = sessionId
    ? [sessionId]
    : (await readdir(sessionsDir, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory() && sessionIdPattern.test(entry.name))
        .map((entry) => entry.name);
  console.log(`Restore S3 → lokal (${sessionIds.length} session, purgeRemote=${purgeRemote})`);

  let restoredRuns = 0;
  let files = 0;
  let failed = 0;
  for (const id of sessionIds) {
    if (!sessionIdPattern.test(id)) { console.warn(`  ${id}: ID tidak valid, dilewati`); failed += 1; continue; }
    const session = await readSession(id);
    if (!session) { console.warn(`  ${id}: session.json hilang/rusak, dilewati`); failed += 1; continue; }
    const runs = Array.isArray(session.value.runs) ? session.value.runs : [];
    if (!runs.some((run) => run?.s3)) continue; // sudah lokal
    try {
      const result = await restoreSessionToLocal(session.value, session.folder, { purgeRemote });
      await writeSession(session.folder, session.value);
      restoredRuns += result.runs;
      files += result.files;
      console.log(`  ${id.slice(0, 8)}: ${result.runs} run dipulihkan (${result.files} file)${purgeRemote ? `, ${result.keys.length} objek S3 dihapus` : ""}`);
    } catch (error) {
      failed += 1;
      console.error(`  ${id.slice(0, 8)}: GAGAL — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`Selesai: ${restoredRuns} run dipulihkan (${files} file), ${failed} gagal/dilewati.`);
  if (failed) process.exit(1);
}

await main();
