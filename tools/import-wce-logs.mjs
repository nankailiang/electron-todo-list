#!/usr/bin/env node
/**
 * 知行 —— 工作日志合集解析工具（通达现场「我的日志」导出文件）
 *
 * 把「南开亮 工作日志 / （1）xxx 完成 / （2）xxx 60% 预计20261105完成」这种
 * 纯文本日志合集，解析成可直接导入知行的任务 + 日报，产出两份 CSV，
 * 并可选地直接调用 backfill-import.mjs 写入数据目录。
 *
 * 用法：
 *   node tools/import-wce-logs.mjs "全部日志合集.txt"
 *   node tools/import-wce-logs.mjs "全部日志合集.txt" --out out/ --write
 *   node tools/import-wce-logs.mjs logs.txt --author 南开亮 --tag 历史日志 --write
 *
 * 参数：
 *   <log.txt>             日志合集文件（必填）
 *   --out <dir>           CSV 输出目录（默认：日志同级目录 /知行导入-<时间戳>/）
 *   --author <name>       抬头署名，日志里解析不出时兜底
 *   --tag <a,b>           给导入的任务打标签
 *   --list-id <id>        任务归入哪个清单，默认 default
 *   --gap <days>          同一任务跨天出现、间隔不超过 N 天视为同一条（默认 10）
 *   --no-merge            不做跨天合并，每条日志都生成一条任务
 *   --write               解析完直接导入（调用 backfill-import.mjs）
 *   --data-dir <dir>      数据目录，透传给 backfill-import
 *   --passphrase <p>      数据已加密时必填，透传给 backfill-import
 *   --on-conflict <skip|overwrite>  重复任务处理方式，默认 skip
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = { gap: 10, merge: true, listId: 'default', onConflict: 'skip', write: false };
const positional = [];
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--out') opt.out = next();
    else if (a === '--author') opt.author = (next() || '').trim();
    else if (a === '--tag') opt.tag = next();
    else if (a === '--list-id') opt.listId = next();
    else if (a === '--gap') opt.gap = Math.max(0, Number(next()) || 10);
    else if (a === '--no-merge') opt.merge = false;
    else if (a === '--write') opt.write = true;
    else if (a === '--data-dir') opt.dataDir = next();
    else if (a === '--passphrase') opt.passphrase = next();
    else if (a === '--on-conflict') opt.onConflict = next();
    else if (a === '-h' || a === '--help') opt.help = true;
    else if (a.startsWith('--')) { console.error(`未知参数: ${a}`); process.exit(1); }
    else positional.push(a);
}

if (opt.help || !positional.length) {
    const src = readFileSync(new URL(import.meta.url), 'utf8');
    console.log(src.split('*/')[0].replace(/^#!.*\n/, '').replace(/^\s*\/\*\*?/, '')
        .split('\n').map(l => l.replace(/^\s*\* ?/, '')).join('\n').trim());
    process.exit(opt.help ? 0 : 1);
}
if (!['skip', 'overwrite'].includes(opt.onConflict)) {
    console.error('--on-conflict 只能是 skip 或 overwrite');
    process.exit(1);
}

const SRC = resolve(positional[0]);
if (!existsSync(SRC)) { console.error(`✗ 文件不存在: ${SRC}`); process.exit(1); }

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const warnings = [];
const warn = (msg) => warnings.push(msg);

function readText(file) {
    const buf = readFileSync(file);
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
        console.log(`  (检测到非 UTF-8 编码，按 GBK 读取: ${basename(file)})`);
        return new TextDecoder('gbk').decode(buf);
    }
}

const stamp = () => {
    const d = new Date();
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
};

/** 八位/六位紧凑日期 → YYYY-MM-DD；也接受带分隔符的写法 */
function normDate(raw) {
    if (!raw) return '';
    const digits = String(raw).replace(/[^\d]/g, '');
    if (digits.length === 8) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    if (digits.length === 6) return `20${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 6)}`;
    const m = String(raw).match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    return '';
}

const isoOf = (date, hour) => new Date(`${date}T${pad(hour)}:00:00`).toISOString();
const dayDiff = (a, b) => Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000);

