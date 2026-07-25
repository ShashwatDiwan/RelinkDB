/**
 * Strip provider-specific statements that don't apply on a different Postgres host.
 * Pattern-based — fine for typical table/data dumps.
 */

const SAFE_TO_STRIP = [
  /^\s*ALTER\s+.+\s+OWNER\s+TO\s+.+;/gim,
  /^\s*SET\s+default_table_access_method\s*=.*;/gim,
  /^\s*SET\s+transaction_timeout\s*=.*;/gim,
  /^\s*COMMENT\s+ON\s+EXTENSION\s+.+;/gim,
  /^\s*GRANT\s+.+ON\s+SCHEMA\s+.+;/gim,
];

const EXTENSION_LINE =
  /^\s*CREATE\s+EXTENSION\s+(IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?.*;/gim;

/**
 * @param {string} sql
 * @returns {{ cleaned: string, removedCount: number, removed: string[] }}
 */
function sanitize(sql) {
  const removed = [];
  let cleaned = sql;
  for (const pattern of SAFE_TO_STRIP) {
    cleaned = cleaned.replace(pattern, (match) => {
      removed.push(match.trim());
      return `-- [sanitized, non-portable] ${match.trim()}`;
    });
  }
  cleaned = cleaned.replace(EXTENSION_LINE, (match) =>
    /IF\s+NOT\s+EXISTS/i.test(match)
      ? match
      : match.replace(/CREATE\s+EXTENSION/i, "CREATE EXTENSION IF NOT EXISTS")
  );
  return { cleaned, removedCount: removed.length, removed };
}

module.exports = { sanitize };
