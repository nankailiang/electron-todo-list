#!/usr/bin/env node
/**
 * 知行 —— 历史数据补录工具（任务 + 日报）
 *
 * 应用内只有「任务」有导入入口（json/csv/txt/md），「日报」没有。本工具
 * 直接把整理好的 CSV/JSON 合并进数据目录，任务和日报都支持。
 *
 * 安全策略：
 *   · 默认 **演练模式（dry-run）**，只打印将要发生的变更，不写盘
 *   · 真正写入需显式加 --write
 *   · 写入前自动把现有 todoList.json / reports.json 备份到 backups/import-<时间戳>/
 *   · 原子写（临时文件 + rename）
 *   · 数据文件是 ENC1: 密文时必须提供 --passphrase，读解密、写重新加密
 *
 * 用法：
 *   node tools/backfill-import.mjs --tasks tasks.csv --reports reports.csv
 *   node tools/backfill-import.mjs --tasks tasks.csv --reports reports.csv --write
 *   node tools/backfill-import.mjs --tasks tasks.json --write --on-conflict overwrite
 *   node tools/backfill-import.mjs --tasks tasks.csv --data-dir "C:\Users\me\AppData\Roaming\zhixing"
 *
 * 参数：
 *   --tasks <file>        任务 CSV / JSON
 *   --reports <file>      日报 CSV / JSON
 *   --data-dir <dir>      数据目录（默认自动探测 Electron 的 %APPDATA%\zhixing）
 *   --passphrase <p>      数据已加密时必填
 *   --on-conflict <skip|overwrite>   重复时怎么办，默认 skip
 *   --write               真正写入（不加则为演练）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync, readdirSync } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = { onConflict: 'skip', write: false };
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--tasks') opt.tasks = next();
    else if (a === '--reports') opt.reports = next();
    else if (a === '--data-dir') opt.dataDir = next();
    else if (a === '--passphrase') opt.passphrase = next();
    else if (a === '--on-conflict') opt.onConflict = next();
    else if (a === '--write') opt.write = true;
    else if (a === '-h' || a === '--help') opt.help = true;
    else { console.error(`未知参数: ${a}`); process.exit(1); }
}

if (opt.help || (!opt.tasks && !opt.reports)) {
    const src = readFileSync(new URL(import.meta.url), 'utf8');
    const header = src.split('*/')[0]
        .replace(/^#!.*\n/, '')
        .replace(/^\s*\/\*\*?/, '')
        .split('\n')
        .map(l => l.replace(/^\s*\* ?/, ''))
        .join('\n')
        .trim();
    console.log(header);
    process.exit(opt.help ? 0 : 1);
}
if (!['skip', 'overwrite'].includes(opt.onConflict)) {
    console.error('--on-conflict 只能是 skip 或 overwrite');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// 数据目录探测
// ---------------------------------------------------------------------------
function findDataDir() {
    if (opt.dataDir) return resolve(opt.dataDir);
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    const candidates = [
        join(appData, 'zhixing'),            // Electron 版（app.getPath('userData')）
        join(appData, 'com.zhixing.app'),    // Tauri 版（app_data_dir）
    ];
    for (const c of candidates) {
        if (existsSync(join(c, 'todoList.json'))) return c;
    }
    return candidates[0];
}

const DATA_DIR = findDataDir();
const P_TODOS = join(DATA_DIR, 'todoList.json');
const P_REPORTS = join(DATA_DIR, 'reports.json');
const P_LISTS = join(DATA_DIR, 'lists.json');
const P_META = join(DATA_DIR, 'crypto.meta.json');
const BACKUP_ROOT = join(DATA_DIR, 'backups');

// ---------------------------------------------------------------------------
// 加密（与 main.js 完全一致：scrypt 默认参数 + aes-256-gcm，密文 ENC1:iv:tag:data）
// ---------------------------------------------------------------------------
function deriveKey(passphrase, saltHex) {
    return scryptSync(passphrase, Buffer.from(saltHex, 'hex'), 32);
}
function encryptString(plain, key) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `ENC1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}
function decryptString(payload, key) {
    const parts = payload.split(':');
    if (parts[0] !== 'ENC1' || parts.length !== 4) throw new Error('密文格式错误');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'hex'));
    decipher.setAuthTag(Buffer.from(parts[2], 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'hex')), decipher.final()]).toString('utf8');
}
const isEnc = (s) => typeof s === 'string' && s.startsWith('ENC1:');

let cryptoKey = null;
function initCrypto() {
    if (!existsSync(P_META)) return;
    if (!opt.passphrase) {
        console.error('✗ 该数据目录已启用加密（存在 crypto.meta.json），必须加 --passphrase <口令>');
        process.exit(1);
    }
    let meta;
    try { meta = JSON.parse(readFileSync(P_META, 'utf8')); }
    catch { console.error('✗ crypto.meta.json 读取失败'); process.exit(1); }
    cryptoKey = deriveKey(opt.passphrase, meta.salt);
    try {
        if (decryptString(meta.verifier, cryptoKey) !== 'todo-verifier-ok') throw new Error('bad');
    } catch {
        console.error('✗ 口令错误');
        process.exit(1);
    }
}

function readDataFile(p) {
    if (!existsSync(p)) return { data: [], encrypted: false };
    const raw = readFileSync(p, 'utf8');
    if (!raw.trim()) return { data: [], encrypted: false };
    if (isEnc(raw)) {
        if (!cryptoKey) throw new Error(`${basename(p)} 是密文但没有口令`);
        return { data: JSON.parse(decryptString(raw, cryptoKey)), encrypted: true };
    }
    return { data: JSON.parse(raw), encrypted: false };
}
function writeDataFile(p, data, encrypted) {
    let content = JSON.stringify(data, null, 2);
    if (encrypted) content = encryptString(content, cryptoKey);
    const tmp = p + '.tmp';
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, p);
}

// ---------------------------------------------------------------------------
// CSV / JSON 读取
// ---------------------------------------------------------------------------
function parseCSV(text) {
    text = text.replace(/^\uFEFF/, '');           // Excel 的 BOM
    const rows = [];
    let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
            if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
            else cur += c;
        } else if (c === '"') q = true;
        else if (c === ',') { row.push(cur); cur = ''; }
        else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
        else if (c !== '\r') cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }

    const clean = rows.filter(r => r.some(v => v.trim() !== ''));
    if (!clean.length) return [];
    // 跳过 # 开头的说明行
    while (clean.length && clean[0][0].trim().startsWith('#')) clean.shift();
    if (!clean.length) return [];

    const headers = clean[0].map(h => h.trim().toLowerCase());
    return clean.slice(1).map(values => {
        const o = {};
        headers.forEach((h, i) => { if (h) o[h] = (values[i] ?? '').trim(); });
        return o;
    });
}

function loadRows(file) {
    if (!existsSync(file)) { console.error(`✗ 文件不存在: ${file}`); process.exit(1); }
    const text = readText(file);
    const ext = extname(file).toLowerCase();
    if (ext === '.json') {
        const j = JSON.parse(text.replace(/^\uFEFF/, ''));
        if (!Array.isArray(j)) { console.error(`✗ ${basename(file)} 顶层必须是数组`); process.exit(1); }
        return j.map(o => {
            const flat = {};
            for (const [k, v] of Object.entries(o)) {
                flat[k.toLowerCase()] = Array.isArray(v) ? v.join('|') : (v == null ? '' : String(v));
            }
            return { flat, raw: o };
        });
    }
    return parseCSV(text).map(flat => ({ flat, raw: null }));
}

/**
 * 读文本文件并自动识别编码。
 * 中文 Windows 下 Excel「另存为 CSV」默认是 GBK，直接按 UTF-8 读会变乱码，
 * 所以先按严格 UTF-8 试，失败再按 GBK 解。
 */
function readText(file) {
    const buf = readFileSync(file);
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
        try {
            console.log(`  (检测到非 UTF-8 编码，按 GBK 读取: ${basename(file)})`);
            return new TextDecoder('gbk').decode(buf);
        } catch {
            console.error(`✗ 无法识别 ${basename(file)} 的编码，请另存为 UTF-8 CSV`);
            process.exit(1);
        }
    }
}

// ---------------------------------------------------------------------------
// 字段规整
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');

/** 本地时区的今天（不能用 toISOString，UTC+8 凌晨会差一天） */
function todayLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** '2025/3/5' / '2025-3-5' / '2025-03-05' / Excel 日期 → 'YYYY-MM-DD'；空返回 '' */
function normDate(v) {
    if (!v) return '';
    const s = String(v).trim();
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    m = s.match(/^(\d{4})(\d{2})(\d{2})$/);           // 20250305
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    const d = new Date(s);
    if (!isNaN(d)) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return '';
}

/** 时间戳 → ISO 字符串（本地时区解释）。支持 ISO / 'YYYY-MM-DD HH:mm' / 'YYYY-MM-DD' */
function normTs(v, fallbackDate, fallbackHour = 9) {
    if (v && String(v).trim()) {
        const s = String(v).trim().replace(/\//g, '-');
        // 纯日期补默认时刻
        if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
            const [y, mo, d] = s.split('-').map(Number);
            return new Date(y, mo - 1, d, fallbackHour, 0, 0).toISOString();
        }
        const d = new Date(s.includes('T') ? s : s.replace(' ', 'T'));
        if (!isNaN(d)) return d.toISOString();
    }
    if (fallbackDate) {
        const [y, mo, d] = fallbackDate.split('-').map(Number);
        return new Date(y, mo - 1, d, fallbackHour, 0, 0).toISOString();
    }
    return new Date().toISOString();
}

function normTime(v) {
    if (!v) return '';
    const m = String(v).trim().match(/^(\d{1,2})[:：](\d{1,2})/);
    if (!m) return '';
    const h = Math.min(23, Number(m[1])), mi = Math.min(59, Number(m[2]));
    return `${pad(h)}:${pad(mi)}`;
}

/** 完成度：接受 30 / "30%" / " 30 "，夹到 0~100；空值按 0 */
function normProgress(v) {
    if (v === undefined || v === null) return 0;
    const s = String(v).trim().replace(/%/g, '');
    if (!s) return 0;
    const n = Number(s);
    if (!isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
}

const PRIORITY_ALIAS = {
    high: 'high', medium: 'medium', low: 'low',
    '高': 'high', '中': 'medium', '低': 'low', '紧急': 'high', '普通': 'medium',
};
const STATUS_ALIAS = {
    pending: 'pending', 'in-progress': 'in-progress', completed: 'completed',
    '待办': 'pending', '未开始': 'pending', '进行中': 'in-progress', '在办': 'in-progress',
    '完成': 'completed', '已完成': 'completed', '结办': 'completed',
};

function splitTags(v, raw) {
    if (raw && Array.isArray(raw.tags)) return raw.tags.map(String).filter(Boolean);
    if (!v) return [];
    return String(v).split(/[|,，;；]/).map(s => s.trim()).filter(Boolean);
}

const warnings = [];

function toTask({ flat, raw }, listIds, orderStart) {
    const content = (flat.content || '').trim();
    if (!content) return null;

    const date = normDate(flat.date) || normDate(flat.completedat) || normDate(flat.createdat);
    const status = STATUS_ALIAS[String(flat.status || '').trim().toLowerCase()] || STATUS_ALIAS[flat.status] || 'pending';
    const priority = PRIORITY_ALIAS[String(flat.priority || '').trim().toLowerCase()] || PRIORITY_ALIAS[flat.priority] || 'medium';

    let listId = flat.listid || 'default';
    if (!listIds.has(listId)) {
        warnings.push(`清单 ${listId} 不存在，任务「${content.slice(0, 16)}」归入 default`);
        listId = 'default';
    }

    const subtasks = raw && Array.isArray(raw.subtasks)
        ? raw.subtasks.map((s, i) => ({ id: String(s.id || `s${i + 1}`), text: String(s.text || ''), done: !!s.done }))
        : [];

    const repeatType = (flat.repeat || '').trim();
    const repeat = {
        type: (raw && raw.repeat && typeof raw.repeat === 'object' ? raw.repeat.type : repeatType) || 'none',
        interval: Number((raw && raw.repeat && typeof raw.repeat === 'object' ? raw.repeat.interval : flat.repeatinterval) || 1) || 1,
    };

    const baseDate = date || normDate(flat.date);
    return {
        id: String(flat.id || '').trim() || `${Date.now()}${Math.floor(Math.random() * 1e6)}`,
        content,
        note: flat.note || '',
        priority,
        status,
        progress: status === 'completed' ? 100 : normProgress(flat.progress),
        listId,
        date: baseDate || '',
        startDate: normDate(flat.startdate),
        dueTime: normTime(flat.duetime),
        tags: splitTags(flat.tags, raw),
        subtasks,
        repeat,
        pinned: /^(true|1|是|y)$/i.test(String(flat.pinned || '')),
        archived: /^(true|1|是|y)$/i.test(String(flat.archived || '')),
        order: (flat.order !== '' && flat.order !== undefined && !isNaN(Number(flat.order))) ? Number(flat.order) : orderStart,
        createdAt: normTs(flat.createdat, baseDate, 9),
        startedAt: status === 'in-progress' ? normTs(flat.startedat, baseDate, 10) : null,
        completedAt: status === 'completed' ? normTs(flat.completedat, baseDate, 18) : null,
        updatedAt: normTs(flat.updatedat, baseDate, 18),
    };
}

function toReport({ flat }) {
    const date = normDate(flat.date);
    const content = (flat.content || '').trim();
    if (!date || !content) return null;
    return {
        id: String(flat.id || '').trim() || `${Date.now()}${Math.floor(Math.random() * 1e6)}`,
        date,
        title: (flat.title || '').trim() || `${date.replace(/-/g, '/')} 工作日报`,
        content,
        createdAt: normTs(flat.createdat, date, 20),
        updatedAt: normTs(flat.updatedat, date, 20),
    };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
console.log(`数据目录: ${DATA_DIR}`);
if (!existsSync(DATA_DIR)) {
    console.error('✗ 目录不存在。请先用知行启动一次，或显式指定 --data-dir');
    process.exit(1);
}
initCrypto();

let lists = [];
try { lists = JSON.parse(readFileSync(P_LISTS, 'utf8')); } catch { /* 没清单文件就用默认 */ }
const listIds = new Set((Array.isArray(lists) ? lists : []).map(l => l.id));
listIds.add('default');

const todoState = readDataFile(P_TODOS);
const reportState = readDataFile(P_REPORTS);

const existingTodos = Array.isArray(todoState.data) ? todoState.data : [];
const existingReports = Array.isArray(reportState.data) ? reportState.data : [];

const exists = {
    todoById: new Map(existingTodos.filter(t => t && t.id).map(t => [String(t.id), t])),
    todoByKey: new Map(existingTodos.filter(t => t && t.content)
        .map(t => [`${t.content}|${t.date || ''}|${t.status || ''}`, t])),
    reportByDate: new Map(existingReports.filter(r => r && r.date).map(r => [r.date, r])),
};

let nextOrder = existingTodos.reduce((m, t) => Math.max(m, Number(t.order) || 0), -1) + 1;

function mergeTasks(rows) {
    let add = 0, skip = 0, overwrite = 0;
    const added = [];
    rows.forEach(row => {
        const t = toTask(row, listIds, nextOrder);
        if (!t) { skip++; return; }
        const byId = exists.todoById.get(t.id);
        const key = `${t.content}|${t.date || ''}|${t.status || ''}`;
        const byKey = exists.todoByKey.get(key);
        const dup = byId || (row.flat.id ? null : byKey);   // 没给 id 才按内容判重

        if (dup) {
            if (opt.onConflict === 'overwrite') {
                Object.assign(dup, t, { id: dup.id });
                overwrite++;
            } else skip++;
            return;
        }
        if (!t.date) t.date = todayLocal();
        t.order = nextOrder++;
        existingTodos.push(t);
        exists.todoById.set(String(t.id), t);
        exists.todoByKey.set(key, t);
        added.push(t);
        add++;
    });
    return { add, skip, overwrite, added };
}

function mergeReports(rows) {
    let add = 0, skip = 0, overwrite = 0;
    rows.forEach(row => {
        const r = toReport(row);
        if (!r) { skip++; return; }
        const dup = exists.reportByDate.get(r.date);
        if (dup) {
            if (opt.onConflict === 'overwrite') {
                Object.assign(dup, r, { id: dup.id });
                overwrite++;
            } else skip++;
            return;
        }
        existingReports.push(r);
        exists.reportByDate.set(r.date, r);
        add++;
    });
    return { add, skip, overwrite };
}

const result = {};

if (opt.tasks) {
    const rows = loadRows(opt.tasks);
    console.log(`\n[任务] ${basename(opt.tasks)} → ${rows.length} 行`);
    result.tasks = mergeTasks(rows);
    const r = result.tasks;
    console.log(`  新增 ${r.add}  跳过 ${r.skip}  覆盖 ${r.overwrite}`);
    if (r.added.length) {
        console.log('  预览（前 5 条）:');
        r.added.slice(0, 5).forEach(t => console.log(`    · ${t.date}  [${t.status}]  ${t.content.slice(0, 30)}`));
    }
}

if (opt.reports) {
    const rows = loadRows(opt.reports);
    console.log(`\n[日报] ${basename(opt.reports)} → ${rows.length} 行`);
    result.reports = mergeReports(rows);
    const r = result.reports;
    console.log(`  新增 ${r.add}  跳过 ${r.skip}  覆盖 ${r.overwrite}`);
}

if (warnings.length) {
    console.log(`\n⚠️  ${warnings.length} 条提醒`);
    [...new Set(warnings)].slice(0, 10).forEach(w => console.log(`   · ${w}`));
}

// ---- 写盘 ----
const willWrite = (result.tasks?.add || result.tasks?.overwrite) || (result.reports?.add || result.reports?.overwrite);

if (!opt.write) {
    console.log('\n—— 演练模式，未写入任何文件 ——');
    const parts = ['node tools/backfill-import.mjs'];
    if (opt.dataDir) parts.push(`--data-dir "${opt.dataDir}"`);
    if (opt.tasks) parts.push(`--tasks "${opt.tasks}"`);
    if (opt.reports) parts.push(`--reports "${opt.reports}"`);
    if (opt.onConflict !== 'skip') parts.push(`--on-conflict ${opt.onConflict}`);
    if (opt.passphrase) parts.push('--passphrase <口令>');
    console.log(`确认无误后加 --write 执行：\n  ${parts.join(' ')} --write`);
    process.exit(0);
}
if (!willWrite) {
    console.log('\n没有需要写入的变更。');
    process.exit(0);
}

// 备份
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backupDir = join(BACKUP_ROOT, `import-${stamp}`);
mkdirSync(backupDir, { recursive: true });
for (const p of [P_TODOS, P_REPORTS]) {
    if (existsSync(p)) copyFileSync(p, join(backupDir, basename(p)));
}
console.log(`\n已备份原数据 → ${backupDir}`);

try {
    if (result.tasks && (result.tasks.add || result.tasks.overwrite)) {
        writeDataFile(P_TODOS, existingTodos, todoState.encrypted);
    }
    if (result.reports && (result.reports.add || result.reports.overwrite)) {
        writeDataFile(P_REPORTS, existingReports, reportState.encrypted);
    }
} catch (e) {
    console.error(`\n✗ 写入失败: ${e.message}`);
    console.error(`  原数据备份在 ${backupDir}，可直接复制回去恢复`);
    process.exit(1);
}

console.log('✓ 导入完成');
if (todoState.encrypted || reportState.encrypted) console.log('  （数据保持加密状态）');
console.log('  重新打开知行即可看到数据。若应用当时正开着，请先退出再导入，否则会被内存中的旧数据覆盖。');
