# Build Brief: "RelinkDB" Desktop App

Hand this document to a coding agent (Claude Code, Cursor, etc.) as-is. It's
self-contained — the agent doesn't need any other context to build this.

---

## 1. Context

The user runs a backend on Render's **Free** tier. Render hard-deletes free
Postgres databases 30 days after creation, with no way to prevent it and no
way to create a replacement via the API on the Free tier (provisioning is
blocked; only paid plans can create infra via API). So every ~30 days the
user must:

1. Manually delete the expiring DB and create a new Free one in the Render
   **dashboard** (this step cannot be automated — accept that constraint,
   don't try to work around it via the API).
2. Pull the latest data out of the *old* DB before it's gone (new user
   signups / progress live there, not in a static seed file).
3. Restore that data into the *new* DB.
4. Point the backend web service's `DATABASE_URL` env var at the new DB and
   redeploy.

Steps 2–4 are already solved via the Render API + local Postgres tooling
(scripts included below, verified working). This brief is about wrapping
those in a local desktop GUI so the user runs buttons instead of terminal
commands, with a bit more automation layered on top.

## 2. Goal

A local Electron desktop app ("RelinkDB") with:

- A settings screen to store connection config (no more editing `.env` by
  hand).
- A one-screen dashboard with three clearly-sequenced actions: **Pull Data**
  → **Recreate DB (opens dashboard)** → **Restore & Relink**.
- Live log output in the UI instead of a terminal.
- A background scheduler that keeps `data.sql` automatically fresh so the
  user never has to remember to run the pull step manually.
- Sensible error states (missing `psql`/`pg_dump`, bad API key, DB not
  found, etc.) surfaced in plain language, not raw stack traces.

## 3. Non-goals

- **Do not** attempt to create/delete Postgres instances via the Render API.
  This is blocked on the Free tier and is explicitly meant to stay a manual
  dashboard step. The app's job is to make that one step feel small, not to
  eliminate it.
- No need for an installer/auto-updater. Running via `npm start` (i.e.
  `electron .`) launching a local app window is sufficient — this is a
  personal tool, not a distributed product.
- No multi-user/cloud sync. Single local user, single config.

## 4. Recommended stack

**Electron + vanilla HTML/CSS/JS (no React needed for something this small).**

Why Electron specifically: the existing backend logic (`child_process` calls
to `psql`/`pg_dump`, `fetch` calls to the Render API, `fs` reads/writes) is
plain Node.js. Electron's main process runs full Node with no sandboxing
friction, so that logic can be reused nearly verbatim as imported modules
instead of a CLI entrypoint. A browser-based alternative would hit CORS
issues calling the Render API directly and can't shell out to `psql`/
`pg_dump` at all.

```
relinkdb/
├── package.json
├── main.js                 # Electron main process — app lifecycle, IPC handlers
├── preload.js               # contextBridge — exposes a safe IPC API to the renderer
├── lib/
│   ├── render-api.js         # PROVIDED — reuse as-is (see §5)
│   ├── backup.js              # PROVIDED — refactor CLI script into an exported function
│   ├── sync.js                 # PROVIDED — refactor CLI script into an exported function
│   ├── config-store.js          # reads/writes local settings (see §7)
│   └── scheduler.js              # background auto-backup timer (see §9)
├── renderer/
│   ├── index.html
│   ├── settings.html
│   ├── styles.css
│   └── renderer.js            # UI logic, calls IPC handlers, renders log stream
└── BUILD_GUIDE.md (this file)
```

## 5. Provided code to reuse

The user already has a working CLI version of the backend logic — three
files. Port them into this project's `lib/` folder with these adjustments:

- **`lib/render-api.js`** — use unchanged. Exports `findPostgresIdByName`,
  `getConnectionString`, `renderRequest`, `fail`. (Note: `fail()` currently
  calls `process.exit(1)` — in the Electron version, replace calls to
  `fail()` with thrown `Error`s instead, so the main process can catch them
  and report to the UI instead of killing the whole app.)
- **`backup.js`** → refactor into `lib/backup.js` exporting an async
  function `pullLatestBackup(config, onLog)` where `onLog(line)` is a
  callback for streaming progress text to the UI (replace `console.log`
  calls with `onLog`). Keep the `pg_dump`-available check and the JS
  fallback dumper exactly as implemented.
