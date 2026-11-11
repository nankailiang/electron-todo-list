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

// 日报输出样式：plain（纯文本工作日志，默认）| markdown（按状态分组的汇总）
function reportOptions() {
    const s = readJson(PATHS.settings, null) || {};
    return {
        author: String(s.reportAuthor || '').trim(),
        style: s.reportStyle === 'markdown' ? 'markdown' : 'plain'
    };
}

/** 纯文本日志里的一行状态尾巴：完成 / 60% 预计20261105完成 / 未开始 */
function plainStatusTail(t, dateStr) {
    if (t.status === 'completed') return '完成';
    if (t.status === 'in-progress') {
        const pct = clampProgress(t.progress);
        // 只有截止日晚于当天才写「预计」，当天完不成的任务不写废话
        const eta = t.date && t.date > dateStr ? ` 预计${String(t.date).replace(/-/g, '')}完成` : '';
        return `${pct}%${eta}`;
    }
    return '未开始';
}

/** 把一组任务排成「（1）内容 完成」的日志正文 */
function plainLogBody(arr, dateStr, author) {
    const head = author ? `${author} 工作日志\n` : '工作日志\n';
    const body = arr.map((t, i) => `（${i + 1}）${t.content} ${plainStatusTail(t, dateStr)}`).join('\n');
    return head + body + '\n';
}

