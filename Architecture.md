# Project Architecture & File Structure
RelinkDB coordinates between a local Electron Desktop Application and automation scripts to handle the Postgres rotation workflow smoothly.

```text
RelinkDB/
├── main.js             # Electron main process (lifecycle, IPC handlers, window management)
├── preload.js          # Context bridge (exposes safe APIs to renderer)
├── renderer/           # Desktop UI assets and frontend scripts
│   ├── index.html      # Main dashboard interface
│   └── app.js          # Dashboard UI logic & event handling
├── backup.js           # CLI script to dump the active database snapshot to data.sql
├── sync.js             # CLI script to restore data.sql to the new DB & update Render service env vars
├── cloud/              # Background monitoring scripts
│   └── expiry-worker.js# Automated expiry watcher and optional notification/webhook runner
└── lib/                # Shared utilities (Render API wrapper, Postgres JS fallback, logger)
```

Process Interactions & Roles
Electron Main Process (main.js): Acts as the central orchestrator. It manages native app windows, handles desktop launcher configurations, and provides IPC handlers that securely execute local operations, database calls, and system notifications.

Renderer Process (renderer/): The operator interface. It renders live database expiry countdowns, status badges, and action controls without exposing sensitive Node.js APIs directly to the UI context.

Backup Script (backup.js): Interacts with the live, active PostgreSQL database to pull a full data snapshot into data.sql. Runs automatically or via manual CLI execution (npm run backup) right before database expiration.

Sync Script (sync.js): Executed after recreating the new Postgres instance in Render (npm run sync). It identifies the new database instance via the Render API, restores data.sql into it, and updates the backend Web Service's database connection environment variable (triggering an automatic redeploy).

Cloud Worker (cloud/): A standalone task runner (npm run cloud:expiry) that periodically checks database age, alerts the operator before expiration, and can auto-trigger backups or post webhook notifications.
