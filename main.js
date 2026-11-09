const { app, BrowserWindow, ipcMain, dialog, shell, Notification, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// 单实例锁：避免多开窗口并发写坏同一份数据文件
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
}

// ---------------------------------------------------------------------------
// 路径与全局状态
// ---------------------------------------------------------------------------
let PATHS = {};
let mainWindow = null;

// 加密运行态（内存中，进程退出即失效）
const cryptoState = {
    enabled: false,   // 是否开启加密
    unlocked: true,   // 当前是否已解锁（未加密时恒为 true）
    key: null,        // 派生出的对称密钥
    meta: null        // { salt, verifier }
};

let lastBackupDate = null; // 记录最近一次备份的日期，用于每日一次

function initPaths() {
    const userDataDir = app.getPath('userData');
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

    PATHS = {
        userDataDir,
        todos: path.join(userDataDir, 'todoList.json'),
        settings: path.join(userDataDir, 'settings.json'),
        lists: path.join(userDataDir, 'lists.json'),
        filters: path.join(userDataDir, 'savedFilters.json'),
        reports: path.join(userDataDir, 'reports.json'),
        cryptoMeta: path.join(userDataDir, 'crypto.meta.json'),
        backupDir: path.join(userDataDir, 'backups')
    };

    if (!fs.existsSync(PATHS.backupDir)) fs.mkdirSync(PATHS.backupDir, { recursive: true });

    // 读取加密元数据，判断是否已启用加密
    try {
        if (fs.existsSync(PATHS.cryptoMeta)) {
            cryptoState.meta = JSON.parse(fs.readFileSync(PATHS.cryptoMeta, 'utf8'));
            if (cryptoState.meta && cryptoState.meta.salt && cryptoState.meta.verifier) {
                cryptoState.enabled = true;
                cryptoState.unlocked = false; // 需要用户输入口令解锁
            }
        }
    } catch (e) {
        console.error('读取加密元数据失败:', e);
    }

    console.log('数据目录:', userDataDir);
}

// ---------------------------------------------------------------------------
// 加密工具
// ---------------------------------------------------------------------------
function deriveKey(passphrase, salt) {
    return crypto.scryptSync(passphrase, Buffer.from(salt, 'hex'), 32);
}

function encryptString(plain, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return 'ENC1:' + iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
}

function decryptString(payload, key) {
    const parts = payload.split(':');
    if (parts[0] !== 'ENC1' || parts.length !== 4) throw new Error('密文格式错误');
    const iv = Buffer.from(parts[1], 'hex');
    const tag = Buffer.from(parts[2], 'hex');
    const data = Buffer.from(parts[3], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function isEncryptedPayload(str) {
    return typeof str === 'string' && str.startsWith('ENC1:');
}

// ---------------------------------------------------------------------------
// 通用 JSON 读写（todos 支持加密）
// ---------------------------------------------------------------------------
function readJson(filePath, fallback, { encrypted = false } = {}) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw.trim()) return fallback;

        if (encrypted && isEncryptedPayload(raw)) {
            if (!cryptoState.unlocked || !cryptoState.key) {
                return { __locked__: true };
            }
            const plain = decryptString(raw, cryptoState.key);
            return JSON.parse(plain);
        }
        return JSON.parse(raw);
    } catch (e) {
        console.error('读取文件失败:', filePath, e);
        return fallback;
    }
}

function writeJson(filePath, data, { encrypted = false } = {}) {
    try {
        let content = JSON.stringify(data, null, 2);
        if (encrypted && cryptoState.enabled && cryptoState.unlocked && cryptoState.key) {
            content = encryptString(content, cryptoState.key);
        }
        // 原子写入：先写临时文件再重命名，避免写入中断损坏数据
        const tmp = filePath + '.tmp';
        fs.writeFileSync(tmp, content, 'utf8');
        fs.renameSync(tmp, filePath);
        return true;
    } catch (e) {
        console.error('写入文件失败:', filePath, e);
        return false;
    }
}

