const byId = (id) => document.getElementById(id);

const state = {
  tab: "dashboard",
  sessions: [],
  filter: "all",
  sort: "newest",
  visible: 12,
  selectedId: null,
  detail: null,
  logsLoaded: false,
  systemLoaded: false,
  overviewLoaded: false,
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatRelative(value) {
  const time = Date.parse(value ?? "");
  if (Number.isNaN(time)) return "—";
  const seconds = Math.round((Date.now() - time) / 1000);
  if (seconds < 60) return "baru saja";
  const units = [["menit", 60], ["jam", 3600], ["hari", 86400]];
  let label = "bulan", divisor = 2592000;
  for (const [name, unitSeconds] of units) {
    if (seconds < unitSeconds * 60) { label = name; divisor = unitSeconds; break; }
  }
  return `${Math.max(1, Math.round(seconds / divisor))} ${label} lalu`;
}

function showToast(message, isError = false) {
  const toast = byId("adminToast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 4200);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) throw new Error(body.error || `Request gagal (${response.status}).`);
  return body;
}

/* ---------- confirm modal ---------- */

let confirmResolve = null;
function confirmDialog({ title, body, okLabel = "Ya, lanjutkan", danger = true }) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    byId("confirmTitle").textContent = title;
    byId("confirmBody").textContent = body;
    const ok = byId("confirmOk");
    ok.textContent = okLabel;
    ok.classList.toggle("btn-danger", danger);
    ok.classList.toggle("btn-primary", !danger);
    byId("confirmModal").hidden = false;
  });
}
function closeConfirm(result) {
  byId("confirmModal").hidden = true;
  if (confirmResolve) { confirmResolve(result); confirmResolve = null; }
}
byId("confirmOk").addEventListener("click", () => closeConfirm(true));
byId("confirmCancel").addEventListener("click", () => closeConfirm(false));
byId("confirmModal").addEventListener("click", (event) => { if (event.target === byId("confirmModal")) closeConfirm(false); });

/* ---------- lightbox ---------- */

function openLightbox(src, caption) {
  byId("lightboxImage").src = src;
  byId("lightboxCaption").textContent = caption ?? "";
  byId("lightbox").hidden = false;
}
function closeLightbox() { byId("lightbox").hidden = true; byId("lightboxImage").removeAttribute("src"); }
byId("lightboxClose").addEventListener("click", closeLightbox);
byId("lightbox").addEventListener("click", (event) => { if (event.target !== byId("lightboxImage")) closeLightbox(); });

/* ---------- tabs ---------- */

const tabLoaders = {
  dashboard: () => loadOverview(),
  sessions: () => loadSessions({ quiet: state.sessions.length > 0 }),
  logs: () => loadServerLogs(),
  system: () => loadSystem(),
};

function switchTab(tab) {
  state.tab = tab;
  for (const button of byId("adminTabs").children) {
    button.classList.toggle("is-active", button.dataset.tab === tab);
  }
  for (const panel of document.querySelectorAll(".tab-panel")) {
    const active = panel.id === `panel-${tab}`;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  }
  tabLoaders[tab]?.();
}
byId("adminTabs").addEventListener("click", (event) => {
  const button = event.target.closest(".admin-tab");
  if (button) switchTab(button.dataset.tab);
});

/* ---------- dashboard ---------- */

function statCard(label, value, sub, tone) {
  const card = element("article", `stat-card${tone ? ` ${tone}` : ""}`);
  card.append(element("span", "stat-label", label), element("b", "stat-value", String(value)));
  if (sub) card.append(element("small", "stat-sub", sub));
  return card;
}