function csvCell(v) {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCSV = (headers, rows) =>
    '\uFEFF' + [headers.join(','), ...rows.map(r => headers.map(h => csvCell(r[h])).join(','))].join('\n') + '\n';

const stableId = (prefix, seed) =>
    `${prefix}-${createHash('sha1').update(seed).digest('hex').slice(0, 10)}`;

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------
const DATE_ONLY = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/;
const SEP = /^[=\-—_]{3,}$/;
const NUMBERED = /^[（(]?\s*(\d{1,3})\s*[）).、,，:：]\s*(.+)$/;
const ETA_RE = /预计\s*(\d{8}|\d{6}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\s*(?:开发)?完成\s*$/;
const PCT_RE = /(?:进度\s*)?(\d{1,3})\s*%\s*$/;

/** 一条日志正文 → {content, status, progress, eta} */
function parseItem(text) {
    let s = text.replace(/[\u3000\u00a0]/g, ' ').replace(/\s+/g, ' ').trim();
    let eta = '';
    const em = s.match(ETA_RE);
    if (em) { eta = normDate(em[1]); s = s.slice(0, em.index).trim(); }

    let progress = null;
    const pm = s.match(PCT_RE);
    if (pm) {
        progress = Math.max(0, Math.min(100, Number(pm[1])));
        s = s.slice(0, pm.index).trim();
    }

    let status = 'pending';
    if (/未完成$/.test(s)) { status = 'in-progress'; s = s.replace(/\s*未完成$/, '').trim(); }
    else if (/完成$/.test(s)) { status = 'completed'; s = s.replace(/\s*完成$/, '').trim(); }
    else if (progress !== null) { status = 'in-progress'; }

    s = s.replace(/[，,。;；\s]+$/, '').trim();
    if (status === 'completed') progress = 100;
    return { content: s, status, progress: progress === null ? 0 : progress, eta };
}

/** 解析整个合集 → [{date, author, items:[...]}] */
function parseLog(text) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    const blocks = [];
    let cur = null;

    const startBlock = (date) => {
        cur = { date, author: '', items: [] };
        blocks.push(cur);
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/[\u3000\u00a0]/g, ' ').trim();
        if (!line || SEP.test(line)) continue;

        const dm = line.match(DATE_ONLY);
        if (dm) { startBlock(`${dm[1]}-${pad(dm[2])}-${pad(dm[3])}`); continue; }

        // 标题行：「南开亮 工作日志」「1. 南开亮 工作日志」「20260814南开亮 工作日志」
        if (line.includes('工作日志')) {
            if (!cur) startBlock('');
            let t = line.replace(/^[（(]?\d{1,3}[）).、,，]\s*/, '').trim();
            const inlineDate = t.match(/^(\d{8}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\s*/);
            if (inlineDate) {
                const d = normDate(inlineDate[1]);
                if (d) {
                    if (cur.date && cur.date !== d) {
                        warn(`第 ${i + 1} 行标题内日期 ${d} 与分块日期 ${cur.date} 不一致，按标题日期归入`);
                        cur.date = d;
                    } else if (!cur.date) {
                        cur.date = d;
                    }
                }
                t = t.slice(inlineDate[0].length).trim();
            }
            const am = t.match(/^(.*?)\s*工作日志$/);
            if (am && am[1]) cur.author = am[1].trim();
            continue;
        }

        const nm = line.match(NUMBERED);
        if (nm && cur) {
            const item = parseItem(nm[2]);
            if (item.content) cur.items.push(item);
            else warn(`第 ${i + 1} 行内容为空：${line}`);
            continue;
        }
        warn(`第 ${i + 1} 行无法识别，已跳过：${line.slice(0, 40)}`);
    }

    return blocks.filter(b => b.date && b.items.length);
}

// ---------------------------------------------------------------------------
// 生成任务 / 日报
// ---------------------------------------------------------------------------
function buildTasks(blocks) {
    // 同一天里重复出现的同名条目（导出的文件有整段重复）只留一条
    const perDay = new Map();
    for (const b of blocks) {
        const seen = new Map();
        for (const it of b.items) {
            const key = it.content;
            const prev = seen.get(key);
            if (prev) {
                // 后出现的进度更高就以它为准
                if ((it.progress || 0) >= (prev.progress || 0) || it.status === 'completed') Object.assign(prev, it);
                continue;
            }
            const copy = { ...it, date: b.date };
            seen.set(key, copy);
            if (!perDay.has(b.date)) perDay.set(b.date, []);
            perDay.get(b.date).push(copy);
        }
    }

    if (!opt.merge) {
        const tasks = [];
        for (const [date, items] of [...perDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            items.forEach((it, i) => tasks.push(toTask(it, [it], i)));
        }
        return { tasks, perDay };
    }

    // 按内容归组 → 连续出现（间隔 ≤ gap 天）的算同一条任务
    const groups = new Map();
    for (const [date, items] of perDay) {
        for (const it of items) {
            if (!groups.has(it.content)) groups.set(it.content, []);
            groups.get(it.content).push(it);
        }
    }

    const tasks = [];
    for (const [content, items] of groups) {
        items.sort((a, b) => a.date.localeCompare(b.date));
        let run = [];
        const flush = () => {
            if (run.length) tasks.push(toTask(run[run.length - 1], run, tasks.length));
            run = [];
        };
        for (const it of items) {
            if (run.length && dayDiff(run[run.length - 1].date, it.date) > opt.gap) flush();
            run.push(it);
        }
        flush();
    }
    tasks.sort((a, b) => (a.startDate || a.date).localeCompare(b.startDate || b.date));
    tasks.forEach((t, i) => { t.order = i; });
    return { tasks, perDay };
}

function toTask(last, run, index) {
    const first = run[0];
    const done = last.status === 'completed';
    const date = last.eta || last.date;
    const tags = (opt.tag || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
    const noteParts = [];
    if (run.length > 1) noteParts.push(`日志 ${first.date} ~ ${last.date}（${run.length} 天）`);
    if (last.eta && last.eta !== last.date) noteParts.push(`原计划 ${last.eta} 完成`);

    return {
        id: stableId('wce', `${last.content}|${first.date}`),
        content: last.content,
        note: noteParts.join('；'),
        priority: 'medium',
        status: last.status,
        progress: done ? 100 : (last.progress || 0),
        listId: opt.listId,
        date,
        startDate: first.date === date ? '' : first.date,
        dueTime: '',
        tags: tags.join('|'),
        createdAt: isoOf(first.date, 9),
        startedAt: last.status === 'pending' ? '' : isoOf(first.date, 10),
        completedAt: done ? isoOf(last.date, 18) : '',
        archived: 'false',
        order: index,
    };
}

function buildReports(perDay, authorFallback) {
    const reports = [];
    for (const [date, items] of [...perDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const author = items.author || authorFallback || '';
        const head = author ? `${author} 工作日志` : '工作日志';
        const body = items.map((it, i) => {
            let tail;
            if (it.status === 'completed') tail = '完成';
            else if (it.status === 'in-progress') tail = `${it.progress || 0}%` + (it.eta ? ` 预计${it.eta.replace(/-/g, '')}完成` : '');
            else tail = '未开始';
            return `（${i + 1}）${it.content} ${tail}`;
        }).join('\n');
        reports.push({
            id: stableId('wcerep', date),
            date,
            title: head,
            content: `${head}\n${body}`,
            createdAt: isoOf(date, 20),
            updatedAt: isoOf(date, 20),
        });
    }
    return reports;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
console.log(`解析日志: ${SRC}`);
const blocks = parseLog(readText(SRC));
if (!blocks.length) { console.error('✗ 没有解析到任何日志条目，请检查文件格式'); process.exit(1); }

const authorFromLog = blocks.map(b => b.author).filter(Boolean)[0] || '';
const { tasks, perDay } = buildTasks(blocks);
// perDay 里补上作者，供日报抬头使用
for (const [date, items] of perDay) {
    const b = blocks.find(x => x.date === date);
    items.author = (b && b.author) || authorFromLog;
}
const reports = buildReports(perDay, opt.author || authorFromLog);

const itemCount = blocks.reduce((n, b) => n + b.items.length, 0);
const stat = {
    completed: tasks.filter(t => t.status === 'completed').length,
    inProgress: tasks.filter(t => t.status === 'in-progress').length,
    pending: tasks.filter(t => t.status === 'pending').length,
};

const outDir = opt.out ? resolve(opt.out) : join(dirname(SRC), `知行导入-${stamp()}`);
mkdirSync(outDir, { recursive: true });
const tasksPath = join(outDir, 'tasks.csv');
const reportsPath = join(outDir, 'reports.csv');

writeFileSync(tasksPath, toCSV(
    ['id', 'content', 'note', 'priority', 'status', 'progress', 'listId', 'date', 'startDate', 'dueTime', 'tags', 'createdAt', 'startedAt', 'completedAt', 'archived', 'order'],
    tasks), 'utf8');
writeFileSync(reportsPath, toCSV(
    ['id', 'date', 'title', 'content', 'createdAt', 'updatedAt'],
    reports), 'utf8');

console.log(`\n日志 ${blocks.length} 天 / 条目 ${itemCount} 条`);
console.log(`任务 ${tasks.length} 条（完成 ${stat.completed}，在办 ${stat.inProgress}，待办 ${stat.pending}）${opt.merge ? '，已按内容合并跨天记录' : '，按日明细不合并'}`);
console.log(`日报 ${reports.length} 篇：${reports[0].date} ~ ${reports[reports.length - 1].date}`);

if (warnings.length) {
    console.log(`\n⚠️  ${warnings.length} 条解析提醒`);
    [...new Set(warnings)].slice(0, 8).forEach(w => console.log(`   · ${w}`));
    if (warnings.length > 8) console.log(`   · …另有 ${warnings.length - 8} 条`);
}

console.log(`\n已生成:`);
console.log(`  ${tasksPath}`);
console.log(`  ${reportsPath}`);

if (!opt.write) {
    console.log('\n—— 未写入数据目录（演练模式） ——');
    const parts = [`node tools/import-wce-logs.mjs "${SRC}"`, `--out "${outDir}"`, '--write'];
    if (opt.dataDir) parts.push(`--data-dir "${opt.dataDir}"`);
    if (opt.onConflict !== 'skip') parts.push(`--on-conflict ${opt.onConflict}`);
    console.log(`确认 CSV 没问题后加 --write 导入：\n  ${parts.join(' ')}`);
    console.log(`也可以直接用补录工具：\n  node tools/backfill-import.mjs --tasks "${tasksPath}" --reports "${reportsPath}" --write`);
    process.exit(0);
}

const args = [join(HERE, 'backfill-import.mjs'), '--tasks', tasksPath, '--reports', reportsPath,
    '--on-conflict', opt.onConflict, '--write'];
if (opt.dataDir) args.push('--data-dir', opt.dataDir);
if (opt.passphrase) args.push('--passphrase', opt.passphrase);

console.log('\n—— 开始导入 ——');
const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
