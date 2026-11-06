import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function loadDotEnv(path = resolve(projectRoot, ".env")) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const splitAt = trimmed.indexOf("=");
    if (splitAt < 1) continue;
    const key = trimmed.slice(0, splitAt).trim();
    let value = trimmed.slice(splitAt + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function readProvider(prefix) {
  return {
    baseUrl: (process.env[`${prefix}_BASE_URL`] ?? "").trim().replace(/\/+$/, ""),
    apiKey: (process.env[`${prefix}_API_KEY`] ?? "").trim(),
    model: (process.env[`${prefix}_MODEL`] ?? "").trim(),
  };
}

function positiveIntegerFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function optionalPositiveIntegerFromEnv(name) {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function booleanFromEnv(name, fallback) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function readS3Config() {
  const bucket = (process.env.SIBERSLICE_S3_BUCKET ?? "").trim();
  const accessKey = (process.env.SIBERSLICE_S3_ACCESS_KEY ?? "").trim();
  const secretKey = (process.env.SIBERSLICE_S3_SECRET_KEY ?? "").trim();
  return {
    bucket,
    accessKey,
    secretKey,
    region: (process.env.SIBERSLICE_S3_REGION ?? "us-east-1").trim(),
    endpoint: (process.env.SIBERSLICE_S3_ENDPOINT ?? "").trim().replace(/\/+$/, ""),
    forcePathStyle: booleanFromEnv("SIBERSLICE_S3_FORCE_PATH_STYLE", true),
    prefix: (process.env.SIBERSLICE_S3_PREFIX ?? "runs").trim().replace(/^\/+|\/+$/g, "") || "runs",
    purgeLocal: booleanFromEnv("SIBERSLICE_S3_PURGE_LOCAL", false),
    presignTtlSeconds: optionalPositiveIntegerFromEnv("SIBERSLICE_S3_PRESIGN_TTL") ?? 900,
    publicBaseUrl: (process.env.SIBERSLICE_S3_PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, ""),
  };
}

function reasoningEffortFromEnv(name) {
  const value = (process.env[name] ?? "none").trim().toLowerCase();
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value) ? value : "none";
}

export const config = {
  port: Math.max(1, Number.parseInt(process.env.SIBERSLICE_PORT ?? "8200", 10) || 8200),
  dataDir: resolve(projectRoot, process.env.SIBERSLICE_DATA_DIR ?? "./data"),
  adminPassword: process.env.SIBERSLICE_ADMIN_PASSWORD ?? "",
  imageSize: (process.env.SIBERSLICE_IMAGE_GEN_SIZE ?? "1536x1024").trim(),
  maxIterations: positiveIntegerFromEnv("SIBERSLICE_MAX_ITERATIONS", 50),
  mainAiReasoningEffort: reasoningEffortFromEnv("SIBERSLICE_MAIN_AI_REASONING_EFFORT"),
  mainAiMaxOutputTokens: optionalPositiveIntegerFromEnv("SIBERSLICE_MAIN_AI_MAX_OUTPUT_TOKENS"),
  mainAi: readProvider("SIBERSLICE_MAIN_AI"),
  imageGen: readProvider("SIBERSLICE_IMAGE_GEN"),
  imageAnalyze: readProvider("SIBERSLICE_IMAGE_ANALYZE"),
  s3: readS3Config(),
};

export function s3Configured() {
  const s3 = config.s3;
  return Boolean(s3.bucket && s3.accessKey && s3.secretKey);
}

export function providerStatus(provider) {
  return Boolean(provider.baseUrl && provider.apiKey && provider.model);
}

export function publicConfig() {
  return {
    providers: {
      mainAi: providerStatus(config.mainAi),
      imageGen: providerStatus(config.imageGen),
      imageAnalyze: providerStatus(config.imageAnalyze),
    },
    ready: providerStatus(config.mainAi) && providerStatus(config.imageGen),
    models: {
      mainAi: config.mainAi.model || null,
      imageGen: config.imageGen.model || null,
      imageAnalyze: config.imageAnalyze.model || null,
    },
  };
}