function renderOverview(data) {
  const grid = byId("dashStats");
  const { totals } = data;
  grid.replaceChildren(
    statCard("Sesi", totals.sessions, totals.busySessions ? `${totals.busySessions} sedang aktif` : "tidak ada yang berjalan"),
    statCard("Run selesai", totals.complete, `${totals.runs} run total`, "green"),
    statCard("Run gagal", totals.failed, totals.failed ? "periksa tab Log" : "bersih", totals.failed ? "red" : "green"),
    statCard("Aset dihasilkan", totals.assets, "dari run yang selesai"),
    statCard("Penyimpanan S3", `${totals.s3Runs}/${totals.runs}`, totals.localRuns ? `${totals.localRuns} run masih lokal` : "semua run di cloud", "accent"),
  );

  const chart = byId("activityChart");
  chart.replaceChildren();
  const max = Math.max(1, ...data.activity.map((day) => day.runs));
  for (const day of data.activity) {
    const column = element("div", "activity-col");
    const bar = element("span", "activity-bar");
    bar.style.height = `${Math.max(2, Math.round((day.runs / max) * 100))}%`;
    if (!day.runs) bar.classList.add("empty");
    bar.title = `${day.label} · ${day.runs} run · ${day.assets} aset`;
    column.append(bar);
    if (day.date === new Date().toISOString().slice(0, 10)) column.append(element("i", "activity-today"));
    chart.append(column);
  }
  const labels = element("div", "activity-labels");
  labels.append(element("span", "", data.activity[0]?.label ?? ""), element("span", "", "14 hari"), element("span", "", data.activity.at(-1)?.label ?? ""));
  chart.append(labels);

  const list = byId("recentRuns");
  list.replaceChildren();
  if (!data.recent.length) {
    list.append(element("p", "list-status", "Belum ada run."));
    return;
  }
  for (const run of data.recent) {
    const row = element("button", "recent-row");
    row.type = "button";
    row.append(
      element("span", `run-dot ${run.status}`),
      element("span", "recent-title", run.groupName || (run.prompt ? run.prompt.slice(0, 40) : run.runId.slice(0, 12))),
      element("span", "recent-meta", `${run.assetCount} aset · ${formatRelative(run.createdAt)}`),
      element("span", `storage-dot ${run.hasS3 ? "s3" : "local"}`, run.hasS3 ? "S3" : "LOK"),
    );
    row.addEventListener("click", () => {
      switchTab("sessions");
      selectSession(run.sessionId);
    });
    list.append(row);
  }
}

async function loadOverview() {
  if (state.overviewLoaded && state.tab === "dashboard") return;
  try {
    renderOverview(await requestJson("/api/admin/overview"));
    state.overviewLoaded = true;
  } catch (error) {
    byId("recentRuns").replaceChildren(element("p", "run-error", error.message));
  }
}

/* ---------- sessions list ---------- */

function runMatchesFilter(run, filter) {
  if (filter === "complete" || filter === "failed") return run.status === filter;
  if (filter === "s3") return Boolean(run.hasS3);
  if (filter === "local") return !run.hasS3 && run.status === "complete";
  return true;
}

function filteredSessions() {
  const query = byId("sessionSearch").value.trim().toLowerCase();
  let list = state.sessions;
  if (state.filter !== "all") {
    list = list.filter((session) => (state.filter === "busy" && session.busy)
      || session.runs?.some((run) => runMatchesFilter(run, state.filter)));
  }
  if (query) {
    list = list.filter((session) => [session.id, session.lastPrompt, ...(session.runs ?? []).map((run) => run.groupName)]
      .filter(Boolean).join(" ").toLowerCase().includes(query));
  }
  const byTime = (value) => Date.parse(value ?? "") || 0;
  const sorters = {
    newest: (a, b) => byTime(b.updatedAt) - byTime(a.updatedAt),
    oldest: (a, b) => byTime(a.updatedAt) - byTime(b.updatedAt),
    runs: (a, b) => b.runCount - a.runCount,
    assets: (a, b) => b.totalAssets - a.totalAssets,
  };
  return [...list].sort(sorters[state.sort] ?? sorters.newest);
}

function buildSessionCard(session) {
  const card = element("button", `session-card${session.id === state.selectedId ? " selected" : ""}`);
  card.type = "button";
  const visual = element("span", "session-visual");
  if (session.thumbnailUrl) {
    const image = element("img");
    image.src = session.thumbnailUrl;
    image.alt = "";
    image.loading = "lazy";
    image.addEventListener("error", () => image.remove());
    visual.append(image);
  } else {
    visual.append(element("span", "session-visual-placeholder", "▦"));
  }
  const body = element("span", "session-card-body");
  body.append(
    element("span", "session-title", session.lastGroupName || session.lastPrompt?.slice(0, 60) || session.id),
    element("span", "session-id", session.id),
  );
  const meta = element("span", "session-card-meta");
  meta.append(
    element("span", "", `${session.completeCount}/${session.runCount} run`),
    session.failedCount ? element("span", "bad", `${session.failedCount} gagal`) : element("span", "", "0 gagal"),
    element("span", "", `${session.totalAssets} aset`),
    session.busy ? element("span", "working", "● aktif") : element("span", "", formatRelative(session.updatedAt)),
  );
  body.append(meta);
  if (session.readError) body.append(element("span", "session-warn", session.readError));
  card.append(visual, body);
  card.addEventListener("click", () => selectSession(session.id));
  return card;
}

