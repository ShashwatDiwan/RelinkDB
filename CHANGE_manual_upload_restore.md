# Change Request: Manual SQL Upload as a Restore Source

Add-on to the existing RelinkDB app. Assumes the app already has:
`db-backup`, `db-restore-and-relink` edge functions, a `render-db-backups`
Storage bucket, and a `backup_runs` table — reuse/extend these, don't
recreate them.

## Why

The normal flow assumes a live source DB to pull from before it expires.
That breaks when the free DB has already expired with no backup taken, or
when migrating from an external source (e.g. a Neon export). Both need
the same thing: restore from an arbitrary uploaded `.sql` file instead of
the auto-pulled snapshot.

## 1. Database change

Add one column to `backup_runs`:

```sql
alter table backup_runs add column if not exists details jsonb;
```

Stores a `{succeeded, skippedHarmless, failed}` summary per run (schema
below) so the history panel can show real per-run detail instead of
pass/fail.

## 2. New shared module: `supabase/functions/_shared/sql-runner.ts`

```typescript
// Naive but effective splitter: respects single-quoted strings and $$ dollar-quoted
// blocks (used by function/trigger bodies) so semicolons inside them aren't
// treated as statement boundaries. Doesn't handle every PL/pgSQL edge case —
// sufficient for typical table + data dumps; flag to the user if the source
// file contains custom functions/triggers, since those need manual review.
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inString = false;
  let inDollar = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    current += ch;

    if (!inString && sql.startsWith("$$", i)) {
      inDollar = !inDollar;
    } else if (!inDollar && ch === "'" && sql[i - 1] !== "\\") {
      inString = !inString;
    } else if (!inString && !inDollar && ch === ";") {
      statements.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements.filter((s) => s.length > 0 && !s.startsWith("--"));
}

const KNOWN_HARMLESS_ERROR_PATTERNS = [
  /role .* does not exist/i,
  /must be owner of/i,
  /extension .* already exists/i,
  /permission denied to set/i,
];

export type RunResult = {
  succeeded: number;
  skippedHarmless: number;
  failed: { statement: string; error: string }[];
};

export async function runStatements(
  sql: any, // postgres.js client instance
  statements: string[],
  { dryRun = false }: { dryRun?: boolean } = {}
): Promise<RunResult> {
  const result: RunResult = { succeeded: 0, skippedHarmless: 0, failed: [] };

  if (dryRun) await sql.unsafe("BEGIN");
  for (const stmt of statements) {
    try {
      await sql.unsafe(stmt);
      result.succeeded++;
    } catch (err) {
      const msg = String(err);
      if (KNOWN_HARMLESS_ERROR_PATTERNS.some((p) => p.test(msg))) {
        result.skippedHarmless++;
      } else {
        result.failed.push({ statement: stmt.slice(0, 200), error: msg });
      }
    }
  }
  if (dryRun) await sql.unsafe("ROLLBACK");

  return result;
}
```

## 3. New function: `supabase/functions/db-sanitize-sql/index.ts`

Strips provider-specific statements that don't apply to a different
Postgres host (pattern-based, not a full SQL parser — fine for
straightforward table/data dumps). Called right after upload, before the
user is offered Dry Run / Restore.

```typescript
const SAFE_TO_STRIP = [
  /^\s*ALTER\s+.+\s+OWNER\s+TO\s+.+;/gim,
  /^\s*SET\s+default_table_access_method\s*=.*;/gim,
  /^\s*COMMENT\s+ON\s+EXTENSION\s+.+;/gim,
  /^\s*GRANT\s+.+ON\s+SCHEMA\s+.+;/gim,
];
const EXTENSION_LINE = /^\s*CREATE\s+EXTENSION\s+(IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?.*;/gim;

function sanitize(sql: string) {
  const removed: string[] = [];
  let cleaned = sql;
  for (const pattern of SAFE_TO_STRIP) {
    cleaned = cleaned.replace(pattern, (match) => {
      removed.push(match.trim());
      return `-- [sanitized, non-portable] ${match.trim()}`;
    });
  }
  cleaned = cleaned.replace(EXTENSION_LINE, (match) =>
    /IF\s+NOT\s+EXISTS/i.test(match) ? match : match.replace(/CREATE\s+EXTENSION/i, "CREATE EXTENSION IF NOT EXISTS")
  );
  return { cleaned, removedCount: removed.length, removed };
}

Deno.serve(async (req) => {
  try {
    const { storageKey } = await req.json(); // e.g. "uploads/1721234567.sql"
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: file } = await admin.storage.from("render-db-backups").download(storageKey);
    const raw = await file!.text();
    const { cleaned, removedCount, removed } = sanitize(raw);

    await admin.storage.from("render-db-backups").upload(storageKey, new Blob([cleaned]), {
      upsert: true,
      contentType: "application/sql",
    });

    return Response.json({ success: true, removedCount, removed });
  } catch (err) {
    return Response.json({ success: false, error: String(err) }, { status: 500 });
  }
});
```

(Needs the same `import { createClient } from "npm:@supabase/supabase-js@2"` import as your other functions.)

## 4. Modify existing `db-restore-and-relink`

Accept two new optional body params: `sourceKey` (defaults to `"data.sql"`)
and `dryRun` (defaults to `false`). Replace the current single
`sql.unsafe(dumpText)` call with:

```typescript
import { splitStatements, runStatements } from "../_shared/sql-runner.ts";

// ...inside the handler, after downloading from `sourceKey` instead of hardcoded "data.sql":
const statements = splitStatements(dumpText);
const runResult = await runStatements(sql, statements, { dryRun });

await admin.from("backup_runs").insert({
  kind: dryRun ? "dry_run" : "restore",
  success: runResult.failed.length === 0,
  details: runResult,
});

// Only PATCH the backend's env var on a real (non-dry) run:
if (!dryRun) {
  // ...existing Render API PUT call, unchanged
}

return Response.json({ success: runResult.failed.length === 0, ...runResult });
```

## 5. UI change (Dashboard page)

Add a collapsed **"Restore from a file instead"** section below the
existing 3-step flow:

1. File picker/drop-zone, `.sql` only → uploads directly to
   `render-db-backups/uploads/<timestamp>.sql` via the Supabase client.
2. On upload complete, auto-call `db-sanitize-sql` with that `storageKey`;
   show the result: *"Removed N provider-specific statements"* with the
   list expandable.
3. Two buttons:
   - **Dry Run** → calls `db-restore-and-relink` with `{ sourceKey, dryRun: true }`.
   - **Restore from this file** → same call with `dryRun: false`, only
     enabled after at least one Dry Run has been run against this file
     (guard against skipping the safety check).
4. Results panel: *"X succeeded · Y skipped as harmless · Z failed"*,
   each failed entry expandable to show its statement + error text.

## Acceptance checklist

- [ ] Uploading `neon.sql` (or similar) runs the sanitize pass and reports
      what it stripped before any execution happens.
- [ ] Dry Run against the uploaded file changes nothing — verify by
      checking target DB row counts are identical before/after.
- [ ] A file with a deliberately malformed statement still completes the
      rest of the restore and reports the specific failure, rather than
      aborting everything after it.
- [ ] Restore-from-file still triggers the backend env var update + redeploy,
      same as the normal flow.
- [ ] History panel shows real per-run detail (succeeded/skipped/failed
      counts) for both dry runs and real restores, distinguishable by kind.
