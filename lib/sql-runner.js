/**
 * Split SQL into executable statements.
 * Respects line comments (--), block comments, quoted strings (with doubled quotes),
 * dollar-quotes, and COPY ... FROM stdin ... \\. data blocks.
 */

function readDollarTag(sql, i) {
  if (sql[i] !== "$") return null;
  let j = i + 1;
  while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
  if (j < sql.length && sql[j] === "$") {
    return sql.slice(i, j + 1);
  }
  if (j === i + 1 && sql[j] === "$") {
    return "$$";
  }
  return null;
}

function sqlStringLiteral(value) {
  if (value === "\\N" || value === null) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Convert pg_dump COPY ... FROM stdin; ... \. blocks into INSERT statements
 * so the pg simple-query protocol can run them.
 */
const COPY_BLOCK_RE =
  /COPY\s+([\s\S]+?)\s+FROM\s+stdin\s*;\r?\n([\s\S]*?)\\.(?=\r?\n|$)/gi;

function copyBlockToInserts(targetRaw, data) {
  const target = targetRaw.trim();
  const paren = target.indexOf("(");
  const table = paren < 0 ? target : target.slice(0, paren).trim();
  const cols = paren < 0 ? "" : target.slice(paren);
  const lines = data.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return "";
  return lines
    .map((line) => {
      const fields = line.split("\t").map(sqlStringLiteral);
      return cols
        ? `INSERT INTO ${table} ${cols} VALUES (${fields.join(", ")});`
        : `INSERT INTO ${table} VALUES (${fields.join(", ")});`;
    })
    .join("\n");
}

function expandCopyBlocks(sql) {
  return sql.replace(COPY_BLOCK_RE, (_match, targetRaw, data) => {
    const inserts = copyBlockToInserts(targetRaw, data);
    return inserts ? `${inserts}\n` : "";
  });
}

/** Count data rows in COPY blocks and INSERT statements within a dump file. */
function countDataRowsInSql(sql) {
  let copyRows = 0;
  const re = new RegExp(COPY_BLOCK_RE.source, COPY_BLOCK_RE.flags);
  let match;
  while ((match = re.exec(sql)) !== null) {
    copyRows += match[2].split(/\r?\n/).filter((l) => l.length > 0).length;
  }
  const insertRows = (sql.match(/^\s*INSERT\s+INTO\s+/gim) || []).length;
  return copyRows + insertRows;
}

/** Return unreplaced COPY ... FROM stdin blocks (pg library cannot run these). */
function findUnexpandedCopyBlocks(sql) {
  const expanded = expandCopyBlocks(sql);
  return expanded.match(/COPY\s+.+\s+FROM\s+stdin/gi) || [];
}

function splitStatements(sql) {
  const expanded = expandCopyBlocks(sql);
  const statements = [];
  let current = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag = null;

  for (let i = 0; i < expanded.length; i++) {
    const ch = expanded[i];
    const next = expanded[i + 1];

    if (inLineComment) {
      current += ch;
      if (ch === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      current += ch;
      if (ch === "*" && next === "/") {
        current += next;
        i++;
        inBlockComment = false;
      }
      continue;
    }

    if (dollarTag) {
      if (expanded.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length - 1;
        dollarTag = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (inString) {
      current += ch;
      if (ch === "'") {
        if (next === "'") {
          current += next;
          i++;
        } else {
          inString = false;
        }
      }
      continue;
    }

    if (ch === "-" && next === "-") {
      current += "--";
      i++;
      inLineComment = true;
      continue;
    }
    if (ch === "/" && next === "*") {
      current += "/*";
      i++;
      inBlockComment = true;
      continue;
    }
    if (ch === "'") {
      current += ch;
      inString = true;
      continue;
    }
    const tag = readDollarTag(expanded, i);
    if (tag) {
      current += tag;
      i += tag.length - 1;
      dollarTag = tag;
      continue;
    }

    current += ch;
    if (ch === ";") {
      const trimmed = stripLeadingComments(current.trim());
      if (trimmed && !isCommentOnly(trimmed)) {
        statements.push(trimmed);
      }
      current = "";
    }
  }

  const tail = stripLeadingComments(current.trim());
  if (tail && !isCommentOnly(tail)) statements.push(tail);

  return statements;
}

function isCommentOnly(stmt) {
  const lines = stmt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => l.startsWith("--") || (l.startsWith("/*") && l.endsWith("*/")));
}

function stripLeadingComments(stmt) {
  const lines = stmt.split(/\r?\n/);
  while (lines.length) {
    const t = lines[0].trim();
    if (!t || t.startsWith("--")) {
      lines.shift();
      continue;
    }
    break;
  }
  return lines.join("\n").trim();
}

const KNOWN_HARMLESS_ERROR_PATTERNS = [
  /role .* does not exist/i,
  /must be owner of/i,
  /extension .* already exists/i,
  /permission denied to set/i,
  /unrecognized configuration parameter/i,
];

const WIPE_PUBLIC_SQL = `
DO $wipe$
DECLARE r RECORD;
BEGIN
  FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename);
  END LOOP;
  FOR r IN (SELECT c.relname AS sequencename
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'S') LOOP
    EXECUTE format('DROP SEQUENCE IF EXISTS public.%I CASCADE', r.sequencename);
  END LOOP;
END
$wipe$;`.trim();

/**
 * @param {import("pg").Client} client
 * @param {string[]} statements
 * @param {{ dryRun?: boolean }} [options]
 */
async function runStatements(client, statements, { dryRun = false } = {}) {
  const result = { succeeded: 0, skippedHarmless: 0, failed: [] };

  if (dryRun) await client.query("BEGIN");

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const sp = `sp_${i}`;
    if (dryRun) {
      try {
        await client.query(`SAVEPOINT ${sp}`);
      } catch {
        /* ignore */
      }
    }
    try {
      await client.query(stmt);
      result.succeeded++;
      if (dryRun) {
        try {
          await client.query(`RELEASE SAVEPOINT ${sp}`);
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      const msg = String(err?.message || err);
      if (dryRun) {
        try {
          await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        } catch {
          /* ignore */
        }
      }
      if (KNOWN_HARMLESS_ERROR_PATTERNS.some((p) => p.test(msg))) {
        result.skippedHarmless++;
      } else {
        result.failed.push({ statement: stmt.slice(0, 200), error: msg });
      }
    }
  }

  if (dryRun) await client.query("ROLLBACK");

  return result;
}

/**
 * @param {string} connectionString
 * @returns {Promise<{ counts: Record<string, number>, total: number }>}
 */
async function queryPublicTableCounts(connectionString) {
  const { Client } = require("pg");
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const { rows: tables } = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
    );
    const counts = {};
    let total = 0;
    for (const { tablename } of tables) {
      const safe = tablename.replace(/"/g, '""');
      const res = await client.query(`SELECT COUNT(*)::int AS n FROM public."${safe}"`);
      counts[tablename] = res.rows[0].n;
      total += res.rows[0].n;
    }
    return { counts, total };
  } finally {
    await client.end();
  }
}

module.exports = {
  splitStatements,
  runStatements,
  expandCopyBlocks,
  countDataRowsInSql,
  findUnexpandedCopyBlocks,
  queryPublicTableCounts,
  WIPE_PUBLIC_SQL,
  KNOWN_HARMLESS_ERROR_PATTERNS,
};
