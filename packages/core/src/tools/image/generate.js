import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requireProvider } from "../../providers/compatibility.js";
import { imageDimensions, MAX_IMAGE_BYTES, readJsonResponse } from "./shared.js";
import { runPython } from "../python-runner.js";

const NORMALIZE_IMAGE_SCRIPT = String.raw`
import json, sys
try:
    from PIL import Image
except ImportError:
    print(json.dumps({"error": "Konversi gambar membutuhkan Pillow. Jalankan python3 -m pip install Pillow."}))
    sys.exit(0)

payload = json.load(sys.stdin)
try:
    with Image.open(payload["inputPath"]) as source:
        source.load()
        source_format = source.format or "unknown"
        source_mode = source.mode
        image = source.convert("RGBA")
        image.save(payload["outputPath"], format="PNG", optimize=True)
    print(json.dumps({"format": source_format, "mode": source_mode, "width": image.width, "height": image.height}))
except Exception as error:
    print(json.dumps({"error": str(error)}))
`;

function decodeBase64Image(value) {
  const encoded = value.trim().replace(/^data:image\/[^;,]+;base64,/i, "");
  return Buffer.from(encoded, "base64");
}

async function saveGeneratedImage(buffer, workDir) {
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error("Ukuran sprite sheet melebihi batas 30 MB.");
  const outputPath = join(workDir, "sheet.png");
  const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");

  if (buffer.length >= pngSignature.length && buffer.subarray(0, pngSignature.length).equals(pngSignature)) {
    const dimensions = imageDimensions(buffer);
    await writeFile(outputPath, buffer);
    return { ...dimensions, bytes: buffer.length, sourceFormat: "PNG", converted: false };
  }

  const temporaryId = randomUUID();
  const inputPath = join(workDir, `.image-response-${temporaryId}.bin`);
  const normalizedPath = join(workDir, `.image-normalized-${temporaryId}.png`);
  try {
    await writeFile(inputPath, buffer, { flag: "wx" });
    const conversion = await runPython(NORMALIZE_IMAGE_SCRIPT, { inputPath, outputPath: normalizedPath }, workDir);
    if (conversion.error) throw new Error(conversion.error);

    const normalizedBuffer = await readFile(normalizedPath);
    if (normalizedBuffer.length > MAX_IMAGE_BYTES) throw new Error("PNG hasil konversi melebihi batas 30 MB.");
    const dimensions = imageDimensions(normalizedBuffer);
    await writeFile(outputPath, normalizedBuffer);
    return {
      ...dimensions,
      bytes: normalizedBuffer.length,
      sourceFormat: conversion.format || "unknown",
      converted: true,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Hasil image generator bukan PNG dan gagal dikonversi: ${detail}`);
  } finally {
    await Promise.all([
      rm(inputPath, { force: true }).catch(() => {}),
      rm(normalizedPath, { force: true }).catch(() => {}),
    ]);
  }
}

async function fetchImageUrl(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Tidak bisa mengunduh gambar hasil: HTTP ${response.status}.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error("Ukuran sprite sheet melebihi batas 30 MB.");
  return buffer;
}

function summarizeImageResponse(entry) {
  if (!entry.body) return { ...entry, raw: entry.raw };
  const payload = { ...entry.body };
  for (const key of ["data", "images"]) {
    if (!Array.isArray(payload[key])) continue;
    payload[key] = payload[key].map((item) => {
      const { b64_json: base64, image_base64: imageBase64, url, ...metadata } = item ?? {};
      const encodedImage = typeof base64 === "string" ? base64 : imageBase64;
      return {
        ...metadata,
        ...(typeof encodedImage === "string" ? { imageBytes: Math.floor(encodedImage.length * 3 / 4), imagePayloadStoredAs: "sheet.png" } : {}),
        ...(typeof url === "string" ? { imageUrlReturned: true } : {}),
      };
    });
  }
  return { status: entry.status, ok: entry.ok, payload };
}

export async function generateImage({ prompt, workDir, provider, imageSize, recorder }) {
  provider = requireProvider(provider, "Image generation");
  const endpoint = "/images/generations";
  const payload = {
    model: provider.model,
    prompt,
    n: 1,
    size: imageSize,
    output_format: "png",
    background: "transparent",
  };
  await recorder?.conversation({ provider: "imageGen", direction: "request", endpoint, payload });
  let response;
  try {
    response = await fetch(`${provider.baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(240_000),
    });
  } catch (error) {
    await recorder?.conversation({
      provider: "imageGen",
      direction: "error",
      endpoint,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    });
    throw error;
  }

  let buffer;
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.startsWith("image/")) {
    if (!response.ok) {
      await recorder?.conversation({ provider: "imageGen", direction: "response", endpoint, status: response.status, ok: false, contentType });
      throw new Error(`Image generation HTTP ${response.status}.`);
    }
    buffer = Buffer.from(await response.arrayBuffer());
    await recorder?.conversation({ provider: "imageGen", direction: "response", endpoint, status: response.status, ok: true, contentType, imageBytes: buffer.length });
  } else {
    const body = await readJsonResponse(response, "Image generation", (entry) => recorder?.conversation({
      provider: "imageGen",
      direction: "response",
      endpoint,
      ...summarizeImageResponse(entry),
    }));
    const item = body.data?.[0] ?? body.images?.[0];
    if (typeof item?.b64_json === "string") buffer = decodeBase64Image(item.b64_json);
    else if (typeof item?.url === "string") buffer = await fetchImageUrl(item.url);
    else if (typeof item?.image_base64 === "string") buffer = decodeBase64Image(item.image_base64);
    else throw new Error("Image generation tidak mengembalikan PNG, b64_json, atau URL gambar.");
  }

  const savedImage = await saveGeneratedImage(buffer, workDir);
  if (savedImage.converted) {
    await recorder?.conversation({
      provider: "imageGen",
      direction: "normalization",
      endpoint,
      sourceFormat: savedImage.sourceFormat,
      outputFormat: "PNG",
      width: savedImage.width,
      height: savedImage.height,
      bytes: savedImage.bytes,
    });
  }
  return { path: "sheet.png", ...savedImage };
}
