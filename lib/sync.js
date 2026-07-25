const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { fail, renderRequest, findPostgresIdByName, getConnectionString } = require("./render-api");
const { hasBinary } = require("./backup");
const {
  splitStatements,
  runStatements,
  countDataRowsInSql,
  findUnexpandedCopyBlocks,
  queryPublicTableCounts,
  WIPE_PUBLIC_SQL,
} = require("./sql-runner");

function logPsqlOutput(result, onLog) {
  if (result.stdout) {
    result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => onLog(line));
  }
  if (result.stderr) {
    result.stderr
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => onLog(line));
  }
}

function runPsql(connectionString, args, onLog) {
  const result = spawnSync("psql", [connectionString, ...args], { encoding: "utf8" });
  logPsqlOutput(result, onLog);
  return result;
}

function wipePublicSchema(connectionString, onLog) {
  onLog("→ Clearing existing public schema objects before restore...");
  const result = runPsql(connectionString, ["-v", "ON_ERROR_STOP=1", "-c", WIPE_PUBLIC_SQL], onLog);
  if (result.status !== 0) {
    fail(result.stderr?.trim() || "Failed to clear public schema before restore.");
  }
  onLog("  ✓ Public schema cleared");
}

function restoreWithPsql(connectionString, backupFile, onLog) {
  onLog("→ Restoring backup with psql...");
  const result = runPsql(
    connectionString,
    ["-v", "ON_ERROR_STOP=1", "-f", backupFile],
    onLog
  );
  if (result.status !== 0) {
    fail(
      result.stderr?.trim() ||
        "psql restore failed. Install PostgreSQL client tools or check the backup file."
    );
  }
  onLog("  ✓ Restore complete");
}

async function restoreWithPgLibrary(connectionString, backupFile, onLog) {
  onLog("→ psql not found locally — restoring via the pg library instead...");
  onLog("  NOTE: COPY blocks are converted to INSERTs; install psql for best results.");

  const dumpText = fs.readFileSync(backupFile, "utf8");
  const unexpanded = findUnexpandedCopyBlocks(dumpText);
  if (unexpanded.length) {
    fail(
      `${unexpanded.length} COPY block(s) could not be parsed for the pg fallback. ` +
        `Install psql and retry, or re-export with pg_dump --inserts.`
    );
  }

  const statements = splitStatements(dumpText);
  const { Client } = require("pg");
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    onLog("→ Clearing existing public schema objects before restore...");
    await client.query(WIPE_PUBLIC_SQL);
    onLog("  ✓ Public schema cleared");

    const runResult = await runStatements(client, statements, { dryRun: false });
    onLog(
      `  · ${runResult.succeeded} succeeded · ${runResult.skippedHarmless} skipped (harmless) · ${runResult.failed.length} failed`
    );
    if (runResult.failed.length) {
      for (const f of runResult.failed.slice(0, 5)) {
        onLog(`  ✖ ${f.error}`, "error");
      }
      fail(`Restore failed: ${runResult.failed.length} statement(s) errored.`);
    }
    onLog("  ✓ Restore complete");
  } finally {
    await client.end();
  }
}

async function verifyRestoredData(connectionString, expectedRows, onLog) {
  onLog("→ Verifying row counts in restored database...");
  const { counts, total } = await queryPublicTableCounts(connectionString);
  for (const [table, n] of Object.entries(counts)) {
    onLog(`  · ${table}: ${n} row(s)`);
  }
  onLog(`  · total: ${total} row(s) across ${Object.keys(counts).length} table(s)`);

  if (expectedRows > 0 && total === 0) {
    fail(
      `Restore finished but the database has 0 rows while the source file had ~${expectedRows}. ` +
        `Data was not loaded — backend env var was NOT updated.`
    );
  }

  return { counts, total };
}

async function updateBackendEnvVar(apiKey, webServiceId, envVarKey, connectionString, onLog) {
  const safeEnvVarKey = encodeURIComponent(envVarKey);
  onLog(`→ Updating ${envVarKey} on web service ${webServiceId}...`);
  await renderRequest(apiKey, `/services/${webServiceId}/env-vars/${safeEnvVarKey}`, {
    method: "PUT",
    body: JSON.stringify({ value: connectionString }),
  });
  onLog("  ✓ Env var updated");

  onLog("→ Triggering a redeploy so the backend picks up the new config...");
  await renderRequest(apiKey, `/services/${webServiceId}/deploys`, {
    method: "POST",
    body: JSON.stringify({ deployMode: "deploy_only" }),
  });
  onLog("  ✓ Redeploy queued on Render");
}

function readSqlFile(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`SQL file not found at ${path.resolve(filePath)}.`);
  }
  const dumpText = fs.readFileSync(filePath, "utf8");
  if (!dumpText.trim()) {
    fail("SQL file is empty.");
  }
  return dumpText;
}

/**
 * @param {{ apiKey: string, dbName: string, webServiceId: string, envVarKey?: string, backupFile: string }} config
 * @param {(line: string, level?: string) => void} onLog
 */
