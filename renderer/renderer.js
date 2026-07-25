const state = {
  stepCompleted: { 1: false, 2: false, 3: false },
  busy: false,
  polling: false,
  uploadFilePath: null,
  uploadOriginalName: null,
  dryRunDoneFor: null,
  dryRunHadFailures: false,
};

const els = {
  statusDbName: document.getElementById("statusDbName"),
  statusLastBackup: document.getElementById("statusLastBackup"),
  statusPgDump: document.getElementById("statusPgDump"),
  statusPsql: document.getElementById("statusPsql"),
  toolsHint: document.getElementById("toolsHint"),
  configHint: document.getElementById("configHint"),
  btnBackup: document.getElementById("btnBackup"),
  btnRecreate: document.getElementById("btnRecreate"),
  btnContinueAnyway: document.getElementById("btnContinueAnyway"),
  btnSync: document.getElementById("btnSync"),
  step1: document.getElementById("step1"),
  step2: document.getElementById("step2"),
  step3: document.getElementById("step3"),
  step1Status: document.getElementById("step1Status"),
  step2Status: document.getElementById("step2Status"),
  step3Status: document.getElementById("step3Status"),
  waitingBanner: document.getElementById("waitingBanner"),
  syncSuccess: document.getElementById("syncSuccess"),
  serviceLink: document.getElementById("serviceLink"),
  logOutput: document.getElementById("logOutput"),
  clearLog: document.getElementById("clearLog"),
  logToggle: document.getElementById("logToggle"),
  logBody: document.getElementById("logBody"),
  historyToggle: document.getElementById("historyToggle"),
  historyBody: document.getElementById("historyBody"),
  historyList: document.getElementById("historyList"),
  historyEmpty: document.getElementById("historyEmpty"),
  uploadToggle: document.getElementById("uploadToggle"),
  uploadBody: document.getElementById("uploadBody"),
  dropZone: document.getElementById("dropZone"),
  btnPickSql: document.getElementById("btnPickSql"),
  uploadFileLabel: document.getElementById("uploadFileLabel"),
  sanitizeReport: document.getElementById("sanitizeReport"),
  sanitizeSummary: document.getElementById("sanitizeSummary"),
  sanitizeDetails: document.getElementById("sanitizeDetails"),
  sanitizeRemovedList: document.getElementById("sanitizeRemovedList"),
  btnDryRun: document.getElementById("btnDryRun"),
  btnRestoreFile: document.getElementById("btnRestoreFile"),
  uploadStatus: document.getElementById("uploadStatus"),
  runResults: document.getElementById("runResults"),
  runResultsSummary: document.getElementById("runResultsSummary"),
  runFailedList: document.getElementById("runFailedList"),
  uploadSyncSuccess: document.getElementById("uploadSyncSuccess"),
  uploadServiceLink: document.getElementById("uploadServiceLink"),
};

function formatTime(iso) {
  if (!iso) return "Never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function appendLog({ level, text, timestamp }) {
  const line = document.createElement("div");
  line.className = `log-line ${level || "info"}`;
  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = new Date(timestamp || Date.now()).toLocaleTimeString();
  line.appendChild(ts);
  line.appendChild(document.createTextNode(text));
  els.logOutput.appendChild(line);
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
}

function setBusy(busy) {
  state.busy = busy;
  updateStepUi();
  updateUploadUi();
}

function updateStepUi() {
  const s1 = state.stepCompleted[1];
  const s2 = state.stepCompleted[2];

  els.step1.classList.toggle("done", s1);
  els.step2.classList.toggle("done", s2);
  els.step3.classList.toggle("done", state.stepCompleted[3]);

  els.step2.classList.toggle("locked", !s1);
  els.step3.classList.toggle("locked", !s2);

  els.btnBackup.disabled = state.busy;
  els.btnRecreate.disabled = state.busy || !s1 || state.polling;
  els.btnSync.disabled = state.busy || !s2;
  els.btnContinueAnyway.classList.toggle("hidden", !state.polling);
  els.waitingBanner.classList.toggle("hidden", !state.polling);
}

