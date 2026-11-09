# AGENTS.md —— 知行（Zhixing）项目上下文

> 面向后续 AI/开发者的“快速上手”文档。读完这份即可了解：这是什么、怎么跑、代码怎么分、数据在哪、有哪些坑、当前进度。
> 最后更新：2026-11-09 ｜ 当前提交：`f5e3878`（branch `main`）

---

## 1. 一句话
**知行** 是一个桌面「任务 + 日报 + 效率看板」工作台。当前有**两套实现**：
- **Electron 版（主，完整可用）**：根目录 `main.js / preload.js / app.js / index.html / styles.css`，本地 JSON 存储、可选加密，已能打出 Windows 安装包。
- **Tauri 2 版（实验，前端复用）**：`tauri-zhixing/`，用于对比体积/性能，后端 Rust 1:1 移植 Electron 的 IPC。

UI 全中文，柔和青绿主题（参考“飞书 × 柔和生活风”）。**没有账号/云同步**，数据只在本机。

---

## 2. 运行与构建（Electron 版）
```bash
npm install
npm start            # 开发运行（注意：走 electron-launch.js，不是 electron .）
npm run dist:win     # 打 Windows 包（nsis 安装版 + portable 便携版，x64+ia32），产物在 dist/
```
- `electron-launch.js`：用 `require("electron")` 定位**本地** electron 并 spawn，清掉会报错的 `NODE_OPTIONS`。**保留它**，别直接 `electron .`（历史上有全局 electron@43 冲突）。
- 依赖：`electron ^39.2.3`、`electron-builder ^26.15.3`（仅 devDependencies，运行时零第三方依赖）。
- 构建配置在 `package.json → build`：`asar:true`、`output: dist`、`win.target = nsis+portable`、**arch 同时含 x64 和 ia32**（这使单包约 167MB；只想小一半就改成仅 `x64`）。
- `dist:win` 脚本内置了 `ELECTRON_MIRROR=npmmirror`（国内下载 electron 必需）。
- ⚠️ **本沙箱特有坑**：electron-builder 清理旧 `dist/win-unpacked` 会被沙箱 “safe-delete” 拦截（>50 文件）。解决：先 `rm -rf dist`（必要时走 escalation），或用 `-c.directories.output=<新目录>`。**你自己电脑上无此问题。**

---

## 3. 目录 / 文件职责
```
main.js            # 主进程：窗口、全部 IPC（文件读写/加密/备份/导入导出/通知/单实例）
preload.js         # 通过 contextBridge 暴露 window.electronAPI（contextIsolation=true, nodeIntegration=false）
index.html         # 单页 UI + 内联 SVG 图标 sprite(<symbol id="i-...">)
styles.css         # 全部样式（CSS 变量主题 light/dark，柔和风）
app.js             # 渲染进程全部逻辑（状态、渲染、交互、快捷键）— 单文件约 2000 行
electron-launch.js # 启动器
assets/            # icon.ico / icon.png
preview/           # 纯静态 UI 预览（浏览器打开看效果，不参与打包）
tauri-zhixing/     # Tauri 2 版实验工程（见 §9）
dist/ build/ release/  # 构建产物（已 gitignore，勿提交）
```

---

## 4. 架构分层
**主进程 `main.js`** 负责一切“系统能力”，通过 `ipcMain.handle/on` 暴露通道；**渲染层 `app.js`** 通过 `window.electronAPI.*`（preload 暴露）调用。开发时改渲染逻辑基本只动 `app.js`；动存储/加密/系统交互才动 `main.js`。

### IPC 通道（main.js）
`get-todos, save-todos, save-todos-sync, get/save-settings(+settings-sync), get/save-lists, get/save-filters, get/save-reports, generate-report, export-report, crypto-status/enable/disable/unlock, notify, list-backups, restore-backup, backup-now, export-todos, parse-import, show-open-dialog, open-file, get-app-info, show-save-dialog, show-message-box`
（`*-sync` 是 `ipcMain.on + sendSync`，用于关窗前同步落盘。）

### preload 暴露（window.electronAPI）
`getTodos/saveTodos/saveTodosSync/saveSettingsSync, getSettings/saveSettings, getLists/saveLists, getFilters/saveFilters, crypto*, getReports/saveReports/generateReport/exportReport, notify, listBackups/restoreBackup/backupNow, exportTodos/parseImport/showOpenDialog, openFile/getAppInfo/showSaveDialog/showMessageBox, onOpenCommandBar(cb)`

---

