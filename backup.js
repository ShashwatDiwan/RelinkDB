#!/usr/bin/env node
/**
 * CLI wrapper — prefer the Electron app (`npm start`). Kept for scripting.
 */
const { pullLatestBackup } = require("./lib/backup");
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const config = {
  apiKey: process.env.RENDER_API_KEY,
  dbName: process.env.RENDER_DB_NAME,
  backupFile: process.env.BACKUP_FILE || "./data.sql",
};

pullLatestBackup(config, (line) => console.log(line)).catch((err) => {
  console.error(`\n✖ ${err.message}\n`);
  process.exit(1);
});
