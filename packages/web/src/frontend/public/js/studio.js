const themeNames = {
  general: "General / Umum", fantasy: "Fantasy", scifi: "Sci‑Fi", nature: "Alam",
  food: "Makanan", ui: "UI Icon", retro: "Retro Arcade", horror: "Horror",
  medical: "Medical", sports: "Sports", music: "Music", ocean: "Ocean",
  kids: "Kids / Toy", business: "Business", space: "Space",
};
const themeIcons = {
  general: "✦", fantasy: "⚔", scifi: "◎", nature: "❧", food: "◍", ui: "▦",
  retro: "▣", horror: "☠", medical: "✚", sports: "▲", music: "♪", ocean: "≈",
  kids: "✿", business: "◧", space: "✦",
};

let sessionId = "";
let currentResult = null;
let providerReady = false;
let sessionReady = false;
let sessionUsed = false;
let actionSequence = 0;
let toastTimer;

const byId = (id) => document.getElementById(id);
const range = byId("range");
const countLabel = byId("countNum");
const generateButton = byId("genBtn");
const loading = byId("loading");
const progressBar = byId("bar");
const phaseLabel = byId("phase");
const assetPreviewOverlay = byId("assetPreviewOverlay");
let lastAssetPreviewTrigger = null;

for (const [id, name] of Object.entries(themeNames)) {
  const option = document.createElement("option");
  option.value = id;
  option.textContent = `${themeIcons[id]}  ${name}`;
  byId("themes").append(option);
}

const themeToggle = byId("themeToggle");
const themeSettings = byId("themeSettings");
themeToggle.addEventListener("click", () => {
  const expanded = themeToggle.getAttribute("aria-expanded") === "true";
  themeToggle.setAttribute("aria-expanded", String(!expanded));
  themeSettings.hidden = expanded;
});

const refToggle = byId("refToggle");
const refSettings = byId("refSettings");
refToggle.addEventListener("click", () => {
  const expanded = refToggle.getAttribute("aria-expanded") === "true";
  refToggle.setAttribute("aria-expanded", String(!expanded));
  refSettings.hidden = expanded;
});

function setCount(value) {
  const evenValue = Math.round((Number(value) || 4) / 2) * 2;
  const count = Math.max(4, Math.min(50, evenValue));
  range.value = String(count);
  countLabel.textContent = String(count);
}

/* ---- reference image (single image, image-to-image mode) ---- */
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const REFERENCE_TYPES = ["image/png", "image/jpeg", "image/webp"];
let referenceDataUrl = null;

function setReferenceFromFile(file) {
  if (!file) return;
  if (!REFERENCE_TYPES.includes(file.type)) {
    toast("Gambar referensi harus berformat PNG, JPG, atau WebP.");
    return;
  }
  if (file.size > MAX_REFERENCE_BYTES) {
    toast("Ukuran gambar referensi maksimal 8 MB.");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    referenceDataUrl = String(reader.result);
    byId("refImage").src = referenceDataUrl;
    byId("refName").textContent = `${file.name || "referensi.png"} · ${file.size < 1024 ? `${file.size} B` : `${(file.size / 1024).toFixed(0)} KB`}`;
    byId("refEmpty").hidden = true;
    byId("refPreview").hidden = false;
  };
  reader.onerror = () => toast("Gagal membaca gambar referensi.");
  reader.readAsDataURL(file);
}

function clearReference() {
  referenceDataUrl = null;
  byId("refInput").value = "";
  byId("refImage").removeAttribute("src");
  byId("refName").textContent = "";
  byId("refEmpty").hidden = false;
  byId("refPreview").hidden = true;
}

(() => {
  const drop = byId("refDrop");
  if (!drop) return;
  const input = byId("refInput");
  drop.addEventListener("click", (event) => {
    if (event.target.closest(".ref-remove")) return;
    input.click();
  });
  drop.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); input.click(); }
  });
  input.addEventListener("change", () => setReferenceFromFile(input.files[0]));
  for (const type of ["dragover", "dragenter"]) drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.add("dragging"); });
  for (const type of ["dragleave", "drop"]) drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.remove("dragging"); });
  drop.addEventListener("drop", (event) => {
    const file = [...(event.dataTransfer?.files ?? [])].find((f) => REFERENCE_TYPES.includes(f.type)) ?? event.dataTransfer?.files?.[0];
    setReferenceFromFile(file);
  });
  byId("refRemove").addEventListener("click", (event) => { event.stopPropagation(); clearReference(); });
  document.addEventListener("paste", (event) => {
    const file = [...(event.clipboardData?.files ?? [])].find((f) => REFERENCE_TYPES.includes(f.type));
    if (!file) return;
    event.preventDefault();
    setReferenceFromFile(file);
  });
})();

