#!/usr/bin/env node
/**
 * 生成 Tauri 版「便携版」（免安装）产物。
 *
 * 背景：Tauri 的 bundler 只有 msi / nsis 两种 Windows 目标，**没有**类似
 * electron-builder `portable` 的目标。但 release 出来的
 * `src-tauri/target/release/zhixing.exe` 本身就把前端资源编进了可执行文件，
 * 是一个真正独立的单文件程序 —— 复制到任何位置双击即可运行，无需安装。
 *
 * 所以「便携版」= 把这个 exe 复制出来，改成用户看得懂的文件名。
 *
 * 前提：先跑过 `npm run build`（或 `cargo build --release`）。
 *
 * 用法：
 *   node scripts/make-portable.mjs            生成到 dist-portable/
 *   node scripts/make-portable.mjs --out <目录>  自定义输出目录
 */

import { readFileSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TAURI_DIR = join(HERE, '..');
const SRC_TAURI = join(TAURI_DIR, 'src-tauri');

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT_DIR = outIdx >= 0 && argv[outIdx + 1]
    ? resolve(argv[outIdx + 1])
    : join(TAURI_DIR, 'dist-portable');

/** 从 Cargo.toml 读包名（决定 release 里的 exe 文件名） */
function cargoPackageName() {
    const toml = readFileSync(join(SRC_TAURI, 'Cargo.toml'), 'utf8');
    const m = toml.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (!m) throw new Error('Cargo.toml 里找不到 package.name');
    return m[1];
}

/** 从 tauri.conf.json 读产品名与版本（决定产物显示名） */
function tauriMeta() {
    const conf = JSON.parse(readFileSync(join(SRC_TAURI, 'tauri.conf.json'), 'utf8'));
    return {
        productName: conf.productName || cargoPackageName(),
        version: conf.version || '0.0.0',
    };
}

const bin = cargoPackageName();
const src = join(SRC_TAURI, 'target', 'release', `${bin}.exe`);

if (!existsSync(src)) {
    console.error(`✗ 找不到 ${src}`);
    console.error('  先执行一次 release 构建: npm run build（首次约 20 分钟）');
    process.exit(1);
}

const { productName, version } = tauriMeta();
const fileName = `${productName} ${version}.exe`;
const dst = join(OUT_DIR, fileName);

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
copyFileSync(src, dst);

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(1);

console.log('✓ 便携版已生成');
console.log(`  ${dst}`);
console.log(`  体积 ${mb(dst)} MB（对比 Electron 便携版 168 MB）`);
console.log('');
console.log('说明：');
console.log('  · 单文件，免安装，复制到任意位置双击即可运行（无需同目录其他文件）');
console.log('  · 依赖系统 WebView2 运行时（Win11 自带；Win10 装过 Edge 即有）');
console.log('  · 数据不在 exe 旁边，而在 %APPDATA%\\com.zhixing.app\\（与安装版共用）');