- **`sync.js`** → same treatment, exporting `restoreAndRelink(config, onLog)`.

Below is the actual content of those three files as they exist today —
port them faithfully, just changing the I/O boundary as described above.

<details>
<summary>lib/render-api.js (reuse as-is, replace fail() semantics)</summary>

```javascript
const API_BASE = "https://api.render.com/v1";

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

async function renderRequest(apiKey, pathname, options = {}) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    fail(
      `Render API error ${res.status} on ${pathname}:\n${JSON.stringify(json, null, 2)}\n` +
        `Double check your RENDER_API_KEY and IDs.`
    );
  }
  return json;
}

async function findPostgresIdByName(apiKey, name) {
  console.log(`→ Looking up Postgres instance named "${name}"...`);
  const list = await renderRequest(apiKey, `/postgres?limit=100`);
  const items = Array.isArray(list) ? list : list.items || [];
  const normalized = items.map((it) => it.postgres || it);
  const matches = normalized.filter((db) => db.name === name);

  if (matches.length === 0) {
    console.error("Available Postgres instances in this account:");
    normalized.forEach((db) => console.error(`  - ${db.name} (${db.id})`));
    fail(`No Postgres instance named "${name}" found.`);
  }

  matches.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const chosen = matches[0];
  console.log(`  ✓ Found ${chosen.name} (${chosen.id})`);
  return chosen.id;
}

async function getConnectionString(apiKey, postgresId) {
  console.log("→ Fetching connection info...");
  const info = await renderRequest(apiKey, `/postgres/${postgresId}/connection-info`);

  const candidate =
    info.externalConnectionString ||
    info.externalUrl ||
    info.connectionInfo?.externalConnectionString ||
    (info.psqlCommand && info.psqlCommand.match(/postgres(?:ql)?:\/\/\S+/)?.[0]);

  if (!candidate) {
    console.error("Unexpected response shape from connection-info endpoint:");
    console.error(JSON.stringify(info, null, 2));
    fail(
      "Couldn't auto-extract the connection string. Open the JSON printed above, find the external " +
        "connection URL field, and update the `candidate` extraction logic in lib/render-api.js."
    );
  }
  console.log("  ✓ Got external connection string");
  return candidate;
}

module.exports = { fail, renderRequest, findPostgresIdByName, getConnectionString };
```

</details>

<details>
<summary>backup.js (refactor into pullLatestBackup())</summary>

```javascript
#!/usr/bin/env node
/**
 * render-db-backup — run BEFORE you delete the expiring Postgres
 * instance in the dashboard. Pulls a fresh dump (schema + data) from
 * the CURRENT live database into BACKUP_FILE, overwriting the old
 * static seed file so real user data survives the migration.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
require("dotenv").config();
const { fail, findPostgresIdByName, getConnectionString } = require("./lib/render-api");

const API_KEY = process.env.RENDER_API_KEY;
const DB_NAME = process.env.RENDER_DB_NAME;
const BACKUP_FILE = process.env.BACKUP_FILE || "./data.sql";

function requireEnv() {
  const missing = [];
  if (!API_KEY) missing.push("RENDER_API_KEY");
  if (!DB_NAME) missing.push("RENDER_DB_NAME");
  if (missing.length) fail(`Missing required .env values: ${missing.join(", ")}`);
}

function hasBinary(bin) {
  return spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
}

function dumpWithPgDump(connectionString) {
  console.log("→ Dumping with pg_dump...");
  const result = spawnSync(
    "pg_dump",
    [connectionString, "--no-owner", "--no-privileges", "--clean", "--if-exists", "-f", BACKUP_FILE],
    { stdio: "inherit" }
  );
  if (result.status !== 0) fail("pg_dump failed. See output above.");
  console.log(`  ✓ Wrote ${path.resolve(BACKUP_FILE)}`);
}

// --- Best-effort JS fallback when pg_dump isn't installed -----------------
// Reconstructs simple CREATE TABLE + INSERT statements via information_schema.
// Good enough for straightforward apps; does NOT capture indexes, foreign
// keys, sequences/auto-increment defaults, custom types, or triggers.
// Install pg_dump for anything beyond a simple schema.

function sqlEscape(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (Buffer.isBuffer(value)) return `'\\x${value.toString("hex")}'`;
  if (typeof value === "object") return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function dumpWithPgLibrary(connectionString) {
  console.log("→ pg_dump not found locally — reconstructing a basic dump via the pg library...");
  console.log("  NOTE: best-effort only — see README for what this fallback can't capture.");
  const { Client } = require("pg");
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();

  let out = "";
  try {
    const { rows: tables } = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );

    for (const { table_name: table } of tables) {
      console.log(`  · ${table}`);
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
      for (const row of dataRows) {
        const values = colNames.map((c) => sqlEscape(row[c])).join(", ");
        out += `INSERT INTO "${table}" (${colNames.map((c) => `"${c}"`).join(", ")}) VALUES (${values});\n`;
      }
      out += "\n";
    }

    fs.writeFileSync(BACKUP_FILE, out);
    console.log(`  ✓ Wrote ${path.resolve(BACKUP_FILE)} (${tables.length} tables)`);
  } finally {
    await client.end();
  }
}

async function main() {
  requireEnv();
  const postgresId = await findPostgresIdByName(API_KEY, DB_NAME);
  const connectionString = await getConnectionString(API_KEY, postgresId);

  if (hasBinary("pg_dump")) {
    dumpWithPgDump(connectionString);
  } else {
    await dumpWithPgLibrary(connectionString);
  }

  console.log("\n✔ Backup complete. Now go delete + recreate the DB in the dashboard, then run `npm run sync`.\n");
}

main().catch((err) => fail(err.stack || err.message));
```

