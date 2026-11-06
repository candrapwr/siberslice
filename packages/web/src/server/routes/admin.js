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
  writeSession,
} from "../session-store.js";
import { restoreSessionToLocal } from "../restore-local.js";

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
    hasS3: Boolean(run.s3),
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
    const completeRuns = runs.filter((run) => run.status === "complete");
    const newestRun = completeRuns.at(-1) ?? runs.at(-1) ?? null;
    return {
      id: entry.name,
      createdAt: value?.createdAt ?? folderInfo?.birthtime?.toISOString() ?? null,
      updatedAt: value?.updatedAt ?? folderInfo?.mtime?.toISOString() ?? null,
      runCount: runs.length,
      completeCount: completeRuns.length,
      failedCount: runs.filter((run) => run.status === "failed").length,
      busy: isSessionBusy(entry.name),
      lastPrompt: runs.at(-1)?.prompt ?? "",
      lastGroupName: runs.at(-1)?.groupName ?? null,
      totalAssets: completeRuns.reduce((sum, run) => sum + run.assetCount, 0),
      s3RunCount: runs.filter((run) => run.hasS3).length,
      thumbnailUrl: newestRun ? `/api/sessions/${entry.name}/files/runs/${newestRun.runId}/sheet.png` : null,
      runs,
      readError,
    };
  }));
  sessions.sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""));
  return sendJson(res, 200, { sessions, total: sessions.length });
}

async function collectSessionSummaries() {
  const entries = (await directoryEntries(sessionsDir))
    .filter((entry) => entry.isDirectory() && sessionIdPattern.test(entry.name));
  const sessions = [];
  for (const entry of entries) {
    let value = null;
    try { value = JSON.parse(await readFile(join(sessionsDir, entry.name, "session.json"), "utf8")); } catch { /* skip broken */ }
    sessions.push({ id: entry.name, value, runs: summarizeRuns(value, entry.name), busy: isSessionBusy(entry.name) });
  }
  return sessions;
}

/** Dashboard aggregates: totals, storage split, activity per day, recent runs. */
export async function handleAdminOverview(res) {
  const sessions = await collectSessionSummaries();
  const allRuns = sessions.flatMap((session) => session.runs.map((run) => ({ ...run, sessionId: session.id, groupName: run.groupName ?? session.value?.lastResult?.runId === run.runId ? session.value.lastResult.groupName : null })));
  const complete = allRuns.filter((run) => run.status === "complete");
  const failed = allRuns.filter((run) => run.status === "failed");
  const days = [];
  const now = new Date();
  for (let i = 13; i >= 0; i--) {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - i);
    days.push({ date: day.toISOString().slice(0, 10), label: day.toLocaleDateString("id-ID", { day: "2-digit", month: "short" }), runs: 0, assets: 0 });
  }
  const dayIndex = new Map(days.map((entry, index) => [entry.date, index]));
  for (const run of complete) {
    const key = typeof run.createdAt === "string" ? run.createdAt.slice(0, 10) : "";
    const index = dayIndex.get(key);
    if (index !== undefined) { days[index].runs += 1; days[index].assets += run.assetCount; }
  }
  const recent = [...allRuns]
    .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""))
    .slice(0, 8);
  return sendJson(res, 200, {
    totals: {
      sessions: sessions.length,
      busySessions: sessions.filter((session) => session.busy).length,
      runs: allRuns.length,
      complete: complete.length,
      failed: failed.length,
      assets: complete.reduce((sum, run) => sum + run.assetCount, 0),
      s3Runs: allRuns.filter((run) => run.hasS3).length,
      localRuns: allRuns.filter((run) => !run.hasS3 && run.status === "complete").length,
    },
    activity: days,
    recent,
  });
}

