import { requireProvider } from "../providers/compatibility.js";
import { executeShell } from "../tools/cli/exec.js";
import { cropAssets, generateImage } from "../tools/image/index.js";

const MAX_IMAGE_ATTEMPTS = 2;

const tools = [
  {
  "type": "function",
  "function": {
    "name": "image_gen",
    "description": "Generate one transparent PNG sprite sheet. CRITICAL RULES: 1) Pure transparent background only. 2) Every asset must be fully isolated. 3) Minimum 64 pixels of transparent space between any two assets. 4) Minimum 80 pixels of transparent padding from all four edges of the canvas. 5) No asset pixel may touch another asset or the canvas border. 6) Arrange in clear left-to-right, top-to-bottom reading order. Fail the generation if these spacing rules are violated.",
    "parameters": {
      "type": "object",
      "properties": {
        "prompt": {
          "type": "string",
          "description": "Must explicitly enforce: pure transparent background, minimum 64px gap between every asset, minimum 80px padding from all edges, no touching between assets or edges."
        },
        "assetNames": {
          "type": "array",
          "description": "Exactly one short descriptive kebab-case filename per asset, in visual reading order (left-to-right, top-to-bottom).",
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

function systemPrompt(input) {
  return [
    "You are SiberSlice, an asset-sheet production agent. Finish the user's generation request by using the available tools. Do not ask follow-up questions.",
    `The user wants exactly ${input.count} distinct assets. Their visual sizes and positions may vary; arrange them as a well-spaced, readable sheet without fixed-size cells. Theme: ${input.theme}. Style: ${input.style}.`,
    `Required workflow: call image_gen with exactly ${input.count} descriptive assetNames in reading order, then call crop_assets. The crop tool segments the actual PNG pixels locally with connected-component analysis, groups nearby detached details, and returns one crop per requested asset. It does not call the image analyzer or use AI-generated coordinates.`,
    `If crop_assets reports that it could not find exactly ${input.count} groups, call image_gen one more time with clearer gaps and fewer detached decorative particles, preserving the requested items and names. At most ${MAX_IMAGE_ATTEMPTS} sheets may be generated.`,
    "Ask the image model for visually isolated assets with generous transparent gaps, but allow different sizes and irregular rows. Do not ask for an equal-cell grid. You may use exec for supplementary local inspection, but do not calculate or invent crop boxes with AI; the crop tool performs pixel segmentation. Keep files in the current work directory.",
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

function makeImagePrompt(modelPrompt, input, assetNames) {
  const orderedNames = assetNames.map((name, index) => `${index + 1}. ${name}`).join("; ");
  return `${modelPrompt}\n\nSHEET REQUIREMENTS: exactly ${input.count} distinct assets on one transparent PNG. Include one visual item for each item name in this order: ${orderedNames}. Keep their visual reading order aligned with the list. Arrange them in a balanced, easy-to-scan composition; loose, irregular rows and different natural object sizes are welcome. Do not force equal-size cells. Leave clear transparent gaps between every complete object, including outlines, shadows, glows, and attached particles; keep detached decorative fragments close to their object. Keep all artwork inside the canvas. No text, labels, numbers, captions, borders, grid lines, or watermark.`;
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

  let response;
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
  } catch (error) {
    await recorder?.conversation({
      provider: "mainAi",
      direction: "error",
      endpoint: "/chat/completions",
      iteration,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    });
    throw error;
  }
  const raw = await response.text();
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
}) {
  requireProvider(providers.mainAi, "Main AI");
  const iterationLimit = Number.isSafeInteger(maxIterations) && maxIterations > 0 ? maxIterations : 50;
  const effortValues = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  const mainAiEffort = effortValues.includes(reasoningEffort) ? reasoningEffort : "none";
  const mainAiTokenLimit = Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : undefined;
  const state = {
    generated: null,
    imageAttempts: 0,
    assetNames: [],
    cropIssues: [],
    crop: null,
    groupName: null,
  };
  const messages = [
    { role: "system", content: systemPrompt(input) },
    {
      role: "user",
      content: `Prompt aset: ${input.prompt}\nTema: ${input.theme}\nGaya: ${input.style}\nJumlah: ${input.count}\nTata letak: fleksibel, ukuran tiap aset boleh berbeda, beri jarak yang cukup. Siapkan juga satu nama file deskriptif untuk setiap aset.`,
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
          let prompt = makeImagePrompt(args.prompt ?? input.prompt, input, state.assetNames);
          if (retryIssues.length > 0) {
            prompt += `\n\nREQUIRED RETRY FIXES from local pixel segmentation: ${retryIssues.join("; ")}. Preserve exactly ${input.count} named assets, separate each silhouette clearly, and keep detached decoration close to its parent asset.`;
          }
          state.imageAttempts += 1;
          state.generated = null;
          state.crop = null;
          state.groupName = null;
          state.generated = await generateImage({ prompt, workDir, provider: providers.imageGen, imageSize, recorder });
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
  return { layout: "Flexible", image: state.generated, crop: state.crop, groupName: state.groupName };
}
