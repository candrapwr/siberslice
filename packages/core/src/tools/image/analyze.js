import { readFile } from "node:fs/promises";
import { requireProvider } from "../../providers/compatibility.js";
import { imageDimensions, MAX_IMAGE_BYTES, readJsonResponse, safePath } from "./shared.js";

const MIME_SIGNATURES = [
  { prefix: Buffer.from("89504e470d0a1a0a", "hex"), mime: "image/png" },
  { prefix: Buffer.from("ffd8", "hex"), mime: "image/jpeg" },
];

function mimeForBuffer(buffer) {
  for (const { prefix, mime } of MIME_SIGNATURES) {
    if (buffer.subarray(0, prefix.length).equals(prefix)) return mime;
  }
  if (buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return "image/png";
}

function responseText(message) {
  if (typeof message?.content === "string") return message.content.trim();
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n").trim();
  }
  return "";
}

export async function analyzeImage({ imagePath, prompt, workDir, provider, recorder }) {
  provider = requireProvider(provider, "Image analysis");
  const buffer = await readFile(safePath(workDir, imagePath));
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error("Gambar terlalu besar untuk dianalisis (maksimum 30 MB).");
  const mime = mimeForBuffer(buffer);
  let sizeNote = "";
  let dimensions = null;
  try {
    dimensions = imageDimensions(buffer); // PNG-only parser
    sizeNote = ` Ukuran gambar: ${dimensions.width}×${dimensions.height} piksel.`;
  } catch { /* non-PNG reference formats are fine for vision models */ }
  const imageData = `data:${mime};base64,${buffer.toString("base64")}`;
  const endpoint = "/chat/completions";
  const payload = {
    model: provider.model,
    temperature: 0,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: `${prompt}${sizeNote} Bila diminta koordinat crop, gunakan koordinat piksel pada gambar asli.` },
        { type: "image_url", image_url: { url: imageData, detail: "high" } },
      ],
    }],
  };
  await recorder?.conversation({ provider: "imageAnalyze", direction: "request", endpoint, payload: {
    model: payload.model,
    temperature: payload.temperature,
    messages: [{ role: "user", content: [
      { type: "text", text: payload.messages[0].content[0].text },
      { type: "image_url", image_url: { detail: "high", imageBytes: buffer.length, mimeType: mime } },
    ] }],
  } });

  let response;
  try {
    response = await fetch(`${provider.baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    await recorder?.conversation({
      provider: "imageAnalyze",
      direction: "error",
      endpoint,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    });
    throw error;
  }

  const body = await readJsonResponse(response, "Image analysis", (entry) => recorder?.conversation({
    provider: "imageAnalyze",
    direction: "response",
    endpoint,
    ...entry,
  }));
  const text = responseText(body.choices?.[0]?.message);
  if (!text) throw new Error("Model image analysis tidak mengembalikan hasil.");
  return JSON.stringify({ imagePath, ...dimensions, analysis: text });
}