</details>

<details>
<summary>sync.js (refactor into restoreAndRelink())</summary>

```javascript
#!/usr/bin/env node
/**
 * RelinkDB — run AFTER you manually create the new Free Postgres
 * instance in the Render dashboard (same name every time). See README.md.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
require("dotenv").config();
const { fail, renderRequest, findPostgresIdByName, getConnectionString } = require("./lib/render-api");

const API_KEY = process.env.RENDER_API_KEY;
const DB_NAME = process.env.RENDER_DB_NAME;
const WEB_SERVICE_ID = process.env.RENDER_WEB_SERVICE_ID;
const ENV_VAR_KEY = process.env.RENDER_ENV_VAR_KEY || "DATABASE_URL";
const BACKUP_FILE = process.env.BACKUP_FILE || "./data.sql";

function requireEnv() {
  const missing = [];
  if (!API_KEY) missing.push("RENDER_API_KEY");
  if (!DB_NAME) missing.push("RENDER_DB_NAME");
  if (!WEB_SERVICE_ID) missing.push("RENDER_WEB_SERVICE_ID");
  if (missing.length) fail(`Missing required .env values: ${missing.join(", ")}`);
  if (!fs.existsSync(BACKUP_FILE)) {
    fail(`Backup file not found at ${path.resolve(BACKUP_FILE)}. Run "npm run backup" first, or check BACKUP_FILE in .env.`);
  }
}

function hasBinary(bin) {
  return spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
}

function restoreWithPsql(connectionString) {
  console.log("→ Restoring backup with psql...");
  const result = spawnSync("psql", [connectionString, "-v", "ON_ERROR_STOP=1", "-f", BACKUP_FILE], {
    stdio: "inherit",
  });
  if (result.status !== 0) fail("psql restore failed. See output above.");
  console.log("  ✓ Restore complete");
}

async function restoreWithPgLibrary(connectionString) {
  console.log("→ psql not found locally — restoring via the pg library instead...");
  console.log("  NOTE: this fallback can't handle pg_dump's COPY-block format.");
  const { Client } = require("pg");
  const sql = fs.readFileSync(BACKUP_FILE, "utf8");
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(sql); // simple-query protocol supports multi-statement strings
    console.log("  ✓ Restore complete");
  } catch (err) {
    fail(
      `Restore failed: ${err.message}\n` +
        `If data.sql has "COPY ... FROM stdin" blocks, install psql, or regenerate with ` +
        `pg_dump --inserts --no-owner your_db > data.sql`
    );
  } finally {
    await client.end();
  }
}

async function updateBackendEnvVar(connectionString) {
  console.log(`→ Updating ${ENV_VAR_KEY} on web service ${WEB_SERVICE_ID}...`);
  await renderRequest(API_KEY, `/services/${WEB_SERVICE_ID}/env-vars/${ENV_VAR_KEY}`, {
    method: "PUT",
    body: JSON.stringify({ value: connectionString }),
  });
  console.log("  ✓ Env var updated — Render will auto-redeploy the service");
}

async function main() {
  const started = Date.now();
  requireEnv();

  const postgresId = await findPostgresIdByName(API_KEY, DB_NAME);
  const connectionString = await getConnectionString(API_KEY, postgresId);

  if (hasBinary("psql")) {
    restoreWithPsql(connectionString);
  } else {
    await restoreWithPgLibrary(connectionString);
  }

  await updateBackendEnvVar(connectionString);

  console.log(`\n✔ Done in ${((Date.now() - started) / 1000).toFixed(1)}s. Backend is redeploying.\n`);
}

main().catch((err) => fail(err.stack || err.message));
```

