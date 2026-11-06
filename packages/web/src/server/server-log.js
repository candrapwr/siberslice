import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config/env.js";

const logsDir = join(config.dataDir, "logs");
const errorsFile = join(logsDir, "server-errors.jsonl");

export async function recordServerError(record) {
  const entry = { timestamp: new Date().toISOString(), ...record };
  try {
    await mkdir(logsDir, { recursive: true });
    await appendFile(errorsFile, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    console.error("SiberSlice gagal menyimpan log server:", error);
  }
}