function updateUploadUi() {
  const hasFile = Boolean(state.uploadFilePath);
  const dryOk = state.dryRunDoneFor === state.uploadFilePath;
  els.btnDryRun.disabled = state.busy || !hasFile;
  els.btnRestoreFile.disabled = state.busy || !hasFile || !dryOk || state.dryRunHadFailures;
  els.btnPickSql.disabled = state.busy;
}

async function refreshStatus() {
  const [config, tools, history] = await Promise.all([
    window.api.getConfig(),
    window.api.checkTools(),
    window.api.getHistory(),
  ]);

  els.statusDbName.textContent = config.dbName || "(not set)";
  els.statusLastBackup.textContent = formatTime(config.lastBackupAt);
  els.statusPgDump.textContent = tools.pgDump ? "Yes" : "No";
  els.statusPsql.textContent = tools.psql ? "Yes" : "No";

  const missingTools = !tools.pgDump || !tools.psql;
  els.toolsHint.classList.toggle("hidden", !missingTools);
  els.toolsHint.classList.toggle("ok", !missingTools);

  const configured = Boolean(config.apiKey && config.dbName && config.webServiceId);
  els.configHint.classList.toggle("hidden", configured);

  renderHistory(history);
}

function renderHistory(history) {
  els.historyList.innerHTML = "";
  if (!history || history.length === 0) {
    els.historyEmpty.classList.remove("hidden");
    return;
  }
  els.historyEmpty.classList.add("hidden");
  for (const entry of history) {
    const li = document.createElement("li");
    const badge = entry.success
      ? `<span class="ok">ok</span>`
      : `<span class="fail">fail</span>`;
    const kind = entry.kind || entry.action;
    let detailBits = "";
    if (entry.details) {
      detailBits = ` · ${entry.details.succeeded ?? 0} ok / ${entry.details.skippedHarmless ?? 0} skipped / ${
        entry.details.failed?.length ?? 0
      } failed`;
    }
    li.innerHTML = `${badge} <strong>${escapeHtml(kind)}</strong> — ${escapeHtml(
      entry.summary || ""
    )}${escapeHtml(detailBits)} <span class="muted">(${formatTime(entry.timestamp)})</span>`;
    els.historyList.appendChild(li);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function plainError(err) {
  const msg = err?.message || String(err);
  if (/RENDER_API_KEY|api key|401|Unauthorized/i.test(msg)) {
    return "Bad or missing API key. Check Settings and try Test Connection.";
  }
  if (/No Postgres instance named/i.test(msg)) {
    return msg;
  }
  if (/pg_dump|psql/i.test(msg) && /not found|failed/i.test(msg)) {
    return msg;
  }
  return msg;
}

function showSanitizeReport({ removedCount, removed }) {
  els.sanitizeReport.classList.remove("hidden");
  els.sanitizeSummary.textContent = `Removed ${removedCount} provider-specific statement(s).`;
  els.sanitizeRemovedList.innerHTML = "";
  if (removedCount > 0 && removed?.length) {
    els.sanitizeDetails.classList.remove("hidden");
    for (const stmt of removed) {
      const li = document.createElement("li");
      li.textContent = stmt;
      els.sanitizeRemovedList.appendChild(li);
    }
  } else {
    els.sanitizeDetails.classList.add("hidden");
  }
}

function showRunResults(details, { dashboardUrl, dryRun } = {}) {
  els.runResults.classList.remove("hidden");
  const failedCount = details?.failed?.length ?? 0;
  let summary = `${details?.succeeded ?? "—"} succeeded · ${
    details?.skippedHarmless ?? 0
  } skipped as harmless · ${failedCount} failed`;

  if (details?.expectedRows != null) {
    summary += ` · source ~${details.expectedRows} row(s)`;
  }
  if (details?.usedPsql) {
    summary += " · restored via psql";
  }
  if (details?.verification) {
    summary += ` · DB now has ${details.verification.total} row(s)`;
  }
  els.runResultsSummary.textContent = summary;

  els.runFailedList.innerHTML = "";
  for (const f of details?.failed || []) {
    const detailsEl = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = f.error?.slice(0, 120) || "Error";
    const pre = document.createElement("pre");
    pre.textContent = `${f.statement || ""}\n\n${f.error || ""}`;
    detailsEl.appendChild(summary);
    detailsEl.appendChild(pre);
    els.runFailedList.appendChild(detailsEl);
  }

  if (!dryRun && dashboardUrl) {
    els.uploadServiceLink.href = dashboardUrl;
    els.uploadSyncSuccess.classList.remove("hidden");
  } else {
    els.uploadSyncSuccess.classList.add("hidden");
  }
}

async function ingestUploadedFile({ filePath, originalName }) {
  state.uploadFilePath = filePath;
  state.uploadOriginalName = originalName;
  state.dryRunDoneFor = null;
  state.dryRunHadFailures = false;
  els.uploadFileLabel.textContent = originalName || filePath;
  els.runResults.classList.add("hidden");
  els.uploadSyncSuccess.classList.add("hidden");
  els.uploadStatus.textContent = "Sanitizing…";

  const sanitizeResult = await window.api.sanitizeSql({ filePath });
  showSanitizeReport(sanitizeResult);
  els.uploadStatus.textContent = "Ready for dry run";
  updateUploadUi();
}

els.btnBackup.addEventListener("click", async () => {
  setBusy(true);
  els.step1Status.textContent = "Running…";
  els.step1.classList.add("active");
  try {
    const result = await window.api.runBackup();
    state.stepCompleted[1] = true;
    els.step1Status.textContent = `Done · ${formatTime(result.lastBackupAt)}`;
    await refreshStatus();
  } catch (err) {
    els.step1Status.textContent = "Failed";
    appendLog({ level: "error", text: plainError(err), timestamp: new Date().toISOString() });
  } finally {
    els.step1.classList.remove("active");
    setBusy(false);
  }
});

els.btnRecreate.addEventListener("click", async () => {
  setBusy(true);
  els.step2.classList.add("active");
  els.step2Status.textContent = "Opening dashboard…";
  try {
    await window.api.openDashboard();
    state.polling = true;
    setBusy(false);
    updateStepUi();
    els.step2Status.textContent = "Waiting for new database…";

    const poll = await window.api.pollNewDb();
    state.polling = false;
    if (poll.ok || poll.cancelled || poll.timedOut) {
      state.stepCompleted[2] = true;
      els.step2Status.textContent =
        poll.ok && !poll.timedOut && !poll.cancelled
          ? "Database detected"
          : "Ready to continue";
    }
  } catch (err) {
    state.polling = false;
    els.step2Status.textContent = "Failed";
    appendLog({ level: "error", text: plainError(err), timestamp: new Date().toISOString() });
  } finally {
    els.step2.classList.remove("active");
    setBusy(false);
    updateStepUi();
  }
});

els.btnContinueAnyway.addEventListener("click", async () => {
  try {
    await window.api.cancelPoll();
  } catch {
    /* ignore */
  }
  state.polling = false;
  state.stepCompleted[2] = true;
  els.step2Status.textContent = "Continued manually";
  updateStepUi();
});

els.btnSync.addEventListener("click", async () => {
  setBusy(true);
  els.step3.classList.add("active");
  els.step3Status.textContent = "Running…";
  els.syncSuccess.classList.add("hidden");
  try {
    const result = await window.api.runSync();
    state.stepCompleted[3] = true;
    els.step3Status.textContent = "Done";
    if (result.dashboardUrl) {
      els.serviceLink.href = result.dashboardUrl;
      els.syncSuccess.classList.remove("hidden");
    }
    await refreshStatus();
  } catch (err) {
    els.step3Status.textContent = "Failed";
    appendLog({ level: "error", text: plainError(err), timestamp: new Date().toISOString() });
  } finally {
    els.step3.classList.remove("active");
    setBusy(false);
  }
});

els.clearLog.addEventListener("click", () => {
  els.logOutput.innerHTML = "";
});

els.logToggle.addEventListener("click", () => {
  const open = els.logBody.classList.toggle("hidden");
  els.logToggle.setAttribute("aria-expanded", String(!open));
});

els.historyToggle.addEventListener("click", () => {
  const open = !els.historyBody.classList.toggle("hidden");
  els.historyToggle.setAttribute("aria-expanded", String(open));
});

els.uploadToggle.addEventListener("click", () => {
  const open = !els.uploadBody.classList.toggle("hidden");
  els.uploadToggle.setAttribute("aria-expanded", String(open));
});

els.btnPickSql.addEventListener("click", async () => {
  try {
    setBusy(true);
    const picked = await window.api.pickSqlUpload();
    if (!picked) {
      els.uploadStatus.textContent = "";
      return;
    }
    await ingestUploadedFile(picked);
  } catch (err) {
    els.uploadStatus.textContent = "Failed";
    appendLog({ level: "error", text: plainError(err), timestamp: new Date().toISOString() });
  } finally {
    setBusy(false);
  }
});

["dragenter", "dragover"].forEach((evt) => {
  els.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.dropZone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((evt) => {
  els.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (evt === "dragleave") els.dropZone.classList.remove("dragover");
  });
});

els.dropZone.addEventListener("drop", async (e) => {
  els.dropZone.classList.remove("dragover");
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".sql")) {
    appendLog({
      level: "error",
      text: "Only .sql files are supported.",
      timestamp: new Date().toISOString(),
    });
    return;
  }
  try {
    setBusy(true);
    const sourcePath = window.api.getPathForFile(file);
    const imported = await window.api.importSqlPath(sourcePath);
    await ingestUploadedFile(imported);
  } catch (err) {
    els.uploadStatus.textContent = "Failed";
    appendLog({ level: "error", text: plainError(err), timestamp: new Date().toISOString() });
  } finally {
    setBusy(false);
  }
});

