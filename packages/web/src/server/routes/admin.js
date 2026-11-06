import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { runPython } from "@siberslice/core/tools/python-runner";
import { config, s3Configured } from "../../config/env.js";
import { readJsonBody, sendError, sendJson } from "../http.js";
import { recordServerError } from "../server-log.js";
import { deleteRunObjects } from "../s3-store.js";
import {
  beginSessionDeletion,
  endSessionDeletion,
  isSessionBusy,
  readSession,
  sessionIdPattern,
  sessionPath,
} from "../session-store.js";

const sessionsDir = join(config.dataDir, "sessions");
const REQUIRED_PYTHON_PACKAGES = ["Pillow", "NumPy"];
const ADMIN_COOKIE = "siberslice_admin";
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const ADMIN_LOGIN_MAX_FAILURES = 8;
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const adminSessions = new Map();
const adminLoginFailures = new Map();

function adminCookieToken(req) {
  const prefix = `${ADMIN_COOKIE}=`;
  const entry = (req.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : "";
}

export function isAdminAuthenticated(req) {
  if (!config.adminPassword) return false;
  const now = Date.now();
  for (const [token, expiresAt] of adminSessions) {
    if (expiresAt <= now) adminSessions.delete(token);
  }
  const token = adminCookieToken(req);
  const expiresAt = adminSessions.get(token);
  return Boolean(token && expiresAt && expiresAt > now);
}

function sendAdminCookie(res, cookie, payload = { authenticated: true }) {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "set-cookie": cookie,
  });
  res.end(JSON.stringify(payload));
}

function cookieOptions(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase();
  return `${req.socket?.encrypted || forwardedProto === "https" ? "; Secure" : ""}; HttpOnly; SameSite=Strict; Path=/`;
}

export function handleAdminAuthStatus(req, res) {
  return sendJson(res, 200, {
    configured: Boolean(config.adminPassword),
    authenticated: isAdminAuthenticated(req),
  });
}

export async function handleAdminLogin(req, res) {
  if (!config.adminPassword) return sendError(res, 503, "Password admin belum diatur di SIBERSLICE_ADMIN_PASSWORD.");
  const address = req.socket?.remoteAddress ?? "unknown";
  const now = Date.now();
  for (const [ip, attempt] of adminLoginFailures) {
    if (attempt.windowStartedAt + ADMIN_LOGIN_WINDOW_MS <= now && attempt.lockedUntil <= now) adminLoginFailures.delete(ip);
  }
  const previous = adminLoginFailures.get(address);
  if (previous?.lockedUntil > now) return sendError(res, 429, "Terlalu banyak percobaan login. Coba lagi setelah 15 menit.");

  let body;
  try {
    body = await readJsonBody(req, 4096);
  } catch (error) {
    return sendError(res, 400, error instanceof Error ? error.message : "Request login tidak valid.");
  }
  const password = typeof body.password === "string" ? body.password : "";
  const expected = createHash("sha256").update(config.adminPassword, "utf8").digest();
  const provided = createHash("sha256").update(password, "utf8").digest();
  if (!timingSafeEqual(expected, provided)) {
    const attempt = previous && previous.windowStartedAt + ADMIN_LOGIN_WINDOW_MS > now
      ? previous
      : { failures: 0, windowStartedAt: now, lockedUntil: 0 };
    attempt.failures += 1;
    if (attempt.failures >= ADMIN_LOGIN_MAX_FAILURES) attempt.lockedUntil = now + ADMIN_LOGIN_WINDOW_MS;
    adminLoginFailures.set(address, attempt);
    return sendError(res, attempt.lockedUntil > now ? 429 : 401, attempt.lockedUntil > now
      ? "Terlalu banyak percobaan login. Coba lagi setelah 15 menit."
      : "Password admin salah.");
  }

  adminLoginFailures.delete(address);
  const token = randomBytes(32).toString("base64url");
  adminSessions.set(token, Date.now() + ADMIN_SESSION_MS);
  const maxAge = Math.floor(ADMIN_SESSION_MS / 1000);
  return sendAdminCookie(res, `${ADMIN_COOKIE}=${token}; Max-Age=${maxAge}${cookieOptions(req)}`);
}

export function handleAdminLogout(req, res) {
  const token = adminCookieToken(req);
  if (token) adminSessions.delete(token);
  return sendAdminCookie(res, `${ADMIN_COOKIE}=; Max-Age=0${cookieOptions(req)}`, { authenticated: false });
}

