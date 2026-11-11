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
- `electron-launch.js`：用 `require("electron")` 定位**本地** electron 并 spawn，清掉会报错的 `NODE_OPTIONS` 与 `ELECTRON_RUN_AS_NODE`（后者会让 electron.exe 退化成 Node、静默不弹窗）。**保留它**，别直接 `electron .`（历史上有全局 electron@43 冲突）。
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
**任务对象关键字段**：`id, content, note, priority(high|medium|low), status(pending|in-progress|completed), progress(0-100 完成度，仅在办展示), listId, date(截止日 YYYY-MM-DD), startDate(开始日，空=立即), dueTime(HH:MM，可空), tags[], subtasks[{id,text,done}], repeat{type:none|daily|weekly|monthly|custom, interval}, pinned, archived, order, createdAt, startedAt, completedAt, updatedAt, recurPrevId(内部：重复任务去重)`

**加密**：`scrypt(pass, salt, N=2^14,r=8,p=1) 派生 32B key` + `AES-256-GCM`，密文格式 `ENC1:<ivhex>:<taghex>:<datahex>`。启用后 `todoList.json`/`reports.json`/备份均加密。

**写入策略**：`writeJson` 原子写（临时文件+rename）；渲染层保存走 400ms 防抖（`persist.todos`），并在 `beforeunload` 用同步通道兜底。

---

## 6. 前端结构（app.js）
- 全局 `State`：`todos, lists, savedFilters, reports, editingReport, settings, filters, sort, selectMode, selected, editingSubtasks, calendar{mode,weekStart...}, cmdk, importBuffer, ...`
- **持久化**：`persist.todos/settings/...`（防抖）+ `saveTodos()`；`migrateData()` 给旧数据补字段。
- **视图**：`view-list` / `view-kanban` / `view-calendar`（三选一，用 `.hidden` 切）+ 仪表盘 `dashboard-wrap`（与视图互斥）。渲染入口 `renderAll()` → `renderSidebar/renderTagFilter/renderSavedFilters/renderDashboard/renderCurrentView`。顶部那排「周日期条」已移除（点它会写 `filters.start/end`，把列表筛空，容易误解）。
- **日历**：`renderCalendar()` 分月视图 `renderMonthGrid()` 与**周时间块** `renderWeekTimeline()`（按 `dueTime` 绝对定位，6:00–24:00，`--hourh:44px`）。周视图用 pointer 拖拽改期（`wtOnMove/wtOnUp/wtCompute`，文档级监听只绑一次）；月视图用 HTML5 DnD 改日期。**顶部「全天」区每列默认只显示 3 条**，其余折叠成 `+N 条`/`收起`（状态在 `State.calendar.allExpanded`），避免任务多时把时间轴挤下去；`.wt-allday` 另有 `max-height:168px` 兜底防止溢出裁字。
- **命令面板/快捷录入**：`openCommandBar(mode)` / `renderCommandBar` / `execCmdkItem`；`parseQuickTask(text)` 中文自然语言（今天/明天/后天/周X/下周X/X月X日/时间/紧急→高/#标签）。触发：`Ctrl/Cmd+K`（命令面板）、`Ctrl/Cmd+Shift+Space`（快捷录入，且由 main.js `globalShortcut` 全局唤起）。
- **自动排程** `autoSchedule()`：把本周“有日期无时间、未完成、已到开始日”的任务按优先级填进 9:00–19:00 空闲整点。
- **双日期**：`startDate`（开始日，语义=延后出现）+ `date`（截止）；筛选面板有“隐藏未开始”。
- **重复任务**：`setStatus('completed')` 时 `spawnRecurring()` 生成下一周期；用 `recurPrevId` 去重（完成→重开→再完成不会重复生成）。
- **完成度**：`progress`（0~100）。展示层统一走 `taskProgress(t)`（结办=100、非在办=0、在办取 `clampProgress(progress)`），卡片/看板用 `progressBarHtml()` 渲染，`bindProgressBar()` 支持点击+拖动轨道改值（拖动期间只改 DOM，松手 `setTaskProgress(id,pct,{silent:true})` 落库）；编辑框 `#f-progress`(range)/`#f-progress-num`/预设按钮由 `setModalProgress()` 三向同步。`setStatus` 结办置 100、改回待办置 0，复制/重复生成重置 0。
- **进度流水 `progressLog`**：`[{d:'YYYY-MM-DD', p:0~100}]`，由 `logProgressChange(t, pct, day?)` 在「改进度条 / 弹窗存盘 / 结办 / 批量改状态」时写入（同一天覆盖当天那条）。用途是日报判定「当天有没有实际进展」——见 12.2。CSV 里用紧凑写法 `2026-10-21:20|2026-10-26:80`。
- **筛选**：`State.filters` 字段 `search/status/priority/tag/start/end/startFrom/startTo/createdFrom/createdTo/completedFrom/completedTo/archived/hideUnstarted`。标签是**自由输入框 + datalist 候选**（不是下拉），按逗号/空格分词、词间取交集、词内是「包含」匹配（`all` 视为空）。截止日期筛 `date`，开始日期筛 `startDate`（没设开始日期的不参与），创建/完成时间按**本地日**比较（`tsDay`），完成时间筛只命中已完成的。`normalizeFilters()` 给老版本 savedFilters 补默认值。
- **标签体系**：`TAG_RULES`（业务域最多 2 + 事务类型最多 1）+ `suggestTags(content, pool)`。`pool` 传 `allTags()` 时只认已有标签（用户可自建新标签，内容含该词即命中）；池为空则退回内置规则表。任务弹窗输入内容时给出可点选的 `#tag-suggest` 建议，保存时按 `settings.autoTag` 自动补；设置页「给全部任务补齐」批量补空标签。
- 关键工具：`todayISO()=localISO(new Date())`（**本地日期，勿用 toISOString 取日期**）；`tsDay(ts)` 把时间戳按本地日归日（统计分组用）。
- 快捷键汇总：`Ctrl+K` 面板 / `Ctrl+Shift+Space` 录入 / `Ctrl+N` 新建 / `Ctrl+F` 搜索 / `Esc` 关弹窗 / 任务框内 `Ctrl+Enter` 保存。

