/* ==========================================================================
   tauri-api.js —— 把 app.js 使用的 window.electronAPI 适配到 Tauri 2 的 invoke/event
   前端 app.js 完全不用改，只要本文件先于 app.js 加载。
   依赖 tauri.conf.json 中 app.withGlobalTauri = true（暴露 window.__TAURI__）。
   ========================================================================== */
(function () {
    const T = window.__TAURI__;
    if (!T || !T.core) {
        // 非 Tauri 环境（例如浏览器直接打开）时给出提示，避免白屏无解释
        console.error('[tauri-api] 未检测到 Tauri 运行时（window.__TAURI__）。请通过 tauri 启动。');
        window.electronAPI = window.electronAPI || {};
        return;
    }
    const invoke = T.core.invoke;

    function pick() {
        // showOpenDialog 的返回值需要适配成 Electron 形状 { canceled, filePaths }
        return invoke('pick_open_file').then((p) => {
            return p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] };
        });
    }

    window.electronAPI = {
        // 任务
        getTodos: () => invoke('get_todos'),
        saveTodos: (todos) => invoke('save_todos', { todos }),
        saveTodosSync: (todos) => invoke('save_todos', { todos }),
        saveSettingsSync: (settings) => invoke('save_settings', { settings }),

        // 设置 / 清单 / 保存的筛选
        getSettings: () => invoke('get_settings'),
        saveSettings: (settings) => invoke('save_settings', { settings }),
        getLists: () => invoke('get_lists'),
        saveLists: (lists) => invoke('save_lists', { lists }),
        getFilters: () => invoke('get_filters'),
        saveFilters: (filters) => invoke('save_filters', { filters }),

        // 加密
        cryptoStatus: () => invoke('crypto_status'),
        cryptoEnable: (passphrase) => invoke('crypto_enable', { passphrase }),
        cryptoDisable: (passphrase) => invoke('crypto_disable', { passphrase }),
        cryptoUnlock: (passphrase) => invoke('crypto_unlock', { passphrase }),

        // 日报
        getReports: () => invoke('get_reports'),
        saveReports: (reports) => invoke('save_reports', { reports }),
        generateReport: (date) => invoke('generate_report', { date }),
        exportReport: (payload) => invoke('export_report', { format: payload.format, report: payload.report }),

        // 通知
        notify: (payload) => invoke('notify', { title: payload.title, body: payload.body }),

        // 备份
        listBackups: () => invoke('list_backups'),
        restoreBackup: (path) => invoke('restore_backup', { path }),
        backupNow: () => invoke('backup_now'),

        // 导入导出
        exportTodos: (payload) => invoke('export_todos', { format: payload.format, todos: payload.todos, columns: payload.columns || null }),
        parseImport: (payload) => invoke('parse_import', { filePath: payload.filePath, format: payload.format }),
        showOpenDialog: () => pick(),

        // 杂项
        openFile: (path) => invoke('open_path', { path }),
        getAppInfo: () => invoke('get_app_info'),
        showSaveDialog: () => invoke('pick_open_file').then((p) => (p ? { canceled: false, filePaths: [p] } : { canceled: true })),
        showMessageBox: () => Promise.resolve({ response: 0 }),

        // 全局快捷键唤起命令面板（Rust 侧 emit 'open-command-bar'）
        onOpenCommandBar: (cb) => {
            if (T.event && T.event.listen) {
                T.event.listen('open-command-bar', (e) => cb(e.payload));
            }
        }
    };
    console.log('[tauri-api] electronAPI 适配层已就绪');
})();
