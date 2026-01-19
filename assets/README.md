# 应用图标文件说明

## 图标文件要求
electron-builder需要以下图标文件来生成不同平台的安装程序：

### Windows平台
- icon.ico - Windows应用图标（推荐尺寸：256x256）

### macOS平台  
- icon.icns - macOS应用图标（推荐尺寸：512x512）

### Linux平台
- icon.png - Linux应用图标（推荐尺寸：512x512）

## 获取图标文件的方法

### 方法1：使用在线图标生成器
1. 访问 https://www.electron.build/icons
2. 上传您的图标图片
3. 下载生成的图标包
4. 解压到assets目录

### 方法2：使用免费图标库
1. 访问 https://www.flaticon.com/ 或 https://www.iconfinder.com/
2. 搜索合适的图标（推荐256x256或更大尺寸）
3. 下载并保存到assets目录

### 方法3：使用默认图标
如果暂时没有图标文件，可以使用以下方法：
1. 删除package.json中的icon配置
2. 或使用系统默认图标

## 临时解决方案
如果您需要立即打包，可以：
1. 注释掉package.json中的所有icon配置
2. 或使用下面的简化配置

## 简化配置示例
```json
"win": {
  "target": [
    {
      "target": "nsis",
      "arch": ["x64", "ia32"]
    }
  ]
},
"mac": {
  "target": "dmg"
},
"linux": {
  "target": ["AppImage", "deb"]
}
```

## 注意事项
- 图标文件尺寸越大，生成的安装程序质量越好
- 建议使用PNG格式的高分辨率图片作为源文件
- 确保图标文件路径正确，相对于项目根目录