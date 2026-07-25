const path = require("path");
const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  clipboard,
  dialog,
  Notification,
} = require("electron");

const {
  getConfig,
  saveConfig,
  setLastBackupAt,
  getStorePath,
  getHistory,
  appendHistory,
  isConfigReadyForBackup,
  isConfigReadyForSync,
} = require("./lib/config-store");
const { pullLatestBackup, hasBinary } = require("./lib/backup");
const { restoreAndRelink, restoreFromFile } = require("./lib/sync");
const { sanitize } = require("./lib/sql-sanitize");
const {
  findPostgresIdByName,
  findPostgresByName,
  getConnectionString,
  isPostgresAvailable,
} = require("./lib/render-api");
const { startScheduler, stopScheduler } = require("./lib/scheduler");
const fs = require("fs");

let mainWindow = null;
let pollCancel = false;

function sendLog(level, text) {
  const payload = {
    level: level || "info",
    text: String(text),
    timestamp: new Date().toISOString(),
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("log:line", payload);
  }
}

function onLogLine(line, level) {
  const inferred =
    level ||
    (line.startsWith("✔") || line.includes("✓")
      ? "success"
      : line.startsWith("✖") || /failed|error/i.test(line)
        ? "error"
        : "info");
  sendLog(inferred, line);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    title: "RelinkDB",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerIpc() {
  ipcMain.handle("shell:openExternal", async (_event, url) => {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
      return { ok: true };
    }
    throw new Error("Invalid URL");
  });

  ipcMain.handle("config:get", () => getConfig());

  ipcMain.handle("config:save", (_event, partial) => {
    const saved = saveConfig(partial || {});
    return saved;
  });

  ipcMain.handle("config:storePath", () => getStorePath());

  ipcMain.handle("config:pickBackupFile", async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Backup file location",
      defaultPath: getConfig().backupFile || path.join(app.getPath("documents"), "data.sql"),
      filters: [{ name: "SQL", extensions: ["sql"] }],
    });
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  });

  ipcMain.handle("config:test", async () => {
    const config = getConfig();
    if (!config.apiKey || !config.dbName) {
      throw new Error("Enter your API key and database name first, then save.");
    }
    try {
      const id = await findPostgresIdByName(config.apiKey, config.dbName, (line) =>
        onLogLine(line)
      );
      await getConnectionString(config.apiKey, id, (line) => onLogLine(line));
      return { ok: true, message: `Connected. Found database "${config.dbName}" (${id}).` };
    } catch (err) {
      onLogLine(`✖ ${err.message}`, "error");
      throw new Error(err.message);
    }
  });

  ipcMain.handle("tools:check", () => ({
    psql: hasBinary("psql"),
    pgDump: hasBinary("pg_dump"),
  }));

  ipcMain.handle("history:get", () => getHistory().slice(0, 5));

  ipcMain.handle("action:backup", async () => {
    const config = getConfig();
    if (!isConfigReadyForBackup(config)) {
      throw new Error("Configure API key, database name, and backup file path in Settings first.");
    }
    try {
      const summary = await pullLatestBackup(config, onLogLine);
      const now = new Date().toISOString();
      setLastBackupAt(now);
      appendHistory({
        timestamp: now,
        action: "backup",
        success: true,
        summary: summary.usedPgDump
          ? "Pulled with pg_dump"
          : `Pulled ${summary.tableCount ?? "?"} tables / ${summary.rowCount ?? "?"} rows`,
      });
      return { ok: true, lastBackupAt: now, summary };
    } catch (err) {
      appendHistory({
        action: "backup",
        success: false,
        summary: err.message?.split("\n")[0] || "Backup failed",
      });
      onLogLine(`✖ ${err.message}`, "error");
      throw new Error(err.message);
    }
  });

  ipcMain.handle("action:sync", async () => {
    const config = getConfig();
    if (!isConfigReadyForSync(config)) {
      throw new Error(
        "Configure API key, database name, web service ID, and backup file in Settings first."
      );
    }
    try {
      const result = await restoreAndRelink(config, onLogLine);
      appendHistory({
        action: "sync",
        success: true,
        summary: `Restored and relinked in ${result.elapsed}s`,
      });
      return {
        ok: true,
        webServiceId: result.webServiceId,
        dashboardUrl: `https://dashboard.render.com/web/${result.webServiceId}`,
      };
    } catch (err) {
      appendHistory({
        action: "sync",
        success: false,
        summary: err.message?.split("\n")[0] || "Restore failed",
      });
      onLogLine(`✖ ${err.message}`, "error");
      throw new Error(err.message);
    }
  });

  ipcMain.handle("action:openDashboard", async () => {
    const config = getConfig();
    if (!config.dbName) {
      throw new Error("Set a database name in Settings first so it can be copied to the clipboard.");
    }
    clipboard.writeText(config.dbName);
    onLogLine(`✓ Copied database name "${config.dbName}" to clipboard`, "success");
    await shell.openExternal("https://dashboard.render.com/new/database");
    onLogLine("→ Opened Render dashboard — paste the name into the New Postgres form", "info");
    return { ok: true, dbName: config.dbName };
  });

  ipcMain.handle("action:cancelPoll", () => {
    pollCancel = true;
    return { ok: true };
  });

  ipcMain.handle("action:pollNewDb", async () => {
    const config = getConfig();
    if (!config.apiKey || !config.dbName) {
      throw new Error("API key and database name are required to poll for the new database.");
    }

    pollCancel = false;
    const timeoutMs = 2 * 60 * 1000;
    const intervalMs = 4000;
    const started = Date.now();
    onLogLine(`→ Waiting for Postgres "${config.dbName}" to become available...`, "info");

    while (!pollCancel && Date.now() - started < timeoutMs) {
      try {
        const db = await findPostgresByName(config.apiKey, config.dbName);
        if (db) {
          const status = db.status || db.state || db.postgresStatus || "(no status field)";
          onLogLine(`  · Found ${db.name} (${db.id}) status=${status}`, "info");
          if (isPostgresAvailable(db)) {
            onLogLine("✔ New database is available", "success");
            return { ok: true, id: db.id, status, timedOut: false };
          }
        } else {
          onLogLine("  · Not found yet — keep creating it in the dashboard…", "info");
        }
      } catch (err) {
        onLogLine(`  · Poll error: ${err.message?.split("\n")[0]}`, "error");
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }

    if (pollCancel) {
      onLogLine("→ Polling cancelled — continuing anyway", "info");
      return { ok: true, timedOut: false, cancelled: true };
    }

    onLogLine("→ Timed out waiting for database — you can continue anyway", "info");
    return { ok: false, timedOut: true };
  });

  ipcMain.handle("action:pickSqlUpload", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Select SQL dump to restore",
      filters: [{ name: "SQL", extensions: ["sql"] }],
      properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths?.length) return null;

    const source = result.filePaths[0];
    const uploadsDir = path.join(app.getPath("userData"), "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });
    const dest = path.join(uploadsDir, `${Date.now()}.sql`);
    fs.copyFileSync(source, dest);
    onLogLine(`✓ Copied ${path.basename(source)} → ${dest}`, "success");
    return { filePath: dest, originalName: path.basename(source) };
  });

  ipcMain.handle("action:importSqlPath", async (_event, sourcePath) => {
    if (!sourcePath || typeof sourcePath !== "string") {
      throw new Error("No file path provided.");
    }
    if (!sourcePath.toLowerCase().endsWith(".sql")) {
      throw new Error("Only .sql files are supported.");
    }
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`File not found: ${sourcePath}`);
    }
    const uploadsDir = path.join(app.getPath("userData"), "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });
    const dest = path.join(uploadsDir, `${Date.now()}.sql`);
    fs.copyFileSync(sourcePath, dest);
    onLogLine(`✓ Copied ${path.basename(sourcePath)} → ${dest}`, "success");
    return { filePath: dest, originalName: path.basename(sourcePath) };
  });

  ipcMain.handle("action:sanitizeSql", async (_event, { filePath } = {}) => {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error("SQL file not found. Pick a file first.");
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const { cleaned, removedCount, removed } = sanitize(raw);
    fs.writeFileSync(filePath, cleaned, "utf8");
    onLogLine(
      `✓ Sanitized SQL — removed ${removedCount} provider-specific statement(s)`,
      "success"
    );
    return { filePath, removedCount, removed };
  });

  ipcMain.handle("action:restoreFromFile", async (_event, { filePath, dryRun = false } = {}) => {
    const config = getConfig();
    if (!config.apiKey || !config.dbName || !config.webServiceId) {
      throw new Error(
        "Configure API key, database name, and web service ID in Settings first."
      );
    }
    if (!filePath) {
      throw new Error("No SQL file selected.");
    }

    const kind = dryRun ? "dry_run" : "restore_file";
    try {
      const result = await restoreFromFile(config, { sourceFile: filePath, dryRun }, onLogLine);
      const details = {
        succeeded: result.succeeded,
        skippedHarmless: result.skippedHarmless,
        failed: result.failed,
      };
      appendHistory({
        action: kind,
        kind,
        success: result.success,
        summary: `${result.succeeded} ok · ${result.skippedHarmless} skipped · ${result.failed.length} failed`,
        details,
      });
      return {
        ok: result.success,
        dryRun,
        webServiceId: result.webServiceId,
        dashboardUrl: `https://dashboard.render.com/web/${result.webServiceId}`,
        details: {
          ...details,
          expectedRows: result.expectedRows,
          verification: result.verification,
          usedPsql: result.usedPsql,
        },
        elapsed: result.elapsed,
      };
    } catch (err) {
      appendHistory({
        action: kind,
        kind,
        success: false,
        summary: err.message?.split("\n")[0] || "Restore from file failed",
      });
      onLogLine(`✖ ${err.message}`, "error");
      throw new Error(err.message);
    }
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  startScheduler({
    onLog: (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("log:line", payload);
      }
    },
    onNotify: ({ title, body }) => {
      if (Notification.isSupported()) {
        new Notification({ title, body }).show();
      }
    },
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopScheduler();
  if (process.platform !== "darwin") app.quit();
});