## 5. 数据存储
数据目录：`%APPDATA%\zhixing\`（Electron `app.getPath('userData')`；dev 早期可能落在 `%APPDATA%\electron-todo-list\`）。文件：
```
todoList.json     # 任务数组（唯一大文件；可选加密）
settings.json     # 外观/行为设置
lists.json        # 清单（列表）
savedFilters.json # 已保存的筛选
reports.json      # 日报（可选加密）
crypto.meta.json  # { salt, verifier }（启用加密才有）
backups/          # 每日备份 todo-backup-YYYY-MM-DD.json，保留 7 天（加密开启时备份也是密文）
```
**任务对象关键字段**：`id, content, note, priority(high|medium|low), status(pending|in-progress|completed), listId, date(截止日 YYYY-MM-DD), startDate(开始日，空=立即), dueTime(HH:MM，可空), tags[], subtasks[{id,text,done}], repeat{type:none|daily|weekly|monthly|custom, interval}, pinned, archived, order, createdAt, startedAt, completedAt, updatedAt, recurPrevId(内部：重复任务去重)`

**加密**：`scrypt(pass, salt, N=2^14,r=8,p=1) 派生 32B key` + `AES-256-GCM`，密文格式 `ENC1:<ivhex>:<taghex>:<datahex>`。启用后 `todoList.json`/`reports.json`/备份均加密。

**写入策略**：`writeJson` 原子写（临时文件+rename）；渲染层保存走 400ms 防抖（`persist.todos`），并在 `beforeunload` 用同步通道兜底。

---

## 6. 前端结构（app.js）
- 全局 `State`：`todos, lists, savedFilters, reports, editingReport, settings, filters, sort, selectMode, selected, editingSubtasks, calendar{mode,weekStart...}, cmdk, importBuffer, ...`
- **持久化**：`persist.todos/settings/...`（防抖）+ `saveTodos()`；`migrateData()` 给旧数据补字段。
- **视图**：`view-list` / `view-kanban` / `view-calendar`（三选一，用 `.hidden` 切）+ 仪表盘 `dashboard-wrap`（与视图互斥）。渲染入口 `renderAll()` → `renderSidebar/renderWeekStrip/renderDashboard/renderCurrentView`。
- **日历**：`renderCalendar()` 分月视图 `renderMonthGrid()` 与**周时间块** `renderWeekTimeline()`（按 `dueTime` 绝对定位，6:00–24:00，`--hourh:44px`）。周视图用 pointer 拖拽改期（`wtOnMove/wtOnUp/wtCompute`，文档级监听只绑一次）；月视图用 HTML5 DnD 改日期。
- **命令面板/快捷录入**：`openCommandBar(mode)` / `renderCommandBar` / `execCmdkItem`；`parseQuickTask(text)` 中文自然语言（今天/明天/后天/周X/下周X/X月X日/时间/紧急→高/#标签）。触发：`Ctrl/Cmd+K`（命令面板）、`Ctrl/Cmd+Shift+Space`（快捷录入，且由 main.js `globalShortcut` 全局唤起）。
- **自动排程** `autoSchedule()`：把本周“有日期无时间、未完成、已到开始日”的任务按优先级填进 9:00–19:00 空闲整点。
- **双日期**：`startDate`（开始日，语义=延后出现）+ `date`（截止）；筛选面板有“隐藏未开始”。
- **重复任务**：`setStatus('completed')` 时 `spawnRecurring()` 生成下一周期；用 `recurPrevId` 去重（完成→重开→再完成不会重复生成）。
- 关键工具：`todayISO()=localISO(new Date())`（**本地日期，勿用 toISOString 取日期**）；`tsDay(ts)` 把时间戳按本地日归日（统计分组用）。
- 快捷键汇总：`Ctrl+K` 面板 / `Ctrl+Shift+Space` 录入 / `Ctrl+N` 新建 / `Ctrl+F` 搜索 / `Esc` 关弹窗 / 任务框内 `Ctrl+Enter` 保存。

---

## 7. 已实现功能清单
多清单(颜色) · 列表/看板(拖拽改状态)/日历(月+周时间块拖拽) · 仪表盘图表(优先/趋势/柱/标签/效率) · 日报(生成/编辑/导出) · 标签 · 子任务 · 重复(日/周/月/自定义) · 到期提醒+每日提醒(系统通知) · 搜索(含拼音首字母)+高级筛选+保存筛选 · 批量操作 · 导入导出(json/csv/txt/md) · 数据加密 · 备份/恢复(每日+手动) · 单实例锁 · 命令面板+快捷录入(全局快捷键) · 一键自动排程 · 开始/截止双日期 · 深浅色主题 · 紧凑模式。

---

## 8. 已知问题 / 注意点（重要）
- **日期**：全部按“本地日期”处理。别再用 `new Date().toISOString().split('T')[0]` 取“今天”（UTC+8 凌晨会错一天）。
- **虚拟滚动已弃用**：`renderList()` 现在全量渲染（旧固定行高虚拟列表会因卡片高度不一而错位）；`renderVirtualList` 仍保留但不再调用。
- **加密备份**：开启加密后备份写密文；恢复时需先解锁。
- **关窗落盘**：`saveTodosSync/saveSettingsSync`（sendSync）在 `beforeunload` 兜底。
- **归档**：任务有 `archived`，默认列表不显示，筛选面板可“显示归档”。
- 导入 CSV 已支持“引号内含换行”的备注（重写过解析器）。
- 未签名 exe 首次运行会被 SmartScreen 拦，属正常。

---

## 9. Tauri 2 版（tauri-zhixing/）
- 目的：验证“更小体积/更快启动”。**前端 100% 复用**：`tauri-zhixing/ui/` = 拷贝的 index/styles/app.js + 新增 `tauri-api.js`（把 `window.electronAPI` 映射到 Tauri `invoke`，用 `withGlobalTauri` 免打包）。
- 后端：`src-tauri/src/main.rs` 用 `#[tauri::command]` 实现上表所有通道；插件 dialog/notification/global-shortcut/single-instance；加密同算法（aes-gcm+scrypt，`ENC1` 格式兼容）。
- 配置：`frontendDist=../ui`、`withGlobalTauri=true`、`capabilities/default.json` 权限、`icons/`。
- **构建前置**：Windows 需 **MSVC 工具链**（VS Build Tools 的 C++ 生成工具）+ `rustup default stable-x86_64-pc-windows-msvc` + WebView2。`cargo build` 会因缺链接器失败于无 MSVC 环境；**GNU(mingw) 目标 Tauri 不支持**。
- 体积预期：nsis 安装包约 10–20MB（对比 Electron 双架构 167MB）。详见 `tauri-zhixing/README.md`。
- 未完全验证：沙箱无 MSVC/GUI 安装器，未实机编译过；逻辑已按 main.js 对齐。

