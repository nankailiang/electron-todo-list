# Todo List Manager 安装和打包配置说明

## 安装程序使用

1. **运行安装包**：双击 `Todo List Manager Setup 1.0.0.exe`
2. **欢迎页面**：点击"下一步"
3. **许可协议**：阅读并同意协议，点击"下一步"
4. **选择安装位置**：
   - 点击"浏览"选择自定义路径
   - 或直接在输入框中修改路径
   - 点击"下一步"
5. **选择开始菜单文件夹**：默认即可，点击"下一步"
6. **创建桌面快捷方式**：建议勾选，点击"下一步"
7. **准备安装**：确认配置，点击"安装"
8. **完成安装**：点击"完成"启动应用

## 快速打包使用

### npm命令方式

```bash
# 快速打包（推荐）
npm run dist:win:quick

# 完整打包（首次或清理缓存后）
npm run dist:win
```

## 技术配置详情

### package.json 关键配置

```json
{
  "scripts": {
    "dist:win:quick": "electron-builder --win --publish never"
  },
  "build": {
    "directories": {
      "output": "dist",
      "buildResources": "assets"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true,
      "installerLanguages": ["zh_CN"],
      "language": "2052"
    }
  }
}
```

## 打包输出文件说明

1. **`win-ia32-unpacked/`** - 32位Windows解压版
2. **`win-unpacked/`** - 64位Windows解压版  
3. **`Todo List Manager Setup 1.0.0.exe`** - 主安装程序

**推荐分发文件：**
- 给用户：`Todo List Manager Setup 1.0.0.exe`
- 便携版：根据系统选择对应的unpacked文件夹

## 常见问题解决

### 安装问题
1. **权限不足**：右键选择"以管理员身份运行"
2. **路径包含特殊字符**：建议使用英文路径
3. **磁盘空间不足**：确保目标磁盘至少有200MB可用空间

### 打包问题
1. **缓存导致的问题**：清理缓存后重新打包
2. **网络连接问题**：首次打包需要网络下载Electron
3. **依赖冲突**：删除`node_modules`后重新安装

## 性能优化建议

1. **定期清理缓存**：建议每月清理一次缓存
2. **使用快速打包**：开发阶段使用快速打包提升效率
3. **网络优化**：考虑使用国内镜像源加速下载