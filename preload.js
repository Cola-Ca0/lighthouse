// 渲染进程与主进程之间唯一的桥 — 只暴露三个最小能力
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('lh', {
  getKey: () => ipcRenderer.invoke('get-key'),
  openWorkspace: () => ipcRenderer.invoke('open-workspace'),
  runTask: (task) => ipcRenderer.invoke('run-task', task),
  loadChat: () => ipcRenderer.invoke('load-chat'),
  saveChat: (msgs) => ipcRenderer.invoke('save-chat', msgs),
  getMemory: () => ipcRenderer.invoke('get-memory'),
  appendMemory: (text) => ipcRenderer.invoke('append-memory', text),
  getRules: () => ipcRenderer.invoke('get-rules'),
  getGreeting: () => ipcRenderer.invoke('get-greeting'),
  appendRule: (line) => ipcRenderer.invoke('append-rule', line),
  openRules: () => ipcRenderer.invoke('open-rules'),
  getEngineHint: () => ipcRenderer.invoke('get-engine-hint'),
  pathForFile: (file) => webUtils.getPathForFile(file),   // 拖进来的文件 → 拿真实路径
  importFiles: (paths) => ipcRenderer.invoke('import-files', paths),
  getWallpaper: () => ipcRenderer.invoke('get-wallpaper'),
  pickWallpaper: () => ipcRenderer.invoke('pick-wallpaper'),
  clearWallpaper: () => ipcRenderer.invoke('clear-wallpaper'),
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),
})