</details>

## 6. IPC contract (main ↔ renderer)

Use `contextBridge` in `preload.js` to expose a minimal API — don't enable
`nodeIntegration` in the renderer. Suggested channels:

| Channel | Direction | Payload | Purpose |
|---|---|---|---|
| `config:get` | renderer→main (invoke) | — | returns current saved config |
| `config:save` | renderer→main (invoke) | `{apiKey, dbName, webServiceId, envVarKey, backupFile, autoBackupIntervalDays}` | persist settings |
| `config:test` | renderer→main (invoke) | — | runs `findPostgresIdByName` + `getConnectionString`, returns success/error, used for a "Test Connection" button |
| `action:backup` | renderer→main (invoke) | — | runs `pullLatestBackup`, streams logs via `log:line` events, resolves/rejects on completion |
| `action:sync` | renderer→main (invoke) | — | runs `restoreAndRelink`, same log streaming |
| `action:openDashboard` | renderer→main (invoke) | — | opens `https://dashboard.render.com/new/database` in the default browser via `shell.openExternal`, and copies the configured DB name to the clipboard first (see §9) |
| `action:pollNewDb` | renderer→main (invoke) | — | polls Render API every few seconds for up to ~2 minutes waiting for a Postgres instance matching the configured name to reach `available` status; resolves when found/ready so the UI can auto-enable the "Restore & Relink" button |
| `log:line` | main→renderer (event) | `{level, text, timestamp}` | streamed log output during long-running actions |
| `tools:check` | renderer→main (invoke) | — | returns `{psql: bool, pgDump: bool}` so the UI can show an install nudge |

## 7. Settings storage

Use the `electron-store` npm package (simple JSON file in the OS user-data
dir, no setup needed) for everything except the Render API key.

For the API key specifically: **do not silently store a secret in plaintext
without telling the user.** Two acceptable approaches, pick one:

- **Simple (MVP-acceptable):** store it in the same `electron-store` JSON
  file, but show a one-time notice in the Settings screen: "Your API key is
  stored locally in plaintext at `<path>`. Don't share this file or commit
  it to version control."
- **Better (if time allows):** use the `keytar` package to store the API key
  in the OS credential store (macOS Keychain / Windows Credential Manager /
  Linux Secret Service) instead of a plain file.

Either is fine for a personal local tool; just be explicit in the UI about
which one was implemented so the user isn't surprised.

## 8. UI spec

### Settings screen
Form fields: Render API Key (password-masked input), Database Name, Web
Service ID, Env Var Key (default `DATABASE_URL`), Backup File Path (with a
native file picker), Auto-backup interval in days (default 3, see §9).
Buttons: **Test Connection** (calls `config:test`, shows a green check or
red error inline), **Save**.

### Main dashboard screen
- Status card at top: configured DB name, last successful backup timestamp
  (read from a small local log file, see below), tool availability
  (`psql`/`pg_dump` detected: yes/no, with a link to install instructions if
  no).
- Three big sequential action buttons, numbered, each disabled until the
  previous one has completed in the current session (but re-enterable —
  don't force a full app restart to redo a step):
  1. **Pull Latest Data** — runs `action:backup`. On success, shows
     timestamp and row/table counts if easily available.
  2. **Recreate Database** — runs `action:openDashboard` (opens browser,
     copies DB name to clipboard), then shows a "Waiting for new
     database…" spinner that calls `action:pollNewDb`. Once detected, this
     button's card turns green and step 3 unlocks automatically. Include a
     manual "I've created it, continue anyway" fallback button in case
     polling doesn't detect it (field-name/status uncertainty — see
     caveat below).
  3. **Restore & Relink** — runs `action:sync`. Shows final success state
     with a link to the backend service's Render dashboard page.
