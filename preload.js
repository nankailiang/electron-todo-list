const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // 任务
    getTodos: () => ipcRenderer.invoke('get-todos'),
    saveTodos: (todos) => ipcRenderer.invoke('save-todos', todos),
    saveTodosSync: (todos) => ipcRenderer.sendSync('save-todos-sync', todos),
    saveSettingsSync: (settings) => ipcRenderer.sendSync('save-settings-sync', settings),

    // 设置 / 清单 / 保存的筛选
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    getLists: () => ipcRenderer.invoke('get-lists'),
    saveLists: (lists) => ipcRenderer.invoke('save-lists', lists),
    getFilters: () => ipcRenderer.invoke('get-filters'),
    saveFilters: (filters) => ipcRenderer.invoke('save-filters', filters),

    // 加密
    cryptoStatus: () => ipcRenderer.invoke('crypto-status'),
    cryptoEnable: (passphrase) => ipcRenderer.invoke('crypto-enable', passphrase),
    cryptoDisable: (passphrase) => ipcRenderer.invoke('crypto-disable', passphrase),
    cryptoUnlock: (passphrase) => ipcRenderer.invoke('crypto-unlock', passphrase),

    // 日报
    getReports: () => ipcRenderer.invoke('get-reports'),
    saveReports: (reports) => ipcRenderer.invoke('save-reports', reports),
    generateReport: (date) => ipcRenderer.invoke('generate-report', { date }),
    exportReport: (payload) => ipcRenderer.invoke('export-report', payload),

    // 通知
    notify: (payload) => ipcRenderer.invoke('notify', payload),

    // 备份
    listBackups: () => ipcRenderer.invoke('list-backups'),
    restoreBackup: (path) => ipcRenderer.invoke('restore-backup', path),
    backupNow: () => ipcRenderer.invoke('backup-now'),

    // 导入导出
    exportTodos: (payload) => ipcRenderer.invoke('export-todos', payload),
    parseImport: (payload) => ipcRenderer.invoke('parse-import', payload),
    showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options),

    // 杂项
    openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
    getAppInfo: () => ipcRenderer.invoke('get-app-info'),
    showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),
    showMessageBox: (options) => ipcRenderer.invoke('show-message-box', options),

    // 全局快捷键唤起命令面板 / 快捷录入
    onOpenCommandBar: (cb) => ipcRenderer.on('open-command-bar', (e, mode) => cb(mode))
});

console.log('Electron API exposed successfully');
