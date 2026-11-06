import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config, s3Configured } from "../config/env.js";

let client = null;

export function s3StorageConfigured() {
  return s3Configured();
}

function getClient() {
  if (!s3StorageConfigured()) throw new Error("Penyimpanan S3 belum dikonfigurasi (bucket/access key/secret key).");
  if (!client) {
    const { region, endpoint, accessKey, secretKey, forcePathStyle } = config.s3;
    client = new S3Client({
      region,
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    });
  }
  return client;
}

export function runKeyPrefix(sessionId, runId) {
  const prefix = config.s3.prefix ? `${config.s3.prefix}/` : "";
  return `${prefix}${sessionId}/${runId}`;
}

export function objectKey(sessionId, runId, relativePath) {
  const segments = String(relativePath).split("/").filter((part) => part && part !== "." && part !== "..");
  if (segments.length === 0) throw new Error("Path objek tidak valid.");
  return `${runKeyPrefix(sessionId, runId)}/${segments.join("/")}`;
}

async function putFile(storedKey, absolutePath, contentType) {
  const { readFile, stat } = await import("node:fs/promises");
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error(`Bukan file reguler: ${absolutePath}`);
  // A full buffer (not a stream) keeps the SDK from using aws-chunked
  // payload framing, which some S3-compatible providers mishandle.
  const response = await getClient().send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: storedKey,
    Body: await readFile(absolutePath),
    ContentType: contentType ?? "application/octet-stream",
  }));
  return { key: storedKey, size: info.size, etag: response.ETag ?? null };
}

const CONTENT_TYPES = new Map([
  [".png", "image/png"],
  [".zip", "application/zip"],
  [".json", "application/json"],
]);

function guessContentType(path) {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return CONTENT_TYPES.get(ext) ?? "application/octet-stream";
}

/**
 * Upload all generated deliverables of a run (sheets, assets, export zip).
 * Returns a manifest of stored keys: { "runs/<id>/sheet.png": { key, size }, ... }
 * keyed by the session-relative path so readers can map old paths to objects.
 */
export async function uploadRun({ sessionId, runId, runDir, files }) {
  const manifest = {};
  for (const relative of files) {
    const absolute = `${runDir}/${relative}`;
    const storedKey = objectKey(sessionId, runId, relative);
    manifest[relative] = await putFile(storedKey, absolute, guessContentType(relative));
  }
  return manifest;
}

export async function headObject(storedKey) {
  try {
    const head = await getClient().send(new HeadObjectCommand({ Bucket: config.s3.bucket, Key: storedKey }));
    return { exists: true, size: head.ContentLength ?? null, contentType: head.ContentType ?? null };
  } catch (error) {
    const name = error?.name ?? "";
    if (name === "NotFound" || name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) return { exists: false };
    throw error;
  }
}

export async function presignDownload(storedKey, { filename, ttlSeconds } = {}) {
  const command = new GetObjectCommand({
    Bucket: config.s3.bucket,
    Key: storedKey,
    ...(filename ? { ResponseContentDisposition: contentDisposition(filename) } : {}),
  });
  return getSignedUrl(getClient(), command, { expiresIn: ttlSeconds ?? config.s3.presignTtlSeconds });
}

export async function deleteRunObjects(storedKeys) {
  let failure = null;
  for (const key of storedKeys) {
    try {
      await getClient().send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

function contentDisposition(filename) {
  const safe = String(filename || "download").replace(/["\\]/g, "");
  const fallback = safe.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "download";
  const encoded = encodeURIComponent(safe).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
