import { requireProvider } from "../providers/compatibility.js";
import { executeShell } from "../tools/cli/exec.js";
import { analyzeImage, cropAssets, generateImage } from "../tools/image/index.js";

const MAX_IMAGE_ATTEMPTS = 2;
const MAX_GRID_COLUMNS = 10;
const GRID_WASTE_WEIGHT = 0.3;
const DEFAULT_IMAGE_SIZE = "1536x1024";

const sleepRetry = (attempt) => new Promise((resolve) => setTimeout(resolve, attempt * 2000));

const tools = [
  {
  "type": "function",
  "function": {
    "name": "image_gen",
    "description": "Generate one transparent PNG sprite sheet. Image models cannot follow exact pixel numbers, so express spacing RELATIVELY (as a fraction of an asset's own size). Non-negotiable rules the prompt must state: 1) fully transparent background; 2) every asset is ONE single connected silhouette — no detached dots, sparkles, rain drops, splashes, swarms of separate creatures, or floating particles; 3) generous empty space between assets, roughly half an asset's own width, and no asset touching another asset or the canvas border; 4) assets arranged in reading order (left-to-right, top-to-bottom); 5) for 12+ assets, ask for a neat aligned grid of equal cells instead of irregular rows.",
    "parameters": {
      "type": "object",
      "properties": {
        "prompt": {
          "type": "string",
          "description": "English art-direction prompt. Enforce with relative terms (never pixel counts): transparent background, one connected silhouette per asset with no floating details, wide empty gutters about half an asset's width, safe margin from canvas edges, reading-order layout. For 12+ assets also require a tidy aligned grid with equal spacing."
        },
        "assetNames": {
          "type": "array",
          "description": "Exactly one short descriptive kebab-case filename per asset, in visual reading order (left-to-right, top-to-bottom). Each name MUST denote a single solid object — never 'swarm', 'particles', 'drops', 'sparkles', 'splatter', 'confetti', or anything that implies multiple separate shapes.",
          "items": { "type": "string" }
        }
      },
      "required": ["prompt", "assetNames"],
      "additionalProperties": false
    }
  }
},
  {
    type: "function",
    function: {
      name: "crop_assets",
      description: "Use local pixel processing to find connected asset regions, merge nearby fragments, crop exactly the requested count, validate the PNGs, and create the export ZIP. No vision-model coordinates are used.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "name_asset_group",
      description: "After every asset has been cropped successfully, assign a concise name to the completed asset group.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "A clear 2–6 word group name in the same language as the user's prompt." },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "exec",
      description: "Run an unrestricted shell command in this generation's work directory. Python and other installed commands are available.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "Shell command to run." } },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
];

function parseAspect(imageSize) {
  const match = String(imageSize ?? DEFAULT_IMAGE_SIZE).match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  if (!match) return 1.5;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return 1.5;
  const ratio = width / height;
  return ratio >= 0.25 && ratio <= 4 ? ratio : 1.5;
}

/**
 * Pick a grid shape for the sheet: cell shape closest to the canvas aspect
 * ratio, with a small penalty for wasted cells so exact fits win ties.
 * Columns are capped at 10 so a row of tiny slivers is never suggested.
 */
function chooseGrid(count, imageSize) {
  const ratio = parseAspect(imageSize);
  const total = Number.isSafeInteger(count) && count > 0 ? count : 1;
  let best = { rows: 1, columns: Math.min(total, MAX_GRID_COLUMNS) };
  let bestScore = Infinity;
  for (let columns = 1; columns <= Math.min(total, MAX_GRID_COLUMNS); columns += 1) {
    const rows = Math.ceil(total / columns);
    const wasted = rows * columns - total;
    const shapeError = Math.abs(Math.log((columns / rows) / ratio));
    const score = shapeError + wasted * GRID_WASTE_WEIGHT;
    if (score < bestScore - 1e-9) {
      bestScore = score;
      best = { rows, columns };
    }
  }
  return best;
}

function gridSentence(count, imageSize) {
  const { rows, columns } = chooseGrid(count, imageSize);
  const cells = rows * columns;
  const filler = cells - count;
  return `a neat aligned grid of ${rows} rows x ${columns} columns (${cells} equal-size invisible cells${filler ? `, leave ${filler} cell${filler > 1 ? "s" : ""} empty` : ""}), perfectly straight rows and columns, each asset centered in its own cell, generous empty gutters about half an asset's width, and a wide margin from every canvas edge`;
}

function systemPrompt(input, imageSize) {
  const grid = gridSentence(input.count, imageSize);
  return [
    "You are SiberSlice, an asset-sheet production agent. Finish the user's generation request by using the available tools. Do not ask follow-up questions.",
    `The user wants exactly ${input.count} distinct assets. Their visual sizes may vary, but every asset must sit clearly separated from its neighbors. Theme: ${input.theme}. Style: ${input.style}.`,
    "Image generation models cannot follow exact pixel measurements and cannot reliably count objects. Never write pixel numbers in the image prompt; describe spacing relatively (gutters about half an asset's width, wide margin from the edges). Each asset must be requested as ONE solid connected silhouette: forbid detached rain drops, sparkles, splashes, dust, floating wings, and swarms of separate creatures. Never choose an asset name that implies multiple disconnected objects (e.g. 'bat-swarm', 'splash'); use a single compact object instead (e.g. 'one-bat', 'water-drop').",
    `Required workflow: call image_gen with exactly ${input.count} descriptive assetNames in reading order, then call crop_assets. The crop tool segments the actual PNG pixels locally with connected-component analysis, groups nearby detached details, and returns one crop per requested asset. It does not call the image analyzer or use AI-generated coordinates. Ask the image model for ${grid}.`,
    `If crop_assets reports that it could not find exactly ${input.count} groups, call image_gen one more time: enforce ${grid}, simplify every asset into one solid connected silhouette, remove all detached decorative fragments, and keep the requested items and names. At most ${MAX_IMAGE_ATTEMPTS} sheets may be generated.`,
    "You may use exec for supplementary local inspection, but do not calculate or invent crop boxes with AI; the crop tool performs pixel segmentation. Keep files in the current work directory.",
    "After crop_assets succeeds, call name_asset_group exactly once. Name the complete group with a clear 2–6 word title in the same language as the user's prompt, reflecting the theme and assets. Do not use a generic title such as 'Asset Group'. Then stop.",
  ].join("\n\n");
}

function parseToolArgs(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new Error("Model mengirim argumen tool dengan JSON tidak valid.");
  }
}

function normalizeGroupName(value) {
  if (typeof value !== "string") throw new Error("Nama grup aset harus berupa teks.");
  const name = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) throw new Error("Nama grup aset tidak boleh kosong.");
  const wordCount = name.split(" ").length;
  if (wordCount < 2 || wordCount > 6) throw new Error("Nama grup aset harus terdiri dari 2 sampai 6 kata.");
  return name;
}

