const { pullLatestBackup } = require("./backup");
const {
  getConfig,
  setLastBackupAt,
  setLastAutoExportDbId,
  appendHistory,
  isConfigReadyForBackup,
} = require("./config-store");
const { findPostgresByName } = require("./render-api");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DB_LIFETIME_DAYS = 30;
const AUTO_EXPORT_LEAD_DAYS = 3;
let timer = null;
let running = false;

function getCreatedAtMs(db) {
  const value =
    db?.createdAt ||
    db?.created_at ||
    db?.created ||
    db?.createdTime ||
    db?.created_time;
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
}

function startScheduler({ onLog, onNotify, onRenewalReady } = {}) {
  stopScheduler();

  const tick = async () => {
    if (running) return;
    const config = getConfig();
    if (!isConfigReadyForBackup(config)) return;

    const intervalDays = Number(config.autoBackupIntervalDays) || 3;
    const intervalMs = intervalDays * 24 * HOUR_MS;
    const last = config.lastBackupAt ? new Date(config.lastBackupAt).getTime() : 0;
    const now = Date.now();

    let db = null;
    let createdAtMs = null;
    let daysRemaining = null;
    try {
      db = await findPostgresByName(config.apiKey, config.dbName);
      createdAtMs = getCreatedAtMs(db);
      if (createdAtMs) {
        const expiresAtMs = createdAtMs + DB_LIFETIME_DAYS * DAY_MS;
        daysRemaining = (expiresAtMs - now) / DAY_MS;
      }
    } catch (err) {
      if (onLog) {
        onLog({
          level: "warn",
          text: `Could not check Postgres age for expiry monitoring: ${err.message}`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    const nearExpiry =
      Number.isFinite(daysRemaining) &&
      daysRemaining !== null &&
      daysRemaining <= AUTO_EXPORT_LEAD_DAYS &&
      daysRemaining > 0;

    if (nearExpiry && db?.id && config.lastAutoExportDbId !== db.id) {
      running = true;
      const log = (text, level = "info") => {
        if (onLog) onLog({ level, text, timestamp: new Date().toISOString() });
      };

      try {
        const daysText = Math.max(0, Math.ceil(daysRemaining));
        log(
          `→ Database expires in about ${daysText} day(s). Auto-exporting a fresh backup now...`,
          "warn"
        );
        await pullLatestBackup(config, (line) => log(line, "info"));
        const nowIso = new Date().toISOString();
        setLastBackupAt(nowIso);
        setLastAutoExportDbId(db.id);
        appendHistory({
          timestamp: nowIso,
          action: "auto-export",
          success: true,
          summary: `Auto-exported while ${daysText} day(s) remained`,
        });
        log(
          "✓ Auto-export complete. Create the new Render DB next, then restore and relink.",
          "success"
        );
        if (onNotify) {
          onNotify({
            title: "RelinkDB",
            body: "Auto-export is done. Create the new Render DB now, then restore and relink.",
          });
        }
        if (onRenewalReady) {
          onRenewalReady({
            dbName: config.dbName,
            dbId: db.id,
            daysRemaining: Math.max(0, Math.ceil(daysRemaining)),
          });
        }
      } catch (err) {
        appendHistory({
          action: "auto-export",
          success: false,
          summary: err.message?.split("\n")[0] || "Auto-export failed",
        });
        log(`✖ Auto-export failed: ${err.message}`, "error");
      } finally {
        running = false;
      }
      return;
    }

    if (last && now - last < intervalMs) return;

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