function renderSessionList() {
  const list = byId("sessionList");
  const filtered = filteredSessions();
  const visible = filtered.slice(0, state.visible);
  list.replaceChildren();
  byId("listStatus").textContent = filtered.length === state.sessions.length
    ? `${filtered.length} sesi`
    : `${filtered.length} dari ${state.sessions.length} sesi cocok`;
  if (!filtered.length) {
    list.append(element("p", "list-status", state.sessions.length ? "Tidak ada sesi yang cocok dengan filter." : "Belum ada sesi tersimpan."));
  } else {
    list.append(...visible.map(buildSessionCard));
  }
  const more = byId("sessionLoadMore");
  more.hidden = filtered.length <= state.visible;
  more.textContent = `Tampilkan lebih banyak (${Math.max(0, filtered.length - state.visible)} lagi)`;
}

async function loadSessions({ quiet = false } = {}) {
  if (!quiet) byId("listStatus").textContent = "Memuat sesi…";
  try {
    const result = await requestJson("/api/admin/sessions");
    state.sessions = result.sessions ?? [];
    if (state.selectedId && !state.sessions.some((session) => session.id === state.selectedId)) {
      state.selectedId = null;
      closeDetail();
    }
    renderSessionList();
    if (state.selectedId) await selectSession(state.selectedId, { quiet: true });
  } catch (error) {
    byId("listStatus").textContent = error.message;
    if (!quiet) showToast(`Gagal memuat daftar sesi: ${error.message}`, true);
  }
}

byId("sessionLoadMore").addEventListener("click", () => { state.visible += 12; renderSessionList(); });
byId("sessionSearch").addEventListener("input", () => { state.visible = 12; renderSessionList(); });
byId("sessionSort").addEventListener("change", (event) => { state.sort = event.target.value; renderSessionList(); });
byId("statusFilters").addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  state.filter = chip.dataset.filter;
  state.visible = 12;
  for (const button of byId("statusFilters").children) button.classList.toggle("is-active", button === chip);
  renderSessionList();
});

/* ---------- session detail (runs) ---------- */

function storageBadge(hasS3) {
  return element("span", `storage-badge ${hasS3 ? "s3" : "local"}`, hasS3 ? "S3" : "LOKAL");
}

function logViewer(sessionId, runId, type, label) {
  const wrapper = element("div", "log-viewer");
  const toggle = element("button", "log-toggle", label);
  toggle.type = "button";
  const output = element("pre", "log-output");
  output.hidden = true;
  let loaded = null;
  toggle.addEventListener("click", async () => {
    if (!output.hidden) { output.hidden = true; toggle.classList.remove("open"); return; }
    output.hidden = false;
    toggle.classList.add("open");
    if (loaded !== null) { output.textContent = loaded || "Log kosong."; return; }
    output.textContent = "Memuat log…";
    try {
      const result = await requestJson(`/api/admin/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/logs/${type}`);
      loaded = result.records?.length
        ? result.records.map((record) => JSON.stringify(record)).join("\n")
        : "";
      output.textContent = loaded || "Log kosong.";
    } catch (error) {
      output.textContent = `Gagal membaca log: ${error.message}`;
    }
  });
  wrapper.append(toggle, output);
  return wrapper;
}

