const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { fail, findPostgresIdByName, getConnectionString } = require("./render-api");

function hasBinary(bin) {
  return spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
}

function dumpWithPgDump(connectionString, backupFile, onLog) {
  onLog("→ Dumping with pg_dump...");
  const result = spawnSync(
    "pg_dump",
    [connectionString, "--no-owner", "--no-privileges", "--clean", "--if-exists", "-f", backupFile],
    { encoding: "utf8" }
  );
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
  if (result.status !== 0) {
    fail(result.stderr?.trim() || "pg_dump failed. Install PostgreSQL client tools or check the connection.");
  }
  onLog(`  ✓ Wrote ${path.resolve(backupFile)}`);
}

function sqlEscape(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (Buffer.isBuffer(value)) return `'\\x${value.toString("hex")}'`;
  if (typeof value === "object") return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function dumpWithPgLibrary(connectionString, backupFile, onLog) {
  onLog("→ pg_dump not found locally — reconstructing a basic dump via the pg library...");
  onLog("  NOTE: best-effort only — indexes, foreign keys, sequences, and custom types are not captured.");
  const { Client } = require("pg");
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();

  let out = "";
  let tableCount = 0;
  let rowCount = 0;
  try {
    const { rows: tables } = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );

    for (const { table_name: table } of tables) {
      onLog(`  · ${table}`);
      tableCount += 1;
      const { rows: columns } = await client.query(
        `SELECT column_name, data_type, udt_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position`,
        [table]
      );
      const { rows: pkRows } = await client.query(
        `SELECT kcu.column_name FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         WHERE tc.table_schema = 'public' AND tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'`,
        [table]
      );
      const pkCols = pkRows.map((r) => r.column_name);

      const colDefs = columns.map((c) => {
        const type = c.data_type === "ARRAY" || c.data_type === "USER-DEFINED" ? c.udt_name : c.data_type;
        const notNull = c.is_nullable === "NO" ? " NOT NULL" : "";
        return `  "${c.column_name}" ${type}${notNull}`;
      });
      if (pkCols.length) colDefs.push(`  PRIMARY KEY (${pkCols.map((c) => `"${c}"`).join(", ")})`);

      out += `DROP TABLE IF EXISTS "${table}" CASCADE;\n`;
      out += `CREATE TABLE "${table}" (\n${colDefs.join(",\n")}\n);\n\n`;

      const colNames = columns.map((c) => c.column_name);
      const { rows: dataRows } = await client.query(`SELECT * FROM "${table}"`);
      rowCount += dataRows.length;
      for (const row of dataRows) {
        const values = colNames.map((c) => sqlEscape(row[c])).join(", ");
        out += `INSERT INTO "${table}" (${colNames.map((c) => `"${c}"`).join(", ")}) VALUES (${values});\n`;
      }
      out += "\n";
    }

    fs.writeFileSync(backupFile, out);
    onLog(`  ✓ Wrote ${path.resolve(backupFile)} (${tableCount} tables, ${rowCount} rows)`);
    return { tableCount, rowCount };
  } finally {
    await client.end();
  }
}

/**
 * @param {{ apiKey: string, dbName: string, backupFile: string }} config
 * @param {(line: string, level?: string) => void} onLog
 */
async function pullLatestBackup(config, onLog = () => {}) {
  const { apiKey, dbName, backupFile } = config;
  const missing = [];
  if (!apiKey) missing.push("API key");
  if (!dbName) missing.push("database name");
  if (!backupFile) missing.push("backup file path");
  if (missing.length) fail(`Missing required settings: ${missing.join(", ")}`);

  const dir = path.dirname(path.resolve(backupFile));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const postgresId = await findPostgresIdByName(apiKey, dbName, onLog);
  const connectionString = await getConnectionString(apiKey, postgresId, onLog);

  let summary = { usedPgDump: false, tableCount: null, rowCount: null };

  if (hasBinary("pg_dump")) {
    dumpWithPgDump(connectionString, backupFile, onLog);
    summary.usedPgDump = true;
  } else {
    const counts = await dumpWithPgLibrary(connectionString, backupFile, onLog);
    summary = { ...summary, ...counts };
  }

  onLog("✔ Backup complete. Next: recreate the DB in the Render dashboard, then Restore & Relink.");
  return summary;
}

module.exports = { pullLatestBackup, hasBinary };