function readTodos() {
    const data = readJson(PATHS.todos, [], { encrypted: cryptoState.enabled });
    if (data && data.__locked__) return { __locked__: true };
    return Array.isArray(data) ? data : [];
}

function saveTodos(todos) {
    if (cryptoState.enabled && !cryptoState.unlocked) {
        return { success: false, error: '数据已锁定，请先解锁' };
    }
    const ok = writeJson(PATHS.todos, todos, { encrypted: cryptoState.enabled });
    if (ok) maybeDailyBackup(todos);
    return { success: ok };
}

// ---------------------------------------------------------------------------
// 备份机制：每日一次，保留最近 7 天
// ---------------------------------------------------------------------------
function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function maybeDailyBackup(todos) {
    try {
        const today = todayStr();
        const backupFile = path.join(PATHS.backupDir, `todo-backup-${today}.json`);
        if (lastBackupDate === today && fs.existsSync(backupFile)) return;

        // 加密开启时，备份同样以密文写入，避免备份目录泄露明文
        let content = JSON.stringify(todos, null, 2);
        if (cryptoState.enabled && cryptoState.unlocked && cryptoState.key) {
            content = encryptString(content, cryptoState.key);
        }
        fs.writeFileSync(backupFile, content, 'utf8');
        lastBackupDate = today;
        pruneBackups();
    } catch (e) {
        console.error('创建备份失败:', e);
    }
}

function pruneBackups() {
    try {
        const files = fs.readdirSync(PATHS.backupDir)
            .filter(f => f.startsWith('todo-backup-') && f.endsWith('.json'))
            .sort();
        while (files.length > 7) {
            const old = files.shift();
            try { fs.unlinkSync(path.join(PATHS.backupDir, old)); } catch (_) {}
        }
    } catch (e) {
        console.error('清理备份失败:', e);
    }
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 960,
        minHeight: 640,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        },
        title: '知行 · 任务与日报工作台',
        backgroundColor: '#f4f5f7',
        icon: path.join(__dirname, 'assets', 'icon.png')
    });

    mainWindow.loadFile('index.html');
    mainWindow.setMenu(null);
    mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
    initPaths();
    createWindow();

    // 全局快捷键：Ctrl/Cmd + Shift + Space 唤起「快捷录入 / 命令面板」（即使窗口在后台）
    try {
        const ok = globalShortcut.register('CommandOrControl+Shift+Space', () => {
            if (!mainWindow) { createWindow(); }
            if (mainWindow) {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
                if (!mainWindow.webContents.isLoading()) {
                    mainWindow.webContents.send('open-command-bar', 'quick');
                } else {
                    mainWindow.webContents.once('did-finish-load', () => {
                        if (mainWindow) mainWindow.webContents.send('open-command-bar', 'quick');
                    });
                }
            }
        });
        if (!ok) console.warn('全局快捷键 Ctrl+Shift+Space 注册失败（可能被占用）');
    } catch (e) {
        console.warn('全局快捷键注册异常:', e);
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// 第二实例启动时，聚焦已有窗口
app.on('second-instance', () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }
});

// ---------------------------------------------------------------------------
// IPC —— 任务
// ---------------------------------------------------------------------------
ipcMain.handle('get-todos', () => readTodos());
ipcMain.handle('save-todos', (e, todos) => saveTodos(todos));

// 同步落盘：用于窗口关闭前（beforeunload）强制保存，避免防抖未触发导致丢失
ipcMain.on('save-todos-sync', (e, todos) => {
    try { e.returnValue = saveTodos(todos); }
    catch (err) { e.returnValue = { success: false, error: err.message }; }
});

// ---------------------------------------------------------------------------
// IPC —— 设置 / 清单 / 保存的筛选
// ---------------------------------------------------------------------------
ipcMain.handle('get-settings', () => readJson(PATHS.settings, null));
ipcMain.handle('save-settings', (e, settings) => ({ success: writeJson(PATHS.settings, settings) }));