function selectView(view) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("on", tab.dataset.view === view));
  const showWorkspace = Boolean(currentResult) || loading.classList.contains("show");
  byId("viewSheet").classList.toggle("on", showWorkspace && view === "sheet");
  byId("viewAssets").classList.toggle("on", showWorkspace && view === "assets");
}

function setProviderStatus(status) {
  const configured = [status.providers.mainAi, status.providers.imageGen].filter(Boolean).length;
  providerReady = status.ready;
  const led = byId("configLed");
  led.classList.toggle("offline", !providerReady);
  byId("configLabel").textContent = `${configured}/2`;
  byId("configLabel").title = providerReady
    ? "AI utama dan image generation siap; slicing memakai pemrosesan piksel lokal"
    : "Lengkapi konfigurasi AI utama dan image generation di file .env lalu jalankan ulang server";
  generateButton.disabled = !providerReady || !sessionReady;
  if (!providerReady) phaseLabel.textContent = "Lengkapi konfigurasi provider di .env";
}

async function loadProviderStatus() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error("Status provider tidak tersedia");
    setProviderStatus(await response.json());
  } catch {
    byId("configLabel").textContent = "OFFLINE";
    byId("configLed").classList.add("offline");
    generateButton.disabled = true;
  }
}

async function createSession() {
  const response = await fetch("/api/sessions", { method: "POST" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Session baru gagal dibuat.");
  sessionId = body.id;
  sessionReady = true;
  sessionUsed = false;
  return body;
}

function resetStudio() {
  currentResult = null;
  byId("emptyState").style.display = "flex";
  byId("sheetImage").hidden = true;
  byId("sheetImage").removeAttribute("src");
  byId("assetsGrid").replaceChildren();
  byId("assetGroupName").textContent = "Kumpulan Aset";
  byId("assetGroupMeta").textContent = "";
  closeAssetPreview(false);
  byId("tabSheet").textContent = "";
  byId("tabAssets").textContent = "";
  byId("mGrid").textContent = "—";
  byId("mDim").textContent = "—";
  byId("mTile").textContent = "—";
  byId("dlSheet").disabled = true;
  byId("dlAll").disabled = true;
  byId("projName").textContent = sessionId ? `session ${sessionId.slice(0, 8)}` : "untitled sheet";
  selectView("sheet");
}

function openAssetPreview(asset, result, trigger) {
  lastAssetPreviewTrigger = trigger;
  const name = asset.label || asset.name.replace(/\.png$/i, "");
  byId("assetPreviewTitle").textContent = name;
  byId("assetPreviewMeta").textContent = `${asset.name} · ${asset.width || "?"}×${asset.height || "?"} px`;
  const image = byId("assetPreviewImage");
  image.src = `${asset.url}?v=${encodeURIComponent(result.runId)}`;
  image.alt = name;
  const download = byId("assetPreviewDownload");
  download.href = `${asset.url}?download=1`;
  download.download = asset.name;
  assetPreviewOverlay.classList.add("open");
  assetPreviewOverlay.setAttribute("aria-hidden", "false");
  byId("assetPreviewClose").focus();
}

function closeAssetPreview(restoreFocus = true) {
  if (!assetPreviewOverlay.classList.contains("open")) return;
  assetPreviewOverlay.classList.remove("open");
  assetPreviewOverlay.setAttribute("aria-hidden", "true");
  byId("assetPreviewImage").removeAttribute("src");
  if (restoreFocus) lastAssetPreviewTrigger?.focus();
  lastAssetPreviewTrigger = null;
}

byId("assetPreviewClose").addEventListener("click", () => closeAssetPreview());
assetPreviewOverlay.addEventListener("click", (event) => {
  if (event.target === assetPreviewOverlay) closeAssetPreview();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && assetPreviewOverlay.classList.contains("open")) closeAssetPreview();
});

function renderResult(result) {
  currentResult = result;
  if (result.prompt) byId("prompt").value = result.prompt;
  if (result.count) setCount(result.count);
  if (result.theme && themeNames[result.theme]) byId("themes").value = result.theme;
  if (result.style) byId("style").value = result.style;
  byId("emptyState").style.display = "none";

  byId("assetGroupName").textContent = result.groupName || "Kumpulan Aset";
  byId("assetGroupMeta").textContent = `${result.assets.length} aset · ${themeNames[result.theme] || result.theme || "General"} · ${result.style || "general"}`;
  const storageBadge = byId("storageBadge");
  if (storageBadge) {
    storageBadge.hidden = false;
    storageBadge.textContent = result.storage === "s3" ? "S3" : "LOCAL";
    storageBadge.className = `storage-badge ${result.storage === "s3" ? "is-s3" : "is-local"}`;
    storageBadge.title = result.storage === "s3" ? "Disimpan di cloud (S3)" : "Disimpan di server lokal";
  }

  const sheet = byId("sheetImage");
  sheet.src = result.sheetPublicUrl || `${result.sheetUrl}?v=${encodeURIComponent(result.runId)}`;
  sheet.hidden = false;
  byId("projName").textContent = (result.groupName || result.prompt || "sprite sheet").slice(0, 28);
  byId("mGrid").textContent = result.layout || "Flexible";
  byId("mDim").textContent = `${result.width}×${result.height}`;
  byId("mTile").textContent = `${result.assets.length} PNG`;
  byId("tabSheet").textContent = `${result.assets.length} assets`;
  byId("tabAssets").textContent = String(result.assets.length);

  const grid = byId("assetsGrid");
  grid.replaceChildren();
  for (const asset of result.assets) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "tile";
    const assetName = asset.label || asset.name.replace(/\.png$/i, "");
    tile.setAttribute("aria-label", `Preview ${assetName}`);
    tile.title = asset.label || asset.name;
    tile.addEventListener("click", () => openAssetPreview(asset, result, tile));
    const image = document.createElement("img");
    image.src = asset.publicUrl || `${asset.url}?v=${encodeURIComponent(result.runId)}`;
    image.alt = asset.label || asset.name;
    const index = document.createElement("div");
    index.className = "idx";
    index.textContent = String(asset.index).padStart(2, "0");
    const download = document.createElement("div");
    download.className = "go";
    download.textContent = "PREVIEW ↗";
    const label = document.createElement("div");
    label.className = "asset-name";
    label.textContent = asset.label || asset.name.replace(/\.png$/i, "");
    tile.append(image, index, label, download);
    grid.append(tile);
  }
  byId("dlSheet").disabled = false;
  byId("dlAll").disabled = false;
  selectView("assets");
}