const pythonCheckScript = String.raw`
import importlib
import importlib.metadata
import json
import sys

checks = []
for display_name, module_name, distribution_name in [
    ("Pillow", "PIL.Image", "Pillow"),
    ("NumPy", "numpy", "numpy"),
]:
    try:
        importlib.import_module(module_name)
        version = importlib.metadata.version(distribution_name)
        checks.append({"name": display_name, "module": module_name, "version": version, "available": True})
    except Exception as error:
        checks.append({"name": display_name, "module": module_name, "version": None, "available": False, "error": str(error)})

print(json.dumps({
    "command": "python3",
    "executable": sys.executable,
    "version": sys.version.split()[0],
    "checks": checks,
    "ready": all(check["available"] for check in checks),
}))
`;

async function directoryEntries(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readJsonLines(path) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return contents.split(/\r?\n/).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { malformed: true, raw: line };
    }
  });
}

function validAssetName(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]*\.png$/i.test(value);
}

function summarizeRuns(session, sessionId) {
  const runs = Array.isArray(session?.runs) ? session.runs : [];
  return runs.map((run) => ({
    runId: run.runId,
    createdAt: run.createdAt ?? null,
    status: run.status ?? "unknown",
    groupName: run.groupName ?? null,
    prompt: run.prompt ?? "",
    theme: run.theme ?? null,
    style: run.style ?? null,
    count: Number(run.count) || (Array.isArray(run.assets) ? run.assets.length : 0),
    assetCount: Array.isArray(run.assets) ? run.assets.length : 0,
    detailUrl: `/api/admin/sessions/${sessionId}`,
  }));
}

export async function handleAdminSessionList(res) {
  const entries = (await directoryEntries(sessionsDir))
    .filter((entry) => entry.isDirectory() && sessionIdPattern.test(entry.name));
  const sessions = await Promise.all(entries.map(async (entry) => {
    const folder = join(sessionsDir, entry.name);
    let value = null;
    let readError = null;
    try {
      value = JSON.parse(await readFile(join(folder, "session.json"), "utf8"));
    } catch (error) {
      readError = error instanceof SyntaxError ? "session.json rusak atau tidak valid." : error?.code === "ENOENT" ? "session.json tidak ditemukan." : error.message;
    }

    const runs = summarizeRuns(value, entry.name);
    let folderInfo;
    try { folderInfo = await stat(folder); } catch { folderInfo = null; }
    return {
      id: entry.name,
      createdAt: value?.createdAt ?? folderInfo?.birthtime?.toISOString() ?? null,
      updatedAt: value?.updatedAt ?? folderInfo?.mtime?.toISOString() ?? null,
      runCount: runs.length,
      completeCount: runs.filter((run) => run.status === "complete").length,
      failedCount: runs.filter((run) => run.status === "failed").length,
      busy: isSessionBusy(entry.name),
      lastPrompt: runs.at(-1)?.prompt ?? "",
      runs,
      readError,
    };
  }));
  sessions.sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""));
  return sendJson(res, 200, { sessions, total: sessions.length });
}