ipcMain.on('save-settings-sync', (e, settings) => {
    try { e.returnValue = { success: writeJson(PATHS.settings, settings) }; }
    catch (err) { e.returnValue = { success: false, error: err.message }; }
});

ipcMain.handle('get-lists', () => readJson(PATHS.lists, null));
ipcMain.handle('save-lists', (e, lists) => ({ success: writeJson(PATHS.lists, lists) }));

ipcMain.handle('get-filters', () => readJson(PATHS.filters, []));
ipcMain.handle('save-filters', (e, filters) => ({ success: writeJson(PATHS.filters, filters) }));

// ---------------------------------------------------------------------------
// IPC —— 日报（reports）
// ---------------------------------------------------------------------------
function readReports() {
    const data = readJson(PATHS.reports, [], { encrypted: cryptoState.enabled });
    if (data && data.__locked__) return { __locked__: true };
    return Array.isArray(data) ? data : [];
}
function writeReports(reports) {
    if (cryptoState.enabled && !cryptoState.unlocked) {
        return { success: false, error: '数据已锁定，请先解锁' };
    }
    const ok = writeJson(PATHS.reports, reports, { encrypted: cryptoState.enabled });
    return { success: ok };
}

// 根据某日任务自动汇总日报内容
function buildReportSummary(todos, dateStr) {
    const scope = Array.isArray(todos) ? todos : [];
    const due = scope.filter(t => t.date === dateStr && !t.archived);
    const completed = due.filter(t => t.status === 'completed' || (t.completedAt && t.completedAt.slice(0, 10) === dateStr));
    const inProgress = due.filter(t => t.status === 'in-progress');
    const pending = due.filter(t => t.status === 'pending');
    // 逾期未完成：截止日期早于当日且未结办
    const overdue = scope.filter(t => !t.archived && t.status !== 'completed' && t.date && t.date < dateStr);

    const pick = (t) => ({ id: t.id, content: t.content, priority: t.priority, listId: t.listId, status: t.status, date: t.date, dueTime: t.dueTime || '' });
    const lines = (arr, label) => {
        if (!arr.length) return `## ${label}\n（无）\n`;
        return `## ${label}\n` + arr.map(t => `- ${t.content}${t.dueTime ? ' ' + t.dueTime : ''}`).join('\n') + '\n';
    };

    const defaultContent =
        `# 工作日报（${dateStr}）\n\n` +
        lines(completed, '今日完成') +
        lines(inProgress, '进行中') +
        lines(pending, '待处理') +
        lines(overdue, '逾期未完成') +
        '## 明日计划\n- \n';

    return {
        date: dateStr,
        total: due.length,
        counts: { completed: completed.length, inProgress: inProgress.length, pending: pending.length, overdue: overdue.length },
        items: {
            completed: completed.map(pick),
            inProgress: inProgress.map(pick),
            pending: pending.map(pick),
            overdue: overdue.map(pick)
        },
        defaultContent
    };
}

