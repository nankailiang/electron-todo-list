#!/usr/bin/env node
/**
 * 知行 —— 工作日志合集解析工具（通达现场「我的日志」导出文件）
 *
 * 把「南开亮 工作日志 / （1）xxx 完成 / （2）xxx 60% 预计20261105完成」这种
 * 纯文本日志合集，解析成可直接导入知行的任务 + 日报，产出两份 CSV，
 * 并可选地直接调用 backfill-import.mjs 写入数据目录。
 *
 * 默认规则（mixed，贴近真实工作方式）：
 *   · 日志里只有「完成」、从不出现进度的任务 → 每次出现都是独立个体，
 *     每天都生成一条任务（例如「征信上报数据核对」130 天 = 130 条）。
 *   · 日志里出现过进度（50% / 未完成 / 预计X完成）的任务 → 视为同一个
 *     长期任务，跨天全部合并成一条，进度取最后一次记录。
 *   · 合并后的长期任务默认也记为「已完成」（按天做完了），只有 --open
 *     点名的任务保持「在办」并保留真实进度（例如 EAST 数据初始化）。
 *   · 优先级按时间压力推断：跨天赶工 / 逾期完成 = 高，带预计完成日 = 中，
 *     当天一次做完 = 低。
 *
 * 用法：
 *   node tools/import-wce-logs.mjs "全部日志合集.txt"
 *   node tools/import-wce-logs.mjs "全部日志合集.txt" --out out/ --write
 *   node tools/import-wce-logs.mjs logs.txt --open "EAST业务系统数据初始化" --replace --write
 *
 * 参数：
 *   <log.txt>             日志合集文件（必填）
 *   --out <dir>           CSV 输出目录（默认：日志同级目录 /知行导入-<时间戳>/）
 *   --author <name>       抬头署名，日志里解析不出时兜底
 *   --tag <a,b>           给导入的任务打标签
 *   --list-id <id>        任务归入哪个清单，默认 default
 *   --open <a,b>          这些任务合并后保持「在办」+ 真实进度（子串匹配，可多次传）
 *   --mode <mixed|all|none>
 *                         mixed（默认）有进度才合并；all 全部按内容跨天合并；
 *                         none 一律每天一条不合并
 *   --gap <days>          all 模式下同一任务间隔不超过 N 天视为同一条（默认 10）
 *   --merge / --no-merge  等价于 --mode all / --mode none
 *   --priority <auto|off> auto（默认）按时间压力推断优先级；off 全部记为中
 *   --replace             导入前先删掉旧的 wce- / wcerep- 记录（重跑本工具时用）
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
const opt = { gap: 10, mode: 'mixed', listId: 'default', onConflict: 'skip', write: false, open: [], priority: 'auto', replace: false };
const positional = [];
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--out') opt.out = next();
    else if (a === '--author') opt.author = (next() || '').trim();
    else if (a === '--tag') opt.tag = next();
    else if (a === '--list-id') opt.listId = next();
    else if (a === '--open') opt.open.push(...String(next() || '').split(/[,，]/));
    else if (a === '--mode') opt.mode = String(next() || '').trim();
    else if (a === '--priority') opt.priority = String(next() || '').trim();
    else if (a === '--gap') opt.gap = Math.max(0, Number(next()) || 10);
    else if (a === '--merge') opt.mode = 'all';
    else if (a === '--no-merge') opt.mode = 'none';
    else if (a === '--replace') opt.replace = true;
    else if (a === '--write') opt.write = true;
    else if (a === '--data-dir') opt.dataDir = next();
    else if (a === '--passphrase') opt.passphrase = next();
    else if (a === '--on-conflict') opt.onConflict = next();
    else if (a === '-h' || a === '--help') opt.help = true;
    else if (a.startsWith('--')) { console.error(`未知参数: ${a}`); process.exit(1); }
    else positional.push(a);
}

opt.open = opt.open.map(s => s.trim()).filter(Boolean);
if (!['mixed', 'all', 'none'].includes(opt.mode)) {
    console.error('--mode 只能是 mixed / all / none');
    process.exit(1);
}
if (!['auto', 'off'].includes(opt.priority)) {
    console.error('--priority 只能是 auto / off');
    process.exit(1);
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
const cleanTags = () => (opt.tag || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);

/** --open 点名的任务：合并后保持「在办」并保留真实进度 */
const isOpenTask = (content) => opt.open.some(n => content.includes(n));

/**
 * 紧急程度（优先级）推断 —— 以「完成时间」为主线，叠加任务本身的赶工特征：
 *   · 仍在办（--open 点名）                        → 最高
 *   · 逾期完成（完成日晚于预计完成日）              → 高
 *   · 跨天拖了 ≥4 天 / ≥2 天赶工                    → 高 / 中
 *   · 当天完成条目 ≥5 条（那天在赶工）              → +1
 *   · 处在当月日均 ≥3.8 条的高压月份                → +1
 * 汇总打分：≥4 高，2~3 中，≤1 低
 */