async function restoreAndRelink(config, onLog = () => {}) {
  const started = Date.now();
  const {
    apiKey,
    dbName,
    webServiceId,
    envVarKey = "DATABASE_URL",
    backupFile,
  } = config;

  const missing = [];
  if (!apiKey) missing.push("API key");
  if (!dbName) missing.push("database name");
  if (!webServiceId) missing.push("web service ID");
  if (!backupFile) missing.push("backup file path");
  if (missing.length) fail(`Missing required settings: ${missing.join(", ")}`);

  const dumpText = readSqlFile(backupFile);
  const expectedRows = countDataRowsInSql(dumpText);
  onLog(`→ Backup file has ~${expectedRows} data row(s)`);
  if (expectedRows === 0) {
    fail(
      `Backup file contains no COPY/INSERT data (schema only). ` +
        `Run "Pull Latest Data" from a populated database before restoring.`
    );
  }

  const postgresId = await findPostgresIdByName(apiKey, dbName, onLog);
  const connectionString = await getConnectionString(apiKey, postgresId, onLog);

  if (hasBinary("psql")) {
    restoreWithPsql(connectionString, backupFile, onLog);
  } else {
    await restoreWithPgLibrary(connectionString, backupFile, onLog);
  }

  const verification = await verifyRestoredData(connectionString, expectedRows, onLog);
  await updateBackendEnvVar(apiKey, webServiceId, envVarKey, connectionString, onLog);

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  onLog(`✔ Done in ${elapsed}s. Backend is redeploying.`);
  return { elapsed, webServiceId, verification };
}

/**
 * Restore from an arbitrary uploaded SQL file.
 * Uses psql when available (required for reliable Neon/pg_dump COPY restores).
 * @param {{ apiKey: string, dbName: string, webServiceId: string, envVarKey?: string }} config
 * @param {{ sourceFile: string, dryRun?: boolean }} options
 * @param {(line: string, level?: string) => void} onLog
 */
async function restoreFromFile(config, { sourceFile, dryRun = false }, onLog = () => {}) {
  const started = Date.now();
  const { apiKey, dbName, webServiceId, envVarKey = "DATABASE_URL" } = config;

  const missing = [];
  if (!apiKey) missing.push("API key");
  if (!dbName) missing.push("database name");
  if (!webServiceId) missing.push("web service ID");
  if (!sourceFile) missing.push("source SQL file");
  if (missing.length) fail(`Missing required settings: ${missing.join(", ")}`);

  const dumpText = readSqlFile(sourceFile);
  const expectedRows = countDataRowsInSql(dumpText);
  onLog(`→ Source file has ~${expectedRows} data row(s)`);
  if (expectedRows === 0) {
    onLog(
      "  ⚠ Warning: file appears to contain schema only — restore will create empty tables.",
      "error"
    );
  }

  const postgresId = await findPostgresIdByName(apiKey, dbName, onLog);
  const connectionString = await getConnectionString(apiKey, postgresId, onLog);

  let runResult = { succeeded: 0, skippedHarmless: 0, failed: [], usedPsql: false };
  let verification = null;

  if (!dryRun && hasBinary("psql")) {
    runResult.usedPsql = true;
    onLog(`→ Restoring ${path.basename(sourceFile)} with psql (native COPY support)...`);
    wipePublicSchema(connectionString, onLog);
    restoreWithPsql(connectionString, sourceFile, onLog);
  } else {
    const unexpanded = findUnexpandedCopyBlocks(dumpText);
    if (unexpanded.length) {
      fail(
        `${unexpanded.length} COPY block(s) could not be parsed. ` +
          (hasBinary("psql")
            ? "Unexpected — report this bug."
            : "Install psql for reliable restores, or re-export with pg_dump --inserts.")
      );
    }

    const statements = splitStatements(dumpText);
    onLog(
      `→ ${dryRun ? "Dry run" : "Restoring"} ${statements.length} statement(s) via pg library...`
    );

    if (/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION|CREATE\s+TRIGGER/i.test(dumpText)) {
      onLog(
        "  NOTE: file appears to contain functions/triggers — review failures carefully."
      );
    }

    const { Client } = require("pg");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();

    const statementsWithWipe = [WIPE_PUBLIC_SQL, ...statements];
    try {
      runResult = {
        ...(await runStatements(client, statementsWithWipe, { dryRun })),
        usedPsql: false,
      };
    } finally {
      await client.end();
    }

    onLog(
      `  · ${runResult.succeeded} succeeded · ${runResult.skippedHarmless} skipped (harmless) · ${runResult.failed.length} failed`
    );

    if (runResult.failed.length) {
      for (const f of runResult.failed.slice(0, 5)) {
        onLog(`  ✖ ${f.error}`, "error");
      }
      if (runResult.failed.length > 5) {
        onLog(`  … and ${runResult.failed.length - 5} more failure(s)`, "error");
      }
    }
  }

  if (!dryRun) {
    if (runResult.failed.length > 0) {
      fail(
        `Restore had ${runResult.failed.length} failed statement(s). Backend env var was NOT updated.`
      );
    }

    verification = await verifyRestoredData(connectionString, expectedRows, onLog);
    await updateBackendEnvVar(apiKey, webServiceId, envVarKey, connectionString, onLog);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    onLog(`✔ Restore from file done in ${elapsed}s. Backend is redeploying.`);
  } else {
    onLog("✔ Dry run complete — nothing was committed to the database.");
  }

  return {
    ...runResult,
    webServiceId,
    dryRun,
    expectedRows,
    verification,
    success: dryRun ? runResult.failed.length === 0 : true,
    elapsed: ((Date.now() - started) / 1000).toFixed(1),
  };
}

module.exports = { restoreAndRelink, restoreFromFile };
