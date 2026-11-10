#!/usr/bin/env node
/**
 * 把仓库根目录的前端文件同步到 tauri-zhixing/ui/。
 *
 * 背景：Tauri 版的 frontendDist 指向 ui/，而 ui/ 里的 app.js / styles.css /
 * index.html 是根目录那份的手工副本（Electron 版和 Tauri 版共用同一套 UI）。
 * 手工副本一旦忘记同步，就会出现「Tauri 版缺功能」的诡异 bug。
 *
 * 这个脚本把它变成确定性的：
 *   app.js / styles.css  —— 原样复制
 *   index.html           —— 复制后额外注入 <script src="tauri-api.js"></script>
 *                            （Tauri 专有的 IPC 适配层，必须排在 app.js 之前）
 *   tauri-api.js         —— 属于 Tauri 版自身，不由本脚本生成，保持不动
 *
 * 用法：
 *   node scripts/sync-ui.mjs           同步
 *   node scripts/sync-ui.mjs --check   只校验，不一致时退出码 1（用于 CI）
 *   node scripts/sync-ui.mjs --quiet   同步但不打印逐文件日志
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TAURI_DIR = join(HERE, '..');
const ROOT_DIR = join(TAURI_DIR, '..');
const UI_DIR = join(TAURI_DIR, 'ui');

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has('--check');
const QUIET = args.has('--quiet');

/** 原样复制的文件 */
const COPY_FILES = ['app.js', 'styles.css'];

/** 只在 Tauri 版存在、需要追加到 index.html 的脚本（顺序敏感） */
const TAURI_SCRIPTS = ['tauri-api.js'];

/** index.html 里 app.js 的 script 标签，注入点以它为锚 */
const ANCHOR_RE = /([ \t]*)<script src="app\.js"><\/script>/;

const problems = [];
const changed = [];
const same = [];

const log = (...a) => { if (!QUIET) console.log(...a); };

function readUtf8(p) {
    return readFileSync(p, 'utf8');
}

/**
 * 复制 index.html 并注入 Tauri 专有脚本。
 * 逐行处理以保留原始缩进与换行风格（仓库文件是 CRLF）。
 */
function buildIndexHtml(srcPath) {
    const src = readUtf8(srcPath);
    const eol = src.includes('\r\n') ? '\r\n' : '\n';

    const m = src.match(ANCHOR_RE);
    if (!m) {
        throw new Error(
            `${relative(ROOT_DIR, srcPath)} 里找不到 <script src="app.js"></script>，` +
            '无法确定 tauri-api.js 的注入位置（文件结构被改动过？）'
        );
    }

    // 已经注入过就跳过，避免重复插入
    if (src.includes('tauri-api.js')) {
        return src;
    }

    const indent = m[1];
    const injected = TAURI_SCRIPTS.map(s => `${indent}<script src="${s}"></script>`).join(eol);
    const at = m.index;
    return src.slice(0, at) + injected + eol + src.slice(at);
}

function describe(rel) {
    return relative(ROOT_DIR, rel).replace(/\\/g, '/');
}

function syncOne(name, transform) {
    const srcPath = join(ROOT_DIR, name);
    const dstPath = join(UI_DIR, name);

    if (!existsSync(srcPath)) {
        problems.push(`源文件缺失: ${describe(srcPath)}`);
        return;
    }

    let next;
    try {
        next = transform(srcPath);
    } catch (err) {
        problems.push(err.message);
        return;
    }

    const prev = existsSync(dstPath) ? readUtf8(dstPath) : null;
    if (prev === next) {
        same.push(name);
        return;
    }

    changed.push(name);
    if (!CHECK_ONLY) {
        writeFileSync(dstPath, next, 'utf8');
    }
}

// ---- 主流程 ----
if (!existsSync(UI_DIR)) mkdirSync(UI_DIR, { recursive: true });

for (const f of COPY_FILES) syncOne(f, readUtf8);
syncOne('index.html', buildIndexHtml);

// tauri-api.js 必须存在，否则注入的 script 会 404
for (const s of TAURI_SCRIPTS) {
    const p = join(UI_DIR, s);
    if (!existsSync(p)) problems.push(`Tauri 专有脚本缺失: ${describe(p)}`);
}

// ---- 结果 ----
if (problems.length) {
    console.error('✗ UI 同步失败:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
}

if (CHECK_ONLY) {
    if (changed.length) {
        console.error('✗ tauri-zhixing/ui/ 与根目录前端不一致，需要重新同步:');
        for (const f of changed) console.error(`  - ${f}`);
        console.error('  执行: npm run sync-ui（或 tauri-zhixing 目录下 node scripts/sync-ui.mjs）');
        process.exit(1);
    }
    log('✓ tauri-zhixing/ui/ 与根目录前端一致');
} else if (changed.length) {
    log(`✓ 已同步 ${changed.length} 个文件到 tauri-zhixing/ui/`);
    for (const f of changed) log(`  - ${f}`);
    if (same.length) log(`  (未变化: ${same.join(', ')})`);
} else {
    log('✓ tauri-zhixing/ui/ 已是最新，无需更新');
}
