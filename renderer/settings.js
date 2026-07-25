const form = document.getElementById("settingsForm");
const resultEl = document.getElementById("formResult");
const storePathEl = document.getElementById("storePath");

function showResult(ok, message) {
  resultEl.className = `inline-result ${ok ? "ok" : "err"}`;
  resultEl.textContent = message;
}

async function load() {
  const [config, storePath] = await Promise.all([
    window.api.getConfig(),
    window.api.getStorePath(),
  ]);

  document.getElementById("apiKey").value = config.apiKey || "";
  document.getElementById("dbName").value = config.dbName || "";
  document.getElementById("webServiceId").value = config.webServiceId || "";
  document.getElementById("envVarKey").value = config.envVarKey || "DATABASE_URL";
  document.getElementById("backupFile").value = config.backupFile || "";
  document.getElementById("autoBackupIntervalDays").value =
    config.autoBackupIntervalDays ?? 3;
  storePathEl.textContent = storePath;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    apiKey: document.getElementById("apiKey").value.trim(),
    dbName: document.getElementById("dbName").value.trim(),
    webServiceId: document.getElementById("webServiceId").value.trim(),
    envVarKey: document.getElementById("envVarKey").value.trim() || "DATABASE_URL",
    backupFile: document.getElementById("backupFile").value.trim(),
    autoBackupIntervalDays: Number(document.getElementById("autoBackupIntervalDays").value) || 3,
  };

  try {
    await window.api.saveConfig(payload);
    showResult(true, "Settings saved.");
  } catch (err) {
    showResult(false, err.message || String(err));
  }
});

document.getElementById("btnTest").addEventListener("click", async () => {
  // Save first so test uses current form values
  const payload = {
    apiKey: document.getElementById("apiKey").value.trim(),
    dbName: document.getElementById("dbName").value.trim(),
    webServiceId: document.getElementById("webServiceId").value.trim(),
    envVarKey: document.getElementById("envVarKey").value.trim() || "DATABASE_URL",
    backupFile: document.getElementById("backupFile").value.trim(),
    autoBackupIntervalDays: Number(document.getElementById("autoBackupIntervalDays").value) || 3,
  };

  try {
    await window.api.saveConfig(payload);
    showResult(true, "Testing…");
    const res = await window.api.testConfig();
    showResult(true, res.message || "Connection OK.");
  } catch (err) {
    showResult(false, err.message || String(err));
  }
});

document.getElementById("pickFile").addEventListener("click", async () => {
  const chosen = await window.api.pickBackupFile();
  if (chosen) {
    document.getElementById("backupFile").value = chosen;
  }
});

load().catch((err) => showResult(false, err.message || String(err)));