function toast(message) {
  byId("toastTxt").textContent = message;
  const element = byId("toast");
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 3200);
}

function progress(event) {
  const phases = {
    agent: [8, "AI menyusun langkah"],
    image_gen_start: [20, "Membuat sprite sheet transparan"],
    crop_assets_start: [72, "Mendeteksi komponen dan memotong aset lokal"],
    exec: [40, "Menjalankan tool shell"],
    image_gen: [45, "Sprite sheet selesai dibuat"],
    crop_assets: [93, "PNG aset lolos validasi"],
    name_asset_group_start: [97, "Menamai grup aset"],
    name_asset_group: [100, "Nama grup aset selesai"],
    image_generated: [45, "Sprite sheet selesai dibuat"],
    assets_cropped: [93, "PNG aset lolos validasi"],
  };
  let current = null;
  if (event.phase === "crop_rejected") {
    progressBar.style.width = "55%";
    phaseLabel.textContent = event.message || "Deteksi komponen perlu dicoba ulang";
    return;
  }
  if (event.phase === "tool_done" && event.tool === "crop_assets") {
    progressBar.style.width = `${event.valid ? 93 : 55}%`;
    phaseLabel.textContent = event.valid ? "PNG aset lolos validasi" : "Deteksi komponen perlu diperbaiki";
    return;
  }
  if (event.phase === "tool_start") current = phases[`${event.tool}_start`];
  if (event.phase === "tool_done") current = phases[event.tool];
  if (event.phase === "agent") current = phases.agent;
  if (event.phase === "image_generated") current = phases.image_generated;
  if (event.phase === "assets_cropped") current = phases.assets_cropped;
  if (event.phase === "asset_group_named") current = phases.name_asset_group;
  if (event.phase === "tool_error") {
    phaseLabel.textContent = event.message || "Tool mengalami kendala";
    return;
  }
  if (current) {
    progressBar.style.width = `${current[0]}%`;
    phaseLabel.textContent = current[1];
  } else if (event.message) {
    phaseLabel.textContent = event.message;
  }
}