---

## 7. 已实现功能清单
多清单(颜色) · 列表/看板(拖拽改状态)/日历(月+周时间块拖拽) · 仪表盘图表(优先/趋势/柱/标签/效率) · 日报(生成/编辑/导出，纯文本工作日志 / Markdown 汇总两种格式，只收当天有进展的在办) · 标签(体系化 + 按内容自动识别) · 子任务 · 在办任务完成度百分比(进度条/滑块/预设 + 进度流水) · 重复(日/周/月/自定义) · 到期提醒+每日提醒(系统通知) · 搜索(含拼音首字母)+高级筛选(状态/优先级/标签自由输入/截止·开始·创建·完成四组时间范围)+保存筛选 · 批量操作 · 导入导出(json/csv/txt/md，导出可选范围与字段列，CSV 表头与导入模板一致可直接回导) · 创建/完成时间可手改 · 数据加密 · 备份/恢复(每日+手动) · 单实例锁 · 命令面板+快捷录入(全局快捷键) · 一键自动排程 · 开始/截止双日期 · 深浅色主题 · 紧凑模式 · 列表手动拖拽排序(仅 sort=manual 且非多选时) · 双击任务卡片编辑。

---

## 8. 已知问题 / 注意点（重要）
- **日期**：全部按“本地日期”处理。别再用 `new Date().toISOString().split('T')[0]` 取“今天”（UTC+8 凌晨会错一天）。
- **虚拟滚动已弃用**：`renderList()` 现在全量渲染（旧固定行高虚拟列表会因卡片高度不一而错位）；`renderVirtualList` 仍保留但不再调用。
- **不要用 `window.prompt`**：Electron 不支持，会直接抛异常。命名类输入统一走行内输入行（参考筛选面板的 `#save-filter-row`）或 `pass-modal`。
- **加密备份**：开启加密后备份写密文；恢复时需先解锁。
- **关窗落盘**：`saveTodosSync/saveSettingsSync`（sendSync）在 `beforeunload` 兜底。
- **归档**：任务有 `archived`，默认列表不显示，筛选面板可“显示归档”。
- 导入 CSV 已支持“引号内含换行”的备注（重写过解析器）。
- 未签名 exe 首次运行会被 SmartScreen 拦，属正常。

---

