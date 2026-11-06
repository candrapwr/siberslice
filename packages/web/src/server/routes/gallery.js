import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { config, s3Configured } from "../../config/env.js";
import { sendJson } from "../http.js";
import { sessionIdPattern } from "../session-store.js";

const sessionsDir = join(config.dataDir, "sessions");
const GALLERY_PAGE_SIZE = 20;

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

function legacyGroupName(run, session) {
  const lastResult = session.lastResult;
  if (lastResult?.runId === run.runId && lastResult.groupName) return lastResult.groupName;
  const fromPrompt = typeof run.prompt === "string" ? run.prompt.split(/[.!?\n]/, 1)[0].trim() : "";
  return fromPrompt.slice(0, 64) || "Kumpulan Aset";
}

async function groupFromRun(sessionId, sessionFolder, session, run) {
  if (!run || run.status === "failed" || !sessionIdPattern.test(run.runId ?? "")) return null;
  const runFolder = join(sessionFolder, "runs", run.runId);
  const remote = s3Configured() && run.s3 ? run.s3 : null;
  let sheetName;
  if (remote) {
    sheetName = remote["sheet-transparent.png"] ? "sheet-transparent.png" : "sheet.png";
    if (!remote[sheetName]) return null;
  } else {
    const transparentSheetPath = join(runFolder, "sheet-transparent.png");
    sheetName = await isFile(transparentSheetPath) ? "sheet-transparent.png" : "sheet.png";
    if (!(await isFile(join(runFolder, sheetName)))) return null;
  }

  let assets = Array.isArray(run.assets) ? run.assets : [];
  if (assets.length === 0) {
    const names = remote
      ? Object.keys(remote).filter((key) => key.startsWith("assets/")).map((key) => key.slice("assets/".length))
      : (await directoryEntries(join(runFolder, "assets")))
          .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
          .map((entry) => entry.name);
    const previousResult = session.lastResult?.runId === run.runId ? session.lastResult : null;
    assets = names.map((name, index) => {
      const previous = previousResult?.assets?.find((asset) => asset.name === name);
      return { index: index + 1, name, label: previous?.label ?? name.replace(/\.png$/i, "").replace(/-/g, " ") };
    });
  }
  assets = assets
    .filter((asset) => typeof asset?.name === "string" && /^[a-z0-9][a-z0-9-]*\.png$/i.test(asset.name))
    .map((asset, index) => ({
      index: Number.isInteger(asset.index) ? asset.index : index + 1,
      name: asset.name,
      label: typeof asset.label === "string" && asset.label ? asset.label : asset.name.replace(/\.png$/i, "").replace(/-/g, " "),
      width: Number(asset.width) || undefined,
      height: Number(asset.height) || undefined,
      url: `/api/sessions/${sessionId}/files/runs/${run.runId}/assets/${encodeURIComponent(asset.name)}`,
    }));
  if (assets.length === 0) return null;

  const createdAt = run.createdAt || session.createdAt || new Date(0).toISOString();
  return {
    id: `${sessionId}:${run.runId}`,
    sessionId,
    runId: run.runId,
    groupName: run.groupName || legacyGroupName(run, session),
    createdAt,
    prompt: typeof run.prompt === "string" ? run.prompt : "",
    theme: typeof run.theme === "string" ? run.theme : "general",
    style: typeof run.style === "string" ? run.style : "general",
    count: Number(run.count) || assets.length,
    storage: remote ? "s3" : "local",
    thumbnailUrl: `/api/sessions/${sessionId}/files/runs/${run.runId}/${sheetName}`,
    exportUrl: `/api/sessions/${sessionId}/runs/${run.runId}/export`,
    assets,
  };
}

async function listCandidates() {
  const sessions = (await directoryEntries(sessionsDir))
    .filter((entry) => entry.isDirectory() && sessionIdPattern.test(entry.name));
  const candidates = [];

  for (const entry of sessions) {
    let session;
    try {
      session = JSON.parse(await readFile(join(sessionsDir, entry.name, "session.json"), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) continue;
      throw error;
    }
    if (!session || typeof session !== "object") continue;
    for (const run of Array.isArray(session.runs) ? session.runs : []) {
      if (!run || run.status === "failed" || !sessionIdPattern.test(run.runId ?? "")) continue;
      candidates.push({
        sessionId: entry.name,
        sessionFolder: join(sessionsDir, entry.name),
        session,
        run,
        createdAt: run.createdAt || session.createdAt || new Date(0).toISOString(),
      });
    }
  }

  return candidates.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export async function handleGallery(res, url) {
  const requestedOffset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
  const requestedStart = Number.isFinite(requestedOffset) ? Math.max(0, requestedOffset) : 0;
  const candidates = await listCandidates();
  const offset = Math.min(requestedStart, candidates.length);
  const page = candidates.slice(offset, offset + GALLERY_PAGE_SIZE);
  const groups = (await Promise.all(page.map((candidate) => groupFromRun(
    candidate.sessionId,
    candidate.sessionFolder,
    candidate.session,
    candidate.run,
  )))).filter(Boolean);
  const nextOffset = Math.min(offset + GALLERY_PAGE_SIZE, candidates.length);
  return sendJson(res, 200, {
    groups,
    total: candidates.length,
    offset,
    limit: GALLERY_PAGE_SIZE,
    hasMore: nextOffset < candidates.length,
    nextOffset,
  });
}