async function readEvents(response, onComplete) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = null;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let boundary;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, boundary);
      const matchLength = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0].length ?? 2;
      buffer = buffer.slice(boundary + matchLength);
      const lines = block.split(/\r?\n/);
      const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
      const dataLine = lines.find((line) => line.startsWith("data:"));
      if (!eventName || !dataLine) continue;
      const data = JSON.parse(dataLine.slice(5).trim());
      if (eventName === "progress") progress(data);
      else if (eventName === "error") throw new Error(data.message || "Proses generate gagal.");
      else if (eventName === "complete") {
        completed = data;
        onComplete(data);
      }
    }
    if (done) break;
  }
  if (!completed) throw new Error("Koneksi proses generate terputus sebelum selesai.");
  return completed;
}

generateButton.onclick = async () => {
  if (!providerReady || !sessionReady) {
    toast("Lengkapi tiga konfigurasi provider di .env terlebih dahulu.");
    return;
  }
  const prompt = byId("prompt").value.trim();
  if (!prompt) {
    byId("prompt").focus();
    toast("Tulis deskripsi aset yang ingin dibuat.");
    return;
  }
  const currentAction = ++actionSequence;
  const count = Math.max(4, Math.min(50, Number(countLabel.textContent)));
  const theme = byId("themes").value;
  const style = byId("style").value;
  generateButton.disabled = true;
  byId("newSession").disabled = true;
  byId("dlSheet").disabled = true;
  byId("dlAll").disabled = true;
  byId("emptyState").style.display = "none";
  loading.classList.add("show");
  progressBar.style.width = "3%";
  phaseLabel.textContent = "Mengirim satu prompt untuk sesi ini";
  selectView("sheet");
  try {
    if (sessionUsed) {
      phaseLabel.textContent = "Membuat session baru";
      await createSession();
      if (currentAction !== actionSequence) return;
      resetStudio();
      byId("emptyState").style.display = "none";
      selectView("sheet");
    }
    sessionUsed = true;
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt,
        theme,
        style,
        count,
        reference: referenceDataUrl ?? undefined,
      }),
    });
    if (currentAction !== actionSequence) return;
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Server mengembalikan HTTP ${response.status}.`);
    }
    const result = await readEvents(response, renderResult);
    if (currentAction === actionSequence) {
      progressBar.style.width = "100%";
      toast(`${result.groupName || "Grup aset"} · ${result.assets.length} aset siap diunduh.`);
    }
  } catch (error) {
    if (currentAction === actionSequence) {
      byId("emptyState").style.display = currentResult ? "none" : "flex";
      toast(error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (currentAction === actionSequence) {
      loading.classList.remove("show");
      if (!currentResult) selectView("sheet");
      generateButton.disabled = !providerReady || !sessionReady;
      byId("newSession").disabled = false;
      if (currentResult) {
        byId("dlSheet").disabled = false;
        byId("dlAll").disabled = false;
      }
    }
  }
};

byId("minus").onclick = () => setCount(Number(range.value) - 2);
byId("plus").onclick = () => setCount(Number(range.value) + 2);
range.oninput = () => setCount(range.value);
document.querySelectorAll(".quick-btn").forEach((button) => {
  button.onclick = () => {
    byId("prompt").value = button.dataset.prompt;
    byId("themes").value = button.dataset.theme;
    byId("style").value = button.dataset.style;
    byId("prompt").focus();
  };
});
document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => selectView(tab.dataset.view);
});

byId("dlSheet").onclick = () => {
  if (!currentResult) return;
  const link = document.createElement("a");
  link.href = `${currentResult.sheetUrl}?download=1`;
  link.download = "sprite-sheet.png";
  link.click();
};
byId("dlAll").onclick = () => {
  if (currentResult) window.location.assign(currentResult.exportUrl);
};

byId("newSession").onclick = async () => {
  const currentAction = ++actionSequence;
  sessionReady = false;
  byId("newSession").disabled = true;
  generateButton.disabled = true;
  try {
    await createSession();
    if (currentAction !== actionSequence) return;
    byId("prompt").value = "";
    setCount(12);
    byId("themes").value = "general";
    byId("style").value = "general";
    resetStudio();
    generateButton.disabled = !providerReady || !sessionReady;
    toast("Session baru siap.");
  } catch (error) {
    sessionReady = Boolean(sessionId);
    generateButton.disabled = !providerReady || !sessionReady;
    toast(error instanceof Error ? error.message : String(error));
  } finally {
    byId("newSession").disabled = false;
  }
};

async function initialize() {
  setCount(range.value);
  loadProviderStatus();
  try { localStorage.removeItem("siberslice-session-id"); } catch {}
  await createSession();
  resetStudio();
  generateButton.disabled = !providerReady || !sessionReady;
}

initialize().catch((error) => {
  toast(error instanceof Error ? error.message : "SiberSlice gagal memulai.");
});