- A collapsible log panel at the bottom streaming `log:line` events in a
  monospace font, auto-scrolling, with basic color coding (info=gray,
  success=green, error=red).
- A small persistent local run history: append each run's
  `{timestamp, action, success, summary}` to a local JSON file (e.g.
  `run-history.json` next to the config) and show the last 5 entries in a
  collapsed "History" section.

## 9. Automation enhancements beyond the CLI version

- **Background auto-backup scheduler:** while the app is running (or, as a
  stretch goal, via `app.setLoginItemSettings` to launch at login and run
  minimized/in the tray), run `pullLatestBackup` automatically every N days
  (configurable, default 3) so `data.sql` is essentially always current —
  the user is never caught with a stale backup regardless of when they
  remember to act. Use a simple `setInterval` check against a stored
  "last run" timestamp rather than a cron dependency; check every hour
  whether the interval has elapsed. Log scheduled runs the same as manual
  ones.
- **Clipboard assist for step 2:** Render's dashboard doesn't support
  pre-filling the "New Postgres" form via URL params, so the next best
  thing is copying the configured DB name to the clipboard right before
  opening the browser, so the user can just paste it into the Name field
  instead of retyping/mistyping it (a mismatched name is the one thing that
  would break the whole automated chain downstream).
- **Optional OS notification** when a scheduled backup completes, and
  (stretch goal, only if a reliable expiration-date field turns up in the
  Postgres API response during implementation — see caveat below) a
  reminder notification a couple of days before expiry.

## 10. Known caveats to design around (don't treat these as bugs)

- **`connection-info` response field names aren't fully documented.** The
  provided `render-api.js` already tries several likely field names and
  throws a descriptive error with the raw JSON if none match. Surface that
  raw JSON in the UI's error state (not just "something went wrong") so the
  user (or the agent, in a follow-up session) can see the actual shape and
  patch the one extraction line.
- **No confirmed API field for "days until expiration."** Don't build the
  status card around a value that might not exist — treat any expiration
  countdown as a nice-to-have that gracefully hides itself if the field
  isn't present in the `GET /v1/postgres/{id}` response, rather than
  something the MVP depends on.
- **Polling for "new DB ready" in step 2** depends on the Postgres list
  endpoint exposing a status field (likely `status: "available"` or
  similar, based on Render's dashboard terminology) — verify the actual
  field name against a real API response during implementation and adjust,
  and always keep the manual "continue anyway" escape hatch described
  above so the flow never hard-blocks on a guessed field name.

## 11. Suggested build order

1. Scaffold Electron app (`main.js`, `preload.js`, minimal `index.html`)
   that just opens a blank window — confirm it runs via `npm start`.
2. Port `lib/render-api.js` unchanged; write a throwaway IPC test call to
   confirm `findPostgresIdByName` works against the user's real account.
3. Build the Settings screen + `config-store.js`; confirm save/reload works.
4. Wire `action:backup` end-to-end (button → IPC → `pullLatestBackup` →
   streamed logs in UI). Test against the user's live DB.
5. Wire `action:openDashboard` + clipboard copy.
6. Wire `action:pollNewDb`, verifying the real status field from the API.
7. Wire `action:sync` end-to-end.
8. Add run history + last-backup timestamp display.
9. Add the background scheduler.
10. Polish: log panel styling, disabled/enabled button states, error
    surfacing, tool-availability check (`tools:check`) with install
    instructions link.

## 12. Acceptance checklist

- [ ] App launches via `npm start` with no terminal usage required after
      initial `npm install`.
- [ ] Settings can be entered once and persist across restarts.
- [ ] "Pull Latest Data" successfully overwrites the configured backup file
      from the live DB and shows progress in the UI.
- [ ] "Recreate Database" opens the browser and copies the DB name to the
      clipboard.
- [ ] "Restore & Relink" successfully restores data into the new DB and
      updates the backend's env var (verify via the Render dashboard that
      a redeploy was triggered).
- [ ] A full end-to-end run (steps 1→2→3) takes under ~2 minutes of active
      user attention, matching the original CLI version's time savings.
- [ ] Missing `psql`/`pg_dump` is detected and clearly communicated, not a
      silent failure.
- [ ] API errors show the actual Render API error message, not a generic
      failure.
- [ ] Scheduler runs a backup automatically after the configured interval
      without the app needing to be manually triggered.
