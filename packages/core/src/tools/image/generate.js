import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requireProvider } from "../../providers/compatibility.js";
import { imageDimensions, MAX_IMAGE_BYTES, readJsonResponse } from "./shared.js";

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
    if (typeof item?.b64_json === "string") buffer = Buffer.from(item.b64_json, "base64");
    else if (typeof item?.url === "string") buffer = await fetchImageUrl(item.url);
    else if (typeof item?.image_base64 === "string") buffer = Buffer.from(item.image_base64, "base64");
    else throw new Error("Image generation tidak mengembalikan PNG, b64_json, atau URL gambar.");
  }

  if (buffer.length > MAX_IMAGE_BYTES) throw new Error("Ukuran sprite sheet melebihi batas 30 MB.");
  const dimensions = imageDimensions(buffer);
  await writeFile(join(workDir, "sheet.png"), buffer);
  return { path: "sheet.png", ...dimensions, bytes: buffer.length };
}