function buildRunCard(run, sessionId) {
  const card = element("article", `run-card status-${run.status}`);
  const head = element("header", "run-head");
  const headMain = element("div", "run-head-main");
  headMain.append(
    element("span", `run-state ${run.status}`, run.status === "complete" ? "✓ SELESAI" : run.status === "failed" ? "✕ GAGAL" : run.status.toUpperCase()),
    element("h4", "run-title", run.groupName || (run.status === "failed" ? "Run gagal" : "Run tanpa nama grup")),
    element("p", "run-sub", `${formatDate(run.createdAt)} · ${run.count ?? run.assets.length} aset${run.theme ? ` · tema ${run.theme}` : ""}${run.style ? ` · ${run.style}` : ""}`),
    storageBadge(run.hasS3),
  );
  head.append(headMain);

  const actions = element("div", "run-actions");
  if (run.sheetUrl) {
    const sheet = element("button", "run-action", "Lihat sheet");
    sheet.type = "button";
    sheet.addEventListener("click", () => openLightbox(run.sheetUrl, `${run.groupName || run.runId} — sprite sheet`));
    actions.append(sheet);
    const downloadSheet = element("a", "run-action", "Sheet ↓");
    downloadSheet.href = `${run.sheetUrl}?download=1`;
    downloadSheet.setAttribute("download", "");
    actions.append(downloadSheet);
  }
  if (run.status === "complete") {
    const zip = element("a", "run-action accent", "Unduh ZIP ↓");
    zip.href = `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(run.runId)}/export?download=1`;
    zip.setAttribute("download", "");
    actions.append(zip);
  }
  if (run.hasS3) {
    const restore = element("button", "run-action restore", "↓ Ke lokal");
    restore.type = "button";
    restore.title = "Unduh run ini ke disk server (sesi penuh)";
    restore.addEventListener("click", () => restoreSession(sessionId));
    actions.append(restore);
  }
  head.append(actions);
  card.append(head);

  const content = element("div", "run-content");
  if (run.prompt) {
    const prompt = element("p", "run-prompt", run.prompt);
    prompt.title = "Prompt yang digunakan";
    content.append(prompt);
  }
  if (run.error) content.append(element("pre", "run-error", run.error));

  if (run.sheetUrl) {
    const preview = element("button", "sheet-preview");
    preview.type = "button";
    const image = element("img");
    image.src = run.sheetUrl;
    image.alt = `Sprite sheet ${run.groupName || run.runId}`;
    image.loading = "lazy";
    image.addEventListener("error", () => { preview.classList.add("broken"); image.alt = "Gambar gagal dimuat"; });
    preview.append(image, element("span", "zoom-hint", "⊕ klik untuk membesarkan"));
    preview.addEventListener("click", () => openLightbox(run.sheetUrl, run.groupName || run.runId));
    content.append(preview);
  }

  if (run.assets.length) {
    const heading = element("div", "asset-heading");
    heading.append(element("span", "", `ASET · ${run.assets.length}`));
    content.append(heading);
    const grid = element("div", "asset-grid");
    for (const asset of run.assets) {
      if (!asset.url) {
        const missing = element("div", "admin-asset missing");
        missing.append(element("span", "missing-mark", "?"), element("span", "", asset.name));
        grid.append(missing);
        continue;
      }
      const tile = element("button", "admin-asset");
      tile.type = "button";
      tile.title = `${asset.label} · ${asset.width || "?"}×${asset.height || "?"} — klik untuk memperbesar`;
      const image = element("img");
      image.src = asset.url;
      image.alt = asset.label;
      image.loading = "lazy";
      const link = element("a", "asset-download", "↓");
      link.href = `${asset.url}?download=1`;
      link.setAttribute("download", "");
      link.title = "Unduh PNG";
      link.addEventListener("click", (event) => event.stopPropagation());
      tile.append(image, element("span", "asset-name", asset.name), link);
      tile.addEventListener("click", () => openLightbox(asset.url, asset.label));
      grid.append(tile);
    }
    content.append(grid);
  }

  const logs = element("div", "log-controls");
  logs.append(logViewer(sessionId, run.runId, "conversation", "Log percakapan AI"));
  if (run.logs?.events) logs.append(logViewer(sessionId, run.runId, "events", "Run events"));
  content.append(logs);
  card.append(content);
  return card;
}

function closeDetail() {
  byId("sessionDetail").hidden = true;
  byId("sessionDetail").replaceChildren();
  byId("emptyDetail").hidden = false;
}

