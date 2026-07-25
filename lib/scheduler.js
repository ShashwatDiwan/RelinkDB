const { pullLatestBackup } = require("./backup");
const {
  getConfig,
  setLastBackupAt,
  appendHistory,
  isConfigReadyForBackup,
} = require("./config-store");

const HOUR_MS = 60 * 60 * 1000;
let timer = null;
let running = false;

function startScheduler({ onLog, onNotify } = {}) {
  stopScheduler();

  const tick = async () => {
    if (running) return;
    const config = getConfig();
    if (!isConfigReadyForBackup(config)) return;

    const intervalDays = Number(config.autoBackupIntervalDays) || 3;
    const intervalMs = intervalDays * 24 * HOUR_MS;
    const last = config.lastBackupAt ? new Date(config.lastBackupAt).getTime() : 0;
    if (last && Date.now() - last < intervalMs) return;

    running = true;
    const log = (text, level = "info") => {
      if (onLog) onLog({ level, text, timestamp: new Date().toISOString() });
    };

    try {
      log(`→ Scheduled auto-backup starting (every ${intervalDays} day(s))...`, "info");
      await pullLatestBackup(config, (line) => log(line, "info"));
      const now = new Date().toISOString();
      setLastBackupAt(now);
      appendHistory({
        timestamp: now,
        action: "auto-backup",
        success: true,
        summary: "Scheduled backup completed",
      });
      log("✔ Scheduled backup completed", "success");
      if (onNotify) {
        onNotify({
          title: "Render DB Refresh",
          body: "Scheduled backup completed successfully.",
        });
      }
    } catch (err) {
      appendHistory({
        action: "auto-backup",
        success: false,
        summary: err.message?.split("\n")[0] || "Scheduled backup failed",
      });
      log(`✖ Scheduled backup failed: ${err.message}`, "error");
    } finally {
      running = false;
    }
  };

  // Check shortly after launch, then hourly
  setTimeout(tick, 15_000);
  timer = setInterval(tick, HOUR_MS);
}

function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { startScheduler, stopScheduler };
