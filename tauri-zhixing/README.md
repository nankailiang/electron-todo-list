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
1. 安装 **Microsoft C++ 生成工具**（VS Build Tools 2022，勾选「使用 C++ 的桌面开发」/ VCTools 工作负载）：
   ```powershell
   winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
   ```
   > 注意：该安装器需要**有交互桌面 / 管理员**，在纯 headless 的 CI/沙箱里会报 5002 起不来。
2. 安装 Rust 的 **MSVC** 工具链并设为默认：
   ```powershell
   rustup toolchain install stable-x86_64-pc-windows-msvc
   rustup default stable-x86_64-pc-windows-msvc
   ```
3. 确认系统已装 **WebView2**（Win11 自带；Win10 装了 Edge 即有；否则装 “Microsoft Edge WebView2 Runtime”）。

## 构建
```powershell
cd tauri-zhixing
npm install            # 安装 @tauri-apps/cli
npm run build          # = tauri build，产物在 src-tauri/target/release/bundle/
```
开发调试：`npm run dev`（= tauri dev）。

产物：`src-tauri/target/release/bundle/nsis/知行_1.0.0_x64-setup.exe`，预计 **10–20MB**（对比 Electron 双架构 167MB）。

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
