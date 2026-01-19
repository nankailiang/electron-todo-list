# Electron Todo List Manager

一个功能完整的待办事项管理应用，使用Electron + 原生JavaScript + HTML + CSS开发。

## 功能特性

✅ **任务管理**：支持添加、编辑、删除任务
✅ **状态跟踪**：待办 → 在办 → 结办 状态流转
✅ **优先级管理**：高、中、低三个优先级等级
✅ **日期管理**：支持任务日期设置和筛选
✅ **搜索功能**：支持按内容、日期、优先级搜索
✅ **排序功能**：支持按日期、优先级排序
✅ **数据持久化**：自动保存到本地文件
✅ **统计功能**：实时显示各类任务数量统计
✅ **响应式设计**：支持不同屏幕尺寸
✅ **任务导入/导出**：支持JSON、CSV、TXT三种格式

## 界面预览

应用采用现代化设计，包含以下主要区域：
- **顶部导航栏**：显示应用标题和任务统计
- **任务添加区域**：添加新任务的表单
- **任务管理区域**：包含搜索、排序、筛选功能和任务列表
- **任务列表**：显示所有任务，支持状态切换和删除操作

## 安装和运行

### 前提条件

- Node.js (v16.x 或更高版本)
- npm 或 yarn

### 安装步骤

1. **克隆或下载项目**

```bash
git clone <repository-url>
cd electron-todo-list
```

2. **安装依赖**

```bash
npm install
```

3. **运行应用**

```bash
npm start
```

## 项目结构

```
electron-todo-list/
├── main.js               # 主进程文件
├── preload.js            # 预加载脚本
├── index.html            # 主页面
├── styles.css            # 样式文件
├── app.js                # 渲染进程逻辑
├── package.json          # 项目配置
├── assets/               # 静态资源
├── README.md             # 项目说明
├── INSTALL_CONFIG.md     # 安装和打包配置
└── dist/                 # 打包输出目录
```

## 核心功能详解

### 1. 数据持久化

- 数据自动保存到用户数据目录
- 每次操作后自动保存，确保数据不会丢失
- 应用启动时自动加载之前保存的数据

### 2. 任务状态管理

- **待办**：新创建的任务默认状态
- **在办**：点击"开始"按钮进入在办状态
- **结办**：点击"完成"按钮进入结办状态
- 结办的任务会显示删除线效果

### 3. 搜索和筛选

- **搜索**：实时搜索任务内容、日期、优先级
- **排序**：日期倒序、日期正序、优先级排序
- **筛选**：按任务状态筛选（全部、待办、在办、结办）

### 4. 优先级显示

- **高优先级**：红色标记
- **中优先级**：黄色标记  
- **低优先级**：绿色标记

## 应用打包指南

### 打包命令

```bash
# 打包 Windows 版本
npm run dist:win

# 打包 macOS 版本
npm run dist:mac

# 打包 Linux 版本
npm run dist:linux

# 打包所有平台
npm run dist

# 快速打包（Windows）
npm run dist:win:quick
```

### 打包输出位置

- **Windows**: 
  - 便携版: `dist/win-unpacked/Todo List Manager.exe`
  - 安装版: `dist/Todo List Manager Setup.exe`
- **macOS**: `dist/Todo List Manager.dmg`
- **Linux**: 
  - AppImage: `dist/Todo List Manager.AppImage`
  - Deb: `dist/todo-list-manager_1.0.0_amd64.deb`

## 数据格式

任务数据格式：

```json
{
  "id": "1620000000000",
  "date": "2025-11-22",
  "priority": "high",
  "content": "完成项目开发",
  "status": "pending",
  "createdAt": "2025-11-22T08:00:00.000Z"
}
```

## 许可证

本项目采用 MIT 许可证。

## 作者

nan_kliang

---

**使用愉快！如有问题或建议，欢迎反馈。**