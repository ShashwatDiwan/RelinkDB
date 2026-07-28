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

1. **Fork the Repository** and create your branch from `main`:
   ```bash
   git checkout -b feat/your-feature-name

2.Install Dependencies:
npm install

Set Up Local Environment:

Copy .env.example to .env and fill in mock or development credentials.
Make Your Changes:
Keep changes focused and atomic.
Maintain consistent formatting (JavaScript / Electron standards used in the codebase).

Test Your Changes:
Verify that local scripts (npm run backup, npm run sync) work as intended.
If modifying the desktop UI, test app startup (npm start).
If modifying the cloud worker, test the expiry loop (npm run cloud:expiry).

Commit and Push:

Bash
git commit -m "feat: detailed description of changes"
git push origin feat/your-feature-name
Open a Pull Request: Describe what your PR changes and why.