/** Environment status card: providers, S3 (no secrets), app settings. */
export async function handleAdminSystem(res) {
  const { mainAi, imageGen, imageAnalyze, port, dataDir, galleryPageSize, galleryPreviewCount } = config;
  return sendJson(res, 200, {
    providers: [
      { name: "AI utama", model: mainAi.model || "—", baseUrl: mainAi.baseUrl || "—", ready: Boolean(mainAi.baseUrl && mainAi.apiKey && mainAi.model) },
      { name: "Image generation", model: imageGen.model || "—", baseUrl: imageGen.baseUrl || "—", ready: Boolean(imageGen.baseUrl && imageGen.apiKey && imageGen.model) },
      { name: "Image analysis (opsional)", model: imageAnalyze.model || "—", baseUrl: imageAnalyze.baseUrl || "—", ready: Boolean(imageAnalyze.baseUrl && imageAnalyze.apiKey && imageAnalyze.model) },
    ],
    s3: {
      configured: s3Configured(),
      bucket: config.s3.bucket || null,
      endpoint: config.s3.endpoint || null,
      publicBaseUrl: config.s3.publicBaseUrl || null,
      prefix: config.s3.prefix,
      purgeLocal: config.s3.purgeLocal,
      hasCredentials: Boolean(config.s3.accessKey && config.s3.secretKey),
    },
    app: { port, dataDir, galleryPageSize, galleryPreviewCount, maxIterations: config.maxIterations },
  });
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
    // Deliverables may live only in S3 (uploaded, possibly purged from disk):
    // the run manifest says whether a file is served, not the local filesystem.
    const manifest = run.s3 ?? null;
    const assetEntries = (await directoryEntries(join(runFolder, "assets")))
      .filter((entry) => entry.isFile() && validAssetName(entry.name));
    const metadataAssets = Array.isArray(run.assets) ? run.assets : [];
    const assetsByName = new Map(metadataAssets.filter((asset) => validAssetName(asset?.name)).map((asset) => [asset.name, asset]));
    for (const entry of assetEntries) if (!assetsByName.has(entry.name)) assetsByName.set(entry.name, { name: entry.name });
    for (const key of manifest ? Object.keys(manifest) : []) {
      const match = key.match(/^assets\/(.+)$/);
      if (match && validAssetName(match[1]) && !assetsByName.has(match[1])) assetsByName.set(match[1], { name: match[1] });
    }
    const assets = await Promise.all([...assetsByName.values()].map(async (asset, index) => {
      const name = asset.name;
      const url = `/api/sessions/${sessionId}/files/runs/${run.runId}/assets/${encodeURIComponent(name)}`;
      const exists = Boolean(manifest?.[`assets/${name}`]) || await isFile(join(runFolder, "assets", name));
      return {
        index: Number.isInteger(asset.index) ? asset.index : index + 1,
        name,
        label: asset.label ?? name.replace(/\.png$/i, "").replace(/-/g, " "),
        width: asset.width ?? null,
        height: asset.height ?? null,
        url: exists ? url : null,
      };
    }));
    let sheetName = await isFile(join(runFolder, "sheet-transparent.png"))
      ? "sheet-transparent.png"
      : "sheet.png";
    let sheetExists = await isFile(join(runFolder, sheetName));
    if (!sheetExists && manifest) {
      sheetName = manifest["sheet-transparent.png"] ? "sheet-transparent.png" : "sheet.png";
      sheetExists = Boolean(manifest[sheetName]);
    }
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
      hasS3: Boolean(manifest),
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

/**
 * Restore a session's S3-backed runs to local disk (mirror of migrate-s3).
 * Optionally purge the cloud copies (--like body { purgeRemote: true }).
 */
export async function handleSessionRestore(res, sessionId, body = {}) {
  if (!sessionIdPattern.test(sessionId)) return sendError(res, 400, "Session ID tidak valid.");
  if (!s3Configured()) return sendError(res, 409, "Penyimpanan S3 belum dikonfigurasi di server ini.");
  if (!beginSessionDeletion(sessionId)) return sendError(res, 409, "Session sedang dipakai proses lain dan belum bisa dipulihkan.");
  try {
    const session = await readSession(sessionId);
    if (!session) return sendError(res, 404, "Session tidak ditemukan.");
    const hasS3Runs = (Array.isArray(session.value.runs) ? session.value.runs : []).some((run) => run?.s3);
    if (!hasS3Runs) return sendError(res, 409, "Session ini tidak punya run yang tersimpan di S3.");
    const purgeRemote = body?.purgeRemote === true;
    const result = await restoreSessionToLocal(session.value, session.folder, { purgeRemote });
    await writeSession(session.folder, session.value);
    return sendJson(res, 200, { restored: true, id: sessionId, runs: result.runs, files: result.files, purgedRemote: purgeRemote });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await recordServerError({ level: "error", type: "s3_restore_failed", sessionId, message: detail });
    return sendError(res, 502, `Gagal memulihkan dari S3: ${detail}`);
  } finally {
    endSessionDeletion(sessionId);
  }
}