## 9. Tauri 2 版（tauri-zhixing/）
- 目的：验证“更小体积/更快启动”。**前端 100% 复用**：`tauri-zhixing/ui/` 里 `app.js`/`styles.css`/`index.html` 由 `scripts/sync-ui.mjs` 从**根目录**生成（根目录是唯一真源），另加手写的 `tauri-api.js`（把 `window.electronAPI` 映射到 Tauri `invoke`，用 `withGlobalTauri` 免打包）。
- **改界面只改根目录**，然后 `npm run sync-ui`；`npm run dev` / `npm run build` 会自动先同步。直接 `npx tauri build` 或 `cargo build` 不触发同步，会用到旧副本——改了前端就必须先同步。`npm run sync-ui:check` 可校验一致性（不一致退出码 1）。
- 同步规则：`app.js`/`styles.css` 原样复制；`index.html` 复制后在 `<script src="app.js">` 前注入 `<script src="tauri-api.js">`（顺序敏感）。脚本保留 CRLF 与原缩进；找不到锚点会直接报错退出，不会静默产出坏文件。
- 后端：`src-tauri/src/main.rs` 用 `#[tauri::command]` 实现上表所有通道；插件 dialog/notification/global-shortcut/single-instance；加密同算法（aes-gcm+scrypt，`ENC1` 格式兼容）。
- 配置：`frontendDist=../ui`、`withGlobalTauri=true`、`capabilities/default.json` 权限、`icons/`。
- **构建前置**：Windows 需 **MSVC 工具链**（VS Build Tools 的 C++ 生成工具）+ `rustup default stable-x86_64-pc-windows-msvc` + WebView2。`cargo build` 会因缺链接器失败于无 MSVC 环境；**GNU(mingw) 目标 Tauri 不支持**。
- 体积实测：nsis 安装包 **1.3 MB**、主程序 3.7 MB、运行内存 ~23 MB（对比 Electron 182 MB / 202 MB / ~140 MB）。
- **便携版**：Tauri 无 `portable` 打包目标，但 release 的 `target/release/zhixing.exe` 已内嵌前端资源，本身就是免安装单文件程序。`npm run portable` 把它复制成 `dist-portable/知行 1.0.0.exe`；`npm run build:portable` 一条龙。依赖系统 WebView2；数据仍在 `%APPDATA%\com.zhixing.app\`（不是绿色软件，数据不跟随 exe）。
- 编译耗时：`lto=true` + `codegen-units=1`，首次 release 约 21 分钟，增量几秒；真正出安装包仅 ~18 秒。
- 已在 Windows 10 19045 实机编译并打包验证通过。详见 `tauri-zhixing/README.md`。

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

## 12. 历史数据补录（tools/backfill-import.mjs）
- 场景：把以前的待办/日报批量补进应用。应用内导入只覆盖**任务**（json/csv/txt/md），**日报没有导入入口**，所以需要这个脚本。
- 用法：`npm run import-data -- --tasks a.csv --reports b.csv`（默认演练不写盘）→ 加 `--write` 执行；`--data-dir` 指定目录，`--passphrase` 处理加密，`--on-conflict skip|overwrite` 处理重复。
- 关键实现点（改这个脚本时注意）：
  - 判重：任务优先按 `id`；没给 id 时按 `content+date+status`；日报按 `date`（一天一篇）。
  - 加密：完全复刻 main.js（`scryptSync(pass, salt, 32)` + `aes-256-gcm` + `ENC1:iv:tag:data`），读到密文必须给口令，写回保持密文。
  - 编码：先按严格 UTF-8 解，失败回落 GBK（Excel 存 CSV 默认 GBK）；剥 BOM。
  - 写盘前把 `todoList.json`/`reports.json` 备份到 `backups/import-<ts>/`，再原子写。
  - 缺省日期用**本地**今天（别用 `toISOString`）。
- 重要语义：统计（今日/本周完成、趋势图、平均耗时）全部按 **`completedAt`** 归日，`startedAt`+`completedAt` 齐全才有耗时。所以补录历史已完成任务必须填 `completedAt`，否则列表里有、图表里没有。
- 文档：`docs/数据补录指南.md`（字段表、模板、日期规则、判重、FAQ）。CSV 模板在 `tools/templates/`（带 BOM，方便 Excel 直接打开）。

---

## 12.1 工作日志合集解析（tools/import-wce-logs.mjs）
- 场景：历史数据是一天一段的纯文本日志（`南开亮 工作日志` + `（1）xxx 完成` + `（2）xxx 60% 预计20261105完成`），不想手抄成 CSV。
- 用法：`node tools/import-wce-logs.mjs 合集.txt [--out dir] [--write]`；默认只产出 `tasks.csv` / `reports.csv`，加 `--write` 才调用 backfill-import 落盘。
- 关键实现点：
  - 解析容错：编号 `（1）/1、/1.` 都认；`未完成 进度50%`、`50%`、`完成` 前无空格的写法都认；标题里的编号和 `20260814` 这类日期前缀会剥掉。
  - 跨天合并：同名任务连续出现（间隔 ≤ `--gap`，默认 10 天）合成一条，`startDate`=首次，`date`=最后一次（有「预计」用预计日），进度/状态取最后一次；`--no-merge` 关闭。
  - 幂等：任务 `id` 由 `wce-<内容+首次日期的 sha1 前 10 位>` 生成，日报 `id` 由日期生成，重复导入全部跳过。
  - 日报正文与程序生成格式完全一致（抬头 + `（N）内容 尾巴`），所以导入后看起来跟应用自己生成的一样。

---

## 12.2 日报生成格式（plain / markdown）
- `main.js buildReportSummary()` 与 Rust `build_report_summary()` 必须保持一致，改一处就要改另一处。
- 默认 `plain`：抬头 `{reportAuthor} 工作日志`，逐条 `（N）{content} {尾巴}`；尾巴规则：结办 `完成`、在办 `{progress}%`（截止日晚于当天补 ` 预计YYYYMMDD完成`）、待办 `未开始`。
- 顺序：完成 → 在办 → 待办。**完成项内部按「完成时间」升序**（`completedAt||updatedAt||date T23:59`，同刻保持原顺序），在办按开始时间、待办按截止日期。
- **在办任务要「当天有进展」才写进日志**（两条判据）：
  1. `progressLog` 里有 `d === 报告日` 且该条记录的进度与上一条不同（`progressDays()` / `progress_days()` 求「进度真正变化过的日期集合」）；
  2. 没有 progressLog 的老数据退回「当天开始」（`startDate/startedAt/createdAt` == 报告日）或「当天有改动」（`updatedAt` 落在当天）。
  换句话说：一直挂着、当天没动过进度的在办任务不会重复出现在每天的日志里。`inProgress[].progress` 用**报告日那天的历史值**（`progressAt()` 取 ≤ 报告日的最后一条流水），不是当前值。
- 导出：plain 模式落 `.txt` 且正文原样输出（正文自带抬头，不再套 Markdown 标题）；markdown 模式落 `.md`，正文已以 `# ` 开头时不重复加 H1。

