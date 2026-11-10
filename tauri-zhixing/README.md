# 知行 · 任务与日报工作台（Tauri 2 版）

这是用 **Tauri 2** 复刻 Electron 版的实验工程，用于对比体积/性能。
前端（`index.html` / `styles.css` / `app.js`）**与 Electron 版完全一致**，仅新增 `tauri-api.js` 把 `window.electronAPI` 适配到 Tauri 命令。后端 `src-tauri/src/main.rs` 是 `main.js` 的 Rust 迁移。

> **前端不要手改**：`ui/` 下的 `app.js`、`styles.css`、`index.html` 由 `scripts/sync-ui.mjs` 从仓库根目录生成（唯一真源是根目录）。改界面请改根目录那份，然后 `npm run sync-ui`——`npm run dev` / `npm run build` 会自动先同步。

## 目录
```
tauri-zhixing/
├─ package.json            # 仅用于 @tauri-apps/cli
├─ scripts/sync-ui.mjs     # 把根目录前端同步到 ui/（index.html 额外注入 tauri-api.js）
├─ ui/                     # 前端（复用 Electron 版）
│  ├─ index.html           # ← 自动生成，勿手改
│  ├─ styles.css           # ← 自动生成，勿手改
│  ├─ app.js               # ← 自动生成，勿手改
│  └─ tauri-api.js         # 手写：window.electronAPI → Tauri invoke 适配层
└─ src-tauri/
   ├─ Cargo.toml
   ├─ build.rs
   ├─ tauri.conf.json      # frontendDist=../ui, withGlobalTauri=true
   ├─ capabilities/default.json
   ├─ icons/               # icon.ico / icon.png
   └─ src/main.rs          # 所有命令（任务/设置/清单/筛选/日报/加密/备份/导入导出/通知/全局快捷键/单实例）
```

## 环境准备（Windows 只支持 MSVC 工具链）

> 本节是 2026-11 在本机（Windows 10 19045，非管理员账号 + 管理员组）**实测通过**的步骤，三样工具全部装在 D 盘。

1. **Rust 工具链**（装到 D 盘，走国内镜像）
   ```bash
   # 设 RUSTUP_HOME=D:\dev\rust\rustup、CARGO_HOME=D:\dev\rust\cargo 后再执行
   rustup-init.exe -y --default-host x86_64-pc-windows-msvc --no-modify-path
   rustup toolchain install stable-x86_64-pc-windows-msvc
   rustup update stable
   ```
   - 加速：`RUSTUP_DIST_SERVER=https://rsproxy.cn`、`RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup`
   - crates 镜像写在 `%CARGO_HOME%\config.toml`：`[source.crates-io] replace-with = 'rsproxy-sparse'`
   - 把 `%CARGO_HOME%\bin` 加进用户 PATH，并把 `RUSTUP_HOME`、`CARGO_HOME` 设为用户环境变量（否则换终端就找不到 cargo）

2. **MSVC 生成工具 + Windows SDK**
   ```powershell
   winget install --id Microsoft.VisualStudio.2022.BuildTools --source winget `
     --accept-package-agreements --accept-source-agreements --disable-interactivity `
     --override "--quiet --wait --norestart --installPath D:\dev\VSBuildTools --path shared=D:\dev\VSBuildShared --path cache=D:\dev\VSCache --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
   ```
   - 必须加 `--source winget`，否则会去连 msstore 源并报证书错误。
   - **不要直接跑 vs_BuildTools.exe**：本机上它的 .NET 下载器会卡在 `vs_installer.opc` 上（零字节、无超时），换 winget 触发就正常。
   - `--path shared=` 能把 MSVC 和大头组件指到 D 盘；但 **Windows SDK 会被微软强制装到 `C:\Program Files (x86)\Windows Kits\10`**（官方文档明示的例外），约 2 GB，无法改。
   - 安装可能以退出码 **1603** 结束（个别 resources MSI 装不上），只要 `cl.exe` / `link.exe` / SDK 的 `rc.exe` 都在，编译不受影响。

3. **WebView2 运行时**：Win11 自带；Win10 装了 Edge 即有。本机已装 157.x。

装完自查：
```bash
ls D:/dev/VSBuildTools/VC/Tools/MSVC/*/bin/Hostx64/x64/cl.exe
ls "C:/Program Files (x86)/Windows Kits/10/bin"/*/x64/rc.exe
```

## 构建
```powershell
cd tauri-zhixing
npm install            # 安装 @tauri-apps/cli（约 2 个包）
npm run build          # 先同步 ui/，再 tauri build，产物在 src-tauri/target/release/bundle/
```
开发调试：`npm run dev`（= 同步 ui/ + tauri dev）。