function normalizeAssetNames(values, count) {
  return Array.from({ length: count }, (_, index) => {
    const value = typeof values?.[index] === "string" ? values[index].trim() : "";
    return value || `asset-${String(index + 1).padStart(2, "0")}`;
  });
}

function makeImagePrompt(modelPrompt, input, assetNames, imageSize, referenceBrief) {
  const orderedNames = assetNames.map((name, index) => `${index + 1}. ${name}`).join("; ");
  let referenceNote = "";
  if (input.reference) {
    referenceNote = referenceBrief
      ? `\nAn input reference image is attached to this request. Its style is: ${referenceBrief} Reproduce THIS style faithfully across all assets unless the user's own description above explicitly asks otherwise; do not invent unrelated styles.`
      : "\nAn input reference image is attached to this request. Follow the user's own description above on how to use it.";
  }
  return `${modelPrompt}${referenceNote}\n\nSHEET REQUIREMENTS: ${input.count} distinct assets on one transparent PNG. Include one visual item for each item name in this order: ${orderedNames}. Keep their visual reading order aligned with the list. Arrangement: ${gridSentence(input.count, imageSize)}. Do not vary sizes drastically, do not rotate items, do not overlap. Never let two assets touch or merge, and keep every asset fully inside the canvas. Each asset must be a single connected silhouette: no detached dots, sparkles, rain drops, splashes, dust, floating parts, or swarms of separate objects — attach or omit every small detail. No text, labels, numbers, captions, borders, grid lines, or watermark.`;
}

