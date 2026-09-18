const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getState: () => ipcRenderer.invoke("get-state"),
  saveSettings: (settings) => ipcRenderer.invoke("save-settings", settings),
  saveSecrets: (secrets) => ipcRenderer.invoke("save-secrets", secrets),
  emptyDatabase: () => ipcRenderer.invoke("empty-database"),
  listGroups: (query) => ipcRenderer.invoke("list-groups", query),
  listVatRates: () => ipcRenderer.invoke("list-vat-rates"),
  startRun: (args) => ipcRenderer.invoke("start-run", args),
  stopRun: () => ipcRenderer.invoke("stop-run"),
  onLog: (callback) => {
    const listener = (_event, line) => callback(line);
    ipcRenderer.on("log", listener);
    return () => ipcRenderer.removeListener("log", listener);
  },
  onRunState: (callback) => {
    const listener = (_event, running) => callback(running);
    ipcRenderer.on("run-state", listener);
    return () => ipcRenderer.removeListener("run-state", listener);
  },
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("state", listener);
    return () => ipcRenderer.removeListener("state", listener);
  },
});
