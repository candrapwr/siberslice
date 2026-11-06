import { resolve, sep } from "node:path";

export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

export function imageDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString("hex", 0, 8) !== "89504e470d0a1a0a") {
    throw new Error("Hasil image generator bukan PNG. Pastikan model mengembalikan PNG transparan.");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export function safePath(workDir, inputPath) {
  if (typeof inputPath !== "string" || !inputPath.trim()) throw new Error("Path gambar tidak valid.");
  const absolute = resolve(workDir, inputPath);
  const root = resolve(workDir) + sep;
  if (absolute !== resolve(workDir) && !absolute.startsWith(root)) {
    throw new Error("Path gambar harus berada di folder kerja generate ini.");
  }
  return absolute;
}

export async function readJsonResponse(response, label, onResponse) {
  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    await onResponse?.({ status: response.status, ok: response.ok, raw: raw.slice(0, 2000), parseError: true });
    throw new Error(`${label} mengembalikan respons yang bukan JSON: ${raw.slice(0, 500)}`);
  }
  await onResponse?.({ status: response.status, ok: response.ok, body });
  if (!response.ok) {
    const detail = body?.error?.message ?? body?.message ?? raw.slice(0, 1200) ?? response.statusText;
    throw new Error(`${label} HTTP ${response.status}: ${detail}`);
  }
  return body;
}
