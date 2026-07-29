# Troubleshooting

Common setup and runtime issues when running RelinkDB, and how to fix them. For initial setup, see the [README Setup section](README.md#setup).

## Environment & credentials

### `Missing RENDER_API_KEY or RENDER_DB_NAME.`

The cloud expiry worker (`npm run cloud:expiry`) exits with this message when either variable is absent.

- Make sure you copied the example file and filled it in:
  ```bash
  cp .env.example .env
  ```
- `RENDER_API_KEY` is created in the Render dashboard under **Account Settings → API Keys → Create API Key** and starts with `rnd_`.
- `RENDER_DB_NAME` must be the **exact** name of your free Postgres instance. Reuse the same name every time you recreate the database so RelinkDB can always find the current one.

### `401 Unauthorized` from the Render API

- The API key is missing, mistyped, or was revoked. Generate a fresh key and update `RENDER_API_KEY` in `.env`.
- Check for stray whitespace or quotes around the value in `.env`.

### Database not found

- `RENDER_DB_NAME` does not match the instance name in the Render dashboard. The lookup is by exact name, so `myapp-db` and `myapp-db-2` are different databases.
- If you just recreated the database, give Render a minute to finish provisioning before running `npm run sync`.

### `npm run sync` fails but `npm run backup` works

- `RENDER_WEB_SERVICE_ID` is required for `sync` (not for backups). Take the `srv-...` segment from the service's dashboard URL.
- If your backend reads its connection string from a key other than `DATABASE_URL`, set `RENDER_ENV_VAR_KEY` accordingly.

## Database connection issues

### Connection timeouts during backup

- **Expired database:** Render free Postgres instances become inaccessible after the 30-day mark (with a 14-day grace period before actual deletion). An expired instance stops answering queries, so backups time out. Always run `npm run backup` a few days **before** expiry.
- **Network:** corporate firewalls or VPNs can block outbound Postgres connections (port `5432`). Try another network if connections hang.

### Restore appears to succeed but the new database is empty

- Confirm `data.sql` (or your custom `BACKUP_FILE`) actually contains data from the last backup — it is overwritten on every `npm run backup` run.
- Note that the cloud worker resolves the `BACKUP_FILE` default against the **current working directory**, while `backup` and `sync` resolve it relative to the **project root**. Use an absolute path if you run the worker from another directory.

## Postgres client tools (`pg_dump` / `psql`)

### `pg_dump` or `psql` not found

RelinkDB automatically falls back to a pure-JS dump/restore path using the `pg` library — fully functional for simple schemas, no extra installs needed. For full-fidelity dumps (foreign keys, indexes, sequences, custom types), install the client tools once:

```bash
# macOS
brew install libpq && brew link --force libpq

# Ubuntu / Debian
sudo apt-get install postgresql-client

# Windows
# Install the client-only option from postgresql.org/download/windows
# or run: scoop install postgresql
```

After installing on Windows, restart your terminal (or log out and back in) so the updated `PATH` is picked up.

## App startup

### Electron app will not start

- Requires **Node.js 18 or newer** (see `engines` in `package.json`). Check with `node --version`.
- Reinstall dependencies if the Electron binary is missing or corrupted:
  ```bash
  rm -rf node_modules && npm install
  ```
- On Windows, if `npm start` misbehaves, try the direct launcher: `npm run start:exe` or `Start RelinkDB.cmd`.

### Unexpected Render API response

When Render's connection-info response shape shifts, RelinkDB prints the raw JSON instead of failing silently. If you see this, check the logged payload — it usually means the API key lacks access or the instance is still provisioning. If the shape has genuinely changed, please [open an issue](https://github.com/ShashwatDiwan/RelinkDB/issues) with the logged output (redact credentials first).

---

Still stuck? [Open an issue](https://github.com/ShashwatDiwan/RelinkDB/issues) with your OS, Node version, the command you ran, and the full error output — with any API keys or connection strings redacted.