// 根据某日任务自动汇总日报内容
function buildReportSummary(todos, dateStr) {
    const scope = Array.isArray(todos) ? todos : [];
    const day = (t) => String(t.completedAt || t.updatedAt || t.createdAt || '').slice(0, 10);
    const startedOn = (t) => String(t.startDate || t.startedAt || t.createdAt || t.date || '').slice(0, 10);

    // 当天到期 / 当天完成
    const due = scope.filter(t => !t.archived && (t.date === dateStr || t.startDate === dateStr));
    // 完成的按「完成时间」从早到晚排，先完成的写在前面的条目（同刻完成保持原有顺序，sort 稳定）
    const doneAt = (t) => String(t.completedAt || t.updatedAt || `${t.date || ''}T23:59`);
    const completed = scope
        .filter(t => !t.archived && (
            (t.status === 'completed' && (t.date === dateStr || day(t) === dateStr)) ||
            (t.completedAt && String(t.completedAt).slice(0, 10) === dateStr)
        ))
        .sort((a, b) => doneAt(a).localeCompare(doneAt(b)));
    // 「当天进度有变化」才写进日志：一直挂着但没推进的在办任务不重复出现在每天的日志里
    const progressDays = (t) => {
        const log = Array.isArray(t.progressLog) ? t.progressLog : [];
        const days = new Set();
        let prev = -1;
        for (const e of log.slice().sort((a, b) => String(a.d || '').localeCompare(String(b.d || '')))) {
            const d = String(e.d || '').slice(0, 10);
            const p = Number(e.p);
            if (!d || !Number.isFinite(p) || p === prev) continue;
            days.add(d);
            prev = p;
        }
        return days;
    };
    // 在办：截止日可能在未来，只要当天已经开始就算「今天在干这件事」；
    // 但只有当天进度真的动过（或有改动的痕迹）才写进日志
    const inProgress = scope
        .filter(t => !t.archived && t.status === 'in-progress' && (!startedOn(t) || startedOn(t) <= dateStr))
        .filter(t => {
            const days = progressDays(t);
            if (days.size) return days.has(dateStr);
            return startedOn(t) === dateStr || day(t) === dateStr;
        })
        .sort((a, b) => startedOn(a).localeCompare(startedOn(b)) || String(a.date || '').localeCompare(String(b.date || '')));
    const pending = due
        .filter(t => t.status === 'pending')
        .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.dueTime || '').localeCompare(String(b.dueTime || '')));
    // 逾期未完成：截止日期早于当日且未结办
    const overdue = scope.filter(t => !t.archived && t.status !== 'completed' && t.date && t.date < dateStr);

    const pick = (t) => ({ id: t.id, content: t.content, priority: t.priority, listId: t.listId, status: t.status, date: t.date, dueTime: t.dueTime || '', progress: clampProgress(t.progress) });
    const lines = (arr, label, withProgress) => {
        if (!arr.length) return `## ${label}\n（无）\n`;
        return `## ${label}\n` + arr.map(t => {
            const pct = withProgress && t.status === 'in-progress' ? `（完成度 ${clampProgress(t.progress)}%）` : '';
            return `- ${t.content}${t.dueTime ? ' ' + t.dueTime : ''}${pct}`;
        }).join('\n') + '\n';
    };

    // 历史进度：生成过去某天的日志时，用那天记下的完成度，而不是今天的值
    const progressAt = (t) => {
        const log = (Array.isArray(t.progressLog) ? t.progressLog : [])
            .filter(e => String(e.d || '') <= dateStr)
            .sort((a, b) => String(a.d || '').localeCompare(String(b.d || '')));
        const last = log[log.length - 1];
        return clampProgress(last ? last.p : t.progress);
    };
    const inProgressView = inProgress.map(t => Object.assign({}, t, { progress: progressAt(t) }));

    const { author, style } = reportOptions();
    const plainItems = [...completed, ...inProgressView, ...pending];
    const defaultContent = style === 'plain'
        ? (plainItems.length ? plainLogBody(plainItems, dateStr, author) : (author ? `${author} 工作日志\n` : '工作日志\n'))
        : `# 工作日报（${dateStr}）\n\n` +
            lines(completed, '今日完成') +
            lines(inProgressView, '进行中', true) +
            lines(pending, '待处理') +
            lines(overdue, '逾期未完成') +
            '## 明日计划\n- \n';

    return {
        date: dateStr,
        title: author ? `${author} 工作日志` : '工作日志',
        author,
        style,
        total: plainItems.length,
        counts: { completed: completed.length, inProgress: inProgressView.length, pending: pending.length, overdue: overdue.length },
        items: {
            completed: completed.map(pick),
            inProgress: inProgressView.map(pick),
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
ipcMain.handle('export-report', async (e, { format = 'txt', style, report }) => {
    try {
        if (!report || !report.content) return { success: false, error: '日报内容为空' };
        // 纯文本日志导出按 .txt 落盘，正文本身就带「姓名 工作日志」抬头，不再套 Markdown 标题
        const plain = (style || 'plain') !== 'markdown';
        const ext = plain ? 'txt' : format;
        const result = await dialog.showSaveDialog({
            title: '导出日报',
            defaultPath: path.join(app.getPath('downloads'), `日报-${report.date || 'export'}.${ext}`),
            filters: [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All Files', extensions: ['*'] }]
        });
        if (result.canceled) return { success: false, error: '导出已取消' };
        let text;
        if (plain) {
            text = report.content.replace(/\r\n/g, '\n').trimEnd() + '\n';
        } else {
            const bodyStartsH1 = /^#\s/.test(String(report.content).trimStart());
            const header = bodyStartsH1
                ? `> 日期：${report.date || ''}\n\n`
                : `# ${report.title || '工作日报'}\n\n> 日期：${report.date || ''}\n\n`;
            const body = format === 'md' ? report.content : report.content
                .replace(/^#+\s*/gm, '')
                .replace(/\*\*(.+?)\*\*/g, '$1');
            text = header + body;
        }
        fs.writeFileSync(result.filePath, text, 'utf8');
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

// CSV 表头顺序与导入模板 tools/templates/tasks.csv 完全一致，导出文件可直接再导入
const CSV_COLUMN_ORDER = ['content', 'date', 'startDate', 'dueTime', 'priority', 'status', 'progress', 'tags', 'note',
    'listId', 'createdAt', 'startedAt', 'completedAt', 'archived', 'id', 'repeat', 'subtasks', 'pinned', 'order', 'updatedAt',
    'progressLog'];

/** 把列参数整理成稳定顺序（未知列忽略，content 必需） */
function pickColumns(columns) {
    const wanted = Array.isArray(columns) && columns.length
        ? new Set(columns.filter(c => CSV_COLUMN_ORDER.includes(c)))
        : new Set(CSV_COLUMN_ORDER);
    wanted.add('content');
    return CSV_COLUMN_ORDER.filter(c => wanted.has(c));
}

/** 单个单元格取值：统一成 CSV 里可读、可再导入的字符串 */
function cellOf(t, key) {
    switch (key) {
        case 'progress': return String(t.status === 'completed' ? 100 : clampProgress(t.progress));
        case 'tags': return (Array.isArray(t.tags) ? t.tags : []).join('|');
        case 'archived': return t.archived ? 'true' : 'false';
        case 'pinned': return t.pinned ? 'true' : 'false';
        case 'repeat': return t.repeat && t.repeat.type && t.repeat.type !== 'none' ? JSON.stringify(t.repeat) : '';
        case 'subtasks': return (Array.isArray(t.subtasks) && t.subtasks.length) ? JSON.stringify(t.subtasks) : '';
        case 'order': return (t.order === undefined || t.order === null) ? '' : String(t.order);
        case 'progressLog': return (Array.isArray(t.progressLog) && t.progressLog.length)
            ? t.progressLog.map(e => `${e.d}:${clampProgress(e.p)}`).join('|')
            : '';
        default: {
            const v = t[key];
            if (v === undefined || v === null) return '';
            return String(v);
        }
    }
}

function csvCell(s) {
    const v = String(s === undefined || s === null ? '' : s);
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

ipcMain.handle('export-todos', async (e, { format, todos, columns }) => {
    try {
        const list = Array.isArray(todos) ? todos : readTodos();
        if (!Array.isArray(list) || list.length === 0) {
            return { success: false, error: '没有可导出的任务' };
        }
        const cols = pickColumns(columns);

        const result = await dialog.showSaveDialog({
            title: '导出待办事项',
            defaultPath: path.join(app.getPath('downloads'), `知行-任务-${new Date().toISOString().slice(0, 10)}-${Date.now().toString().slice(-5)}.${format}`),
            filters: [{ name: `${format.toUpperCase()} Files`, extensions: [format] }, { name: 'All Files', extensions: ['*'] }]
        });
        if (result.canceled) return { success: false, error: '导出已取消' };

        let content = '';
        switch (format) {
            case 'json': content = JSON.stringify(list.map(t => projectTodo(t, cols)), null, 2); break;
            case 'csv': content = toCSV(list, cols); break;
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

/** JSON 导出按勾选的列投影，未勾选的字段不出现 */
function projectTodo(t, cols) {
    const out = {};
    cols.forEach(k => {
        if (k === 'progress') out.progress = t.status === 'completed' ? 100 : clampProgress(t.progress);
        else if (k === 'tags') out.tags = Array.isArray(t.tags) ? t.tags : [];
        else if (k === 'subtasks') out.subtasks = Array.isArray(t.subtasks) ? t.subtasks : [];
        else if (k === 'archived' || k === 'pinned') out[k] = !!t[k];
        else out[k] = t[k] === undefined ? null : t[k];
    });
    return out;
}

function toCSV(todos, columns) {
    const cols = Array.isArray(columns) && columns.length ? columns : CSV_COLUMN_ORDER;
    // 加 BOM，Excel 打开中文不乱码；解析导入时会自动去掉
    let csv = '\uFEFF' + cols.join(',') + '\n';
    todos.forEach(t => {
        csv += cols.map(c => csvCell(cellOf(t, c))).join(',') + '\n';
    });
    return csv;
}

function toTXT(todos) {
    let txt = `待办事项列表\n导出时间: ${new Date().toLocaleString()}\n总数量: ${todos.length}\n${'-'.repeat(50)}\n\n`;
    todos.forEach((t, i) => {
        txt += `${i + 1}. [${STATUS_MAP[t.status] || t.status}] ${t.content}`;
        if (t.status === 'in-progress') txt += `（完成度 ${clampProgress(t.progress)}%）`;
        txt += '\n';
        txt += `   日期: ${t.date || ''}${t.dueTime ? ' ' + t.dueTime : ''}\n`;
        if (t.startDate) txt += `   开始日期: ${t.startDate}\n`;
        txt += `   优先级: ${PRIORITY_MAP[t.priority] || t.priority}\n`;
        if (t.tags && t.tags.length) txt += `   标签: ${t.tags.join(', ')}\n`;
        if (t.note) txt += `   备注: ${t.note}\n`;
        if (t.subtasks && t.subtasks.length) {
            txt += `   子任务: ${t.subtasks.map(s => `${s.done ? '[√]' : '[ ]'}${s.text}`).join(' / ')}\n`;
        }
        if (t.createdAt) txt += `   创建时间: ${fmtMoment(t.createdAt)}\n`;
        if (t.startedAt) txt += `   开始时间: ${fmtMoment(t.startedAt)}\n`;
        if (t.completedAt) txt += `   完成时间: ${fmtMoment(t.completedAt)}\n`;
        if (t.repeat && t.repeat.type && t.repeat.type !== 'none') txt += `   重复: ${REPEAT_MAP[t.repeat.type] || t.repeat.type}${t.repeat.type === 'custom' ? ' / 每 ' + (t.repeat.interval || 1) + ' 天' : ''}\n`;
        if (t.archived) txt += '   已归档\n';
        txt += `${'-'.repeat(50)}\n`;
    });
    return txt;
}

// ISO 时间 → 本地「YYYY-MM-DD HH:mm」
function fmtMoment(v) {
    if (!v) return '';
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const REPEAT_MAP = { none: '不重复', daily: '每日', weekly: '每周', monthly: '每月', custom: '自定义天数' };

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
            if (status === 'in-progress') metas.push(`完成度 ${clampProgress(t.progress)}%`);
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
            const stamps = [];
            if (t.createdAt) stamps.push(`创建 ${fmtMoment(t.createdAt)}`);
            if (t.startedAt) stamps.push(`开始 ${fmtMoment(t.startedAt)}`);
            if (t.completedAt) stamps.push(`完成 ${fmtMoment(t.completedAt)}`);
            if (stamps.length) md += `  <sub>${stamps.join('　')}</sub>\n`;
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

// 完成度：0~100 整数，容忍 "30%" 这类写法与脏数据
function clampProgress(v) {
    if (v === null || v === undefined || v === '') return 0;
    const n = Math.round(parseFloat(String(v).replace('%', '').trim()));
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

// 「true/false/1/0/是/否」都能吃
function toBool(v, dflt = false) {
    if (typeof v === 'boolean') return v;
    if (v === undefined || v === null || v === '') return dflt;
    return /^(true|1|yes|y|是|已归档|置顶)$/i.test(String(v).trim());
}

// 重复周期：支持 "daily"、"daily:2"、{"type":"daily","interval":2} 三种写法
function normalizeRepeat(v) {
    if (!v) return { type: 'none', interval: 1 };
    if (typeof v === 'object') {
        const type = ['none', 'daily', 'weekly', 'monthly', 'custom'].includes(v.type) ? v.type : 'none';
        return { type, interval: Math.max(1, parseInt(v.interval) || 1) };
    }
    const s = String(v).trim();
    if (s.startsWith('{')) {
        try { return normalizeRepeat(JSON.parse(s)); } catch { return { type: 'none', interval: 1 }; }
    }
    const [type, interval] = s.split(/[:/|]/);
    const t = ['none', 'daily', 'weekly', 'monthly', 'custom'].includes(type) ? type : 'none';
    return { type: t, interval: Math.max(1, parseInt(interval) || 1) };
}

function normalizeTodo(t) {
    if (!t || !t.content) return null;
    let tags = t.tags;
    if (typeof tags === 'string') tags = tags.split(/[|,]/).map(s => s.trim()).filter(Boolean);
    if (!Array.isArray(tags)) tags = [];
    let subtasks = t.subtasks;
    if (typeof subtasks === 'string') {
        const s = subtasks.trim();
        if (!s) subtasks = [];
        else if (s.startsWith('[')) { try { subtasks = JSON.parse(s); } catch { subtasks = []; } }
        else subtasks = s.split(/[|;]/).map(x => ({ text: x.trim(), done: false })).filter(x => x.text);
    }
    if (!Array.isArray(subtasks)) subtasks = [];
    subtasks = subtasks.map(s => ({
        id: s.id ? String(s.id) : (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
        text: String(s.text || '').trim(),
        done: toBool(s.done)
    })).filter(s => s.text);
    const status = ['pending', 'in-progress', 'completed'].includes(t.status) ? t.status : 'pending';
    // 进度流水：兼容 JSON（[{d,p}]）与紧凑写法（2026-10-21:20|2026-10-29:80）
    let progressLog = t.progressLog;
    if (typeof progressLog === 'string') {
        const s = progressLog.trim();
        if (!s) progressLog = [];
        else if (s.startsWith('[')) { try { progressLog = JSON.parse(s); } catch { progressLog = []; } }
        else progressLog = s.split(/[|;]/).map(pair => {
            const [d, p] = pair.split(/[:：]/);
            return { d: String(d || '').trim(), p: clampProgress(p) };
        }).filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e.d));
    }
    if (!Array.isArray(progressLog)) progressLog = [];
    progressLog = progressLog.map(e => ({
        d: String((e && (e.d || e.date)) || '').slice(0, 10),
        p: clampProgress(e && (e.p !== undefined ? e.p : e.progress))
    })).filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e.d))
        .sort((a, b) => a.d.localeCompare(b.d));
    return {
        id: t.id ? String(t.id) : (Date.now().toString() + Math.random().toString(36).slice(2, 8)),
        listId: t.listId || 'default',
        startDate: t.startDate || '',
        date: t.date || todayStr(),
        dueTime: t.dueTime || '',
        priority: ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium',
        content: String(t.content).trim(),
        note: t.note || '',
        status,
        progress: status === 'completed' ? 100 : clampProgress(t.progress),
        progressLog,
        tags,
        subtasks,
        pinned: toBool(t.pinned),
        archived: toBool(t.archived),
        repeat: normalizeRepeat(t.repeat),
        order: Number.isFinite(parseInt(t.order)) ? parseInt(t.order) : 0,
        createdAt: t.createdAt || new Date().toISOString(),
        startedAt: t.startedAt || null,
        completedAt: t.completedAt || null,
        updatedAt: t.updatedAt || new Date().toISOString()
    };
}

function parseCSV(content) {
    // 去掉 Excel 导出带的 BOM，否则首列表头会变成「\uFEFFcontent」
    const text = String(content).replace(/^\uFEFF/, '');
    // 完整 CSV 解析：支持引号包裹的字段内含逗号、换行（备注多行不再损坏）
    const rows = [];
    let row = [], cur = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false; }
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
        if (t) todos.push({ content: t.replace(/^\d+\.\s*/, ''), date: todayStr(), priority: 'medium', status: 'pending' });
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
                date: todayStr(),
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