ipcMain.handle('get-reports', () => readReports());
ipcMain.handle('save-reports', (e, reports) => writeReports(reports));
ipcMain.handle('generate-report', (e, { date }) => {
    try {
        const todos = readTodos();
        const list = Array.isArray(todos) ? todos : [];
        return { success: true, summary: buildReportSummary(list, date) };
    } catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('export-report', async (e, { format, report }) => {
    try {
        if (!report || !report.content) return { success: false, error: '日报内容为空' };
        const result = await dialog.showSaveDialog({
            title: '导出日报',
            defaultPath: path.join(app.getPath('downloads'), `日报-${report.date || 'export'}.${format}`),
            filters: [{ name: format.toUpperCase(), extensions: [format] }, { name: 'All Files', extensions: ['*'] }]
        });
        if (result.canceled) return { success: false, error: '导出已取消' };
        const header = `# ${report.title || '工作日报'}\n\n> 日期：${report.date || ''}\n\n`;
        const content = format === 'md' ? report.content : report.content
            .replace(/^#+\s*/gm, '')
            .replace(/\*\*(.+?)\*\*/g, '$1');
        fs.writeFileSync(result.filePath, header + content, 'utf8');
        return { success: true, path: result.filePath };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// ---------------------------------------------------------------------------
// IPC —— 加密
// ---------------------------------------------------------------------------
ipcMain.handle('crypto-status', () => ({
    enabled: cryptoState.enabled,
    unlocked: cryptoState.unlocked
}));

// 开启加密：设置口令并加密现有数据
ipcMain.handle('crypto-enable', (e, passphrase) => {
    try {
        if (!passphrase || passphrase.length < 4) {
            return { success: false, error: '口令至少 4 个字符' };
        }
        const salt = crypto.randomBytes(16).toString('hex');
        const key = deriveKey(passphrase, salt);
        const verifier = encryptString('todo-verifier-ok', key);
        cryptoState.meta = { salt, verifier };
        cryptoState.enabled = true;
        cryptoState.unlocked = true;
        cryptoState.key = key;
        fs.writeFileSync(PATHS.cryptoMeta, JSON.stringify(cryptoState.meta, null, 2), 'utf8');

        // 用当前数据重新加密写入（任务 + 日报）
        const current = readJson(PATHS.todos, []);
        const todos = Array.isArray(current) ? current : [];
        writeJson(PATHS.todos, todos, { encrypted: true });
        const currentReports = readReports();
        writeJson(PATHS.reports, Array.isArray(currentReports) ? currentReports : [], { encrypted: true });
        return { success: true };
    } catch (err) {
        console.error('开启加密失败:', err);
        return { success: false, error: err.message };
    }
});

// 关闭加密：验证口令后以明文写回
ipcMain.handle('crypto-disable', (e, passphrase) => {
    try {
        if (!cryptoState.enabled) return { success: true };
        const key = deriveKey(passphrase, cryptoState.meta.salt);
        try {
            const check = decryptString(cryptoState.meta.verifier, key);
            if (check !== 'todo-verifier-ok') throw new Error('bad');
        } catch (_) {
            return { success: false, error: '口令错误' };
        }
        cryptoState.key = key;
        cryptoState.unlocked = true;
        const todos = readTodos();
        const arr = Array.isArray(todos) ? todos : [];
        const reportsNow = readReports();   // 关闭前先解密日报
        const reportsArr = Array.isArray(reportsNow) ? reportsNow : [];
        // 关闭加密标记后明文写入
        cryptoState.enabled = false;
        cryptoState.key = null;
        cryptoState.meta = null;
        writeJson(PATHS.todos, arr, { encrypted: false });
        writeJson(PATHS.reports, reportsArr, { encrypted: false });
        try { fs.unlinkSync(PATHS.cryptoMeta); } catch (_) {}
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// 解锁
ipcMain.handle('crypto-unlock', (e, passphrase) => {
    try {
        if (!cryptoState.enabled) return { success: true };
        const key = deriveKey(passphrase, cryptoState.meta.salt);
        try {
            const check = decryptString(cryptoState.meta.verifier, key);
            if (check !== 'todo-verifier-ok') throw new Error('bad');
        } catch (_) {
            return { success: false, error: '口令错误' };
        }
        cryptoState.key = key;
        cryptoState.unlocked = true;
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// ---------------------------------------------------------------------------
// IPC —— 系统通知
// ---------------------------------------------------------------------------
ipcMain.handle('notify', (e, { title, body }) => {
    try {
        if (Notification.isSupported()) {
            const n = new Notification({ title: title || '待办提醒', body: body || '' });
            n.show();
            n.on('click', () => { if (mainWindow) mainWindow.show(); });
            return { success: true };
        }
        return { success: false, error: '系统不支持通知' };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// ---------------------------------------------------------------------------
// IPC —— 备份
// ---------------------------------------------------------------------------
ipcMain.handle('list-backups', () => {
    try {
        return fs.readdirSync(PATHS.backupDir)
            .filter(f => f.startsWith('todo-backup-') && f.endsWith('.json'))
            .sort().reverse()
            .map(f => {
                const full = path.join(PATHS.backupDir, f);
                const stat = fs.statSync(full);
                return { name: f, path: full, size: stat.size, mtime: stat.mtime };
            });
    } catch (e) {
        return [];
    }
});

ipcMain.handle('restore-backup', (e, backupPath) => {
    try {
        const raw = fs.readFileSync(backupPath, 'utf8');
        let parsed;
        if (isEncryptedPayload(raw)) {
            if (!cryptoState.unlocked || !cryptoState.key) {
                return { success: false, error: '该备份已加密，请先解锁后再恢复' };
            }
            parsed = JSON.parse(decryptString(raw, cryptoState.key));
        } else {
            parsed = JSON.parse(raw);
        }
        const todos = parsed;
        if (!Array.isArray(todos)) throw new Error('备份文件格式错误');
        saveTodos(todos);
        return { success: true, todos };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('backup-now', () => {
    try {
        const todos = readTodos();
        if (todos && todos.__locked__) return { success: false, error: '数据已锁定' };
        lastBackupDate = null; // 强制覆盖当天备份
        maybeDailyBackup(Array.isArray(todos) ? todos : []);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// ---------------------------------------------------------------------------
// IPC —— 导出（支持传入指定任务集合，实现筛选导出；新增 markdown）
// ---------------------------------------------------------------------------
const STATUS_MAP = { pending: '待办', 'in-progress': '在办', completed: '结办' };
const PRIORITY_MAP = { high: '高', medium: '中', low: '低' };

ipcMain.handle('export-todos', async (e, { format, todos }) => {
    try {
        const list = Array.isArray(todos) ? todos : readTodos();
        if (!Array.isArray(list) || list.length === 0) {
            return { success: false, error: '没有可导出的任务' };
        }

        const result = await dialog.showSaveDialog({
            title: '导出待办事项',
            defaultPath: path.join(app.getPath('downloads'), `todo-export-${Date.now()}.${format}`),
            filters: [{ name: `${format.toUpperCase()} Files`, extensions: [format] }, { name: 'All Files', extensions: ['*'] }]
        });
        if (result.canceled) return { success: false, error: '导出已取消' };

        let content = '';
        switch (format) {
            case 'json': content = JSON.stringify(list, null, 2); break;
            case 'csv': content = toCSV(list); break;
            case 'txt': content = toTXT(list); break;
            case 'md': content = toMarkdown(list); break;
            default: return { success: false, error: '不支持的格式' };
        }
        fs.writeFileSync(result.filePath, content, 'utf8');
        return { success: true, path: result.filePath, count: list.length };
    } catch (err) {
        console.error('导出失败:', err);
        return { success: false, error: err.message };
    }
});

function toCSV(todos) {
    const headers = ['id', 'listId', 'startDate', 'date', 'dueTime', 'priority', 'content', 'note', 'status', 'tags', 'createdAt', 'startedAt', 'completedAt'];
    let csv = headers.join(',') + '\n';
    todos.forEach(t => {
        const row = [
            t.id, t.listId || '', t.startDate || '', t.date || '', t.dueTime || '', t.priority || '',
            `"${(t.content || '').replace(/"/g, '""')}"`,
            `"${(t.note || '').replace(/"/g, '""')}"`,
            t.status || '', `"${(t.tags || []).join('|')}"`,
            t.createdAt || '', t.startedAt || '', t.completedAt || ''
        ];
        csv += row.join(',') + '\n';
    });
    return csv;
}

function toTXT(todos) {
    let txt = `待办事项列表\n导出时间: ${new Date().toLocaleString()}\n总数量: ${todos.length}\n${'-'.repeat(50)}\n\n`;
    todos.forEach((t, i) => {
        txt += `${i + 1}. [${STATUS_MAP[t.status] || t.status}] ${t.content}\n`;
        txt += `   日期: ${t.date || ''}${t.dueTime ? ' ' + t.dueTime : ''}\n`;
        txt += `   优先级: ${PRIORITY_MAP[t.priority] || t.priority}\n`;
        if (t.tags && t.tags.length) txt += `   标签: ${t.tags.join(', ')}\n`;
        if (t.note) txt += `   备注: ${t.note}\n`;
        txt += `${'-'.repeat(50)}\n`;
    });
    return txt;
}

function toMarkdown(todos) {
    let md = `# 待办事项列表\n\n> 导出时间：${new Date().toLocaleString()}　总数：${todos.length}\n\n`;
    const groups = { pending: [], 'in-progress': [], completed: [] };
    todos.forEach(t => (groups[t.status] || groups.pending).push(t));
    const sectionTitle = { pending: '待办', 'in-progress': '在办', completed: '结办' };
    Object.keys(groups).forEach(status => {
        if (!groups[status].length) return;
        md += `## ${sectionTitle[status]}（${groups[status].length}）\n\n`;
        groups[status].forEach(t => {
            const box = status === 'completed' ? '[x]' : '[ ]';
            const pr = PRIORITY_MAP[t.priority] || '';
            md += `- ${box} **${t.content}**`;
            const metas = [];
            if (t.date) metas.push(`📅 ${t.date}${t.dueTime ? ' ' + t.dueTime : ''}`);
            if (pr) metas.push(`🚩 ${pr}`);
            if (t.tags && t.tags.length) metas.push(t.tags.map(x => '`#' + x + '`').join(' '));
            if (metas.length) md += ` — ${metas.join('　')}`;
            md += '\n';
            if (t.note) md += `  > ${t.note.replace(/\n/g, '\n  > ')}\n`;
            if (t.subtasks && t.subtasks.length) {
                t.subtasks.forEach(s => {
                    md += `  - ${s.done ? '[x]' : '[ ]'} ${s.text}\n`;
                });
            }
        });
        md += '\n';
    });
    return md;
}

// ---------------------------------------------------------------------------
// IPC —— 导入（预览 + 确认两步）
// ---------------------------------------------------------------------------
ipcMain.handle('show-open-dialog', (e, options) => dialog.showOpenDialog({
    title: '选择文件', properties: ['openFile'], ...options
}));

// 仅解析并返回预览数据，不写入
ipcMain.handle('parse-import', async (e, { filePath, format }) => {
    try {
        if (!fs.existsSync(filePath)) throw new Error('文件不存在');
        const content = fs.readFileSync(filePath, 'utf8');
        let parsed = [];
        switch (format) {
            case 'json': parsed = JSON.parse(content); break;
            case 'csv': parsed = parseCSV(content); break;
            case 'txt': parsed = parseTXT(content); break;
            case 'md': parsed = parseMarkdown(content); break;
            default: throw new Error('不支持的文件格式');
        }
        if (!Array.isArray(parsed)) throw new Error('导入的数据不是数组格式');

        const normalized = parsed.map(normalizeTodo).filter(Boolean);
        return { success: true, todos: normalized };
    } catch (err) {
        console.error('解析导入文件失败:', err);
        return { success: false, error: err.message };
    }
});

function normalizeTodo(t) {
    if (!t || !t.content) return null;
    let tags = t.tags;
    if (typeof tags === 'string') tags = tags.split(/[|,]/).map(s => s.trim()).filter(Boolean);
    if (!Array.isArray(tags)) tags = [];
    return {
        id: t.id ? String(t.id) : (Date.now().toString() + Math.random().toString(36).slice(2, 8)),
        listId: t.listId || 'default',
        startDate: t.startDate || '',
        date: t.date || new Date().toISOString().split('T')[0],
        dueTime: t.dueTime || '',
        priority: ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium',
        content: String(t.content).trim(),
        note: t.note || '',
        status: ['pending', 'in-progress', 'completed'].includes(t.status) ? t.status : 'pending',
        tags,
        subtasks: Array.isArray(t.subtasks) ? t.subtasks : [],
        pinned: !!t.pinned,
        createdAt: t.createdAt || new Date().toISOString(),
        startedAt: t.startedAt || null,
        completedAt: t.completedAt || null,
        updatedAt: t.updatedAt || new Date().toISOString()
    };
}

function parseCSV(content) {
    // 完整 CSV 解析：支持引号包裹的字段内含逗号、换行（备注多行不再损坏）
    const rows = [];
    let row = [], cur = '', inQuotes = false;
    for (let i = 0; i < content.length; i++) {
        const c = content[i];
        if (inQuotes) {
            if (c === '"') { if (content[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false; }
            else cur += c;
        } else {
            if (c === '"') inQuotes = true;
            else if (c === ',') { row.push(cur); cur = ''; }
            else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
            else if (c === '\r') { /* ignore */ }
            else cur += c;
        }
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    if (!rows.length) return [];
    const headers = rows[0].map(h => h.trim().toLowerCase());
    const todos = [];
    for (let r = 1; r < rows.length; r++) {
        const values = rows[r];
        if (!values || !values.length || (values.length === 1 && !values[0].trim())) continue;
        const t = {};
        headers.forEach((h, idx) => {
            const v = (values[idx] || '').trim();
            if (h === 'createdat') t.createdAt = v;
            else if (h === 'startedat') t.startedAt = v;
            else if (h === 'completedat') t.completedAt = v;
            else if (h === 'duetime') t.dueTime = v;
            else if (h === 'listid') t.listId = v;
            else if (h === 'startdate') t.startDate = v;
            else t[h] = v;
        });
        todos.push(t);
    }
    return todos;
}

function parseCSVLine(line) {
    const values = [];
    let cur = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
            else inQuotes = !inQuotes;
        } else if (c === ',' && !inQuotes) { values.push(cur.trim()); cur = ''; }
        else cur += c;
    }
    values.push(cur.trim());
    return values;
}

function parseTXT(content) {
    const todos = [];
    content.trim().split('\n').forEach(line => {
        const t = line.trim();
        if (t) todos.push({ content: t.replace(/^\d+\.\s*/, ''), date: new Date().toISOString().split('T')[0], priority: 'medium', status: 'pending' });
    });
    return todos;
}

function parseMarkdown(content) {
    const todos = [];
    content.split('\n').forEach(line => {
        const m = line.match(/^\s*[-*]\s*\[( |x|X)\]\s*(.+)$/);
        if (m) {
            let text = m[2].replace(/\*\*/g, '').trim();
            // 去掉尾部元信息
            text = text.split(' — ')[0].trim();
            todos.push({
                content: text,
                status: m[1].toLowerCase() === 'x' ? 'completed' : 'pending',
                date: new Date().toISOString().split('T')[0],
                priority: 'medium'
            });
        }
    });
    return todos;
}

// ---------------------------------------------------------------------------
// IPC —— 杂项
// ---------------------------------------------------------------------------
ipcMain.handle('open-file', (e, filePath) => {
    shell.openPath(filePath);
    return { success: true };
});

ipcMain.handle('get-app-info', () => ({
    version: app.getVersion(),
    dataPath: PATHS.todos,
    userDataPath: PATHS.userDataDir,
    backupDir: PATHS.backupDir,
    downloadsPath: app.getPath('downloads')
}));

ipcMain.handle('show-save-dialog', (e, options) => dialog.showSaveDialog(options));
ipcMain.handle('show-message-box', (e, options) => dialog.showMessageBox(options));
