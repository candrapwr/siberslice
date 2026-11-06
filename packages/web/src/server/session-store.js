import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config/env.js";

const sessionsDir = join(config.dataDir, "sessions");
export const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const busySessions = new Set();
const deletingSessions = new Set();

export function isSessionBusy(id) {
  return busySessions.has(id) || deletingSessions.has(id);
}

export function claimSession(id) {
  if (isSessionBusy(id)) return false;
  busySessions.add(id);
  return true;
}

export function releaseSession(id) {
  busySessions.delete(id);
}

export function beginSessionDeletion(id) {
  if (isSessionBusy(id)) return false;
  deletingSessions.add(id);
  return true;
}

export function endSessionDeletion(id) {
  deletingSessions.delete(id);
}

export function sessionPath(id) {
  if (!sessionIdPattern.test(id)) throw new Error("Session ID tidak valid.");
  return join(sessionsDir, id);
}

export async function readSession(id) {
  const folder = sessionPath(id);
  try {
    const value = JSON.parse(await readFile(join(folder, "session.json"), "utf8"));
    return { folder, value };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeSession(folder, value) {
  value.updatedAt = new Date().toISOString();
  const target = join(folder, "session.json");
  const temporary = `${target}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, target);
}

export async function createSession() {
  const id = randomUUID();
  const folder = sessionPath(id);
  await mkdir(join(folder, "runs"), { recursive: true });
  const value = { id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), runs: [], lastResult: null };
  await writeSession(folder, value);
  return { folder, value };
}

export async function ensureSessionsDirectory() {
  await mkdir(sessionsDir, { recursive: true });
}