els.btnDryRun.addEventListener("click", async () => {
  if (!state.uploadFilePath) return;
  setBusy(true);
  els.uploadStatus.textContent = "Dry run…";
  try {
    const result = await window.api.restoreFromFile({
      filePath: state.uploadFilePath,
      dryRun: true,
    });
    state.dryRunDoneFor = state.uploadFilePath;
    state.dryRunHadFailures = !result.ok;
    showRunResults(result.details, { dryRun: true });
    els.uploadStatus.textContent = result.ok
      ? "Dry run OK � restore enabled"
      : "Dry run finished with failures � fix errors before restoring";
    await refreshStatus();
  } catch (err) {
    els.uploadStatus.textContent = "Dry run failed";
    appendLog({ level: "error", text: plainError(err), timestamp: new Date().toISOString() });
  } finally {
    setBusy(false);
  }
});

els.btnRestoreFile.addEventListener("click", async () => {
  if (!state.uploadFilePath || state.dryRunDoneFor !== state.uploadFilePath) return;
  setBusy(true);
  els.uploadStatus.textContent = "Restoring…";
  try {
    const result = await window.api.restoreFromFile({
      filePath: state.uploadFilePath,
      dryRun: false,
    });
    showRunResults(result.details, {
      dryRun: false,
      dashboardUrl: result.dashboardUrl,
    });
    els.uploadStatus.textContent = result.ok
      ? "Dry run OK � restore enabled"
      : "Dry run finished with failures � fix errors before restoring";
    await refreshStatus();
  } catch (err) {
    els.uploadStatus.textContent = "Restore failed";
    appendLog({ level: "error", text: plainError(err), timestamp: new Date().toISOString() });
  } finally {
    setBusy(false);
  }
});

document.getElementById("installLink")?.addEventListener("click", (e) => {
  e.preventDefault();
  window.api.openExternal("https://www.postgresql.org/download/windows/");
});

document.getElementById("serviceLink")?.addEventListener("click", (e) => {
  const href = els.serviceLink.getAttribute("href");
  if (href && href !== "#") {
    e.preventDefault();
    window.api.openExternal(href);
  }
});

els.uploadServiceLink?.addEventListener("click", (e) => {
  const href = els.uploadServiceLink.getAttribute("href");
  if (href && href !== "#") {
    e.preventDefault();
    window.api.openExternal(href);
  }
});

window.api.onLogLine(appendLog);

(async function init() {
  updateStepUi();
  updateUploadUi();
  await refreshStatus();
})();