function urgencyOf({ days, eta, doneDate, open, ctx }) {
    if (opt.priority === 'off') return 'medium';
    let score = 0;
    if (open) score += 4;
    if (eta && doneDate && doneDate > eta) score += 3;
    if (days >= 4) score += 3;
    else if (days >= 2) score += 2;
    if (eta) score += 1;
    if ((ctx.dayCount.get(doneDate) || 0) >= 5) score += 1;
    const load = ctx.monthLoad.get(String(doneDate || '').slice(0, 7)) || 0;
    if (load >= 3.8) score += 1;
    if (score >= 3) return 'high';
    if (score >= 1) return 'medium';
    return 'low';
}

function buildTasks(blocks) {
    // 当天条目数 / 当月日均条目数：作为「那段时间忙不忙」的量化依据
    const dayCount = new Map();
    const monthDays = new Map();
    const monthItems = new Map();
    for (const b of blocks) {
        const m = b.date.slice(0, 7);
        dayCount.set(b.date, (dayCount.get(b.date) || 0) + b.items.length);
        if (!monthDays.has(m)) monthDays.set(m, new Set());
        monthDays.get(m).add(b.date);
        monthItems.set(m, (monthItems.get(m) || 0) + b.items.length);
    }
    const monthLoad = new Map();
    for (const [m, days] of monthDays) monthLoad.set(m, monthItems.get(m) / Math.max(1, days.size));
    const ctx = { dayCount, monthLoad };

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

    const byContent = new Map();
    for (const [, items] of perDay) {
        for (const it of items) {
            if (!byContent.has(it.content)) byContent.set(it.content, []);
            byContent.get(it.content).push(it);
        }
    }

    const tasks = [];
    const merged = [];
    for (const [content, items] of byContent) {
        items.sort((a, b) => a.date.localeCompare(b.date));
        const hasProgress = items.some(it => it.status === 'in-progress');
        const mergeThis = opt.mode === 'all' || (opt.mode === 'mixed' && hasProgress);

        if (!mergeThis) {
            // 每天都发生过、且从不带进度 → 每次都是独立个体，一天一条
            for (const it of items) tasks.push(toDailyTask(content, it, ctx));
            continue;
        }

        // 有进度 → 同一个长期任务：连续出现（间隔 ≤ gap 天）的一段合并成一条
        let run = [];
        const flush = () => {
            if (!run.length) return;
            tasks.push(toMergedTask(content, run, ctx));
            merged.push({ content, days: run.length, from: run[0].date, to: run[run.length - 1].date });
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
    return { tasks, perDay, merged };
}

/** 当天一次做完的独立任务 */
function toDailyTask(content, it, ctx) {
    return {
        id: stableId('wce', `${content}|${it.date}`),
        content,
        note: '',
        priority: urgencyOf({ days: 1, eta: it.eta, doneDate: it.date, open: false, ctx }),
        status: 'completed',
        progress: 100,
        listId: opt.listId,
        date: it.date,
        startDate: '',
        dueTime: '',
        tags: cleanTags().join('|'),
        createdAt: isoOf(it.date, 9),
        startedAt: isoOf(it.date, 10),
        completedAt: isoOf(it.date, 18),
        archived: 'false',
        order: 0,
    };
}

/** 有进度记录的长期任务（跨天合并成一条） */
function toMergedTask(content, run, ctx) {
    const first = run[0];
    const last = run[run.length - 1];
    const days = run.length;
    const open = isOpenTask(content);
    const eta = last.eta || '';
    const progress = last.progress || 0;
    const date = open ? (eta || last.date) : last.date;

    const noteParts = [];
    if (days > 1) noteParts.push(`日志 ${first.date} ~ ${last.date}（${days} 天）`);
    if (eta) noteParts.push(open ? `预计 ${eta} 完成` : `原计划 ${eta} 完成`);
    if (days > 1) noteParts.push(`进度轨迹 ${run.map(it => `${it.progress || 0}%`).join(' → ')}`);

    return {
        id: stableId('wce', `${content}|${first.date}`),
        content,
        note: noteParts.join('；'),
        priority: urgencyOf({ days, eta, doneDate: last.date, open, ctx }),
        status: open ? 'in-progress' : 'completed',
        progress: open ? progress : 100,
        listId: opt.listId,
        date,
        startDate: first.date === date ? '' : first.date,
        dueTime: '',
        tags: cleanTags().join('|'),
        createdAt: isoOf(first.date, 9),
        startedAt: isoOf(first.date, 10),
        completedAt: open ? '' : isoOf(last.date, 18),
        archived: 'false',
        order: 0,
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
const { tasks, perDay, merged } = buildTasks(blocks);
// perDay 里补上作者，供日报抬头使用
for (const [date, items] of perDay) {
    const b = blocks.find(x => x.date === date);
    items.author = (b && b.author) || authorFromLog;
}
const reports = buildReports(perDay, opt.author || authorFromLog);

const itemCount = blocks.reduce((n, b) => n + b.items.length, 0);
const dedupCount = [...perDay.values()].reduce((n, arr) => n + arr.length, 0);
const stat = {
    completed: tasks.filter(t => t.status === 'completed').length,
    inProgress: tasks.filter(t => t.status === 'in-progress').length,
    pending: tasks.filter(t => t.status === 'pending').length,
};
const dailyCount = tasks.length - merged.length;
const byPriority = (p) => tasks.filter(t => t.priority === p).length;

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

const modeDesc = { mixed: '有进度的合并、纯完成的每天独立', all: '全部按内容合并', none: '全部按天不合并' }[opt.mode];
console.log(`\n日志 ${blocks.length} 天 / 条目 ${itemCount} 条（同日去重后 ${dedupCount} 条）`);
console.log(`任务 ${tasks.length} 条（完成 ${stat.completed}，在办 ${stat.inProgress}，待办 ${stat.pending}）· ${modeDesc}`);
console.log(`  · 当天完成的独立任务：${dailyCount} 条`);
console.log(`  · 跨天长期任务：${merged.length} 条${merged.length ? `（${merged.map(m => m.content).slice(0, 3).join('、')}${merged.length > 3 ? ' 等' : ''}）` : ''}`);
console.log(`  紧急程度：高 ${byPriority('high')} / 中 ${byPriority('medium')} / 低 ${byPriority('low')}`);
if (opt.open.length) console.log(`  --open 保持在办：${tasks.filter(t => t.status === 'in-progress').map(t => `${t.content}(${t.progress}%)`).join('、') || '无命中'}`);
console.log(`日报 ${reports.length} 篇：${reports[0].date} ~ ${reports[reports.length - 1].date}`);

const highs = tasks.filter(t => t.priority === 'high');
if (highs.length) {
    console.log('\n高优先级（按完成时间排在冲刺期 / 跨天赶工 / 逾期）：');
    highs.slice(0, 12).forEach(t => console.log(`  · ${t.startDate || t.date}${t.startDate ? ' ~ ' + t.date : ''}  ${t.content.slice(0, 34)}${t.status === 'in-progress' ? `（在办 ${t.progress}%）` : ''}`));
    if (highs.length > 12) console.log(`  · …另有 ${highs.length - 12} 条`);
}

// ---- 按月的节奏 / 紧急度粗判断 ----
{
    const months = new Map();
    for (const b of blocks) {
        const m = b.date.slice(0, 7);
        const cur = months.get(m) || { items: 0, days: new Set() };
        cur.items += b.items.length;
        cur.days.add(b.date);
        months.set(m, cur);
    }
    for (const t of merged) {
        const m = t.from.slice(0, 7);
        const cur = months.get(m) || { items: 0, days: new Set() };
        cur.long = (cur.long || 0) + 1;
        months.set(m, cur);
    }
    const hot = new Map();
    for (const t of tasks.filter(x => x.priority === 'high')) {
        const m = (t.startDate || t.date).slice(0, 7);
        hot.set(m, (hot.get(m) || 0) + 1);
    }
    console.log('\n月度节奏（条目数 / 跨天任务 / 高优先级）：');
    for (const [m, v] of [...months.entries()].sort()) {
        const perDay = (v.items / Math.max(1, v.days.size)).toFixed(1);
        const level = (hot.get(m) || 0) >= 4 ? '紧凑' : (hot.get(m) || 0) >= 2 ? '偏紧' : '常规';
        console.log(`  ${m}  条目 ${String(v.items).padStart(3)}  日均 ${perDay} 条  跨天任务 ${String(v.long || 0).padStart(2)}  高优先级 ${String(hot.get(m) || 0).padStart(2)}  ${level}`);
    }
}

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
    const parts = [`node tools/import-wce-logs.mjs "${SRC}"`, `--out "${outDir}"`];
    if (opt.open.length) parts.push(`--open "${opt.open.join(',')}"`);
    if (opt.mode !== 'mixed') parts.push(`--mode ${opt.mode}`);
    if (opt.priority !== 'auto') parts.push(`--priority ${opt.priority}`);
    if (opt.replace) parts.push('--replace');
    if (opt.dataDir) parts.push(`--data-dir "${opt.dataDir}"`);
    if (opt.onConflict !== 'skip') parts.push(`--on-conflict ${opt.onConflict}`);
    parts.push('--write');
    console.log(`确认 CSV 没问题后这样导入：\n  ${parts.join(' ')}`);
    console.log(`也可以直接用补录工具：\n  node tools/backfill-import.mjs --tasks "${tasksPath}" --reports "${reportsPath}"${opt.replace ? ' --prune wce,wcerep' : ''} --write`);
    process.exit(0);
}

const args = [join(HERE, 'backfill-import.mjs'), '--tasks', tasksPath, '--reports', reportsPath,
    '--on-conflict', opt.onConflict, '--write'];
if (opt.replace) args.push('--prune', 'wce,wcerep');
if (opt.dataDir) args.push('--data-dir', opt.dataDir);
if (opt.passphrase) args.push('--passphrase', opt.passphrase);

console.log('\n—— 开始导入 ——');
const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
