# RelinkDB

Cuts the monthly "Render free Postgres expired" chore down to about
two minutes: one manual click-through in the dashboard, then two commands.

## Why this works despite the free-tier API restrictions

Render blocks **provisioning** new infrastructure (creating a database or
service) via the API on the Free tier — that part really does have to
stay manual. But **reading** an existing database's data/connection info
and **updating** an existing service's env vars are unrestricted,
regardless of plan:

- `GET /v1/postgres/{id}/connection-info` → full connection string
- `PUT /v1/services/{id}/env-vars/{key}` → updates the var and triggers
  an automatic redeploy
- Direct Postgres access (`pg_dump`/`psql`) to the still-alive database →
  full read/write, no Render API involved at all

This script chains those together with local dump/restore steps, so the
only thing left for you to do by hand is the "New Postgres" click.

## One-time setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

- **RENDER_API_KEY** — Account Settings → API Keys → Create API Key
- **RENDER_DB_NAME** — pick a name (e.g. `myapp-db`) and reuse it *every
  time* you recreate the database. Both scripts find "the current DB" by
  this name.
- **RENDER_WEB_SERVICE_ID** — open your backend service in the Render
  dashboard; the ID (`srv-...`) is in the URL. Or `GET /v1/services`.
- **RENDER_ENV_VAR_KEY** — env var your app reads the DB URL from
  (defaults to `DATABASE_URL`).
- **BACKUP_FILE** — path to `data.sql` (this file gets overwritten each
  month with fresh data — see below).

## Monthly workflow (do this a few days before expiration, not after)

The order matters: **pull data from the old DB while it's still alive**,
*then* delete it.

1. **Terminal — pull fresh data (~10–30s):**
   ```bash
   npm run backup
   ```
   Connects to your *current* (still-running) database and overwrites
   `data.sql` with everything in it right now — including any users who
   signed up and any progress they've made. This replaces the old idea
   of a static seed file.

2. **Dashboard — recreate the DB (manual, ~30–45s):** Delete the
   (now backed-up) database. Click **New → Postgres**, use the *same
   name* as `RENDER_DB_NAME` in `.env`, choose **Free**, click **Create**.
   Don't bother copying any credentials.

3. **Terminal — restore + relink (~10–20s):**
   ```bash
   npm run sync
   ```
   Finds the new instance, restores the `data.sql` you just pulled in
   step 1, and updates your backend's env var — which redeploys
   automatically.

Total hands-on time: about two minutes, only one of which is you
clicking around in the dashboard.

### Timing note

Because free databases get a 14-day grace period before actual deletion
(they just become inaccessible while expired), do this *before* the
30-day mark, not after — you want to pull from a database that's still
answering queries. Render emails you as the expiration approaches, or
set your own reminder ~2 days early to be safe.

## About the dump/restore tooling

**Best case:** install the Postgres client tools once, and both scripts
use the real `pg_dump`/`psql` binaries — fully reliable, handles any
schema complexity (foreign keys, indexes, sequences, custom types).

```bash
# macOS
brew install libpq && brew link --force libpq

# Ubuntu/Debian
sudo apt-get install postgresql-client

# Windows
# Install via https://www.postgresql.org/download/windows/ (client-only
# option), or `scoop install postgresql`
```

**Without them:** both scripts fall back to pure-JS versions using the
`pg` npm library:

- `backup.js` fallback reconstructs a *basic* dump via
  `information_schema` — table names, columns, types, primary keys, and
  all row data as `INSERT` statements. It does **not** capture indexes,
  foreign keys, sequence/auto-increment defaults, custom types, or
  triggers. Fine for a simple app; not a substitute for `pg_dump` if
  your schema has any of that.
- `sync.js` fallback restores plain SQL fine, but can't handle
  `pg_dump`'s default `COPY ... FROM stdin` format — a non-issue if
  `backup.js` produced the file (its fallback never emits `COPY`), but
  matters if you ever hand-craft or import a dump from elsewhere.

Bottom line: the fallbacks make the whole loop work with zero extra
installs, but installing `postgresql-client` once removes every caveat
above and is worth the five minutes.

## A note on the connection-info response shape

Render doesn't publish a fully static schema for
`/postgres/{id}/connection-info`. The scripts try a few likely field
names and print the raw JSON if none match, so you can see the actual
field name and adjust one line in `lib/render-api.js`
(`getConnectionString`).
