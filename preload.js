const { contextBridge, ipcRenderer } = require('electron');

console.log('Preload script loaded');

// 暴露API给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
    // 待办事项相关
    getTodos: () => {
        console.log('preload: getTodos called');
        return ipcRenderer.invoke('get-todos');
    },
    saveTodos: (todos) => {
        console.log('preload: saveTodos called with', todos.length, 'todos');
        return ipcRenderer.invoke('save-todos', todos);
    },
    addTodo: (todo) => {
        console.log('preload: addTodo called');
        return ipcRenderer.invoke('add-todo', todo);
    },
    updateTodo: (todo) => {
        console.log('preload: updateTodo called for id', todo.id);
        return ipcRenderer.invoke('update-todo', todo);
    },
    deleteTodo: (todoId) => {
        console.log('preload: deleteTodo called for id', todoId);
        return ipcRenderer.invoke('delete-todo', todoId);
    },
    
    // 导出任务
    exportTodos: (format) => {
        console.log('preload: exportTodos called with format', format);
        return ipcRenderer.invoke('export-todos', format);
    },
    
    // 导入任务
    importTodos: (options) => {
        console.log('preload: importTodos called with options', options);
        return ipcRenderer.invoke('import-todos', options);
    },
    
    // 显示文件选择对话框
    showOpenDialog: (options) => {
        console.log('preload: showOpenDialog called');
        return ipcRenderer.invoke('show-open-dialog', options);
    },
    
    // 打开文件
    openFile: (filePath) => {
        console.log('preload: openFile called for path', filePath);
        return ipcRenderer.invoke('open-file', filePath);
    },
    
    // 获取应用信息
    getAppInfo: () => {
        console.log('preload: getAppInfo called');
        return ipcRenderer.invoke('get-app-info');
    },
    
    // 系统信息
    getAppPath: (pathName) => {
        console.log('preload: getAppPath called for', pathName);
        return ipcRenderer.invoke('get-app-path', pathName);
    },
    
    // 对话框
    showSaveDialog: (options) => {
        console.log('preload: showSaveDialog called');
        return ipcRenderer.invoke('show-save-dialog', options);
    },
    showMessageBox: (options) => {
        console.log('preload: showMessageBox called');
        return ipcRenderer.invoke('show-message-box', options);
    }
});

console.log('Electron API exposed successfully');