---

## 10. 编码约定 / 风格
- **UI 中文**；配色用 `styles.css` 顶部 CSS 变量（`--primary` 青绿等），改主题只动变量；深色在 `html[data-theme="dark"]`。
- **图标**：`index.html` 内联 `<symbol id="i-xxx">`，用时 `<svg class="icon"><use href="#i-xxx"/></svg>`。`.icon` 已设 `fill:none; stroke:currentColor; stroke-width:1.8`（**线条图标靠描边**；点状图标自带 `fill="currentColor" stroke="none"`）。新增图标记得成对处理，否则会变成实心黑块。
- **导航**：只有底部浮动导航（任务/看板/日历/统计/日报/设置），顶部已移除重复的视图切换。切视图用 `setView()`/`renderCurrentView()`，并调用 `syncBottomNav()` 高亮。
- **清单颜色**：用 `#list-swatches` 常用色板（点击写隐藏 `#list-color`），`syncListSwatches()` 同步高亮。
- **截止时间**：任务表单里是隐藏字段 `#f-time`（用户不想手填；但仍支持文字自动识别时间/自动排程/周视图拖拽赋值）。
- 写文件优先 `Edit`；不要提交 `node_modules/ dist/ build/ release/ *.exe tauri-*-target .workbuddy/`（.gitignore 已覆盖）。

---

## 11. Git / 网络
- 远程：`origin = https://github.com/nankailiang/electron-todo-list.git`，分支 `main`。
- **推送需代理**：本机系统代理 `127.0.0.1:7897`（Clash Verge / verge-mihomo）。已在仓库本地设 `git config --local http.proxy/https.proxy = http://127.0.0.1:7897`。直连 github.com 会被墙（api/ssh 也不通），raw/objects/codeload 可达但推送必须经 github.com。
- 换环境推送前先 `git config http.proxy <你的代理>` 或确保能连 github.com。

---

## 12. 下一步建议（未做）
- 番茄钟 + 专注时长统计；习惯打卡(streak)；艾森豪威尔四象限视图；任务预计时长+容量超载预警；任务活动日志；指定“每周几”重复；语音录入；云同步/多端。
- Electron 想更小：`win.target.arch` 只留 `x64`（约砍到 ~85MB）+ `compression: maximum`。