export async function handleAdminSessionDetail(res, sessionId) {
  const result = await readSession(sessionId);
  if (!result) return sendError(res, 404, "Session tidak ditemukan.");

  const runsById = new Map((Array.isArray(result.value.runs) ? result.value.runs : [])
    .filter((run) => sessionIdPattern.test(run?.runId ?? ""))
    .map((run) => [run.runId, run]));
  const runEntries = (await directoryEntries(join(result.folder, "runs")))
    .filter((entry) => entry.isDirectory() && sessionIdPattern.test(entry.name));
  for (const entry of runEntries) {
    if (!runsById.has(entry.name)) runsById.set(entry.name, { runId: entry.name, status: isSessionBusy(sessionId) ? "running" : "incomplete" });
  }

  const runs = await Promise.all([...runsById.values()].map(async (run) => {
    const runFolder = join(result.folder, "runs", run.runId);
    const assetEntries = (await directoryEntries(join(runFolder, "assets")))
      .filter((entry) => entry.isFile() && validAssetName(entry.name));
    const metadataAssets = Array.isArray(run.assets) ? run.assets : [];
    const assetsByName = new Map(metadataAssets.filter((asset) => validAssetName(asset?.name)).map((asset) => [asset.name, asset]));
    for (const entry of assetEntries) if (!assetsByName.has(entry.name)) assetsByName.set(entry.name, { name: entry.name });
    const assets = await Promise.all([...assetsByName.values()].map(async (asset, index) => {
      const name = asset.name;
      const url = `/api/sessions/${sessionId}/files/runs/${run.runId}/assets/${encodeURIComponent(name)}`;
      const exists = await isFile(join(runFolder, "assets", name));
      return {
        index: Number.isInteger(asset.index) ? asset.index : index + 1,
        name,
        label: asset.label ?? name.replace(/\.png$/i, "").replace(/-/g, " "),
        width: asset.width ?? null,
        height: asset.height ?? null,
        url: exists ? url : null,
      };
    }));
    const sheetName = await isFile(join(runFolder, "sheet-transparent.png"))
      ? "sheet-transparent.png"
      : "sheet.png";
    const sheetExists = await isFile(join(runFolder, sheetName));
    const logFolder = join(runFolder, "logs");
    return {
      runId: run.runId,
      createdAt: run.createdAt ?? null,
      status: run.status ?? "unknown",
      groupName: run.groupName ?? null,
      prompt: run.prompt ?? "",
      theme: run.theme ?? null,
      style: run.style ?? null,
      count: Number(run.count) || assets.length,
      error: run.error ?? null,
      sheetUrl: sheetExists ? `/api/sessions/${sessionId}/files/runs/${run.runId}/${sheetName}` : null,
      assets: assets.filter((asset) => asset.url),
      logs: {
        conversation: await isFile(join(logFolder, "conversation.jsonl")),
        events: await isFile(join(logFolder, "events.jsonl")),
      },
    };
  }));
  runs.sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""));

  return sendJson(res, 200, {
    id: sessionId,
    session: result.value,
    busy: isSessionBusy(sessionId),
    runs,
  });
}

export async function handleAdminRunLogs(res, sessionId, runId, logType) {
  if (!sessionIdPattern.test(runId)) return sendError(res, 400, "Run ID tidak valid.");
  if (!["conversation", "events"].includes(logType)) return sendError(res, 400, "Jenis log tidak valid.");
  const result = await readSession(sessionId);
  if (!result) return sendError(res, 404, "Session tidak ditemukan.");
  const runFolder = join(result.folder, "runs", runId);
  const entries = await directoryEntries(join(result.folder, "runs"));
  if (!entries.some((entry) => entry.isDirectory() && entry.name === runId)) return sendError(res, 404, "Run tidak ditemukan.");
  const records = await readJsonLines(join(runFolder, "logs", `${logType}.jsonl`));
  return sendJson(res, 200, { sessionId, runId, type: logType, records });
}

export async function handleAdminPythonCheck(res) {
  try {
    const result = await runPython(pythonCheckScript, {}, config.dataDir, 15_000);
    return sendJson(res, 200, result);
  } catch (error) {
    return sendJson(res, 200, {
      command: "python3",
      executable: null,
      version: null,
      checks: REQUIRED_PYTHON_PACKAGES.map((name) => ({ name, available: false, version: null })),
      ready: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleAdminServerErrors(res, url) {
  const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(500, requestedLimit)) : 200;
  const records = await readJsonLines(join(config.dataDir, "logs", "server-errors.jsonl"));
  return sendJson(res, 200, { records: records.slice(-limit), total: records.length, limit });
}

export async function handleDeleteAdminSession(res, sessionId) {
  if (!sessionIdPattern.test(sessionId)) return sendError(res, 400, "Session ID tidak valid.");
  if (!beginSessionDeletion(sessionId)) return sendError(res, 409, "Session sedang dipakai proses lain dan belum bisa dihapus.");
  try {
    let info;
    try { info = await stat(sessionPath(sessionId)); } catch (error) {
      if (error?.code === "ENOENT") return sendError(res, 404, "Session tidak ditemukan.");
      throw error;
    }
    if (!info.isDirectory()) return sendError(res, 404, "Session tidak ditemukan.");
    if (s3Configured()) {
      try {
        const session = await readSession(sessionId);
        const keys = (Array.isArray(session?.value.runs) ? session.value.runs : [])
          .flatMap((run) => Object.values(run?.s3 ?? {}))
          .map((entry) => entry?.key)
          .filter(Boolean);
        await deleteRunObjects(keys);
      } catch (error) {
        // S3 cleanup failure must not block deleting the local session; keep it visible in server logs.
        await recordServerError({ level: "warn", type: "s3_delete_failed", sessionId, message: error instanceof Error ? error.message : String(error) });
      }
    }
    await rm(sessionPath(sessionId), { recursive: true });
    return sendJson(res, 200, { deleted: true, id: sessionId });
  } finally {
    endSessionDeletion(sessionId);
  }
}
