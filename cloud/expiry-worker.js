require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { pullLatestBackup } = require("../lib/backup");
const { getExpiryStatus } = require("../lib/expiry");
const { findPostgresByName } = require("../lib/render-api");

const DEFAULT_CHECK_MS = 24 * 60 * 60 * 1000;
const STATE_FILE =
  process.env.RELINKDB_STATE_FILE || path.join(__dirname, "expiry-worker-state.json");

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      lastAutoExportDbId: parsed.lastAutoExportDbId || null,
      lastNotificationAt: parsed.lastNotificationAt || null,
      lastCheckAt: parsed.lastCheckAt || null,
    };
  } catch {
    return {
      lastAutoExportDbId: null,
      lastNotificationAt: null,
      lastCheckAt: null,
    };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function buildNotificationPayload({ config, db, expiry, backupResult }) {
  return {
    event: "renewal-ready",
    dbName: config.dbName,
    dbId: db.id,
    notificationEmail: config.notificationEmail || null,
    expiresAt: expiry.expiresAt,
    createdAt: expiry.createdAt,
    daysRemaining: Math.max(0, Math.ceil(expiry.daysRemaining)),
    hoursRemaining: Math.max(0, Math.ceil(expiry.hoursRemaining)),
    backupFile: config.backupFile,
    autoExported: Boolean(backupResult),
    backupSummary: backupResult
      ? {
          usedPgDump: Boolean(backupResult.usedPgDump),
          tableCount: backupResult.tableCount ?? null,
          rowCount: backupResult.rowCount ?? null,
        }
      : null,
    message:
      "The Render Postgres is in the warning window. Create the replacement database now, then restore and relink.",
  };
}

async function sendWebhook(url, payload) {
  if (!url) return false;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Webhook responded ${res.status} ${res.statusText}`);
  }
  return true;
}

async function runOnce() {
  const config = {
    apiKey: process.env.RENDER_API_KEY,
    dbName: process.env.RENDER_DB_NAME,
    backupFile: process.env.BACKUP_FILE || path.join(process.cwd(), "data.sql"),
    notificationEmail: process.env.RELINKDB_NOTIFICATION_EMAIL || null,
  };

  if (!config.apiKey || !config.dbName) {
    throw new Error("Missing RENDER_API_KEY or RENDER_DB_NAME.");
  }

  const state = loadState();
  const db = await findPostgresByName(config.apiKey, config.dbName);
  if (!db) {
    log(`No database named "${config.dbName}" found.`);
    state.lastCheckAt = new Date().toISOString();
    saveState(state);
    return;
  }

  const expiry = getExpiryStatus(db, Date.now());
  state.lastCheckAt = new Date().toISOString();

  if (!expiry.known) {
    log(`Found ${db.name} (${db.id}) but no creation timestamp was available.`);
    saveState(state);
    return;
  }

  if (!expiry.nearExpiry) {
    log(
      `DB ${db.name} (${db.id}) has ${Math.max(0, Math.ceil(expiry.daysRemaining))} day(s) left.`
    );
    saveState(state);
    return;
  }

  if (state.lastAutoExportDbId === db.id) {
    log(`Skipping export for ${db.id}; this cycle was already exported.`);
    saveState(state);
    return;
  }

  const daysText = Math.max(0, Math.ceil(expiry.daysRemaining));
  log(`DB expires in about ${daysText} day(s). Exporting backup now...`);
  const backupResult = await pullLatestBackup(config, (line, level) => {
    const prefix = level ? level.toUpperCase() : "INFO";
    log(`${prefix}: ${line}`);
  });

  const nowIso = new Date().toISOString();
  state.lastAutoExportDbId = db.id;
  state.lastNotificationAt = nowIso;
  saveState(state);

  const payload = buildNotificationPayload({ config, db, expiry, backupResult });
  const webhook = process.env.RELINKDB_NOTIFY_WEBHOOK;
  if (webhook) {
    await sendWebhook(webhook, payload);
    log("Notification webhook sent.");
  } else {
    log(`Notification payload: ${JSON.stringify(payload)}`);
  }
  log("Auto-export complete.");
}

async function main() {
  const mode = (process.argv[2] || "loop").toLowerCase();
  const checkMs = Number(process.env.RELINKDB_CHECK_MS) || DEFAULT_CHECK_MS;

  if (mode === "once") {
    await runOnce();
    return;
  }

  await runOnce();
  setInterval(() => {
    runOnce().catch((err) => log(`Worker error: ${err.message}`));
  }, checkMs);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
