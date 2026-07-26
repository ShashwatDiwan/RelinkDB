const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const launcherPath = path.join(root, "Start RelinkDB.cmd");
const shortcutPath = path.join(os.homedir(), "Desktop", "RelinkDB.lnk");

if (!fs.existsSync(launcherPath)) {
  console.error(`Launcher not found at ${launcherPath}`);
  process.exit(1);
}

const ps = `
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')
$shortcut.TargetPath = '${launcherPath.replace(/'/g, "''")}'
$shortcut.WorkingDirectory = '${root.replace(/'/g, "''")}'
$shortcut.Description = 'Launch RelinkDB'
$shortcut.Save()
`;

const result = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
  { encoding: "utf8" }
);

if (result.status !== 0) {
  console.error(result.stderr || result.stdout || "Failed to create desktop shortcut.");
  process.exit(result.status || 1);
}

console.log(`Desktop shortcut created: ${shortcutPath}`);
