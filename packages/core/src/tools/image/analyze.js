import { readFile } from "node:fs/promises";
import { requireProvider } from "../../providers/compatibility.js";
import { imageDimensions, MAX_IMAGE_BYTES, readJsonResponse, safePath } from "./shared.js";

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
  const dimensions = imageDimensions(buffer);
  const imageData = `data:image/png;base64,${buffer.toString("base64")}`;
  const endpoint = "/chat/completions";
  const payload = {
    model: provider.model,
    temperature: 0,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: `${prompt}\n\nUkuran gambar: ${dimensions.width}×${dimensions.height} piksel. Bila diminta koordinat crop, gunakan koordinat piksel pada gambar asli.` },
        { type: "image_url", image_url: { url: imageData, detail: "high" } },
      ],
    }],
  };
  await recorder?.conversation({ provider: "imageAnalyze", direction: "request", endpoint, payload });

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