async function callMainAi(messages, providerConfig, recorder, iteration, reasoningEffort, maxOutputTokens) {
  const provider = requireProvider(providerConfig, "Main AI");
  const payload = {
    model: provider.model,
    messages,
    tools,
    tool_choice: "auto",
    parallel_tool_calls: false,
    temperature: 0.2,
    reasoning_effort: reasoningEffort,
    ...(maxOutputTokens !== undefined ? { max_tokens: maxOutputTokens } : {}),
  };
  await recorder?.conversation({ provider: "mainAi", direction: "request", endpoint: "/chat/completions", iteration, payload });

  // Transient network faults (DNS blip, dropped connection, timeout) and
  // rate-limit/5xx responses must not kill a run whose heavy work (sheet +
  // crop) is already done — retry the same call with backoff before giving up.
  const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
  const maxAttempts = 3;
  let response;
  let raw;
  for (let attempt = 1; ; attempt++) {
    try {
      response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${provider.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok && RETRYABLE_STATUS.has(response.status) && attempt < maxAttempts) {
        await response.text().catch(() => "");
        await recorder?.conversation({ provider: "mainAi", direction: "retry", endpoint: "/chat/completions", iteration, attempt, status: response.status, reason: "retryable HTTP status" });
        response = undefined;
        await sleepRetry(attempt);
        continue;
      }
      break;
    } catch (error) {
      // undici wraps connection failures as TypeError("fetch failed");
      // AbortSignal.timeout raises TimeoutError. Both are transient.
      const transient = ["TimeoutError", "AbortError", "TypeError"].includes(error?.name);
      if (attempt < maxAttempts && transient) {
        await recorder?.conversation({ provider: "mainAi", direction: "retry", endpoint: "/chat/completions", iteration, attempt, reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
        await sleepRetry(attempt);
        continue;
      }
      await recorder?.conversation({
        provider: "mainAi",
        direction: "error",
        endpoint: "/chat/completions",
        iteration,
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      });
      throw new Error(`Koneksi ke AI utama gagal setelah ${attempt} percobaan: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    await recorder?.conversation({
      provider: "mainAi",
      direction: "response",
      endpoint: "/chat/completions",
      iteration,
      status: response.status,
      ok: response.ok,
      raw,
    });
    throw new Error(`Main AI mengembalikan respons bukan JSON: ${raw.slice(0, 500)}`);
  }
  await recorder?.conversation({
    provider: "mainAi",
    direction: "response",
    endpoint: "/chat/completions",
    iteration,
    status: response.status,
    ok: response.ok,
    payload: body,
  });
  if (!response.ok) {
    const detail = body?.error?.message ?? body?.message ?? raw.slice(0, 1200) ?? response.statusText;
    throw new Error(`Main AI HTTP ${response.status}: ${detail}`);
  }
  const message = body.choices?.[0]?.message;
  if (!message) throw new Error("Main AI tidak mengembalikan pesan.");
  return message;
}

export async function runAgent({
  input,
  workDir,
  onProgress,
  providers,
  imageSize,
  recorder,
  maxIterations = 50,
  reasoningEffort = "none",
  maxOutputTokens,
  referencePath = null,
}) {
  requireProvider(providers.mainAi, "Main AI");
  const iterationLimit = Number.isSafeInteger(maxIterations) && maxIterations > 0 ? maxIterations : 50;
  const effortValues = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  const mainAiEffort = effortValues.includes(reasoningEffort) ? reasoningEffort : "none";
  const mainAiTokenLimit = Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : undefined;
  const sheetGrid = chooseGrid(input.count, imageSize);

  // When a reference image is attached and a vision provider is configured,
  // "look" at it once so the (text-only) main AI and the image generator get a
  // concrete style brief derived from the actual pixels instead of guessing.
  let referenceBrief = null;
  if (input.reference && referencePath && providers.imageAnalyze?.baseUrl && providers.imageAnalyze?.apiKey && providers.imageAnalyze?.model) {
    onProgress({ phase: "reference_analysis", message: "AI melihat gambar referensi" });
    try {
      const analyzed = await analyzeImage({
        imagePath: "reference.png",
        prompt: "Gambar ini adalah referensi gaya untuk sprite sheet yang akan dibuat. Deskripsikan dalam 2-3 kalimat BAHASA INGGRIS: gaya seni (mis. pixel art, flat vector, cat air), palet warna dominan (sebutkan warna spesifik), garis/outlines, pencahayaan, dan mood. Sebutkan juga 3-5 warna hex dominan. Jangan jelaskan subjek/objeknya, fokus pada ciri gaya visual saja.",
        workDir,
        provider: providers.imageAnalyze,
        recorder,
      });
      referenceBrief = JSON.parse(analyzed).analysis ?? null;
      if (referenceBrief) referenceBrief = String(referenceBrief).replace(/\s+/g, " ").trim().slice(0, 700);
      onProgress({ phase: "reference_analyzed", message: "Gaya referensi berhasil dipelajari" });
    } catch (error) {
      // Analysis is an enhancement; generation can still proceed with the raw reference attached.
      const detail = error instanceof Error ? error.message : String(error);
      await recorder?.event({ level: "warn", type: "reference_analysis_failed", message: detail }).catch(() => {});
      onProgress({ phase: "reference_analysis_skipped", message: "Analisis referensi gagal; gambar tetap dikirim apa adanya" });
    }
  }

  const state = {
    generated: null,
    imageAttempts: 0,
    assetNames: [],
    cropIssues: [],
    crop: null,
    groupName: null,
  };
  const messages = [
    { role: "system", content: systemPrompt(input, imageSize) },
    {
      role: "user",
      content: `Prompt aset: ${input.prompt}\nTema: ${input.theme}\nGaya: ${input.style}\nJumlah: ${input.count}\nTata letak: grid rata ${sheetGrid.rows} baris x ${sheetGrid.columns} kolom dengan sel sama besar, satu aset per sel, jarak kosong lebar sekitar setengah lebar aset. Siapkan juga satu nama file deskriptif untuk setiap aset (satu objek tunggal yang menyatu, bukan gerombolan atau partikel terlepas).${input.reference ? (referenceBrief
        ? `\nPengguna melampirkan gambar referensi yang akan ikut dikirim ke image generator. Hasil pengamatan vision terhadap gambar tersebut: ${referenceBrief} Gunakan ciri gaya ini saat menyusun prompt gambar, kecuali pengguna secara eksplisit meminta hal lain. Jangan mengarang gaya yang bertentangan dengan referensi.`
        : "\nPengguna melampirkan gambar referensi yang akan ikut dikirim ke image generator bersama permintaan ini. Gambar itu hanya diteruskan apa adanya; cara pemakaiannya cukup ikuti penjelasan pengguna di prompt, jangan tambah-tambahi.") : ""}`,
    },
  ];

  for (let iteration = 1; iteration <= iterationLimit; iteration++) {
    onProgress({ phase: "agent", message: `AI mengatur langkah ${iteration}`, iteration });
    const assistant = await callMainAi(messages, providers.mainAi, recorder, iteration, mainAiEffort, mainAiTokenLimit);
    const calls = assistant.tool_calls ?? [];
    if (calls.length === 0) {
      if (state.crop?.assets?.length === input.count && state.groupName) break;
      if (state.crop?.assets?.length === input.count) throw new Error("AI selesai sebelum memberi nama grup aset.");
      if (state.cropIssues.length > 0) {
        throw new Error(`Auto-slicing belum menemukan batas aset yang valid: ${state.cropIssues.join(" ")}`);
      }
      const note = typeof assistant.content === "string" ? ` Model: ${assistant.content.slice(0, 350)}` : "";
      throw new Error(`AI selesai sebelum generate dan auto-slicing selesai.${note}`);
    }

    messages.push({
      role: "assistant",
      content: assistant.content ?? null,
      tool_calls: calls,
    });

    for (const call of calls) {
      const name = call.function?.name;
      const args = parseToolArgs(call.function?.arguments);
      onProgress({ phase: "tool_start", tool: name, message: `Menjalankan ${name}` });
      let result;
      try {
        if (name === "image_gen") {
          if (state.imageAttempts >= MAX_IMAGE_ATTEMPTS) {
            throw new Error(`Batas ${MAX_IMAGE_ATTEMPTS} percobaan generate sprite sheet sudah tercapai.`);
          }
          if (state.generated && !state.crop && state.cropIssues.length === 0) {
            throw new Error("Sheet hanya boleh dibuat ulang setelah validasi auto-slicing gagal.");
          }
          if (state.crop) throw new Error("Sheet sudah berhasil dipotong; tidak perlu membuat ulang.");
          const retryIssues = state.cropIssues;
          state.assetNames = normalizeAssetNames(args.assetNames, input.count);
          let prompt = makeImagePrompt(args.prompt ?? input.prompt, input, state.assetNames, imageSize, referenceBrief);
          if (retryIssues.length > 0) {
            prompt += `\n\nREQUIRED RETRY FIXES from local pixel segmentation: ${retryIssues.join("; ")}. Preserve the ${input.count} named assets and reading order, but redraw the sheet as a strict aligned ${sheetGrid.rows}x${sheetGrid.columns} grid of equal cells, draw every asset as ONE solid connected silhouette with no detached drops, sparkles, splashes, or separate swarm members, and keep every asset well away from the canvas borders and from each other.`;
          }
          state.imageAttempts += 1;
          state.generated = null;
          state.crop = null;
          state.groupName = null;
          state.generated = await generateImage({ prompt, workDir, provider: providers.imageGen, imageSize, recorder, referencePath: input.reference ? referencePath : null });
          state.cropIssues = [];
          result = JSON.stringify({ ...state.generated, assetNames: state.assetNames });
          onProgress({
            phase: "image_generated",
            tool: name,
            attempt: state.imageAttempts,
            maxAttempts: MAX_IMAGE_ATTEMPTS,
            message: `Sprite sheet selesai dibuat (percobaan ${state.imageAttempts}/${MAX_IMAGE_ATTEMPTS})`,
            image: state.generated,
          });
        } else if (name === "crop_assets") {
          if (!state.generated) throw new Error("Buat sprite sheet sebelum crop.");
          if (state.crop) throw new Error("Aset dari sheet ini sudah berhasil dipotong.");
          const cropped = await cropAssets({
            imagePath: state.generated.path,
            assetNames: state.assetNames,
            expectedCount: input.count,
            workDir,
          });
          if (cropped.validationError) {
            state.crop = null;
            state.cropIssues = [cropped.validationError];
            result = JSON.stringify({
              valid: false,
              retry: state.imageAttempts < MAX_IMAGE_ATTEMPTS ? "image_gen" : "stop",
              issues: state.cropIssues,
            });
            onProgress({
              phase: "crop_rejected",
              tool: name,
              valid: false,
              retry: state.imageAttempts < MAX_IMAGE_ATTEMPTS ? "image_gen" : "stop",
              message: `Auto-slicing gagal: ${cropped.validationError}`,
            });
          } else {
            state.crop = cropped;
            state.cropIssues = [];
            result = JSON.stringify(state.crop);
            onProgress({
              phase: "assets_cropped",
              tool: name,
              valid: true,
              message: `${state.crop.assets.length} aset lolos validasi crop`,
            });
          }
        } else if (name === "name_asset_group") {
          if (!state.crop || state.crop.assets.length !== input.count) {
            throw new Error("Seluruh aset harus selesai di-crop sebelum grup diberi nama.");
          }
          if (state.groupName) throw new Error("Nama grup aset sudah dibuat.");
          state.groupName = normalizeGroupName(args.name);
          result = JSON.stringify({ groupName: state.groupName });
          onProgress({ phase: "asset_group_named", tool: name, message: `Grup aset: ${state.groupName}` });
        } else if (name === "exec") {
          result = await executeShell({ command: args.command, workDir });
        } else {
          throw new Error(`Tool tidak dikenal: ${name || "(kosong)"}`);
        }
      } catch (error) {
        result = `Error: ${error instanceof Error ? error.message : String(error)}`;
        if (name === "crop_assets") {
          state.crop = null;
          state.cropIssues = [error instanceof Error ? error.message : String(error)];
        }
        await recorder?.event({
          level: "error",
          type: "tool_failed",
          tool: name,
          arguments: args,
          error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
        });
        onProgress({ phase: "tool_error", tool: name, message: result });
      }

      messages.push({ role: "tool", tool_call_id: call.id, content: String(result) });
      onProgress({
        phase: "tool_done",
        tool: name,
        valid: name === "crop_assets" ? Boolean(state.crop) : undefined,
        message: `${name} selesai`,
      });
    }

    if (state.crop?.assets?.length === input.count && state.groupName) break;
    if (state.cropIssues.length > 0 && state.imageAttempts >= MAX_IMAGE_ATTEMPTS) {
      throw new Error(`Auto-slicing gagal setelah ${MAX_IMAGE_ATTEMPTS} percobaan: ${state.cropIssues.join(" ")}`);
    }
  }

  if (!state.generated) throw new Error("AI tidak memanggil tool image_gen.");
  if (!state.crop || state.crop.assets.length !== input.count) {
    if (state.cropIssues.length > 0) throw new Error(`Auto-slicing belum berhasil: ${state.cropIssues.join(" ")}`);
    throw new Error(`AI belum berhasil melakukan auto-slicing tepat ${input.count} aset dalam ${iterationLimit} iterasi.`);
  }
  if (!state.groupName) throw new Error("AI belum memberi nama grup aset.");
  return {
    layout: `${sheetGrid.rows}x${sheetGrid.columns}`,
    image: state.generated,
    crop: state.crop,
    groupName: state.groupName,
  };
}
