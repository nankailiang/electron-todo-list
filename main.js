const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// 确保用户数据目录存在
function ensureUserDataDir() {
    const userDataDir = app.getPath('userData');
    if (!fs.existsSync(userDataDir)) {
        fs.mkdirSync(userDataDir, { recursive: true });
    }
}

// 应用数据文件路径
let TODO_FILE_PATH;

// 初始化应用
function initializeApp() {
    ensureUserDataDir();
    TODO_FILE_PATH = path.join(app.getPath('userData'), 'todoList.json');
    console.log('Todo file path:', TODO_FILE_PATH);
}

// 创建浏览器窗口
function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            enableRemoteModule: false
        },
        title: 'Todo List Manager',
        backgroundColor: '#f8f9fa',
        icon: path.join(__dirname, 'assets', 'icon.png')
    });

    // 加载主页面
    mainWindow.loadFile('index.html');

    // 打开开发者工具（生产环境可注释）
    // mainWindow.webContents.openDevTools();

    // 移除窗口菜单
    mainWindow.setMenu(null);

    // 窗口关闭事件
    mainWindow.on('closed', function () {
        // 清空窗口引用
    });
}

// 应用就绪事件
app.whenReady().then(() => {
    initializeApp();
    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

// 应用退出事件
app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

// 确保文件存在
function ensureFileExists() {
    try {
        if (!fs.existsSync(TODO_FILE_PATH)) {
            fs.writeFileSync(TODO_FILE_PATH, JSON.stringify([], null, 2), 'utf8');
            console.log('Created new todo file at:', TODO_FILE_PATH);
        }
    } catch (error) {
        console.error('Error ensuring file exists:', error);
        throw error;
    }
}

// 读取待办事项
function readTodos() {
    try {
        ensureFileExists();
        const data = fs.readFileSync(TODO_FILE_PATH, 'utf8');
        return JSON.parse(data) || [];
    } catch (error) {
        console.error('Error reading todos:', error);
        return [];
    }
}

// 保存待办事项
function saveTodos(todos) {
    try {
        ensureFileExists();
        fs.writeFileSync(TODO_FILE_PATH, JSON.stringify(todos, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error('Error saving todos:', error);
        return false;
    }
}

// 获取所有待办事项
ipcMain.handle('get-todos', () => {
    return readTodos();
});

// 保存所有待办事项
ipcMain.handle('save-todos', (event, todos) => {
    return saveTodos(todos);
});

// 添加待办事项
ipcMain.handle('add-todo', (event, todo) => {
    try {
        const todos = readTodos();
        const newTodo = {
            id: Date.now().toString(),
            ...todo,
            status: 'pending',
            createdAt: new Date().toISOString()
        };
        todos.push(newTodo);
        const success = saveTodos(todos);
        return { success, todo: newTodo };
    } catch (error) {
        console.error('Error adding todo:', error);
        return { success: false, error: error.message };
    }
});

// 更新待办事项
ipcMain.handle('update-todo', (event, updatedTodo) => {
    try {
        const todos = readTodos();
        const index = todos.findIndex(todo => todo.id === updatedTodo.id);
        if (index !== -1) {
            todos[index] = { ...todos[index], ...updatedTodo };
            const success = saveTodos(todos);
            return { success };
        }
        return { success: false, error: 'Todo not found' };
    } catch (error) {
        console.error('Error updating todo:', error);
        return { success: false, error: error.message };
    }
});

// 删除待办事项
ipcMain.handle('delete-todo', (event, todoId) => {
    try {
        const todos = readTodos();
        const newTodos = todos.filter(todo => todo.id !== todoId);
        const success = saveTodos(newTodos);
        return { success };
    } catch (error) {
        console.error('Error deleting todo:', error);
        return { success: false, error: error.message };
    }
});

// 导出待办事项
ipcMain.handle('export-todos', async (event, format) => {
    try {
        const todos = readTodos();
        if (todos.length === 0) {
            return { success: false, error: '没有待办事项可导出' };
        }

        // 显示保存对话框
        const result = await dialog.showSaveDialog({
            title: '导出待办事项',
            defaultPath: path.join(app.getPath('downloads'), `todo-export-${new Date().getTime()}.${format}`),
            filters: [
                { name: `${format.toUpperCase()} Files`, extensions: [format] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });

        if (result.canceled) {
            return { success: false, error: '导出已取消' };
        }

        let content = '';
        switch (format) {
            case 'json':
                content = JSON.stringify(todos, null, 2);
                break;
            case 'csv':
                content = await convertToCSV(todos);
                break;
            case 'txt':
                content = convertToTXT(todos);
                break;
            default:
                return { success: false, error: '不支持的格式' };
        }

        fs.writeFileSync(result.filePath, content, 'utf8');
        return { success: true, path: result.filePath };
    } catch (error) {
        console.error('Error exporting todos:', error);
        return { success: false, error: error.message };
    }
});

// 转换为CSV格式
async function convertToCSV(todos) {
    return new Promise((resolve, reject) => {
        try {
            const headers = ['ID', 'Date', 'Priority', 'Content', 'Status', 'Created At'];
            let csv = headers.join(',') + '\n';

            todos.forEach(todo => {
                const row = [
                    `"${todo.id}"`,
                    `"${todo.date}"`,
                    `"${todo.priority}"`,
                    `"${todo.content.replace(/"/g, '""')}"`,
                    `"${todo.status}"`,
                    `"${todo.createdAt}"`
                ];
                csv += row.join(',') + '\n';
            });

            resolve(csv);
        } catch (error) {
            reject(error);
        }
    });
}

// 转换为TXT格式
function convertToTXT(todos) {
    let txt = `待办事项列表\n`;
    txt += `导出时间: ${new Date().toLocaleString()}\n`;
    txt += `总数量: ${todos.length}\n`;
    txt += '-'.repeat(50) + '\n\n';

    todos.forEach((todo, index) => {
        const statusMap = { pending: '待办', 'in-progress': '在办', completed: '结办' };
        const priorityMap = { high: '高', medium: '中', low: '低' };
        
        txt += `${index + 1}. [${statusMap[todo.status]}] ${todo.content}\n`;
        txt += `   日期: ${todo.date}\n`;
        txt += `   优先级: ${priorityMap[todo.priority]}\n`;
        txt += `   创建时间: ${new Date(todo.createdAt).toLocaleString()}\n`;
        txt += '-'.repeat(50) + '\n';
    });

    return txt;
}

// 显示文件选择对话框
ipcMain.handle('show-open-dialog', (event, options) => {
    return dialog.showOpenDialog({
        title: '选择文件',
        properties: ['openFile'],
        ...options
    });
});

// 导入任务
ipcMain.handle('import-todos', async (event, { filePath, format }) => {
    try {
        console.log('Importing todos from:', filePath, 'Format:', format);
        
        if (!fs.existsSync(filePath)) {
            throw new Error('文件不存在');
        }

        const content = fs.readFileSync(filePath, 'utf8');
        let importedTodos = [];

        switch (format) {
            case 'json':
                importedTodos = JSON.parse(content);
                break;
            case 'csv':
                importedTodos = await parseCSV(content);
                break;
            case 'txt':
                importedTodos = parseTXT(content);
                break;
            default:
                throw new Error('不支持的文件格式');
        }

        // 验证导入的数据
        if (!Array.isArray(importedTodos)) {
            throw new Error('导入的数据不是数组格式');
        }

        // 处理导入的数据
        const existingTodos = readTodos();
        const stats = {
            total: importedTodos.length,
            added: 0,
            updated: 0,
            skipped: 0,
            errors: 0
        };

        const processedTodos = importedTodos.map(todo => {
            try {
                // 验证任务数据
                if (!todo || !todo.content || !todo.date) {
                    stats.skipped++;
                    return null;
                }

                // 标准化任务数据
                const normalizedTodo = {
                    id: todo.id || Date.now().toString() + Math.random().toString(36).substr(2, 9),
                    date: todo.date,
                    priority: todo.priority || 'medium',
                    content: todo.content.trim(),
                    status: ['pending', 'in-progress', 'completed'].includes(todo.status) ? todo.status : 'pending',
                    createdAt: todo.createdAt || new Date().toISOString()
                };

                // 检查是否已存在
                const existingIndex = existingTodos.findIndex(t => t.id === normalizedTodo.id);
                if (existingIndex !== -1) {
                    // 更新已存在的任务
                    existingTodos[existingIndex] = normalizedTodo;
                    stats.updated++;
                } else {
                    // 添加新任务
                    existingTodos.push(normalizedTodo);
                    stats.added++;
                }

                return normalizedTodo;
            } catch (error) {
                console.error('Error processing todo:', error);
                stats.errors++;
                return null;
            }
        }).filter(Boolean);

        // 保存更新后的任务列表
        saveTodos(existingTodos);

        console.log('Import completed:', stats);
        return {
            success: true,
            stats,
            importedCount: processedTodos.length
        };

    } catch (error) {
        console.error('Error importing todos:', error);
        return {
            success: false,
            error: error.message,
            stats: { total: 0, added: 0, updated: 0, skipped: 0, errors: 1 }
        };
    }
});

// 解析CSV文件
async function parseCSV(content) {
    return new Promise((resolve, reject) => {
        try {
            const lines = content.trim().split('\n');
            const headers = lines[0].trim().split(',').map(h => h.trim());
            const todos = [];

            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;

                const values = parseCSVLine(line);
                const todo = {};

                headers.forEach((header, index) => {
                    const value = values[index] || '';
                    switch (header.toLowerCase()) {
                        case 'id':
                            todo.id = value;
                            break;
                        case 'date':
                            todo.date = value;
                            break;
                        case 'priority':
                            todo.priority = value;
                            break;
                        case 'content':
                            todo.content = value;
                            break;
                        case 'status':
                            todo.status = value;
                            break;
                        case 'createdat':
                        case 'created at':
                            todo.createdAt = value;
                            break;
                    }
                });

                todos.push(todo);
            }

            resolve(todos);
        } catch (error) {
            reject(error);
        }
    });
}

// 辅助函数：解析CSV行（处理引号）
function parseCSVLine(line) {
    const values = [];
    let currentValue = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
            if (inQuotes && i < line.length - 1 && line[i + 1] === '"') {
                // 处理转义的引号
                currentValue += '"';
                i++; // 跳过下一个引号
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            values.push(currentValue.trim());
            currentValue = '';
        } else {
            currentValue += char;
        }
    }

    values.push(currentValue.trim());
    return values;
}

// 解析TXT文件
function parseTXT(content) {
    const todos = [];
    const lines = content.trim().split('\n');
    let currentTodo = null;

    lines.forEach(line => {
        line = line.trim();
        if (!line) {
            if (currentTodo && currentTodo.content) {
                todos.push(currentTodo);
                currentTodo = null;
            }
            return;
        }

        if (!currentTodo) {
            currentTodo = {
                content: '',
                date: new Date().toISOString().split('T')[0],
                priority: 'medium',
                status: 'pending'
            };
        }

        const dateMatch = line.match(/日期:\s*(\d{4}-\d{2}-\d{2})/);
        const priorityMatch = line.match(/优先级:\s*(高|中|低)/);
        const statusMatch = line.match(/状态:\s*(待办|在办|结办)/);

        if (dateMatch) {
            currentTodo.date = dateMatch[1];
        } else if (priorityMatch) {
            const priorityMap = { '高': 'high', '中': 'medium', '低': 'low' };
            currentTodo.priority = priorityMap[priorityMatch[1]] || 'medium';
        } else if (statusMatch) {
            const statusMap = { '待办': 'pending', '在办': 'in-progress', '结办': 'completed' };
            currentTodo.status = statusMap[statusMatch[1]] || 'pending';
        } else if (line.startsWith('.')) {
            currentTodo.content = line.substring(1).trim();
        } else {
            currentTodo.content += line + '\n';
        }
    });

    if (currentTodo && currentTodo.content) {
        todos.push(currentTodo);
    }

    return todos;
}

// 打开文件
ipcMain.handle('open-file', (event, filePath) => {
    try {
        shell.openPath(filePath).then(result => {
            if (result) {
                console.error('Error opening file:', result);
                return { success: false, error: result };
            }
            return { success: true };
        });
    } catch (error) {
        console.error('Error opening file:', error);
        return { success: false, error: error.message };
    }
});

// 获取应用信息
ipcMain.handle('get-app-info', () => {
    return {
        version: app.getVersion(),
        dataPath: TODO_FILE_PATH,
        userDataPath: app.getPath('userData'),
        downloadsPath: app.getPath('downloads')
    };
});

// 获取应用路径
ipcMain.handle('get-app-path', (event, pathName) => {
    return app.getPath(pathName);
});

// 显示保存对话框
ipcMain.handle('show-save-dialog', (event, options) => {
    return dialog.showSaveDialog(options);
});

// 显示消息框
ipcMain.handle('show-message-box', (event, options) => {
    return dialog.showMessageBox(options);
});