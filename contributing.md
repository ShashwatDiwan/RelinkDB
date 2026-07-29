# Contributing to RelinkDB

First off, thank you for considering contributing to RelinkDB! Tools like this thrive on community improvements and bug fixes.

---

## How Can I Contribute?

### 1. Reporting Bugs

Before creating a bug report, please check existing issues to see if the problem has already been reported. When creating an issue, please include:

* **OS / Environment:** (e.g., Windows 11, macOS Sequoia, Ubuntu 22.04)
* **Node Version:** Output of `node -v`
* **Postgres Client Installed?:** Whether `pg_dump`/`pg_restore` are installed locally or if you're using the pure-JS fallback
* **Steps to Reproduce:** Clear steps to trigger the bug
* **Expected vs. Actual Behavior**

### 2. Suggesting Enhancements

Feature requests are welcome! Please describe:

* The problem or limitation you're encountering
* The proposed solution or feature behavior
* Any alternative workarounds you've considered

### 3. Submitting Pull Requests

Follow the step-by-step local development guide below, then open a PR.

---

## Step-by-Step Local Development Guide

### Prerequisites

* **Node.js 18 or newer** (see `engines` in `package.json`) — check with `node -v`
* **npm** (bundled with Node)
* **Postgres client tools (optional):** `pg_dump`/`psql` enable full-fidelity dumps. Without them, RelinkDB falls back to a pure-JS path using the `pg` library — fine for development.
* A free [Render](https://render.com) account if you want to test against real infrastructure

### 1. Fork and clone

Fork the repository on GitHub, then:

```bash
git clone https://github.com/<your-username>/RelinkDB.git
cd RelinkDB
git checkout -b feat/your-feature-name
```

### 2. Install dependencies

```bash
npm install
```

This installs Electron (dev dependency) plus `dotenv`, `electron-store`, and `pg`.

### 3. Configure your local environment

```bash
cp .env.example .env
```

Fill in `.env` with development credentials:

| Variable | Needed for | Notes |
|---|---|---|
| `RENDER_API_KEY` | everything | Render dashboard → Account Settings → API Keys |
| `RENDER_DB_NAME` | everything | Exact name of your test Postgres instance |
| `RENDER_WEB_SERVICE_ID` | `sync` only | The `srv-...` ID of a test web service |
| `RENDER_ENV_VAR_KEY` | optional | Defaults to `DATABASE_URL` |
| `BACKUP_FILE` | optional | Defaults to `./data.sql` |

See the [README's Environment Variables Reference](README.md#environment-variables-reference) for the full list, including the `RELINKDB_*` cloud worker variables.

> **Tip:** use a throwaway/test database for development — never point local scripts at a database holding real user data.

### 4. Run the app in development mode

```bash
npm start          # launches the Electron desktop app
```

On Windows you can also use `npm run start:exe` or `Start RelinkDB.cmd`.

### 5. Make your changes

* Keep changes focused and atomic
* Maintain consistent formatting (JavaScript / Electron standards used in the codebase)

### 6. Test your changes

Verify the paths your change touches:

```bash
npm run backup         # local backup script
npm run sync           # restore + relink script
npm start              # desktop UI startup
npm run cloud:expiry   # cloud expiry worker loop
```

If you changed dump/restore logic, test both engines: once with Postgres client tools installed, and once relying on the pure-JS fallback.

### 7. Commit and push

Use a descriptive, conventional-style commit message:

```bash
git commit -m "feat: detailed description of changes"
git push origin feat/your-feature-name
```

### 8. Open a Pull Request

Open a PR against `main` on this repository. In the description, cover:

* **What** the PR changes
* **Why** the change is needed (link the related issue, e.g. `Closes #123`)
* **How** you tested it (which scripts/flows from step 6)

---

Questions? Open an issue — happy to help you get set up.