function renderSessionDetail(result) {
  const detail = byId("sessionDetail");
  detail.replaceChildren();
  byId("emptyDetail").hidden = true;
  detail.hidden = false;

  const header = element("header", "detail-header");
  const title = element("div", "detail-title");
  const completeCount = result.runs.filter((run) => run.status === "complete").length;
  const failedCount = result.runs.filter((run) => run.status === "failed").length;
  const assetTotal = result.runs.reduce((sum, run) => sum + (run.assets?.length ?? 0), 0);
  title.append(
    element("h2", "", result.session?.lastResult?.groupName || result.runs.find((run) => run.groupName)?.groupName || "Sesi tanpa nama"),
    element("p", "detail-subtitle", `${result.id} · diperbarui ${formatRelative(result.session?.updatedAt)}`),
    element("p", "detail-substats", `${completeCount} selesai · ${failedCount} gagal · ${assetTotal} aset`),
  );
  const actions = element("div", "detail-actions");
  const hasS3Runs = result.runs.some((run) => run.hasS3);
  if (hasS3Runs) {
    const purgeLabel = element("label", "restore-purge");
    const purgeInput = document.createElement("input");
    purgeInput.type = "checkbox";
    purgeLabel.append(purgeInput, document.createTextNode(" Hapus salinan S3 setelah unduh"));
    const restore = element("button", "run-action restore", "Kembalikan ke lokal");
    restore.type = "button";
    restore.addEventListener("click", () => restoreSession(result.id, purgeInput.checked));
    actions.append(purgeLabel, restore);
  }
  const refresh = element("button", "run-action", "↻");
  refresh.type = "button";
  refresh.title = "Muat ulang detail sesi";
  refresh.addEventListener("click", () => selectSession(result.id, { quiet: true }));
  const remove = element("button", "delete-button", result.busy ? "Sedang dipakai" : "Hapus sesi");
  remove.type = "button";
  remove.disabled = result.busy;
  remove.addEventListener("click", () => deleteSession(result.id));
  actions.append(refresh, remove);
  header.append(title, actions);
  detail.append(header);

  if (!result.runs.length) {
    detail.append(element("p", "list-status", "Sesi ini belum memiliki run."));
    return;
  }
  for (const run of result.runs) detail.append(buildRunCard(run, result.id));
}

async function selectSession(id, { quiet = false } = {}) {
  state.selectedId = id;
  renderSessionList();
  if (!quiet) {
    byId("emptyDetail").hidden = true;
    byId("sessionDetail").hidden = false;
    byId("sessionDetail").replaceChildren(element("p", "list-status", "Memuat detail sesi…"));
  }
  try {
    const result = await requestJson(`/api/admin/sessions/${encodeURIComponent(id)}`);
    state.detail = result;
    renderSessionDetail(result);
  } catch (error) {
    byId("sessionDetail").hidden = false;
    byId("sessionDetail").replaceChildren(element("p", "run-error", error.message));
    if (!quiet) showToast(`Gagal memuat sesi: ${error.message}`, true);
  }
}

/* ---------- actions: restore / delete ---------- */

async function restoreSession(id, purgeRemote = false) {
  const ok = await confirmDialog({
    title: "Kembalikan ke penyimpanan lokal",
    body: purgeRemote
      ? `Run pada sesi ${id} akan diunduh dari S3 ke disk server, lalu salinan cloud-nya DIHAPUS.`
      : `Run pada sesi ${id} akan diunduh dari S3 ke disk server (salinan cloud dipertahankan).`,
    okLabel: "Mulai unduh",
    danger: Boolean(purgeRemote),
  });
  if (!ok) return;
  try {
    const result = await requestJson(`/api/admin/sessions/${encodeURIComponent(id)}/restore`, {
      method: "POST",
      body: JSON.stringify({ purgeRemote: Boolean(purgeRemote) }),
    });
    showToast(`${result.runs} run dipulihkan ke lokal (${result.files} file)${result.purgedRemote ? " · salinan S3 dihapus" : ""}.`);
    await Promise.all([loadSessions({ quiet: true }), selectSession(id, { quiet: true })]);
  } catch (error) {
    showToast(`Gagal memulihkan sesi: ${error.message}`, true);
  }
}

