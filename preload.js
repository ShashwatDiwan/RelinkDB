const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  testConfig: () => ipcRenderer.invoke("config:test"),
  getStorePath: () => ipcRenderer.invoke("config:storePath"),
  pickBackupFile: () => ipcRenderer.invoke("config:pickBackupFile"),
  runBackup: () => ipcRenderer.invoke("action:backup"),
  runSync: () => ipcRenderer.invoke("action:sync"),
  openDashboard: () => ipcRenderer.invoke("action:openDashboard"),
  pollNewDb: () => ipcRenderer.invoke("action:pollNewDb"),
  cancelPoll: () => ipcRenderer.invoke("action:cancelPoll"),
  pickSqlUpload: () => ipcRenderer.invoke("action:pickSqlUpload"),
  importSqlPath: (sourcePath) => ipcRenderer.invoke("action:importSqlPath", sourcePath),
  sanitizeSql: (payload) => ipcRenderer.invoke("action:sanitizeSql", payload),
  restoreFromFile: (payload) => ipcRenderer.invoke("action:restoreFromFile", payload),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  checkTools: () => ipcRenderer.invoke("tools:check"),
  getExpiryStatus: () => ipcRenderer.invoke("status:expiry"),
  getHistory: () => ipcRenderer.invoke("history:get"),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  onLogLine: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("log:line", listener);
    return () => ipcRenderer.removeListener("log:line", listener);
  },
  onRenewalReady: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("renewal:ready", listener);
    return () => ipcRenderer.removeListener("renewal:ready", listener);
  },
});
