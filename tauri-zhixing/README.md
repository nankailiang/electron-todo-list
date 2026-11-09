# 知行 · 任务与日报工作台（Tauri 2 版）

这是用 **Tauri 2** 复刻 Electron 版的实验工程，用于对比体积/性能。
前端（`index.html` / `styles.css` / `app.js`）**与 Electron 版完全一致**，仅新增 `tauri-api.js` 把 `window.electronAPI` 适配到 Tauri 命令。后端 `src-tauri/src/main.rs` 是 `main.js` 的 Rust 迁移。

## 目录
```
tauri-zhixing/
├─ package.json            # 仅用于 @tauri-apps/cli
├─ ui/                     # 前端（复用 Electron 版）
│  ├─ index.html
│  ├─ styles.css
│  ├─ app.js
│  └─ tauri-api.js         # window.electronAPI → Tauri invoke 适配层
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
npm run build          # = tauri build，产物在 src-tauri/target/release/bundle/
```
开发调试：`npm run dev`（= tauri dev）。
只想快速验证能不能编：`cd src-tauri && cargo build`（debug，约 15 分钟首次）。

产物：`src-tauri/target/release/bundle/nsis/知行_1.0.0_x64-setup.exe`，**实测 1.3 MB**（对比 Electron 双架构 182 MB），主程序 `zhixing.exe` 3.7 MB / 运行内存约 23 MB。

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