async function deleteSession(id) {
  const ok = await confirmDialog({
    title: "Hapus sesi permanen",
    body: `Sesi ${id} beserta seluruh run, sheet, aset PNG, ZIP, dan log AI akan dihapus permanen${(state.detail?.runs ?? []).some((run) => run.hasS3) ? ", termasuk objek di S3" : ""}. Tindakan ini tidak bisa dibatalkan.`,
    okLabel: "Hapus sekarang",
  });
  if (!ok) return;
  try {
    await requestJson(`/api/admin/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    state.selectedId = null;
    closeDetail();
    showToast("Sesi dan seluruh datanya sudah dihapus.");
    await Promise.all([loadSessions({ quiet: true }), loadOverview()]);
    state.overviewLoaded = false;
  } catch (error) {
    showToast(`Gagal menghapus sesi: ${error.message}`, true);
    await loadSessions({ quiet: true });
  }
}

/* ---------- logs tab ---------- */

function renderLogRow(record) {
  const level = record.level === "warn" ? "warn" : "error";
  const row = element("div", `log-row ${level}`);
  const head = element("div", "log-row-head");
  head.append(
    element("span", `log-level ${level}`, level === "warn" ? "WARN" : "ERR"),
    element("span", "log-time", formatDate(record.timestamp)),
    element("span", "log-type", record.type ?? "server"),
    element("span", "log-message", record.message ?? ""),
  );
  row.append(head);
  const rest = { ...record };
  delete rest.timestamp; delete rest.level; delete rest.type; delete rest.message;
  if (Object.keys(rest).length) {
    const extra = element("pre", "log-extra");
    extra.hidden = true;
    extra.textContent = JSON.stringify(rest, null, 2);
    const more = element("button", "log-more", "Detail");
    more.type = "button";
    more.addEventListener("click", () => { extra.hidden = !extra.hidden; more.textContent = extra.hidden ? "Detail" : "Tutup"; });
    row.append(more, extra);
  }
  return row;
}

function renderServerLogs(records) {
  const query = byId("logSearch").value.trim().toLowerCase();
  const type = byId("logTypeFilter").value;
  const filtered = records.filter((record) => {
    if (type !== "all" && record.level !== type) return false;
    return !query || JSON.stringify(record).toLowerCase().includes(query);
  });
  const list = byId("errorList");
  list.replaceChildren();
  byId("serverErrorSummary").textContent = records.length
    ? `${filtered.length} dari ${records.length} catatan (yang terbaru di atas)`
    : "Tidak ada error yang tercatat — server sehat.";
  if (!filtered.length) {
    if (records.length) list.append(element("p", "list-status", "Tidak ada catatan yang cocok dengan pencarian/filter."));
    return;
  }
  list.append(...[...filtered].reverse().map(renderLogRow));
}

async function loadServerLogs() {
  if (state.logsLoaded) { renderServerLogs(state.logs); return; }
  byId("errorList").replaceChildren(element("p", "list-status", "Memuat log…"));
  try {
    const result = await requestJson("/api/admin/server-errors?limit=500");
    state.logs = result.records ?? [];
    state.logsLoaded = true;
    renderServerLogs(state.logs);
  } catch (error) {
    byId("errorList").replaceChildren(element("p", "run-error", error.message));
  }
}
byId("logSearch").addEventListener("input", () => { if (state.logs) renderServerLogs(state.logs); });
byId("logTypeFilter").addEventListener("change", () => { if (state.logs) renderServerLogs(state.logs); });

/* ---------- system tab ---------- */

function systemRow(label, value, ready) {
  const row = element("div", "system-row");
  if (ready !== undefined) row.append(element("span", `status-dot ${ready ? "ok" : "bad"}`, ready ? "✓" : "✕"));
  row.append(element("span", "system-label", label), element("code", "system-value", String(value ?? "—")));
  return row;
}

async function loadSystem() {
  if (state.systemLoaded) return;
  try {
    const [info, python] = await Promise.all([requestJson("/api/admin/system"), requestJson("/api/admin/python-check")]);
    const providers = byId("systemProviders");
    providers.replaceChildren();
    for (const provider of info.providers) providers.append(systemRow(provider.name, `${provider.model} · ${provider.baseUrl}`, provider.ready));

    const s3 = byId("systemS3");
    s3.replaceChildren();
    s3.append(systemRow("Status", info.s3.configured ? "aktif" : "belum dikonfigurasi (pakai disk lokal)", info.s3.configured));
    if (info.s3.configured) {
      s3.append(
        systemRow("Bucket", info.s3.bucket),
        systemRow("Endpoint", info.s3.endpoint),
        systemRow("Domain publik", info.s3.publicBaseUrl || "(kosong — gunakan presigned URL)"),
        systemRow("Prefix", info.s3.prefix),
        systemRow("Purge lokal setelah upload", info.s3.purgeLocal ? "ya" : "tidak"),
      );
    }

    const py = byId("systemPython");
    py.replaceChildren();
    py.append(systemRow("Python", python.version ?? python.error ?? "tidak terdeteksi", python.ready));
    for (const check of python.checks ?? []) py.append(systemRow(check.name, check.version ?? check.error ?? "—", check.available));

    const app = byId("systemApp");
    app.replaceChildren();
    app.append(
      systemRow("Port", info.app.port),
      systemRow("Data dir", info.app.dataDir),
      systemRow("Gallery page size", info.app.galleryPageSize),
      systemRow("Preview per kartu", info.app.galleryPreviewCount),
      systemRow("Iterasi maksimum AI", info.app.maxIterations),
    );
    state.systemLoaded = true;
  } catch (error) {
    for (const id of ["systemProviders", "systemS3", "systemPython", "systemApp"]) {
      byId(id).replaceChildren(element("p", "run-error", error.message));
    }
  }
}

/* ---------- auth + boot ---------- */

function showLogin(message = "", configured = true) {
  byId("loginScreen").hidden = false;
  byId("adminTabs").hidden = true;
  byId("logoutAdmin").hidden = true;
  byId("loginError").textContent = message;
  byId("adminPassword").disabled = !configured;
  byId("loginSubmit").disabled = !configured;
}

function reloadCurrentTab() {
  state.overviewLoaded = false;
  state.systemLoaded = false;
  state.logsLoaded = false;
  return tabLoaders[state.tab]?.();
}

async function enterAdmin() {
  byId("loginScreen").hidden = true;
  byId("adminTabs").hidden = false;
  byId("logoutAdmin").hidden = false;
  byId("adminPassword").value = "";
  byId("loginError").textContent = "";
  state.overviewLoaded = false;
  state.systemLoaded = false;
  state.logsLoaded = false;
  switchTab(state.tab);
}

async function checkAdminAuth() {
  try {
    const auth = await requestJson("/api/admin/auth");
    if (!auth.configured) {
      showLogin("Password belum diatur. Tambahkan SIBERSLICE_ADMIN_PASSWORD ke file .env lalu restart server.", false);
      return;
    }
    if (auth.authenticated) await enterAdmin();
    else showLogin();
  } catch (error) {
    showLogin(error.message);
  }
}

byId("adminLoginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = byId("loginSubmit");
  button.disabled = true;
  button.textContent = "Memeriksa…";
  byId("loginError").textContent = "";
  try {
    await requestJson("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: byId("adminPassword").value }),
    });
    await enterAdmin();
  } catch (error) {
    byId("loginError").textContent = error.message;
  } finally {
    button.textContent = "Masuk ↗";
    button.disabled = false;
  }
});

byId("logoutAdmin").addEventListener("click", async () => {
  try { await requestJson("/api/admin/logout", { method: "POST" }); } catch (error) { showToast(error.message, true); }
  state.sessions = [];
  state.selectedId = null;
  state.tab = "dashboard";
  byId("sessionList").replaceChildren();
  closeDetail();
  showLogin();
});

byId("refreshAll").addEventListener("click", async () => {
  state.overviewLoaded = false;
  state.systemLoaded = false;
  state.logsLoaded = false;
  if (state.tab === "sessions") await loadSessions({ quiet: true });
  else await tabLoaders[state.tab]?.();
  showToast("Data dimuat ulang.");
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!byId("confirmModal").hidden) closeConfirm(false);
  else if (!byId("lightbox").hidden) closeLightbox();
});

checkAdminAuth();
