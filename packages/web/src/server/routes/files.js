import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { config, s3Configured } from "../../config/env.js";
import { sendError } from "../http.js";
import { readSession, sessionIdPattern } from "../session-store.js";
import { headObject, presignDownload } from "../s3-store.js";

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../frontend/public");
const localAssetReferencePattern = /((?:href|src)=["'])(\/(?:css|js)\/[^"'?#]+)(?:\?[^"']*)?(["'])/gi;

async function versionHtmlAssets(html) {
  const paths = [...new Set([...html.matchAll(localAssetReferencePattern)].map((match) => match[2]))];
  const versions = new Map();
  await Promise.all(paths.map(async (assetPath) => {
    const absolute = resolve(publicDir, assetPath.slice(1));
    if (!absolute.startsWith(`${publicDir}${sep}`)) return;
    try {
      const info = await stat(absolute);
      versions.set(assetPath, `${Math.trunc(info.mtimeMs)}-${info.size}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }));

  return html.replace(localAssetReferencePattern, (match, prefix, assetPath, suffix) => {
    const version = versions.get(assetPath);
    return version ? `${prefix}${assetPath}?v=${version}${suffix}` : match;
  });
}

function generatedFileType(file) {
  const ext = extname(file).toLowerCase();
  return ({
    ".png": "image/png",
    ".zip": "application/zip",
    ".json": "application/json; charset=utf-8",
  })[ext] ?? "application/octet-stream";
}

function safeDownloadName(value) {
  return String(value || "download")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f\/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "download";
}

function contentDisposition(filename) {
  const safeName = safeDownloadName(filename);
  const fallback = safeName.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "download";
  const encoded = encodeURIComponent(safeName)
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function serveFile(res, folder, requestedPath, download = false, downloadName) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestedPath);
  } catch {
    return sendError(res, 400, "Path file tidak valid.");
  }
  const segments = decoded.split(/[\\/]+/);
  if (!decoded || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return sendError(res, 400, "Path file tidak valid.");
  }
  if (segments.some((segment) => segment.toLowerCase() === "logs")) {
    return sendError(res, 404, "File tidak ditemukan.");
  }
  const absolute = resolve(folder, ...segments);
  if (!absolute.startsWith(`${resolve(folder)}${sep}`)) return sendError(res, 403, "Path file di luar session.");
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return sendError(res, 404, "File tidak ditemukan.");
    res.writeHead(200, {
      "content-type": generatedFileType(absolute),
      "content-length": info.size,
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      ...(download ? { "content-disposition": contentDisposition(downloadName || segments.at(-1)) } : {}),
    });
    res.end(await readFile(absolute));
  } catch (error) {
    if (error?.code === "ENOENT") return sendError(res, 404, "File tidak ditemukan.");
    throw error;
  }
}

function runEntry(session, runId) {
  return Array.isArray(session.value.runs) ? session.value.runs.find((entry) => entry?.runId === runId) ?? null : null;
}

function s3KeyForRun(session, runId, relativePath) {
  const run = runEntry(session, runId);
  if (!run?.s3) return null;
  const manifestKey = relativePath.split(/[\\/]+/).filter(Boolean).join("/");
  if (run.s3[manifestKey]?.key) return run.s3[manifestKey].key;
  if (!run.s3.prefix) return null;
  return `${run.s3.prefix}/${manifestKey}`;
}

async function redirectPresigned(res, storedKey, downloadName) {
  const url = await presignDownload(storedKey, downloadName ? { filename: downloadName } : {});
  res.writeHead(302, { location: url, "cache-control": "no-store" });
  res.end();
}

export async function handleSessionFile(res, sessionId, filePath, download = false) {
  const session = await readSession(sessionId);
  if (!session) return sendError(res, 404, "Session tidak ditemukan.");
  const match = filePath.match(/^runs\/([0-9a-fA-F-]{36})\/(.+)$/);
  if (match && sessionIdPattern.test(match[1]) && s3Configured()) {
    const [, runId] = match;
    try {
      const relative = decodeURIComponent(match[2]).split(/[\\/]+/).filter(Boolean).join("/");
      const storedKey = s3KeyForRun(session, runId, relative);
      if (!storedKey) return sendError(res, 409, "Run ini dibuat sebelum penyimpanan S3 aktif, jadi filenya tidak tersedia di cloud. Generate ulang aset ini untuk memakai S3.");
      const info = await headObject(storedKey);
      if (!info.exists) return sendError(res, 404, "File tidak ditemukan di S3 (mungkin sudah dihapus dari bucket).");
      return await redirectPresigned(res, storedKey, download ? relative.split("/").at(-1) : null);
    } catch (error) {
      if (error?.code === "URIError") return sendError(res, 400, "Path file tidak valid.");
      throw error;
    }
  }
  return serveFile(res, session.folder, filePath, download);
}

export async function handleExport(res, sessionId, runId) {
  if (!sessionIdPattern.test(sessionId)) return sendError(res, 400, "Session ID tidak valid.");
  if (!sessionIdPattern.test(runId)) return sendError(res, 400, "Run ID tidak valid.");
  const session = await readSession(sessionId);
  if (!session) return sendError(res, 404, "Session tidak ditemukan.");
  const run = runEntry(session, runId);
  const lastResult = session.value.lastResult?.runId === runId ? session.value.lastResult : null;
  const legacyName = typeof run?.prompt === "string" ? run.prompt.split(/[.!?\n]/, 1)[0].trim().slice(0, 64) : "";
  const groupName = run?.groupName || lastResult?.groupName || legacyName || "Kumpulan Aset";
  const downloadName = `${groupName}.zip`;
  if (s3Configured()) {
    const storedKey = s3KeyForRun(session, runId, "assets.zip");
    if (!storedKey) return sendError(res, 409, "Run ini dibuat sebelum penyimpanan S3 aktif, jadi export-nya belum tersedia di cloud. Generate ulang aset ini untuk memakai S3.");
    const info = await headObject(storedKey);
    if (!info.exists) return sendError(res, 404, "File tidak ditemukan di S3 (mungkin sudah dihapus dari bucket).");
    return redirectPresigned(res, storedKey, downloadName);
  }
  return serveFile(res, session.folder, `runs/${runId}/assets.zip`, true, downloadName);
}

export async function serveStatic(res, pathname) {
  const alias = pathname === "/landing.html"
    ? "/index.html"
    : pathname === "/admin"
      ? "/admin.html"
      : pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(alias === "/" ? "/index.html" : alias);
  } catch {
    return sendError(res, 400, "Path asset tidak valid.");
  }
  const segments = decoded.split(/[\\/]+/).filter(Boolean);
  if (!segments.length || segments.some((part) => part === "." || part === "..")) {
    return sendError(res, 400, "Path asset tidak valid.");
  }
  const absolute = resolve(publicDir, ...segments);
  if (!absolute.startsWith(`${publicDir}${sep}`)) return sendError(res, 403, "Path asset di luar frontend.");
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return sendError(res, 404, "Asset tidak ditemukan.");
    const ext = extname(absolute).toLowerCase();
    const mime = ({
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon",
    })[ext] ?? "application/octet-stream";
    let body = await readFile(absolute);
    if (ext === ".html") body = Buffer.from(await versionHtmlAssets(body.toString("utf8")), "utf8");
    res.writeHead(200, {
      "content-type": mime,
      "content-length": body.length,
      "cache-control": ext === ".html"
        ? "no-cache"
        : [".css", ".js"].includes(ext)
          ? "public, max-age=31536000, immutable"
          : "public, max-age=3600",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  } catch (error) {
    if (error?.code === "ENOENT") return sendError(res, 404, "Asset tidak ditemukan.");
    throw error;
  }
}
