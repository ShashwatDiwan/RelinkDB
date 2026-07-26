const path = require("path");

let store = null;

function defaultBackupFile() {
  const { app } = require("electron");
  return path.join(app.getPath("documents"), "render-db-refresh", "data.sql");
}

function getDefaults() {
  return {
    apiKey: "",
    dbName: "",
    webServiceId: "",
    envVarKey: "DATABASE_URL",
    notificationEmail: "",
    backupFile: defaultBackupFile(),
    autoBackupIntervalDays: 1,
    launchAtLogin: true,
    lastBackupAt: null,
    lastAutoExportDbId: null,
    runHistory: [],
  };
}

function getStore() {
  if (!store) {
    const Store = require("electron-store");
    store = new Store({
      name: "config",
      defaults: getDefaults(),
    });
  }
  return store;
}

function getConfig() {
  const s = getStore();
  const defaults = getDefaults();
  return {
    apiKey: s.get("apiKey", defaults.apiKey),
    dbName: s.get("dbName", defaults.dbName),
    webServiceId: s.get("webServiceId", defaults.webServiceId),
    envVarKey: s.get("envVarKey", defaults.envVarKey),
    notificationEmail: s.get("notificationEmail", defaults.notificationEmail),
    backupFile: s.get("backupFile", defaults.backupFile),
    autoBackupIntervalDays: s.get("autoBackupIntervalDays", defaults.autoBackupIntervalDays),
    launchAtLogin: s.get("launchAtLogin", defaults.launchAtLogin),
    lastBackupAt: s.get("lastBackupAt", defaults.lastBackupAt),
    lastAutoExportDbId: s.get("lastAutoExportDbId", defaults.lastAutoExportDbId),
  };
}

function saveConfig(partial) {
  const s = getStore();
  const allowed = [
    "apiKey",
    "dbName",
    "webServiceId",
    "envVarKey",
    "notificationEmail",
    "backupFile",
    "autoBackupIntervalDays",
    "launchAtLogin",
  ];
  for (const key of allowed) {
    if (partial[key] !== undefined) {
      s.set(key, partial[key]);
    }
  }
  return getConfig();
}

function setLastBackupAt(iso) {
  getStore().set("lastBackupAt", iso);
}

function setLastAutoExportDbId(dbId) {
  getStore().set("lastAutoExportDbId", dbId || null);
}

function getStorePath() {
  return getStore().path;
}

function getHistory() {
  return getStore().get("runHistory", []);
}

function appendHistory(entry) {
  const history = getHistory();
  history.unshift({
    timestamp: entry.timestamp || new Date().toISOString(),
    action: entry.action,
    kind: entry.kind || entry.action,
    success: Boolean(entry.success),
    summary: entry.summary || "",
    details: entry.details || null,
  });
  getStore().set("runHistory", history.slice(0, 50));
  return getHistory().slice(0, 5);
}

function isConfigReadyForBackup(config = getConfig()) {
  return Boolean(config.apiKey && config.dbName && config.backupFile);
}

function isConfigReadyForSync(config = getConfig()) {
  return Boolean(
    config.apiKey && config.dbName && config.webServiceId && config.backupFile
  );
}

module.exports = {
  getConfig,
  saveConfig,
  setLastBackupAt,
  setLastAutoExportDbId,
  getStorePath,
  getHistory,
  appendHistory,
  isConfigReadyForBackup,
  isConfigReadyForSync,
};