## 12.3 任务导出字段与「导出→再导入」闭环
- 列定义在 `app.js EXPORT_COLUMNS`（21 列，前 14 列与 `tools/templates/tasks.csv` 表头顺序完全一致，后面追加 `id,repeat,subtasks,pinned,order,updatedAt,progressLog`）；`main.js CSV_COLUMN_ORDER` 与 Rust `CSV_COLUMN_ORDER` 必须同步。
- 导出弹窗：范围（当前筛选/全部）× 格式（csv/json/txt/md）× 字段勾选（默认全部，`content` 锁定必选，选择记在 `settings.exportColumns`）。TXT/MD 忽略列选择，固定输出全部字段。
- 归一化必须能吃回自己导出的内容：`normalizeTodo` / `normalize_todo` 支持 `archived/pinned` 的 `true|false|1|0|是`、`repeat` 的 JSON 或 `daily:2`、`subtasks` 的 JSON 数组或 `a|b` 字符串、`progressLog` 的 JSON 数组或 `2026-10-21:20|2026-10-26:80`、`order` 数字。CSV 带 UTF-8 BOM，解析前先 strip，否则首列表头会变成 `\uFEFFcontent`。
- 时间字段：任务弹窗可改「创建时间 / 完成时间」（`datetime-local`），`isoToLocalInput` / `localInputToIso` 做 ISO(UTC) ↔ 本地互转，落库仍是 ISO 字符串。
- **日历数量口径**：日历（月/周）与列表共用 `getVisibleTodos()`，但日历只按任务的 `date`（截止日期）落到当前月/周内的格子，所以「日历条数 < 列表条数」是正常的。`#cal-summary` 会显示「本月/本周 N 条 · 全部 M 条」说明口径；月视图一天超过 3 条时显示「+N 更多」，点击展开/收起（展开状态存 `State.calendar.allExpanded[date]`）。

---

## 13. 下一步建议（未做）
- 番茄钟 + 专注时长统计；习惯打卡(streak)；艾森豪威尔四象限视图；任务预计时长+容量超载预警；任务活动日志；指定“每周几”重复；语音录入；云同步/多端。
- Electron 想更小：`win.target.arch` 只留 `x64`（约砍到 ~85MB）+ `compression: maximum`。