| 命令 | 作用 |
|---|---|
| `npm run sync-ui` | 手动把根目录前端同步到 `ui/` |
| `npm run sync-ui:check` | 只校验是否一致，不一致退出码 1（适合挂 CI） |
| `npm run portable` | 从已有 release 产物生成便携版（免安装），不重新编译 |
| `npm run build:portable` | 同步 + 编译 + 打包安装包 + 生成便携版，一条龙 |
| `npm run build:win` | 显式指定 `x86_64-pc-windows-msvc` |

> ⚠️ 直接 `npx tauri build` 或 `cd src-tauri && cargo build` **不会**触发同步。如果改了根目录前端又用这两种方式打包，会用到旧的 `ui/`。要么先跑 `npm run sync-ui`，要么统一用 `npm run build`。

只想快速验证能不能编：`cd src-tauri && cargo build`（debug，约 15 分钟首次）。

产物：`src-tauri/target/release/bundle/nsis/知行_1.0.0_x64-setup.exe`，**实测 1.3 MB**（对比 Electron 双架构 182 MB），主程序 `zhixing.exe` 3.7 MB / 运行内存约 23 MB。

### 便携版（免安装）

Tauri 的 bundler 只有 `msi` / `nsis` 两个 Windows 目标，**没有** electron-builder 那种 `portable` 目标。但不需要——release 出来的 `zhixing.exe` 本身就把前端资源编进了可执行文件，是**真正独立的单文件程序**，复制到任何位置双击即可运行。

```powershell
npm run build        # 先构建一次
npm run portable     # 复制成 dist-portable\知行 1.0.0.exe
# 或者一条龙：npm run build:portable
```

实测结论：
- 复制到空目录单独运行正常，窗口标题、WebView2 渲染都正常，**同目录不需要任何附属文件**，也不会在 exe 旁边生成文件。
- 版本信息已嵌入（`ProductName=知行`、`FileVersion=1.0.0`），资源管理器属性里能看到。
- **依赖系统 WebView2 运行时**：Win11 自带；Win10 装过 Edge 即有。裸机没装会直接打不开、也没有友好提示——这种情况请用安装包（NSIS 会引导安装 WebView2）。
- **数据不在 exe 旁边**，在 `%APPDATA%\com.zhixing.app\`，与安装版共用同一份数据。所以它「免安装」但不「绿色」：换台机器拷 exe 过去，任务是空的。真要随身携带数据，需要改 Rust 侧把 `app_data_dir()` 换成一个「exe 同目录 / 便携标记」的判断，目前没做。

> 首次 `tauri build` 的 release 编译约 **21 分钟**（`Cargo.toml` 开了 `lto = true` + `codegen-units = 1`），增量重编只要几秒。调试用 `cargo build` 首次约 15 分钟。

### NSIS 组件下载失败怎么办
国内网络下 `tauri build` 常卡在 `Downloading .../nsis-3.13.zip`（502/超时）。Tauri 会校验 `%LOCALAPPDATA%\tauri\NSIS`，少一个文件就整个删掉重下，所以必须按这个结构手动放好：

```
%LOCALAPPDATA%\tauri\NSIS\
├─ Bin\makensis.exe                    ← nsis-3.13.zip 解压（去掉外层 nsis-3.13 目录）
└─ Plugins\x86-unicode\
   ├─ ApplicationID.dll                ← NSIS-ApplicationID.zip 里的 Release/ApplicationID.dll
   └─ additional\nsis_tauri_utils.dll  ← 注意 additional 子目录，放根目录不认
```

## 与 Electron 版的对应关系
| Electron (main.js) | Tauri (src-tauri/src/main.rs) |
|---|---|
| ipcMain.handle / preload.invoke | `#[tauri::command]` + invoke |
| app.getPath('userData') + fs | `app.path().app_data_dir()` + std::fs |
| scrypt + AES-256-GCM（ENC1 格式） | 同算法（scrypt + aes-gcm crate），密文格式兼容 |
| new Notification | tauri-plugin-notification |
| globalShortcut | tauri-plugin-global-shortcut（emit 'open-command-bar'） |
| dialog.showSave/OpenDialog | tauri-plugin-dialog（blocking_save_file / blocking_pick_file） |
| 单实例锁 | tauri-plugin-single-instance |
| 前端 HTML/CSS/JS | 原样复用（app.js 不改） |

## 已知差异 / 待完善
- `saveTodosSync`（关窗前同步落盘）在 Tauri 无同步 IPC，适配层改为尽力而为的异步保存；如需严格保证，可在 Rust 侧监听窗口关闭事件做最后一次保存。
- 未签名安装包首次运行会被 SmartScreen 提示，属正常。
- 数据目录：Windows 下为 `%APPDATA%\com.zhixing.app\`（与 Electron 的 `%APPDATA%\知行\` 不同，互不影响，可手动迁移 `todoList.json` 等）。
