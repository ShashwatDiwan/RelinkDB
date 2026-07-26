const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const distRoot = path.join(root, "dist", "portable");
const appRoot = path.join(distRoot, "resources", "app");
const electronDist = path.join(root, "node_modules", "electron", "dist");

const ignoreNames = new Set([
  ".git",
  ".agents",
  ".cursor",
  "dist",
  "release",
  "coverage",
  "tmp",
]);

function cleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyWorkspace(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (ignoreNames.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      fs.cpSync(from, to, { recursive: true, force: true });
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

function buildPortable() {
  cleanDir(distRoot);
  fs.cpSync(electronDist, distRoot, { recursive: true, force: true });
  const exePath = path.join(distRoot, "RelinkDB.exe");
  fs.copyFileSync(path.join(distRoot, "electron.exe"), exePath);
  copyWorkspace(root, appRoot);
  console.log(`Portable build staged at ${exePath}`);
  console.log(`Launch with: ${exePath}`);
}

buildPortable();
