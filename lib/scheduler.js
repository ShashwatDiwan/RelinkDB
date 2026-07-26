const { getConfig } = require("./config-store");
const { findPostgresByName } = require("./render-api");
const { HOUR_MS, getExpiryStatus } = require("./expiry");

let timer = null;
let running = false;
let lastNotifiedDbId = null;

function startScheduler({ onLog, onNotify, onRenewalReady } = {}) {
  stopScheduler();

  const tick = async () => {
    if (running) return;
    const config = getConfig();
    if (!config.apiKey || !config.dbName) return;

    let db = null;
    let expiry = { known: false, daysRemaining: null, nearExpiry: false };
    try {
      db = await findPostgresByName(config.apiKey, config.dbName);
      expiry = getExpiryStatus(db, Date.now());
    } catch (err) {
      if (onLog) {
        onLog({
          level: "warn",
          text: `Could not check Postgres age for expiry monitoring: ${err.message}`,
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }

    const log = (text, level = "info") => {
      if (onLog) onLog({ level, text, timestamp: new Date().toISOString() });
    };

    try {
      if (expiry.nearExpiry && db?.id) {
        running = true;
        const daysText = Math.max(0, Math.ceil(expiry.daysRemaining));
        if (lastNotifiedDbId !== db.id) {
          log(
            `â†’ Database is in the warning window (${daysText} day(s) left). Cloud export should already be running or completed.`,
            "warn"
          );
          lastNotifiedDbId = db.id;
          if (onNotify) {
            onNotify({
              title: "RelinkDB",
              body: "The Render DB is in the warning window. Create the replacement database now, then restore and relink.",
            });
          }
          if (onRenewalReady) {
            onRenewalReady({
              dbName: config.dbName,
              dbId: db.id,
              daysRemaining: daysText,
              expiresAt: expiry.expiresAt,
            });
          }
        }
      } else if (db?.id) {
        lastNotifiedDbId = null;
      }
    } catch (err) {
      log(`âœ– Expiry monitor failed: ${err.message}`, "error");
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
