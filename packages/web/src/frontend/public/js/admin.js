const byId = (id) => document.getElementById(id);
const state = { sessions: [], selectedId: null };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function formatDate(value) {
  if (!value) return "Tanggal tidak tersedia";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Tanggal tidak tersedia" : new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function showToast(message, isError = false) {
  const toast = byId("adminToast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3600);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) throw new Error(body.error || `Request gagal (${response.status}).`);
  return body;
}

function renderPythonStatus(result) {
  const icon = byId("pythonIcon");
  icon.className = `status-icon ${result.ready ? "ready" : "missing"}`;
  icon.textContent = result.ready ? "✓" : "!";
  byId("pythonSummary").textContent = result.ready
    ? `Siap digunakan${result.version ? ` · Python ${result.version}` : ""}`
    : result.error || "Python atau dependensi slicing belum lengkap.";
  const facts = byId("pythonFacts");
  facts.replaceChildren();
  if (result.command) {
    const fact = element("span", "runtime-fact", `${result.command}${result.version ? ` ${result.version}` : ""}`);
    if (result.executable) {
      fact.append(element("b", "", "aktif"));
      fact.title = result.executable;
    }
    facts.append(fact);
  }
  for (const check of result.checks ?? []) {
    const fact = element("span", `runtime-fact${check.available ? "" : " missing"}`, check.name);
    fact.append(element("b", "", check.available ? (check.version || "OK") : "belum ada"));
    if (check.error) fact.title = check.error;
    facts.append(fact);
  }
  byId("pythonInstall").hidden = Boolean(result.ready);
}

async function loadPythonStatus() {
  byId("pythonIcon").className = "status-icon pending";
  byId("pythonIcon").textContent = "…";
  byId("pythonSummary").textContent = "Memeriksa interpreter dan paket…";
  try { renderPythonStatus(await requestJson("/api/admin/python-check")); }
  catch (error) { renderPythonStatus({ ready: false, error: error.message, checks: [] }); }
}

function renderServerErrors(records, total) {
  byId("serverErrorSummary").textContent = total === 0 ? "Tidak ada error yang tercatat." : `Menampilkan ${records.length} dari ${total} catatan terakhir.`;
  const output = byId("serverErrors");
  output.hidden = total === 0;
  output.textContent = records.map((record) => JSON.stringify(record, null, 2)).join("\n\n");
}

async function loadServerErrors() {
  const button = byId("loadServerErrors");
  button.disabled = true;
  button.textContent = "Memuat…";
  try {
    const result = await requestJson("/api/admin/server-errors?limit=200");
    renderServerErrors(result.records ?? [], result.total ?? 0);
  } catch (error) {
    byId("serverErrorSummary").textContent = error.message;
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Muat log";
  }
}

function buildSessionItem(session) {
  const button = element("button", `session-item${session.id === state.selectedId ? " selected" : ""}`);
  button.type = "button";
  const top = element("span", "session-item-top");
  top.append(element("span", "session-id", session.id), element("span", "session-date", formatDate(session.updatedAt)));
  button.append(top, element("span", "session-prompt", session.lastPrompt || session.readError || "Belum ada run dalam sesi ini."));
  const meta = element("span", "session-item-meta");
  meta.append(element("span", "good", `${session.completeCount} selesai`), element("span", "bad", `${session.failedCount} gagal`));
  if (session.busy) meta.append(element("span", "working", "aktif"));
  button.append(meta);
  button.addEventListener("click", () => selectSession(session.id));
  return button;
}

function renderSessionList() {
  const query = byId("sessionSearch").value.trim().toLowerCase();
  const filtered = state.sessions.filter((session) => !query || [session.id, session.lastPrompt, ...(session.runs ?? []).map((run) => run.groupName)].join(" ").toLowerCase().includes(query));
  byId("sessionTotal").textContent = String(state.sessions.length);
  byId("listStatus").textContent = filtered.length === state.sessions.length ? `${filtered.length} sesi ditampilkan` : `${filtered.length} dari ${state.sessions.length} sesi cocok`;
  const list = byId("sessionList");
  list.replaceChildren();
  if (!filtered.length) {
    list.append(element("p", "list-status", state.sessions.length ? "Tidak ada sesi yang cocok." : "Belum ada sesi tersimpan."));
    return;
  }
  list.append(...filtered.map(buildSessionItem));
}

async function loadSessions({ preserveSelection = true } = {}) {
  byId("listStatus").textContent = "Memuat sesi…";
  try {
    const result = await requestJson("/api/admin/sessions");
    state.sessions = result.sessions ?? [];
    const selectedExists = state.sessions.some((session) => session.id === state.selectedId);
    if (!preserveSelection || !selectedExists) {
      state.selectedId = null;
      byId("sessionDetail").hidden = true;
      byId("emptyDetail").hidden = false;
    }
    renderSessionList();
    if (state.selectedId) await selectSession(state.selectedId, { quiet: true });
  } catch (error) {
    byId("listStatus").textContent = error.message;
    showToast(`Gagal memuat daftar sesi: ${error.message}`, true);
  }
}

function appendStat(container, label, value) {
  const box = element("div", "stat-box");
  box.append(element("span", "", label), element("b", "", value || "—"));
  container.append(box);
}

function buildLogDetails(sessionId, runId, type, label) {
  const details = document.createElement("details");
  const summary = element("summary", "log-button", label);
  const output = element("pre", "log-output", "Buka untuk memuat log…");
  details.append(summary, output);
  let loaded = false;
  details.addEventListener("toggle", async () => {
    if (!details.open || loaded) return;
    loaded = true;
    output.textContent = "Memuat log…";
    try {
      const result = await requestJson(`/api/admin/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/logs/${type}`);
      output.textContent = result.records?.length ? result.records.map((record) => JSON.stringify(record, null, 2)).join("\n\n") : "Log kosong.";
    } catch (error) {
      output.textContent = `Gagal membaca log: ${error.message}`;
      loaded = false;
    }
  });
  return details;
}

function renderRun(run, sessionId) {
  const card = element("article", "run-card");
  const head = element("header", "run-head");
  const title = element("div");
  title.append(element("h4", "", run.groupName || (run.status === "failed" ? "Run gagal" : "Run tanpa nama grup")));
  title.append(element("p", "run-id", `${formatDate(run.createdAt)} · ${run.runId}`));
  head.append(title, element("span", `run-state ${run.status}`, run.status || "unknown"));
  card.append(head);

  const content = element("div", "run-content");
  content.append(element("p", "run-prompt", run.prompt || "Prompt tidak tersimpan."));
  const meta = element("div", "run-meta");
  meta.append(element("span", "", `${run.count || run.assets.length} aset diminta`));
  if (run.theme) meta.append(element("span", "", `Tema: ${run.theme}`));
  if (run.style) meta.append(element("span", "", `Gaya: ${run.style}`));
  meta.append(element("span", "", `${run.assets.length} file ditemukan`));
  content.append(meta);

  if (run.sheetUrl) {
    const sheet = element("img", "sheet-preview");
    sheet.src = run.sheetUrl;
    sheet.alt = `Sprite sheet ${run.groupName || run.runId}`;
    sheet.loading = "lazy";
    content.append(sheet);
  }
  if (run.assets.length) {
    const assetHeading = element("div", "asset-heading");
    assetHeading.append(element("span", "", `ASET INDIVIDUAL · ${run.assets.length}`));
    const zip = element("a", "", "Unduh ZIP ↓");
    zip.href = `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(run.runId)}/export`;
    zip.setAttribute("download", "");
    assetHeading.append(zip);
    content.append(assetHeading);
    const grid = element("div", "asset-grid");
    for (const asset of run.assets) {
      const link = element("a", "admin-asset");
      link.href = asset.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.title = `${asset.label} · ${asset.width || "?"}×${asset.height || "?"}`;
      const image = element("img");
      image.src = asset.url;
      image.alt = asset.label;
      image.loading = "lazy";
      link.append(image, element("span", "", asset.name));
      grid.append(link);
    }
    content.append(grid);
  }
  if (run.error) content.append(element("pre", "run-error", run.error));

  const logs = element("div", "log-controls");
  if (run.logs?.conversation) logs.append(buildLogDetails(sessionId, run.runId, "conversation", "AI conversation"));
  if (run.logs?.events) logs.append(buildLogDetails(sessionId, run.runId, "events", "Run events"));
  if (logs.childElementCount) content.append(logs);
  card.append(content);
  return card;
}

function renderSessionDetail(result) {
  const detail = byId("sessionDetail");
  detail.replaceChildren();
  byId("emptyDetail").hidden = true;
  detail.hidden = false;
  const header = element("header", "detail-header");
  const title = element("div", "detail-title");
  title.append(element("p", "eyebrow", "SESSION INSPECTOR"), element("h2", "", result.id));
  title.append(element("p", "detail-subtitle", `Dibuat ${formatDate(result.session.createdAt)} · Diperbarui ${formatDate(result.session.updatedAt)}`));
  const remove = element("button", "delete-button", result.busy ? "Sedang dipakai" : "Hapus sesi");
  remove.type = "button";
  remove.disabled = result.busy;
  remove.addEventListener("click", () => deleteSession(result.id));
  header.append(title, remove);
  detail.append(header);

  const stats = element("div", "detail-stats");
  appendStat(stats, "Jumlah run", result.runs.length);
  appendStat(stats, "Run selesai", result.runs.filter((run) => run.status === "complete").length);
  appendStat(stats, "Run gagal", result.runs.filter((run) => run.status === "failed").length);
  appendStat(stats, "Status", result.busy ? "Berjalan" : "Tersimpan");
  detail.append(stats);

  const raw = document.createElement("details");
  raw.className = "json-details";
  raw.append(element("summary", "", "Metadata lengkap session.json"), element("pre", "", JSON.stringify(result.session, null, 2)));
  detail.append(raw);
  const heading = element("div", "runs-heading");
  heading.append(element("h3", "", "Isi sesi"), element("span", "", `${result.runs.length} RUN`));
  detail.append(heading);
  if (!result.runs.length) detail.append(element("p", "list-status", "Sesi ini belum memiliki run."));
  for (const run of result.runs) detail.append(renderRun(run, result.id));
}

async function selectSession(id, { quiet = false } = {}) {
  state.selectedId = id;
  renderSessionList();
  if (!quiet) {
    byId("emptyDetail").hidden = true;
    byId("sessionDetail").hidden = false;
    byId("sessionDetail").replaceChildren(element("p", "list-status", "Memuat detail sesi…"));
  }
  try { renderSessionDetail(await requestJson(`/api/admin/sessions/${encodeURIComponent(id)}`)); }
  catch (error) {
    byId("sessionDetail").hidden = false;
    byId("sessionDetail").replaceChildren(element("p", "run-error", error.message));
    if (!quiet) showToast(`Gagal memuat sesi: ${error.message}`, true);
  }
}

async function deleteSession(id) {
  if (!window.confirm(`Hapus sesi ${id}? Semua sheet, aset PNG, ZIP, log AI, dan run dalam sesi ini akan dihapus permanen.`)) return;
  try {
    await requestJson(`/api/admin/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    state.sessions = state.sessions.filter((session) => session.id !== id);
    state.selectedId = null;
    renderSessionList();
    byId("sessionDetail").replaceChildren();
    byId("sessionDetail").hidden = true;
    byId("emptyDetail").hidden = false;
    showToast("Sesi dan seluruh datanya sudah dihapus.");
  } catch (error) {
    showToast(`Gagal menghapus sesi: ${error.message}`, true);
    await loadSessions();
  }
}

async function refreshAll() {
  await Promise.all([loadSessions(), loadPythonStatus()]);
}

function showLogin(message = "", configured = true) {
  byId("loginScreen").hidden = false;
  byId("logoutAdmin").hidden = true;
  byId("loginError").textContent = message;
  byId("adminPassword").disabled = !configured;
  byId("loginSubmit").disabled = !configured;
}

async function enterAdmin() {
  byId("loginScreen").hidden = true;
  byId("logoutAdmin").hidden = false;
  byId("adminPassword").value = "";
  byId("loginError").textContent = "";
  await refreshAll();
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
  const password = byId("adminPassword").value;
  button.disabled = true;
  button.textContent = "Memeriksa…";
  byId("loginError").textContent = "";
  try {
    await requestJson("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
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
  try { await requestJson("/api/admin/logout", { method: "POST" }); }
  catch (error) { showToast(error.message, true); }
  state.sessions = [];
  state.selectedId = null;
  byId("sessionList").replaceChildren();
  byId("sessionDetail").replaceChildren();
  byId("sessionDetail").hidden = true;
  byId("emptyDetail").hidden = false;
  showLogin();
});

byId("sessionSearch").addEventListener("input", renderSessionList);
byId("refreshSessions").addEventListener("click", () => loadSessions());
byId("refreshAll").addEventListener("click", refreshAll);
byId("checkPython").addEventListener("click", loadPythonStatus);
byId("loadServerErrors").addEventListener("click", loadServerErrors);
checkAdminAuth();
