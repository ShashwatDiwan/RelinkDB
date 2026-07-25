#!/usr/bin/env node
/**
 * CLI wrapper — prefer the Electron app (`npm start`). Kept for scripting.
 */
const { restoreAndRelink } = require("./lib/sync");
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const config = {
  apiKey: process.env.RENDER_API_KEY,
  dbName: process.env.RENDER_DB_NAME,
  webServiceId: process.env.RENDER_WEB_SERVICE_ID,
  envVarKey: process.env.RENDER_ENV_VAR_KEY || "DATABASE_URL",
  backupFile: process.env.BACKUP_FILE || "./data.sql",
};

restoreAndRelink(config, (line) => console.log(line)).catch((err) => {
  console.error(`\n✖ ${err.message}\n`);
  process.exit(1);
});
