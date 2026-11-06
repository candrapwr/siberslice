import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runAgent } from "@siberslice/core/agent";
import { requireProvider } from "@siberslice/core/providers";
import { config, s3Configured } from "../../config/env.js";
import { readJsonBody, sendError, sendEvent } from "../http.js";
import { claimSession, isSessionBusy, readSession, releaseSession, writeSession, sessionIdPattern } from "../session-store.js";
import { createRunRecorder } from "../run-recorder.js";
import { recordServerError } from "../server-log.js";
import { runKeyPrefix, uploadRun } from "../s3-store.js";

function validateGeneration(body) {
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  const count = Number(body?.count);
  if (!prompt) throw new Error("Prompt aset wajib diisi.");
  if (prompt.length > 4000) throw new Error("Prompt maksimal 4.000 karakter.");
  if (!Number.isInteger(count) || count < 4 || count > 50 || count % 2 !== 0) throw new Error("Jumlah aset harus bilangan genap dari 4 sampai 50.");
  return {
    prompt,
    count,
    theme: String(body.theme ?? "general").trim().slice(0, 80) || "general",
    style: String(body.style ?? "general").trim().slice(0, 80) || "general",
  };
}

export async function handleGenerate(req, res, id) {
  if (!sessionIdPattern.test(id)) return sendError(res, 400, "Session ID tidak valid.");
  const existingSession = await readSession(id);
  if (!existingSession) return sendError(res, 404, "Session tidak ditemukan.");
  if (isSessionBusy(id)) return sendError(res, 409, "Session ini sedang menjalankan proses lain.");

  let input;
  try {
    input = validateGeneration(await readJsonBody(req));
    requireProvider(config.mainAi, "Main AI");
    requireProvider(config.imageGen, "Image generation");
  } catch (error) {
    await recordServerError({ level: "warn", type: "generation_rejected", sessionId: id, message: error instanceof Error ? error.message : String(error) });
    return sendError(res, 400, error instanceof Error ? error.message : String(error));
  }

  if (!claimSession(id)) return sendError(res, 409, "Session ini sedang menjalankan proses lain.");
  let session;
  try {
    session = await readSession(id);
  } catch (error) {
    releaseSession(id);
    throw error;
  }
  if (!session) {
    releaseSession(id);
    return sendError(res, 404, "Session tidak ditemukan.");
  }
  const runId = randomUUID();
  const runDir = join(session.folder, "runs", runId);
  let recorder;
  try {
    await mkdir(runDir, { recursive: true });
    recorder = await createRunRecorder(runDir);
    await recorder.event({
      level: "info",
      type: "run_started",
      maxIterations: config.maxIterations,
      reasoningEffort: config.mainAiReasoningEffort,
      maxOutputTokens: config.mainAiMaxOutputTokens,
      input: { prompt: input.prompt, theme: input.theme, style: input.style, count: input.count },
    });
  } catch (error) {
    releaseSession(id);
    throw error;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();
  sendEvent(res, "started", { sessionId: id, runId });
  const keepAlive = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(": keepalive\n\n");
  }, 15_000);

  try {
    const result = await runAgent({
      input,
      workDir: runDir,
      providers: {
        mainAi: config.mainAi,
        imageGen: config.imageGen,
      },
      imageSize: config.imageSize,
      maxIterations: config.maxIterations,
      reasoningEffort: config.mainAiReasoningEffort,
      maxOutputTokens: config.mainAiMaxOutputTokens,
      recorder,
      onProgress: (event) => {
        recorder.event({ level: event.phase === "tool_error" ? "error" : "info", type: "progress", detail: event }).catch(() => {});
        sendEvent(res, "progress", event);
      },
    });
    const base = `/api/sessions/${id}`;
    const sheetPath = result.crop.sheetPreviewPath || "sheet.png";
    const deliverables = [
      ...new Set(["sheet.png", "sheet-transparent.png", "assets.zip", sheetPath]),
      ...result.crop.assets.map((asset) => `assets/${asset.name}`),
    ];

    let s3Manifest = null;
    if (s3Configured()) {
      try {
        s3Manifest = await uploadRun({ sessionId: id, runId, runDir, files: deliverables });
        s3Manifest.prefix = runKeyPrefix(id, runId);
        if (config.s3.purgeLocal) {
          await Promise.all([
            rm(join(runDir, "sheet.png"), { force: true }),
            rm(join(runDir, "sheet-transparent.png"), { force: true }),
            rm(join(runDir, "assets.zip"), { force: true }),
            rm(join(runDir, "assets"), { recursive: true, force: true }),
          ]);
        }
      } catch (uploadError) {
        const detail = uploadError instanceof Error ? uploadError.message : String(uploadError);
        throw new Error(`Hasil generate gagal diunggah ke S3: ${detail}`);
      }
    }

    const output = {
      sessionId: id,
      runId,
      createdAt: new Date().toISOString(),
      groupName: result.groupName,
      prompt: input.prompt,
      theme: input.theme,
      style: input.style,
      count: input.count,
      layout: result.layout,
      width: result.image.width,
      height: result.image.height,
      storage: s3Manifest ? "s3" : "local",
      sheetUrl: `${base}/files/runs/${runId}/${sheetPath}`,
      exportUrl: `${base}/runs/${runId}/export`,
      assets: result.crop.assets.map((asset) => ({
        index: asset.index,
        name: asset.name,
        label: asset.label,
        width: asset.width,
        height: asset.height,
        url: `${base}/files/runs/${runId}/assets/${encodeURIComponent(asset.name)}`,
      })),
    };
    session.value.runs ??= [];
    session.value.runs.push({
      runId,
      createdAt: output.createdAt,
      status: "complete",
      groupName: output.groupName,
      prompt: input.prompt,
      theme: input.theme,
      style: input.style,
      count: input.count,
      ...(s3Manifest ? { s3: s3Manifest } : {}),
      assets: output.assets.map(({ index, name, label, width, height }) => ({ index, name, label, width, height })),
    });
    session.value.lastResult = output;
    await recorder.event({ level: "info", type: "run_completed", groupName: output.groupName, assetCount: output.assets.length });
    await recorder.flush();
    await writeSession(session.folder, session.value);
    sendEvent(res, "complete", output);
    res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordServerError({
      level: "error",
      type: "generation_failed",
      sessionId: id,
      runId,
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    try {
      await recorder.event({ level: "error", type: "run_failed", message, stack: error instanceof Error ? error.stack : undefined });
      await recorder.flush();
    } catch (logError) {
      console.error("SiberSlice gagal menulis log proses:", logError);
    }
    session.value.runs ??= [];
    session.value.runs.push({ runId, createdAt: new Date().toISOString(), prompt: input.prompt, count: input.count, status: "failed", error: message });
    try { await writeSession(session.folder, session.value); } catch { /* preserve the original generation error */ }
    sendEvent(res, "error", { message });
    res.end();
  } finally {
    clearInterval(keepAlive);
    releaseSession(id);
  }
}
