/* ==========================================================================
   Todo List Manager —— 渲染进程逻辑
   ========================================================================== */
'use strict';

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------
const State = {
    todos: [],
    lists: [],
    savedFilters: [],
    reports: [],
    editingReport: null,
    settings: {
        theme: 'light',
        density: 'comfortable',
        showTime: true,
        showNote: true,
        autoPromote: false,
        autoArchive: false,
        remind: true,
        dailyReminder: false,
        dailyTime: '09:00',
        currentListId: 'all',
        currentView: 'list',
        showDashboard: false
    },
    filters: { search: '', status: 'all', priority: 'all', tag: 'all', start: '', end: '', archived: false, hideUnstarted: false },
    sort: { by: 'manual', dir: 'desc' },
    selectMode: false,
    selected: new Set(),
    editingSubtasks: [],
    calendar: { year: 0, month: 0, mode: 'week', weekStart: null },
    cmdk: { items: [], index: 0, mode: 'command' },
    importBuffer: null,
    confirmCallback: null,
    passCallback: null,
    suggestIndex: -1
};

const STATUS = { pending: '待办', 'in-progress': '在办', completed: '结办' };
const PRIORITY = { high: '高', medium: '中', low: '低' };
const PR_ORDER = { high: 3, medium: 2, low: 1 };

const $ = (id) => document.getElementById(id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// 内联 SVG 图标（飞书风格线性图标，离线可用）
function I(name, attrs) {
    return `<svg class="icon"${attrs ? ' ' + attrs : ''}><use href="#i-${name}"/></svg>`;
}

// ---------------------------------------------------------------------------
// 拼音首字母（内置常用字映射表）—— 用于拼音首字母搜索
// ---------------------------------------------------------------------------
// 汉字 Unicode 码点按部首/笔画排序而非拼音，无法用码点分界推算首字母。
// 这里内置一份常用字→拼音首字母映射，覆盖高频汉字；未收录的字不参与拼音匹配。
const PY_GROUPS = {
    a: '阿啊爱安按暗岸',
    b: '把吧爸白百班板版办半伴帮包报抱杯背被本比笔必毕边编便标表别并病补不部步布',
    c: '才材财采菜参餐草测层查察差产长常场厂车成城乘吃持迟尺充虫出初除处传床创春词此次从',
    d: '答打大代带待单但当刀导到道得的等低底地第点电店定东冬动都读度短段对多',
    e: '额恶饿而儿二',
    f: '发法翻烦反饭方房访放非飞费分风封否夫服福府父付复负富妇份',
    g: '改概干感刚钢高告哥歌革格个给根跟更工公功共够古股故顾关观管光广规贵国过',
    h: '还孩海害含寒喊汉好号喝合和河黑很红后候呼胡湖户花华化画话坏欢环换黄回会婚活火货',
    j: '击基机积级极几己记纪技既继家加价假间检见件建健将讲交角脚叫教接节结解介今金紧近进经精究九酒旧就局举句具据急集计际仅键',
    k: '开看康考科可克刻客课空口哭苦快款',
    l: '来蓝劳老乐雷类冷离李里理力立利连联脸练两量亮料列林临领另令留流六龙楼路旅律绿论落',
    m: '妈麻马吗买卖满忙毛没每美妹门梦米面民名明命模母目',
    n: '拿哪那奶男南难脑呢内能你年念鸟您牛农女',
    o: '哦欧偶',
    p: '怕拍排盘旁跑陪配朋批评瓶普',
    q: '七期其奇齐起气汽器千前钱浅强抢桥切亲轻清情请求区取去全权',
    r: '然让热人认任仍日容如入软',
    s: '三色森杀沙山商上少社设身深什神生声胜师十时识实食史使世事视是手守首受书数说思四送算虽岁孙所',
    t: '他她它台太态谈汤堂糖讨特提题体天条听停通同头图土团推退',
    w: '哇外完晚万王往望为围位味温文问我无五午务物',
    x: '西希息喜洗系细下夏先现线相香想向消小笑校写谢心新信星行姓休修许续需学雪寻项限像效',
    y: '压牙言严研眼演样要也业叶页一衣医依已以意义因音引饮应英影用优由游有又右于鱼语雨预元员原远院愿约越云运',
    z: '杂在再咱早造怎增站张章找照者这真正政知直职志只制中重种主住注专转装准桌资子字自总走足组最左作坐做周昨钟准资'
};
const PY_MAP = (() => {
    const m = {};
    for (const letter in PY_GROUPS) for (const ch of PY_GROUPS[letter]) m[ch] = letter;
    return m;
})();
function firstLetterOf(ch) {
    const code = ch.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) return PY_MAP[ch] || '';
    return /[a-z0-9]/i.test(ch) ? ch.toLowerCase() : '';
}
function pinyinInitials(str) {
    let out = '';
    for (const ch of str) out += firstLetterOf(ch);
    return out;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t == null ? '' : t; return d.innerHTML; }
function debounce(fn, wait) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); }; }
function throttle(fn, wait) { let last = 0, timer; return (...a) => { const now = Date.now(); if (now - last >= wait) { last = now; fn(...a); } else { clearTimeout(timer); timer = setTimeout(() => { last = Date.now(); fn(...a); }, wait - (now - last)); } }; }

function fmtDateTime(ts) {
    if (!ts) return '';
    try { return new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
    catch { return ''; }
}
function todayISO() { return localISO(new Date()); }

// ---- 本地日期助手（避免 UTC 偏移：基于本地年月日，而非 toISOString）----
function localISO(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function isoAddDays(iso, n) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return localISO(d); }
function mondayISO(iso) { const d = new Date(iso + 'T00:00:00'); const day = d.getDay(); d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day)); return localISO(d); }

// ---- 完成度（0~100 整数）----
// 语义：只在「在办」任务上展示和调整；结办一律视为 100%，待办视为 0%。
// 待办任务里保留的 progress 不会展示，但「开始」后会接着用，方便先预估。
function clampProgress(v) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}
function storedProgress(t) { return t ? clampProgress(t.progress) : 0; }
function taskProgress(t) {
    if (!t) return 0;
    if (t.status === 'completed') return 100;
    if (t.status !== 'in-progress') return 0;
    return storedProgress(t);
}
function dayNum(iso) { return parseInt(iso.slice(8, 10), 10); }
function fmtMD(iso) { const p = iso.split('-'); return `${parseInt(p[1], 10)}月${parseInt(p[2], 10)}日`; }
// 把 UTC 时间戳按其本地日期归日（用于完成时间统计分组）
function tsDay(ts) { return ts ? localISO(new Date(ts)) : ''; }

function dueDateObj(t) {
    if (!t.date) return null;
    const iso = t.dueTime ? `${t.date}T${t.dueTime}:00` : `${t.date}T23:59:59`;
    const d = new Date(iso);
    return isNaN(d) ? null : d;
}
function isOverdue(t) {
    if (t.status === 'completed' || t.archived) return false;
    const d = dueDateObj(t);
    return d ? d.getTime() < Date.now() : false;
}
function isDueSoon(t) {
    if (t.status === 'completed' || t.archived) return false;
    const d = dueDateObj(t);
    if (!d) return false;
    const diff = d.getTime() - Date.now();
    return diff >= 0 && diff <= 24 * 3600 * 1000;
}

function showNotification(msg, type = 'info') {
    const n = $('notification');
    n.textContent = msg;
    n.className = `notification notification-${type}`;
    requestAnimationFrame(() => n.classList.add('show'));
    clearTimeout(n._t);
    n._t = setTimeout(() => n.classList.remove('show'), 2800);
}

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------
const persist = {
    todos: debounce(() => { window.electronAPI.saveTodos(State.todos); }, 400),
    settings: debounce(() => { window.electronAPI.saveSettings(State.settings); }, 300),
    lists: () => window.electronAPI.saveLists(State.lists),
    filters: () => window.electronAPI.saveFilters(State.savedFilters),
    reports: debounce(() => { window.electronAPI.saveReports(State.reports); }, 400)
};
function saveTodos() { persist.todos(); }

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
async function init() {
    try {
        // 加密解锁检查
        const cs = await window.electronAPI.cryptoStatus();
        if (cs.enabled && !cs.unlocked) {
            await promptUnlock();
        }

        const [settings, lists, filters] = await Promise.all([
            window.electronAPI.getSettings(),
            window.electronAPI.getLists(),
            window.electronAPI.getFilters()
        ]);

        if (settings) Object.assign(State.settings, settings);
        State.settings.encrypt = cs.enabled;

        State.lists = (lists && lists.length) ? lists : [
            { id: 'default', name: '默认清单', color: '#4c6ef5' }
        ];
        State.savedFilters = filters || [];

        const reports = await window.electronAPI.getReports();
        State.reports = (reports && !reports.__locked__) ? reports : [];

        await loadTodos();

        applySettingsToUI();
        bindEvents();
        // 全局快捷键唤起命令面板 / 快捷录入
        if (window.electronAPI.onOpenCommandBar) {
            window.electronAPI.onOpenCommandBar((mode) => openCommandBar(mode || 'quick'));
        }
        migrateData();
        runAutomations();

        renderAll();
        showNotification('应用加载完成', 'success');

        // 每分钟检查到期提醒 + 自动化
        setInterval(() => { runAutomations(); checkReminders(); checkDailyReminder(); }, 60 * 1000);
        checkReminders();
        checkDailyReminder();
    } catch (e) {
        console.error('初始化失败:', e);
        showNotification('初始化失败: ' + e.message, 'error');
    }
}

async function loadTodos() {
    const data = await window.electronAPI.getTodos();
    if (data && data.__locked__) { State.todos = []; return; }
    State.todos = Array.isArray(data) ? data : [];
}

// 数据迁移：为旧数据补齐新字段
function migrateData() {
    let changed = false;
    State.todos.forEach(t => {
        if (t.listId === undefined) { t.listId = 'default'; changed = true; }
        if (t.note === undefined) { t.note = ''; changed = true; }
        if (t.tags === undefined) { t.tags = []; changed = true; }
        if (t.subtasks === undefined) { t.subtasks = []; changed = true; }
        if (t.pinned === undefined) { t.pinned = false; changed = true; }
        if (t.archived === undefined) { t.archived = false; changed = true; }
        if (t.dueTime === undefined) { t.dueTime = ''; changed = true; }
        if (t.startDate === undefined) { t.startDate = ''; changed = true; }
        if (t.order === undefined) { t.order = 0; changed = true; }
        // repeat 统一为 {type, interval}：兼容旧版字符串（如 "none"/"daily"）
        if (typeof t.repeat === 'string') {
            t.repeat = { type: t.repeat || 'none', interval: 1 }; changed = true;
        } else if (!t.repeat || typeof t.repeat !== 'object') {
            t.repeat = { type: 'none', interval: 1 }; changed = true;
        } else if (!t.repeat.type) {
            t.repeat = { type: 'none', interval: parseInt(t.repeat.interval, 10) || 1 }; changed = true;
        }
        if (t.startedAt === undefined) { t.startedAt = t.status === 'in-progress' ? (t.updatedAt || null) : null; changed = true; }
        if (t.completedAt === undefined) { t.completedAt = t.status === 'completed' ? (t.updatedAt || null) : null; changed = true; }
        // 完成度：旧数据补 0；结办任务统一按 100%
        const p = t.status === 'completed' ? 100 : (t.progress === undefined ? 0 : clampProgress(t.progress));
        if (t.progress !== p) { t.progress = p; changed = true; }
    });
    if (changed) saveTodos();
}

// ---------------------------------------------------------------------------
// 自动化：动态提权、自动归档、重复任务生成
// ---------------------------------------------------------------------------
function runAutomations() {
    let changed = false;
    const now = Date.now();

    State.todos.forEach(t => {
        // 临近到期自动提权
        if (State.settings.autoPromote && t.status !== 'completed' && !t.archived && !t._promoted) {
            if (isDueSoon(t) && t.priority !== 'high') {
                t.priority = t.priority === 'low' ? 'medium' : 'high';
                t._promoted = true;
                changed = true;
            }
        }
        // 自动归档已完成超 3 天
        if (State.settings.autoArchive && t.status === 'completed' && !t.archived && t.completedAt) {
            if (now - new Date(t.completedAt).getTime() > 3 * 24 * 3600 * 1000) {
                t.archived = true; changed = true;
            }
        }
    });

    if (changed) { saveTodos(); }
    return changed;
}

// 完成重复任务时，生成下一个周期任务
function spawnRecurring(task) {
    // 类型缺失/未知一律不生成，避免把一次性任务误判成每日重复
    if (!task.repeat || typeof task.repeat !== 'object' || !task.repeat.type || task.repeat.type === 'none' || !task.date) return;
    // 去重：若该任务已经生成过后继（recurPrevId 指向它），不再重复生成
    if (State.todos.some(x => x.recurPrevId === task.id)) return;
    const type = task.repeat.type;
    let nextDate;
    if (type === 'daily') nextDate = isoAddDays(task.date, 1);
    else if (type === 'weekly') nextDate = isoAddDays(task.date, 7);
    else if (type === 'custom') nextDate = isoAddDays(task.date, parseInt(task.repeat.interval) || 1);
    else if (type === 'monthly') {
        const d = new Date(task.date + 'T00:00:00');
        const day = d.getDate();
        d.setMonth(d.getMonth() + 1);
        if (d.getDate() < day) d.setDate(0); // 处理月末溢出
        nextDate = localISO(d);
    } else nextDate = isoAddDays(task.date, 1);

    const clone = {
        ...structuredCloneSafe(task),
        id: uid(),
        date: nextDate,
        recurPrevId: task.id,
        status: 'pending',
        progress: 0,
        pinned: task.pinned,
        subtasks: (task.subtasks || []).map(s => ({ ...s, done: false })),
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        updatedAt: new Date().toISOString(),
        _promoted: false
    };
    State.todos.unshift(clone);
}
function structuredCloneSafe(o) { return JSON.parse(JSON.stringify(o)); }

// ---------------------------------------------------------------------------
// 提醒
// ---------------------------------------------------------------------------
const remindedSet = new Set();
function checkReminders() {
    if (!State.settings.remind) return;
    State.todos.forEach(t => {
        if (t.status === 'completed' || t.archived) return;
        if ((isDueSoon(t) || isOverdue(t)) && !remindedSet.has(t.id)) {
            remindedSet.add(t.id);
            window.electronAPI.notify({
                title: isOverdue(t) ? '任务已逾期' : '任务即将到期',
                body: t.content
            });
        }
    });
}
function checkDailyReminder() {
    if (!State.settings.dailyReminder) return;
    const key = 'dailyReminded-' + todayISO();
    if (localStorage.getItem(key)) return;
    const now = new Date();
    const [h, m] = (State.settings.dailyTime || '09:00').split(':').map(Number);
    if (now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m)) {
        const todayTasks = State.todos.filter(t => t.date === todayISO() && t.status !== 'completed' && !t.archived);
        if (todayTasks.length) {
            window.electronAPI.notify({ title: '今日待办清单', body: `今天有 ${todayTasks.length} 项待办，加油！` });
            localStorage.setItem(key, '1');
        }
    }
}

// ---------------------------------------------------------------------------
// 筛选 / 排序
// ---------------------------------------------------------------------------
function getVisibleTodos() {
    const f = State.filters;
    let list = State.todos.filter(t => {
        // 清单
        if (State.settings.currentListId !== 'all' && t.listId !== State.settings.currentListId) return false;
        // 归档
        if (!f.archived && t.archived) return false;
        if (f.archived && !t.archived) return false;
        // 隐藏未开始（开始日晚于今天，未完成）
        if (f.hideUnstarted && t.startDate && t.startDate > todayISO() && t.status !== 'completed') return false;
        // 状态
        if (f.status !== 'all' && t.status !== f.status) return false;
        // 优先级
        if (f.priority !== 'all' && t.priority !== f.priority) return false;
        // 标签
        if (f.tag !== 'all' && !(t.tags || []).includes(f.tag)) return false;
        // 日期范围
        if (f.start && (!t.date || t.date < f.start)) return false;
        if (f.end && (!t.date || t.date > f.end)) return false;
        // 搜索（内容 / 标签 / 备注 / 拼音首字母）
        if (f.search) {
            const q = f.search.toLowerCase();
            const hay = (t.content + ' ' + (t.note || '') + ' ' + (t.tags || []).join(' ')).toLowerCase();
            const py = pinyinInitials(t.content + (t.note || ''));
            if (!hay.includes(q) && !py.includes(q)) return false;
        }
        return true;
    });

    return sortTodos(list);
}

function sortTodos(list) {
    const { by, dir } = State.sort;
    const mul = dir === 'asc' ? 1 : -1;
    const arr = [...list];
    arr.sort((a, b) => {
        // 置顶永远优先
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        let r = 0;
        switch (by) {
            case 'priority': r = PR_ORDER[a.priority] - PR_ORDER[b.priority]; break;
            case 'date': r = (a.date || '').localeCompare(b.date || ''); break;
            case 'created': r = new Date(a.createdAt || 0) - new Date(b.createdAt || 0); break;
            case 'completed': r = new Date(a.completedAt || 0) - new Date(b.completedAt || 0); break;
            case 'name': r = a.content.localeCompare(b.content, 'zh'); break;
            case 'manual': r = (a.order || 0) - (b.order || 0); break;
            default: r = 0;
        }
        if (r === 0) r = (a.order || 0) - (b.order || 0);
        return r * mul;
    });
    return arr;
}

// ---------------------------------------------------------------------------
// 渲染入口
// ---------------------------------------------------------------------------
function renderAll() {
    renderSidebar();
    renderWeekStrip();
    renderTagFilter();
    renderSavedFilters();
    renderDashboard();
    renderCurrentView();
    updateHeader();
}

function renderWeekStrip() {
    const container = $('week-strip');
    if (!container) return;
    const now = new Date();
    const day = now.getDay(); // 0=Sun
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(now);
    monday.setDate(now.getDate() + mondayOffset);
    const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
    const todayStr = todayISO();

    let html = '';
    for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        const dateStr = localISO(d);
        const isToday = dateStr === todayStr;
        html += `<button class="week-day${isToday ? ' today' : ''}" data-date="${dateStr}">
            <span class="wd-name">${weekDays[d.getDay()]}</span>
            <span class="wd-num">${d.getDate()}</span>
        </button>`;
    }
    container.innerHTML = html;

    // 高亮今天
    const todayEl = container.querySelector('.week-day.today');
    if (todayEl) todayEl.classList.add('active');
}

function renderCurrentView() {
    const view = State.settings.currentView;
    $('view-list').classList.toggle('hidden', view !== 'list');
    $('view-kanban').classList.toggle('hidden', view !== 'kanban');
    $('view-calendar').classList.toggle('hidden', view !== 'calendar');
    syncBottomNav();

    const visible = getVisibleTodos();
    const empty = $('empty-state');
    empty.classList.remove('show');

    if (view === 'list') { renderList(visible); }
    else if (view === 'kanban') { renderKanban(visible); }
    else if (view === 'calendar') { renderCalendar(); }

    if (view !== 'calendar' && visible.length === 0) empty.classList.add('show');
}

// 底部导航高亮同步（与当前视图/仪表盘一致）
function syncBottomNav() {
    const nav = $('bottom-nav');
    if (!nav) return;
    let active = '';
    if (State.settings.showDashboard) active = 'stats';
    else if (State.settings.currentView === 'list') active = 'tasks';
    else if (State.settings.currentView === 'kanban') active = 'kanban';
    else if (State.settings.currentView === 'calendar') active = 'calendar';
    nav.querySelectorAll('.bottom-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === active));
}

function updateHeader() {
    const lid = State.settings.currentListId;
    if (lid === 'all') {
        $('cur-list-name').textContent = '全部任务';
        $('cur-list-color').style.background = 'var(--text-3)';
    } else {
        const l = State.lists.find(x => x.id === lid);
        $('cur-list-name').textContent = l ? l.name : '任务';
        $('cur-list-color').style.background = l ? l.color : 'var(--primary)';
    }
}

// ---------------------------------------------------------------------------
// 侧栏 / 清单
// ---------------------------------------------------------------------------
function listCount(id) {
    return State.todos.filter(t => !t.archived && (id === 'all' || t.listId === id)).length;
}
function renderSidebar() {
    const nav = $('list-nav');
    let html = `<div class="list-item ${State.settings.currentListId === 'all' ? 'active' : ''}" data-list="all">
        <span class="dot" style="background:var(--text-3)"></span> 全部任务 <span class="count">${listCount('all')}</span></div>`;
    State.lists.forEach(l => {
        html += `<div class="list-item ${State.settings.currentListId === l.id ? 'active' : ''}" data-list="${l.id}">
            <span class="dot" style="background:${l.color}"></span>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(l.name)}</span>
            <span class="count">${listCount(l.id)}</span>
            ${l.id !== 'default' ? `<svg class="icon list-del" data-del-list="${l.id}"><use href="#i-times"/></svg>` : ''}
        </div>`;
    });
    nav.innerHTML = html;

    nav.querySelectorAll('.list-item').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target.dataset.delList) return;
            State.settings.currentListId = el.dataset.list;
            persist.settings();
            State.selected.clear();
            renderAll();
            closeSidebarMobile();
        });
    });
    nav.querySelectorAll('[data-del-list]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = el.dataset.delList;
            const l = State.lists.find(x => x.id === id);
            confirmAction(`删除清单「${l.name}」？其任务将移至默认清单。`, () => {
                State.todos.forEach(t => { if (t.listId === id) t.listId = 'default'; });
                State.lists = State.lists.filter(x => x.id !== id);
                if (State.settings.currentListId === id) State.settings.currentListId = 'all';
                persist.lists(); saveTodos(); persist.settings();
                renderAll();
                showNotification('清单已删除', 'success');
            });
        });
    });
}

// ---------------------------------------------------------------------------
// 列表视图（全量渲染 + 手动拖拽排序）
// ---------------------------------------------------------------------------
let listScrollHandler = null;
function renderList(visible) {
    const container = $('task-list');
    container.classList.toggle('compact', State.settings.density === 'compact');
    // 仅「手动」排序且非多选时允许拖拽调整顺序
    const reorderable = State.sort.by === 'manual' && !State.selectMode;
    container.classList.toggle('reorderable', reorderable);

    // 统一全量渲染（此前按固定行高的虚拟滚动会因卡片高度不一导致重叠/错位，已弃用）
    if (listScrollHandler) { const sc = document.querySelector('.content'); if (sc) sc.removeEventListener('scroll', listScrollHandler); listScrollHandler = null; }
    container.style.height = '';
    container.style.position = '';
    container.innerHTML = '';
    visible.forEach(t => container.appendChild(createTaskEl(t)));
    if (reorderable) bindListReorder(container);
}

// 列表视图手动拖拽排序（sort = manual 时生效）
let listDragId = null;
function clearListDropMarks() {
    document.querySelectorAll('.task-item.drop-before, .task-item.drop-after')
        .forEach(e => e.classList.remove('drop-before', 'drop-after'));
}
function bindListReorder(container) {
    container.querySelectorAll('.task-item').forEach(el => {
        el.draggable = true;
        el.addEventListener('dragstart', (e) => {
            listDragId = el.dataset.id;
            el.classList.add('dragging');
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', listDragId);
            }
        });
        el.addEventListener('dragend', () => { el.classList.remove('dragging'); clearListDropMarks(); listDragId = null; });
        el.addEventListener('dragover', (e) => {
            if (!listDragId || el.dataset.id === listDragId) return;
            e.preventDefault();
            const r = el.getBoundingClientRect();
            const after = (e.clientY - r.top) > r.height / 2;
            clearListDropMarks();
            el.classList.add(after ? 'drop-after' : 'drop-before');
            el._dropAfter = after;
        });
        el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
        el.addEventListener('drop', (e) => {
            e.preventDefault();
            const targetId = el.dataset.id;
            const after = !!el._dropAfter;
            clearListDropMarks();
            if (listDragId && targetId !== listDragId) reorderTodos(listDragId, targetId, after);
            listDragId = null;
        });
    });
}

function reorderTodos(dragId, targetId, after) {
    const from = State.todos.findIndex(t => t.id === dragId);
    if (from < 0) return;
    const [moved] = State.todos.splice(from, 1);
    let to = State.todos.findIndex(t => t.id === targetId);
    if (to < 0) { State.todos.splice(from, 0, moved); return; }
    if (after) to += 1;
    State.todos.splice(to, 0, moved);
    // order 需与当前排序方向一致：降序时把数组顺序反过来编号，保证拖完的视觉顺序不被翻转
    const n = State.todos.length;
    const desc = State.sort.dir === 'desc';
    State.todos.forEach((t, i) => { t.order = desc ? n - 1 - i : i; });
    saveTodos(); renderCurrentView();
    showNotification('已调整顺序', 'success');
}

function renderVirtualList(container, visible) {
    const ROW = State.settings.density === 'compact' ? 56 : 118;
    const scroller = document.querySelector('.content');
    const total = visible.length;
    container.style.position = 'relative';
    container.style.height = (total * ROW) + 'px';

    const draw = () => {
        const scrollTop = scroller.scrollTop;
        const viewH = scroller.clientHeight;
        const start = Math.max(0, Math.floor(scrollTop / ROW) - 5);
        const end = Math.min(total, Math.ceil((scrollTop + viewH) / ROW) + 5);
        container.innerHTML = '';
        for (let i = start; i < end; i++) {
            const el = createTaskEl(visible[i]);
            el.style.position = 'absolute';
            el.style.top = (i * ROW) + 'px';
            el.style.left = '0'; el.style.right = '0';
            container.appendChild(el);
        }
    };
    if (listScrollHandler) scroller.removeEventListener('scroll', listScrollHandler);
    listScrollHandler = throttle(draw, 30);
    scroller.addEventListener('scroll', listScrollHandler);
    draw();
}

function createTaskEl(t) {
    const el = document.createElement('div');
    const overdue = isOverdue(t), soon = isDueSoon(t);
    el.className = `task-item ${t.status} pr-${t.priority}` +
        (t.pinned ? ' pinned' : '') + (overdue ? ' overdue' : '') +
        (State.selected.has(t.id) ? ' selected' : '');
    el.dataset.id = t.id;

    const list = State.lists.find(l => l.id === t.listId);
    const dateBadge = t.date ? `<span class="badge date ${overdue ? 'overdue' : soon ? 'due-soon' : ''}">
        ${I('calendar')} ${t.date}${t.dueTime ? ' ' + t.dueTime : ''}</span>` : '';
    const startBadge = (t.startDate && !t.completedAt) ? `<span class="badge start" title="开始日 ${t.startDate}">${I('sun')} 开始 ${t.startDate.slice(5)}</span>` : '';
    const tagBadges = (t.tags || []).map(tg => `<span class="badge tag">#${escapeHtml(tg)}</span>`).join('');
    const subDone = (t.subtasks || []).filter(s => s.done).length;
    const subBadge = (t.subtasks && t.subtasks.length) ? `<span class="badge subtask">${I('list-check')} ${subDone}/${t.subtasks.length}</span>` : '';
    const repeatBadge = (t.repeat && t.repeat.type !== 'none') ? `<span class="badge status">${I('repeat')}</span>` : '';
    const listBadge = (State.settings.currentListId === 'all' && list) ? `<span class="badge status" style="color:${list.color}">${I('folder')} ${escapeHtml(list.name)}</span>` : '';

    const notePreview = (State.settings.showNote && t.note) ? `<div class="task-note-preview">${escapeHtml(t.note.slice(0, 120))}${t.note.length > 120 ? '…' : ''}</div>` : '';
    const timeMeta = State.settings.showTime ? `<div class="task-meta-time">${I('history')} 创建 ${fmtDateTime(t.createdAt)}${t.completedAt ? '｜完成 ' + fmtDateTime(t.completedAt) : ''}</div>` : '';

    const checkbox = State.selectMode ? `<div class="task-check"><input type="checkbox" class="sel-check" ${State.selected.has(t.id) ? 'checked' : ''}></div>` : '';

    // 悬浮操作按钮
    let statusBtn = '';
    if (t.status === 'pending') statusBtn = `<button class="act" data-act="start" title="开始">${I('play')}</button>`;
    else if (t.status === 'in-progress') statusBtn = `<button class="act" data-act="complete" title="完成">${I('check')}</button>`;
    else statusBtn = `<button class="act" data-act="reopen" title="重新打开">${I('rotate')}</button>`;

    el.innerHTML = `
        <div class="task-top">
            ${checkbox}
            <div class="task-main">
                <div class="task-content">${escapeHtml(t.content)}</div>
                ${notePreview}
                <div class="task-badges">
                    <span class="badge pr-${t.priority}">${I('flag')} ${PRIORITY[t.priority]}</span>
                    <span class="badge status st-${t.status}">${I('circle')} ${STATUS[t.status]}</span>
                    ${startBadge}${dateBadge}${listBadge}${subBadge}${repeatBadge}${tagBadges}
                </div>
                ${progressBarHtml(t)}
                ${timeMeta}
            </div>
            <div class="task-actions">
                <span class="priority-quick" title="快速改优先级">
                    <button class="pq h" data-pr="high">高</button>
                    <button class="pq m" data-pr="medium">中</button>
                    <button class="pq l" data-pr="low">低</button>
                </span>
                ${statusBtn}
                <button class="act" data-act="pin" title="置顶">${I('thumbtack', t.pinned ? 'style="color:var(--warning)"' : '')}</button>
                <button class="act" data-act="edit" title="编辑详情">${I('pen')}</button>
                <button class="act" data-act="copy" title="复制">${I('copy')}</button>
                <button class="act" data-act="archive" title="${t.archived ? '取消归档' : '归档'}">${I('archive')}</button>
                <button class="act danger" data-act="delete" title="删除">${I('trash')}</button>
            </div>
        </div>
        ${renderSubtaskList(t)}
    `;

    bindTaskEl(el, t);
    return el;
}

function renderSubtaskList(t) {
    if (!t.subtasks || !t.subtasks.length || State.settings.density === 'compact') return '';
    return `<div class="subtask-list">${t.subtasks.map(s => `
        <label class="subtask-row ${s.done ? 'done' : ''}">
            <input type="checkbox" class="sub-check" data-sub="${s.id}" ${s.done ? 'checked' : ''}>
            <span>${escapeHtml(s.text)}</span>
        </label>`).join('')}</div>`;
}

// 在办任务的完成度进度条；点击轨道即可直接定位百分比
function progressBarHtml(t, compact) {
    if (t.status !== 'in-progress') return '';
    const p = taskProgress(t);
    return `<div class="task-progress${compact ? ' compact' : ''}" data-progress-bar
        title="完成度 ${p}%，点击进度条可直接调整">
        <div class="tp-track"><div class="tp-fill" style="width:${p}%"></div></div>
        <span class="tp-num">${p}%</span>
    </div>`;
}

// 把点击/拖动位置换算成百分比（0~100）
function progressFromPointer(e, track) {
    const rect = track.getBoundingClientRect();
    if (!rect.width) return 0;
    return clampProgress((e.clientX - rect.left) / rect.width * 100);
}

function bindTaskEl(el, t) {
    el.querySelectorAll('[data-act]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            handleTaskAction(t.id, btn.dataset.act);
        });
    });
    el.querySelectorAll('[data-pr]').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); setPriority(t.id, btn.dataset.pr); });
    });
    el.querySelectorAll('.sub-check').forEach(cb => {
        cb.addEventListener('change', (e) => { e.stopPropagation(); toggleSubtask(t.id, cb.dataset.sub); });
    });
    const selCheck = el.querySelector('.sel-check');
    if (selCheck) selCheck.addEventListener('change', () => toggleSelect(t.id));
    bindProgressBar(el, t);
    // 点击卡片主体在多选模式下切换选中
    el.addEventListener('click', () => { if (State.selectMode) toggleSelect(t.id); });
    // 双击卡片打开编辑（避开操作按钮、子任务勾选区与进度条）
    el.addEventListener('dblclick', (e) => {
        if (e.target.closest('.task-actions') || e.target.closest('.subtask-list') || e.target.closest('.task-check') || e.target.closest('.task-progress')) return;
        openTaskModal(t);
    });
}

// 进度条交互：按下即预览，拖动跟手，松手落库（不触发整表重渲染，避免拖拽中断）
function bindProgressBar(el, t) {
    const bar = el.querySelector('[data-progress-bar]');
    if (!bar) return;
    const track = bar.querySelector('.tp-track');
    const fill = bar.querySelector('.tp-fill');
    const num = bar.querySelector('.tp-num');
    if (!track) return;

    const preview = (pct) => {
        if (fill) fill.style.width = pct + '%';
        if (num) num.textContent = pct + '%';
        bar.title = `完成度 ${pct}%，点击进度条可直接调整`;
    };

    let dragging = false;
    const onMove = (ev) => { if (dragging) preview(progressFromPointer(ev, track)); };
    const onUp = (ev) => {
        if (!dragging) return;
        dragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const pct = progressFromPointer(ev, track);
        preview(pct);
        setTaskProgress(t.id, pct, { silent: true });
    };

    bar.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        dragging = true;
        preview(progressFromPointer(e, track));
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
    bar.addEventListener('click', (e) => e.stopPropagation());
}

// ---------------------------------------------------------------------------
// 任务操作
// ---------------------------------------------------------------------------
function findTask(id) { return State.todos.find(t => t.id === id); }

function handleTaskAction(id, act) {
    const t = findTask(id);
    if (!t) return;
    switch (act) {
        case 'start': setStatus(id, 'in-progress'); break;
        case 'complete': setStatus(id, 'completed'); break;
        case 'reopen': setStatus(id, 'pending'); break;
        case 'pin': t.pinned = !t.pinned; t.updatedAt = new Date().toISOString(); saveTodos(); renderCurrentView(); renderSidebar(); showNotification(t.pinned ? '已置顶' : '已取消置顶', 'info'); break;
        case 'edit': openTaskModal(t); break;
        case 'copy': copyTask(t); break;
        case 'archive': toggleArchive(id); break;
        case 'delete':
            confirmAction('确定要删除这个任务吗？', () => {
                State.todos = State.todos.filter(x => x.id !== id);
                saveTodos(); renderAll(); showNotification('任务已删除', 'success');
            });
            break;
    }
}

function setStatus(id, status) {
    const t = findTask(id);
    if (!t) return;
    const now = new Date().toISOString();
    if (status === 'in-progress' && !t.startedAt) t.startedAt = now;
    if (status === 'completed') {
        t.completedAt = now;
        t.progress = 100;
        if (!t.startedAt) t.startedAt = now;
        spawnRecurring(t);
    }
    if (status === 'pending') { t.completedAt = null; t.progress = 0; }
    t.status = status;
    t.updatedAt = now;
    saveTodos();
    renderAll();
    showNotification(`已标记为「${STATUS[status]}」`, 'success');
}

// 调整在办任务完成度；opts.silent 时不重渲染（进度条自身的 DOM 已同步）
function setTaskProgress(id, pct, opts) {
    const t = findTask(id);
    if (!t || t.status !== 'in-progress') return;
    const next = clampProgress(pct);
    if (next === storedProgress(t)) return;
    t.progress = next;
    t.updatedAt = new Date().toISOString();
    saveTodos();
    if (!opts || !opts.silent) renderCurrentView();
    if (State.settings.showDashboard) renderDashboard();
}

function setPriority(id, pr) {
    const t = findTask(id);
    if (!t || t.priority === pr) return;
    t.priority = pr; t._promoted = false; t.updatedAt = new Date().toISOString();
    saveTodos(); renderCurrentView();
    showNotification(`优先级已改为「${PRIORITY[pr]}」`, 'info');
}

function copyTask(t) {
    const clone = {
        ...structuredCloneSafe(t),
        id: uid(),
        content: t.content + '（副本）',
        status: 'pending',
        progress: 0,
        pinned: false,
        subtasks: (t.subtasks || []).map(s => ({ ...s, id: uid(), done: false })),
        createdAt: new Date().toISOString(),
        startedAt: null, completedAt: null, updatedAt: new Date().toISOString()
    };
    State.todos.unshift(clone);
    saveTodos(); renderAll();
    showNotification('已复制任务', 'success');
}

function toggleArchive(id) {
    const t = findTask(id);
    if (!t) return;
    t.archived = !t.archived; t.updatedAt = new Date().toISOString();
    saveTodos(); renderAll();
    showNotification(t.archived ? '已归档' : '已取消归档', 'success');
}

function toggleSubtask(taskId, subId) {
    const t = findTask(taskId);
    if (!t) return;
    const s = (t.subtasks || []).find(x => x.id === subId);
    if (s) { s.done = !s.done; t.updatedAt = new Date().toISOString(); saveTodos(); renderCurrentView(); }
}

// ---------------------------------------------------------------------------
// 多选 / 批量
// ---------------------------------------------------------------------------
function toggleSelectMode(on) {
    State.selectMode = on !== undefined ? on : !State.selectMode;
    if (!State.selectMode) State.selected.clear();
    $('bulk-bar').classList.toggle('show', State.selectMode);
    $('select-mode-btn').classList.toggle('btn-primary', State.selectMode);
    renderCurrentView();
}
function toggleSelect(id) {
    if (State.selected.has(id)) State.selected.delete(id); else State.selected.add(id);
    updateBulkBar();
    // 局部更新选中态
    const el = document.querySelector(`.task-item[data-id="${id}"]`);
    if (el) el.classList.toggle('selected', State.selected.has(id));
}
function updateBulkBar() { $('bulk-count').textContent = `已选 ${State.selected.size} 项`; }

function bulkApply(fn, msg) {
    if (!State.selected.size) { showNotification('请先选择任务', 'warning'); return; }
    State.selected.forEach(id => { const t = findTask(id); if (t) fn(t); });
    saveTodos(); renderAll(); showNotification(msg, 'success');
}

// ---------------------------------------------------------------------------
// 任务模态框（新建 / 编辑，含子任务、备注、重复、智能识别）
// ---------------------------------------------------------------------------
function openTaskModal(task) {
    const isEdit = !!task;
    $('task-modal-title').textContent = isEdit ? '编辑任务' : '新建任务';
    $('task-id').value = isEdit ? task.id : '';
    $('f-content').value = isEdit ? task.content : '';
    $('f-note').value = isEdit ? (task.note || '') : '';
    $('f-priority').value = isEdit ? task.priority : 'medium';
    $('f-date').value = isEdit ? (task.date || '') : todayISO();
    $('f-start').value = isEdit ? (task.startDate || '') : '';
    $('f-time').value = isEdit ? (task.dueTime || '') : '';
    $('f-tags').value = isEdit ? (task.tags || []).join(', ') : '';
    $('f-repeat').value = isEdit ? (task.repeat ? task.repeat.type : 'none') : 'none';
    $('f-repeat-interval').value = isEdit && task.repeat ? (task.repeat.interval || 3) : 3;
    $('f-repeat-interval').classList.toggle('hidden', $('f-repeat').value !== 'custom');
    setModalProgress(isEdit ? storedProgress(task) : 0);

    // 清单下拉
    const listSel = $('f-list');
    listSel.innerHTML = State.lists.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');
    listSel.value = isEdit ? task.listId : (State.settings.currentListId === 'all' ? 'default' : State.settings.currentListId);

    State.editingSubtasks = isEdit ? structuredCloneSafe(task.subtasks || []) : [];
    renderSubtaskEditor();

    openModal('task-modal');
    setTimeout(() => $('f-content').focus(), 100);
}

// 弹窗里的完成度控件：range / 数字 / 预设按钮三处保持同步
function setModalProgress(v) {
    const p = clampProgress(v);
    const range = $('f-progress'), num = $('f-progress-num'), label = $('f-progress-val');
    if (range) range.value = p;
    if (num) num.value = p;
    if (label) label.textContent = p + '%';
}

function renderSubtaskEditor() {
    const box = $('subtask-editor');
    box.innerHTML = State.editingSubtasks.map((s, i) => `
        <div class="subtask-edit-row">
            <input type="checkbox" ${s.done ? 'checked' : ''} data-idx="${i}" class="se-done">
            <input type="text" class="form-control se-text" data-idx="${i}" value="${escapeHtml(s.text)}" placeholder="子任务内容">
            <button class="rm" data-idx="${i}">${I('times')}</button>
        </div>`).join('');
    box.querySelectorAll('.se-text').forEach(inp => inp.addEventListener('input', () => { State.editingSubtasks[inp.dataset.idx].text = inp.value; }));
    box.querySelectorAll('.se-done').forEach(inp => inp.addEventListener('change', () => { State.editingSubtasks[inp.dataset.idx].done = inp.checked; }));
    box.querySelectorAll('.rm').forEach(btn => btn.addEventListener('click', () => { State.editingSubtasks.splice(btn.dataset.idx, 1); renderSubtaskEditor(); }));
}

function saveTaskFromModal() {
    const content = $('f-content').value.trim();
    if (!content) { showNotification('请输入任务内容', 'warning'); return; }
    const id = $('task-id').value;
    const tags = $('f-tags').value.split(',').map(s => s.trim()).filter(Boolean);
    const repeatType = $('f-repeat').value;
    const subtasks = State.editingSubtasks.filter(s => s.text.trim()).map(s => ({ id: s.id || uid(), text: s.text.trim(), done: !!s.done }));
    const existing = id ? findTask(id) : null;

    const payload = {
        content,
        note: $('f-note').value.trim(),
        priority: $('f-priority').value,
        listId: $('f-list').value,
        date: $('f-date').value,
        startDate: $('f-start').value || '',
        dueTime: $('f-time').value,
        tags,
        repeat: { type: repeatType, interval: parseInt($('f-repeat-interval').value) || 1 },
        progress: (existing && existing.status === 'completed') ? 100 : clampProgress($('f-progress-num').value),
        subtasks
    };

    if (id) {
        const t = findTask(id);
        Object.assign(t, payload, { updatedAt: new Date().toISOString(), _promoted: false });
        showNotification('任务已更新', 'success');
    } else {
        const now = new Date().toISOString();
        const maxOrder = Math.max(0, ...State.todos.map(t => t.order || 0));
        State.todos.unshift({
            id: uid(), ...payload, status: 'pending', pinned: false, archived: false,
            order: maxOrder + 1, createdAt: now, startedAt: null, completedAt: null, updatedAt: now
        });
        showNotification('任务添加成功', 'success');
    }
    saveTodos();
    closeModal('task-modal');
    renderAll();
}

// 智能识别：解析内容中的日期 / 优先级关键词
function smartParse() {
    const inp = $('f-content');
    let text = inp.value;
    let changed = false;

    // 优先级
    if (/紧急|重要|急/.test(text) && $('f-priority').value !== 'high') { $('f-priority').value = 'high'; changed = true; }

    // 日期
    const now = new Date();
    if (/今天/.test(text)) { $('f-date').value = todayISO(); changed = true; }
    else if (/明天/.test(text)) { const d = new Date(now); d.setDate(d.getDate() + 1); $('f-date').value = localISO(d); changed = true; }
    else if (/后天/.test(text)) { const d = new Date(now); d.setDate(d.getDate() + 2); $('f-date').value = localISO(d); changed = true; }
    else { const m = text.match(/(\d{1,2})月(\d{1,2})[日号]/); if (m) { const d = new Date(now.getFullYear(), +m[1] - 1, +m[2]); $('f-date').value = localISO(d); changed = true; } }

    // 时间 HH:MM
    const tm = text.match(/(\d{1,2}):(\d{2})/);
    if (tm) { $('f-time').value = `${tm[1].padStart(2, '0')}:${tm[2]}`; changed = true; }

    if (changed) showNotification('已智能识别日期/优先级', 'info');
}

// 输入联想（基于历史任务内容）
function showSuggestions(q) {
    const box = $('content-suggest');
    if (!q || q.length < 1) { box.classList.remove('show'); return; }
    const seen = new Set();
    const matches = State.todos
        .map(t => t.content)
        .filter(c => c.toLowerCase().includes(q.toLowerCase()) && !seen.has(c) && seen.add(c))
        .slice(0, 6);
    if (!matches.length) { box.classList.remove('show'); return; }
    box.innerHTML = matches.map((m, i) => `<div class="suggest-item ${i === State.suggestIndex ? 'active' : ''}" data-v="${escapeHtml(m)}">${escapeHtml(m)}</div>`).join('');
    box.classList.add('show');
    box.querySelectorAll('.suggest-item').forEach(el => el.addEventListener('mousedown', (e) => { e.preventDefault(); $('f-content').value = el.dataset.v; box.classList.remove('show'); }));
}

// ---------------------------------------------------------------------------
// 看板视图（拖拽切换状态）
// ---------------------------------------------------------------------------
function renderKanban(visible) {
    const cols = [
        { key: 'pending', label: '待办', color: 'var(--warning)' },
        { key: 'in-progress', label: '在办', color: 'var(--info)' },
        { key: 'completed', label: '结办', color: 'var(--success)' }
    ];
    const wrap = $('kanban');
    wrap.innerHTML = cols.map(c => {
        const items = visible.filter(t => t.status === c.key);
        return `<div class="kanban-col" data-status="${c.key}">
            <div class="kanban-col-head"><span class="dot" style="background:${c.color}"></span>${c.label}<span class="k-count">${items.length}</span></div>
            <div class="kanban-cards" data-status="${c.key}">
                ${items.map(t => `
                    <div class="kanban-card pr-${t.priority} ${t.pinned ? 'pinned' : ''}" draggable="true" data-id="${t.id}">
                        <div class="kc-content">${escapeHtml(t.content)}</div>
                        <div class="task-badges">
                            <span class="badge pr-${t.priority}">${PRIORITY[t.priority]}</span>
                            ${t.startDate && !t.completedAt ? `<span class="badge start" title="开始日 ${t.startDate}">${I('sun')} ${t.startDate.slice(5)}</span>` : ''}
                            ${t.date ? `<span class="badge date ${isOverdue(t) ? 'overdue' : ''}">${t.date}</span>` : ''}
                            ${(t.tags || []).slice(0, 2).map(tg => `<span class="badge tag">#${escapeHtml(tg)}</span>`).join('')}
                        </div>
                        ${progressBarHtml(t, true)}
                    </div>`).join('')}
            </div>
        </div>`;
    }).join('');

    bindKanbanDnD();
}

function bindKanbanDnD() {
    let dragId = null;
    $('kanban').querySelectorAll('.kanban-card').forEach(card => {
        card.addEventListener('dragstart', () => { dragId = card.dataset.id; card.classList.add('dragging'); });
        card.addEventListener('dragend', () => card.classList.remove('dragging'));
        card.addEventListener('dblclick', (e) => {
            if (e.target.closest('.task-progress')) return;
            const t = findTask(card.dataset.id); if (t) openTaskModal(t);
        });
        const t = findTask(card.dataset.id);
        if (t) bindProgressBar(card, t);
    });
    $('kanban').querySelectorAll('.kanban-col').forEach(col => {
        col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
        col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
        col.addEventListener('drop', (e) => {
            e.preventDefault(); col.classList.remove('drag-over');
            if (dragId) { setStatus(dragId, col.dataset.status); dragId = null; }
        });
    });
}

// ---------------------------------------------------------------------------
// 日历视图
// ---------------------------------------------------------------------------
function renderCalendar() {
    const cal = State.calendar;
    if (!cal.mode) cal.mode = 'week';
    if (!cal.year) { const n = new Date(); cal.year = n.getFullYear(); cal.month = n.getMonth(); }
    if (!cal.weekStart) cal.weekStart = mondayISO(localISO(new Date()));

    document.querySelectorAll('#cal-mode-switch button').forEach(b => b.classList.toggle('active', b.dataset.calmode === cal.mode));

    const grid = $('calendar-grid');
    const week = $('week-timeline');
    if (cal.mode === 'week') {
        grid.classList.add('hidden');
        week.classList.remove('hidden');
        renderWeekTimeline();
    } else {
        week.classList.add('hidden');
        grid.classList.remove('hidden');
        renderMonthGrid();
    }
}

function renderMonthGrid() {
    const { year, month } = State.calendar;
    $('cal-title').textContent = `${year} 年 ${month + 1} 月`;

    const first = new Date(year, month, 1);
    const startDay = first.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const grid = $('calendar-grid');
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    let html = weekdays.map(w => `<div class="cal-weekday">${w}</div>`).join('');

    const visible = getVisibleTodos();
    const byDate = {};
    visible.forEach(t => { if (t.date) (byDate[t.date] = byDate[t.date] || []).push(t); });

    const prevDays = new Date(year, month, 0).getDate();
    const cells = [];
    for (let i = startDay - 1; i >= 0; i--) cells.push({ d: prevDays - i, other: true, date: null });
    for (let d = 1; d <= daysInMonth; d++) {
        const ds = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        cells.push({ d, other: false, date: ds });
    }
    while (cells.length % 7 !== 0) cells.push({ d: cells.length, other: true, date: null });

    const today = todayISO();
    cells.forEach(c => {
        const isToday = c.date === today;
        const tasks = c.date ? (byDate[c.date] || []) : [];
        const shown = tasks.slice(0, 3);
        html += `<div class="cal-cell ${c.other ? 'other-month' : ''} ${isToday ? 'today' : ''}" data-date="${c.date || ''}">
            <span class="cal-daynum">${c.date ? c.d : ''}</span>
            ${shown.map(t => `<div class="cal-task pr-${t.priority} ${t.status === 'completed' ? 'completed' : ''}" draggable="true" data-id="${t.id}" title="${escapeHtml(t.content)}">${escapeHtml(t.content)}</div>`).join('')}
            ${tasks.length > 3 ? `<div class="cal-more">+${tasks.length - 3} 更多</div>` : ''}
        </div>`;
    });
    grid.innerHTML = html;

    // 点击打开 + 拖拽改期
    grid.querySelectorAll('.cal-task').forEach(el => {
        el.addEventListener('click', () => { const t = findTask(el.dataset.id); if (t) openTaskModal(t); });
        el.addEventListener('dragstart', (e) => { el.classList.add('dragging'); e.dataTransfer.setData('text/plain', el.dataset.id); e.dataTransfer.effectAllowed = 'move'; });
        el.addEventListener('dragend', () => el.classList.remove('dragging'));
    });
    grid.querySelectorAll('.cal-cell[data-date]').forEach(cell => {
        const date = cell.dataset.date;
        if (!date) return;
        cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('drag-over'); });
        cell.addEventListener('dragleave', () => cell.classList.remove('drag-over'));
        cell.addEventListener('drop', (e) => {
            e.preventDefault(); cell.classList.remove('drag-over');
            const id = e.dataTransfer.getData('text/plain');
            const t = findTask(id);
            if (t && t.date !== date) {
                t.date = date; t.updatedAt = new Date().toISOString();
                saveTodos(); renderMonthGrid();
                showNotification(`已改期到 ${date}`, 'success');
            }
        });
    });
}

// 周时间块参数
const WT = { hourh: 44, h0: 6, h1: 24 };
let wtDrag = null;

function renderWeekTimeline() {
    const cal = State.calendar;
    if (!cal.weekStart) cal.weekStart = mondayISO(localISO(new Date()));
    const start = cal.weekStart;
    const days = []; for (let i = 0; i < 7; i++) days.push(isoAddDays(start, i));
    const today = localISO(new Date());
    $('cal-title').textContent = `${fmtMD(days[0])} – ${fmtMD(days[6])}`;

    const visible = getVisibleTodos();
    const byDate = {};
    visible.forEach(t => { if (t.date && t.date >= days[0] && t.date <= days[6]) (byDate[t.date] = byDate[t.date] || []).push(t); });

    const WD = ['一', '二', '三', '四', '五', '六', '日'];
    const H0 = WT.h0, H1 = WT.h1, HH = WT.hourh, slots = H1 - H0;

    let gutter = '';
    for (let h = H0; h <= H1; h++) gutter += `<div class="wt-hour" style="top:${(h - H0) * HH}px">${String(h).padStart(2, '0')}:00</div>`;

    const head = `<div class="wt-head"><div class="wt-gutter-spacer"></div>${days.map((d, i) =>
        `<div class="wt-daylabel ${d === today ? 'today' : ''}"><span>周${WD[i]}</span><b>${dayNum(d)}</b></div>`).join('')}</div>`;

    const allrow = `<div class="wt-allrow"><div class="wt-alllabel">全天</div>${days.map(d => {
        const al = (byDate[d] || []).filter(t => !t.dueTime);
        return `<div class="wt-allday" data-date="${d}">${al.map(t =>
            `<div class="wt-chip pr-${t.priority} ${t.status === 'completed' ? 'completed' : ''}" data-task-id="${t.id}" title="${escapeHtml(t.content)}">${escapeHtml(t.content)}</div>`).join('')}</div>`;
    }).join('')}</div>`;

    const cols = days.map(d => {
        const timed = (byDate[d] || []).filter(t => t.dueTime);
        return `<div class="wt-col" data-date="${d}">${timed.map(t => {
            const [hh, mm] = (t.dueTime || '0:0').split(':').map(Number);
            const minutes = hh * 60 + (mm || 0);
            const top = Math.max(0, ((minutes - H0 * 60) / 60) * HH);
            return `<div class="wt-block pr-${t.priority} ${t.status === 'completed' ? 'completed' : ''}" data-task-id="${t.id}" style="top:${top}px" title="${escapeHtml(t.content)}"><span class="wt-block-time">${t.dueTime}</span><span class="wt-block-txt">${escapeHtml(t.content)}</span></div>`;
        }).join('')}</div>`;
    }).join('');

    let nowLine = '';
    if (days.includes(today)) {
        const now = new Date(); const mins = now.getHours() * 60 + now.getMinutes();
        if (mins >= H0 * 60 && mins <= H1 * 60) nowLine = `<div class="wt-nowline" style="top:${((mins - H0 * 60) / 60) * HH}px"></div>`;
    }

    $('week-timeline').innerHTML = `${head}${allrow}<div class="wt-scroll"><div class="wt-body" style="height:${slots * HH}px"><div class="wt-gutter">${gutter}</div><div class="wt-cols">${cols}${nowLine}</div></div></div>`;
    bindWeekDnD();
}

function wtCompute(x, y) {
    const wrap = $('week-timeline'); if (!wrap) return null;
    const colsEl = wrap.querySelector('.wt-cols'); if (!colsEl) return null;
    const r = colsEl.getBoundingClientRect();
    let idx = Math.floor((x - r.left) / (r.width / 7));
    idx = Math.max(0, Math.min(6, idx));
    let minutes = WT.h0 * 60 + ((y - r.top) / WT.hourh) * 60;
    minutes = Math.round(minutes / 30) * 30;
    minutes = Math.max(WT.h0 * 60, Math.min(WT.h1 * 60 - 30, minutes));
    const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const top = ((minutes - WT.h0 * 60) / 60) * WT.hourh;
    const col = wrap.querySelectorAll('.wt-col')[idx];
    return { idx, time, top, col, date: col ? col.dataset.date : null };
}

function wtClearIndicators() {
    const wrap = $('week-timeline'); if (!wrap) return;
    wrap.querySelectorAll('.wt-dropline').forEach(e => e.remove());
    wrap.querySelectorAll('.wt-col').forEach(c => c.classList.remove('drop-target'));
}

function wtOnMove(e) {
    if (!wtDrag) return;
    if (Math.abs(e.clientX - wtDrag.startX) + Math.abs(e.clientY - wtDrag.startY) > 4) wtDrag.moved = true;
    const tgt = wtCompute(e.clientX, e.clientY);
    if (!tgt) return;
    wtClearIndicators();
    tgt.col.classList.add('drop-target');
    const line = document.createElement('div');
    line.className = 'wt-dropline';
    line.style.top = tgt.top + 'px';
    line.innerHTML = `<span>${tgt.time}</span>`;
    tgt.col.appendChild(line);
    wtDrag.last = tgt;
}

function wtOnUp() {
    const d = wtDrag;
    wtClearIndicators();
    if (d && d.el) d.el.classList.remove('dragging');
    wtDrag = null;
    if (!d) return;
    const t = findTask(d.id); if (!t) return;
    if (d.moved && d.last && d.last.date) {
        t.date = d.last.date; t.dueTime = d.last.time; t.updatedAt = new Date().toISOString();
        saveTodos(); renderWeekTimeline();
        showNotification(`已改到 ${t.date} ${t.dueTime}`, 'success');
    } else {
        openTaskModal(t);
    }
}

function bindWeekDnD() {
    const wrap = $('week-timeline'); if (!wrap) return;
    wrap.querySelectorAll('[data-task-id]').forEach(el => {
        el.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            wtDrag = { id: el.dataset.taskId, el, moved: false, last: null, startX: e.clientX, startY: e.clientY };
            el.classList.add('dragging');
        });
        el.addEventListener('dblclick', () => { const t = findTask(el.dataset.taskId); if (t) openTaskModal(t); });
    });
}

// ---------------------------------------------------------------------------
// 统计 / 图表
// ---------------------------------------------------------------------------
function renderDashboard() {
    $('dashboard-wrap').classList.toggle('hidden', !State.settings.showDashboard);
    $('task-view-wrap').classList.toggle('hidden', State.settings.showDashboard);
    const st = $('stats-toggle'); if (st) st.classList.toggle('active', State.settings.showDashboard);
    if (!State.settings.showDashboard) return;

    const scope = State.todos.filter(t => State.settings.currentListId === 'all' || t.listId === State.settings.currentListId);
    const active = scope.filter(t => !t.archived);
    const total = active.length;
    const completed = active.filter(t => t.status === 'completed').length;
    const pending = active.filter(t => t.status === 'pending').length;
    const inProgressTasks = active.filter(t => t.status === 'in-progress');
    const inProgress = inProgressTasks.length;
    const avgProgress = inProgress ? Math.round(inProgressTasks.reduce((s, t) => s + taskProgress(t), 0) / inProgress) : 0;
    const overdue = active.filter(t => isOverdue(t)).length;
    const rate = total ? Math.round(completed / total * 100) : 0;

    const today = todayISO();
    const todayTodo = active.filter(t => t.date === today && t.status !== 'completed').length;
    const todayDone = scope.filter(t => t.completedAt && tsDay(t.completedAt) === today).length;

    const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const weekStartStr = localISO(weekStart);
    const weekDone = scope.filter(t => t.completedAt && tsDay(t.completedAt) >= weekStartStr).length;

    $('dashboard').innerHTML = `
        ${metric('list', '总任务', total, 'primary')}
        ${metric('circle-check', '完成率', rate + '%', 'success', `${completed} / ${total}`)}
        ${metric('clock', '待办', pending, 'warning')}
        ${metric('activity', '在办', inProgress, 'info', inProgress ? `平均完成度 ${avgProgress}%` : '')}
        ${metric('warning', '逾期', overdue, 'danger')}
        ${metric('sun', '今日待办', todayTodo, 'primary', `今日完成 ${todayDone}`)}
        ${metric('calendar-week', '本周完成', weekDone, 'success')}
    `;

    renderPie(active);
    renderLine(scope);
    renderBar(scope);
    renderTags(active);
    renderEfficiency(scope);
}

function metric(icon, label, value, accent, sub) {
    return `<div class="metric accent-${accent}">
        <div class="metric-label">${I(icon)} ${label}</div>
        <div class="metric-value">${value}</div>
        ${sub ? `<div class="metric-sub">${sub}</div>` : ''}
    </div>`;
}

function renderPie(active) {
    const data = [
        { label: '高', value: active.filter(t => t.priority === 'high').length, color: 'var(--high)' },
        { label: '中', value: active.filter(t => t.priority === 'medium').length, color: 'var(--medium)' },
        { label: '低', value: active.filter(t => t.priority === 'low').length, color: 'var(--low)' }
    ];
    const total = data.reduce((s, d) => s + d.value, 0) || 1;
    let acc = 0;
    const gradient = data.map(d => {
        const start = acc / total * 360; acc += d.value; const end = acc / total * 360;
        return `${d.color} ${start}deg ${end}deg`;
    }).join(', ');
    $('pie-chart').innerHTML = `
        <div style="width:150px;height:150px;border-radius:50%;background:conic-gradient(${gradient});position:relative;display:flex;align-items:center;justify-content:center;">
            <div style="width:90px;height:90px;border-radius:50%;background:var(--surface);"></div>
            <span style="position:absolute;font-size:1.5rem;font-weight:700;color:var(--text);">${total}</span>
        </div>
        <div class="pie-legend">
            ${data.map(d => `<div class="lg"><span class="sw" style="background:${d.color};border-radius:4px;"></span>${d.label}优先级：${d.value}（${Math.round(d.value / total * 100)}%）</div>`).join('')}
        </div>`;
}

function renderLine(scope) {
    const days = [];
    for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(localISO(d)); }
    const counts = days.map(ds => scope.filter(t => t.completedAt && tsDay(t.completedAt) === ds).length);
    const max = Math.max(1, ...counts);
    const W = 320, H = 160, pad = 24;
    const stepX = (W - pad * 2) / 6;
    const pts = counts.map((c, i) => [pad + i * stepX, H - pad - (c / max) * (H - pad * 2)]);
    const poly = pts.map(p => p.join(',')).join(' ');
    const area = `${pad},${H - pad} ${poly} ${W - pad},${H - pad}`;
    $('line-chart').innerHTML = `
        <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
            <defs>
                <linearGradient id="lineGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="var(--primary)" stop-opacity="0.20"/>
                    <stop offset="100%" stop-color="var(--primary)" stop-opacity="0.02"/>
                </linearGradient>
            </defs>
            <polyline points="${area}" fill="url(#lineGrad)" stroke="none"/>
            <polyline points="${poly}" fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            ${pts.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="var(--primary)"/><circle cx="${p[0]}" cy="${p[1]}" r="7" fill="var(--primary)" opacity="0.15"/><text x="${p[0]}" y="${p[1] - 10}" font-size="10" font-weight="600" fill="var(--text-2)" text-anchor="middle">${counts[i]}</text>`).join('')}
            ${days.map((d, i) => `<text x="${pad + i * stepX}" y="${H - 6}" font-size="9" fill="var(--text-3)" text-anchor="middle">${d.slice(5)}</text>`).join('')}
        </svg>`;
}

function renderBar(scope) {
    // 本周（周一~周日）每日完成数柱状图
    const days = [];
    const ws = new Date(); ws.setDate(ws.getDate() - ((ws.getDay() + 6) % 7)); // 本周一
    for (let i = 0; i < 7; i++) { const d = new Date(ws); d.setDate(ws.getDate() + i); days.push(localISO(d)); }
    const counts = days.map(ds => scope.filter(t => t.completedAt && tsDay(t.completedAt) === ds).length);
    const labels = ['一', '二', '三', '四', '五', '六', '日'];
    const max = Math.max(1, ...counts);
    const W = 320, H = 170, padB = 22, padT = 14;
    const stepX = W / 7;
    const bw = stepX * 0.5;
    let bars = '';
    counts.forEach((c, i) => {
        const h = (c / max) * (H - padB - padT);
        const x = i * stepX + (stepX - bw) / 2;
        const y = H - padB - h;
        const isToday = days[i] === todayISO();
        const barColor = isToday ? 'var(--primary)' : 'var(--primary-soft-2)';
        bars += `<rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="6" fill="${barColor}"/>
            <text x="${x + bw / 2}" y="${y - 5}" font-size="10" font-weight="600" fill="${isToday ? 'var(--primary)' : 'var(--text-2)'}" text-anchor="middle">${c}</text>
            <text x="${x + bw / 2}" y="${H - 6}" font-size="9" font-weight="500" fill="${isToday ? 'var(--primary)' : 'var(--text-3)'}" text-anchor="middle">${labels[i]}</text>`;
    });
    $('bar-chart').innerHTML = `<svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${bars}<line x1="0" y1="${H - padB}" x2="${W}" y2="${H - padB}" stroke="var(--border)" stroke-width="1"/></svg>`;
}

function renderTags(active) {
    const map = {};
    active.forEach(t => (t.tags || []).forEach(tag => { map[tag] = (map[tag] || 0) + 1; }));
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const box = $('tag-chart');
    if (!entries.length) { box.innerHTML = '<p style="font-size:0.82rem;color:var(--text-3);">暂无标签数据</p>'; return; }
    const max = entries[0][1];
    const palette = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', '#F5A623', '#9B8AF5', '#B0B0BF'];
    box.innerHTML = entries.map(([tag, n], i) => `
        <div class="tag-bar-row">
            <span class="tag-bar-name" title="${escapeHtml(tag)}">#${escapeHtml(tag)}</span>
            <div class="tag-bar-track"><div class="tag-bar-fill" style="width:${Math.max(8, n / max * 100)}%;background:${palette[i % palette.length]}"></div></div>
            <span class="tag-bar-num">${n}</span>
        </div>`).join('');
}

function renderEfficiency(scope) {
    const done = scope.filter(t => t.status === 'completed' && t.startedAt && t.completedAt);
    if (!done.length) { $('efficiency-body').innerHTML = '暂无足够数据进行效率分析（需要有开始并完成的任务）。'; return; }
    const durs = done.map(t => new Date(t.completedAt) - new Date(t.startedAt));
    const avg = durs.reduce((s, d) => s + d, 0) / durs.length;
    const fmtDur = (ms) => { const h = ms / 3600000; if (h < 1) return Math.round(ms / 60000) + ' 分钟'; if (h < 24) return h.toFixed(1) + ' 小时'; return (h / 24).toFixed(1) + ' 天'; };

    const byPr = ['high', 'medium', 'low'].map(pr => {
        const list = done.filter(t => t.priority === pr);
        if (!list.length) return `${PRIORITY[pr]}优先级：暂无`;
        const a = list.reduce((s, t) => s + (new Date(t.completedAt) - new Date(t.startedAt)), 0) / list.length;
        return `${PRIORITY[pr]}优先级：平均 ${fmtDur(a)}（${list.length} 项）`;
    });

    $('efficiency-body').innerHTML = `
        <div style="margin-bottom:6px;">已完成任务平均耗时：<b style="color:var(--primary)">${fmtDur(avg)}</b>（共 ${done.length} 项）</div>
        <div style="display:flex;gap:20px;flex-wrap:wrap;">${byPr.map(x => `<span>${x}</span>`).join('')}</div>`;
}

// ---------------------------------------------------------------------------
// 标签 / 保存的筛选
// ---------------------------------------------------------------------------
function allTags() {
    const set = new Set();
    State.todos.forEach(t => (t.tags || []).forEach(tag => set.add(tag)));
    return [...set];
}
function renderTagFilter() {
    const sel = $('filter-tag');
    const cur = sel.value;
    sel.innerHTML = '<option value="all">全部</option>' + allTags().map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    sel.value = [...sel.options].some(o => o.value === cur) ? cur : 'all';
}
function renderSavedFilters() {
    const bar = $('saved-filter-bar');
    if (!State.savedFilters.length) { bar.innerHTML = '<span style="font-size:0.8rem;color:var(--text-3)">暂无保存的筛选</span>'; return; }
    bar.innerHTML = State.savedFilters.map(f => `
        <span class="saved-filter-chip" data-id="${f.id}">${I('bookmark')}${escapeHtml(f.name)}<svg class="icon rm" data-rm="${f.id}"><use href="#i-times"/></svg></span>`).join('');
    bar.querySelectorAll('.saved-filter-chip').forEach(chip => chip.addEventListener('click', (e) => {
        if (e.target.dataset.rm) return;
        const f = State.savedFilters.find(x => x.id === chip.dataset.id);
        if (f) { Object.assign(State.filters, f.criteria); syncFilterUI(); renderCurrentView(); showNotification(`已应用筛选「${f.name}」`, 'info'); }
    }));
    bar.querySelectorAll('[data-rm]').forEach(el => el.addEventListener('click', (e) => {
        e.stopPropagation();
        State.savedFilters = State.savedFilters.filter(x => x.id !== el.dataset.rm);
        persist.filters(); renderSavedFilters();
    }));
}
function syncFilterUI() {
    $('filter-status').value = State.filters.status;
    $('filter-priority').value = State.filters.priority;
    $('filter-tag').value = State.filters.tag;
    $('filter-start').value = State.filters.start;
    $('filter-end').value = State.filters.end;
    $('filter-archived').checked = State.filters.archived;
    const hu = $('filter-hide-unstarted'); if (hu) hu.checked = !!State.filters.hideUnstarted;
    $('search-input').value = State.filters.search;
}

// ---------------------------------------------------------------------------
// 导入 / 导出
// ---------------------------------------------------------------------------
async function doExport(format) {
    const visible = getVisibleTodos();
    if (!visible.length) { showNotification('当前筛选无任务可导出', 'warning'); return; }
    const res = await window.electronAPI.exportTodos({ format, todos: visible });
    if (res.success) showNotification(`已导出 ${res.count} 条任务`, 'success');
    else if (res.error !== '导出已取消') showNotification('导出失败: ' + res.error, 'error');
}

async function doImport(format) {
    const dlg = await window.electronAPI.showOpenDialog({
        filters: [{ name: format.toUpperCase(), extensions: [format] }, { name: 'All', extensions: ['*'] }]
    });
    if (dlg.canceled || !dlg.filePaths.length) return;
    const res = await window.electronAPI.parseImport({ filePath: dlg.filePaths[0], format });
    if (!res.success) { showNotification('解析失败: ' + res.error, 'error'); return; }
    if (!res.todos.length) { showNotification('文件中未解析到任务', 'warning'); return; }

    State.importBuffer = res.todos;
    const existingIds = new Set(State.todos.map(t => t.id));
    const conflicts = res.todos.filter(t => existingIds.has(t.id)).length;
    $('import-count').textContent = res.todos.length;
    $('conflict-count').textContent = conflicts;
    $('import-preview-body').innerHTML = res.todos.slice(0, 50).map(t => `
        <tr><td>${escapeHtml(t.content)}</td><td>${t.date || ''}</td><td>${PRIORITY[t.priority] || ''}</td><td>${STATUS[t.status] || ''}</td><td>${(t.tags || []).join(', ')}</td></tr>`).join('');
    openModal('import-modal');
}

function confirmImport() {
    if (!State.importBuffer) return;
    const mode = document.querySelector('input[name="conflict"]:checked').value;
    const existing = new Map(State.todos.map(t => [t.id, t]));
    let added = 0, updated = 0, skipped = 0;
    const targetList = State.settings.currentListId === 'all' ? 'default' : State.settings.currentListId;

    State.importBuffer.forEach(t => {
        if (existing.has(t.id)) {
            if (mode === 'skip') { skipped++; return; }
            if (mode === 'overwrite') { Object.assign(existing.get(t.id), t); updated++; return; }
            if (mode === 'merge') { t.id = uid(); State.todos.push({ ...t }); added++; return; }
        } else {
            if (!t.listId || !State.lists.find(l => l.id === t.listId)) t.listId = targetList;
            State.todos.push(t); added++;
        }
    });
    saveTodos();
    State.importBuffer = null;
    closeModal('import-modal');
    renderAll();
    showNotification(`导入完成：新增 ${added}，更新 ${updated}，跳过 ${skipped}`, 'success');
}

// ---------------------------------------------------------------------------
// 备份
// ---------------------------------------------------------------------------
async function openBackup() {
    const backups = await window.electronAPI.listBackups();
    const box = $('backup-list');
    if (!backups.length) { box.innerHTML = '<p style="color:var(--text-3);font-size:0.85rem;">暂无备份</p>'; }
    else {
        box.innerHTML = backups.map(b => `
            <div class="backup-item">
                ${I('file-shield', 'style="color:var(--primary)"')}
                <span class="bi-name">${b.name.replace('todo-backup-', '').replace('.json', '')}</span>
                <span class="bi-size">${(b.size / 1024).toFixed(1)} KB</span>
                <button class="btn btn-sm btn-ghost" data-restore="${escapeHtml(b.path)}">恢复</button>
            </div>`).join('');
        box.querySelectorAll('[data-restore]').forEach(btn => btn.addEventListener('click', () => {
            confirmAction('恢复此备份将覆盖当前所有任务，确定吗？', async () => {
                const res = await window.electronAPI.restoreBackup(btn.dataset.restore);
                if (res.success) { await loadTodos(); migrateData(); renderAll(); showNotification('已从备份恢复', 'success'); }
                else showNotification('恢复失败: ' + res.error, 'error');
            });
        }));
    }
    openModal('backup-modal');
}

// ---------------------------------------------------------------------------
// 日报（daily report）
// ---------------------------------------------------------------------------
function openReportModal() {
    $('report-empty').classList.remove('hidden');
    $('report-editor').classList.add('hidden');
    State.editingReport = null;
    renderReportHistory();
    openModal('report-modal');
}

function renderReportHistory() {
    const box = $('report-history');
    if (!State.reports.length) {
        box.innerHTML = '<p style="font-size:0.82rem;color:var(--text-3);padding:6px 2px;">还没有日报，点击「写新日报」开始记录。</p>';
        return;
    }
    const sorted = [...State.reports].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    box.innerHTML = sorted.map(r => `
        <div class="report-item ${State.editingReport && State.editingReport.id === r.id ? 'active' : ''}" data-id="${r.id}">
            <span class="report-dot ${r.date === todayISO() ? 'today' : ''}"></span>
            <div class="report-item-main">
                <div class="report-item-title">${escapeHtml(r.title || (r.date + ' 日报'))}</div>
                <div class="report-item-date">${r.date || ''}</div>
            </div>
        </div>`).join('');
    box.querySelectorAll('.report-item').forEach(el => el.addEventListener('click', () => openReport(el.dataset.id)));
}

function openReport(id) {
    const r = State.reports.find(x => x.id === id);
    if (!r) return;
    State.editingReport = r;
    $('report-date').value = r.date || todayISO();
    $('report-title').value = r.title || '';
    $('report-content').value = r.content || '';
    $('report-empty').classList.add('hidden');
    $('report-editor').classList.remove('hidden');
    renderReportHistory();
}

async function newReport() {
    const today = todayISO();
    State.editingReport = null;
    $('report-date').value = today;
    $('report-title').value = `${today.replace(/-/g, '/')} 工作日报`;
    $('report-content').value = '';
    $('report-empty').classList.add('hidden');
    $('report-editor').classList.remove('hidden');
    renderReportHistory();
    await generateReportContent(today);
}

async function generateReportContent(date) {
    const res = await window.electronAPI.generateReport(date);
    if (!res.success) { showNotification('生成失败: ' + res.error, 'error'); return; }
    if (!$('report-title').value.trim()) $('report-title').value = `${date.replace(/-/g, '/')} 工作日报`;
    $('report-content').value = res.summary.defaultContent;
    showNotification('已根据当日任务生成日报草稿', 'success');
}

function saveReport() {
    const date = $('report-date').value || todayISO();
    const title = $('report-title').value.trim() || `${date.replace(/-/g, '/')} 工作日报`;
    const content = $('report-content').value;
    if (!content.trim()) { showNotification('日报内容不能为空', 'warning'); return; }
    const now = new Date().toISOString();
    if (State.editingReport && State.editingReport.id) {
        const r = State.reports.find(x => x.id === State.editingReport.id);
        if (r) { r.date = date; r.title = title; r.content = content; r.updatedAt = now; }
    } else {
        const rep = { id: uid(), date, title, content, createdAt: now, updatedAt: now };
        State.reports.unshift(rep);
        State.editingReport = rep;
    }
    persist.reports();
    renderReportHistory();
    showNotification('日报已保存', 'success');
}

function deleteReport() {
    if (!State.editingReport || !State.editingReport.id) { closeModal('report-modal'); return; }
    const id = State.editingReport.id;
    confirmAction('确定删除这篇日报吗？', () => {
        State.reports = State.reports.filter(x => x.id !== id);
        State.editingReport = null;
        persist.reports();
        renderReportHistory();
        $('report-editor').classList.add('hidden');
        $('report-empty').classList.remove('hidden');
        showNotification('日报已删除', 'success');
    });
}

function exportReport() {
    const date = $('report-date').value || todayISO();
    const title = $('report-title').value.trim() || '工作日报';
    const content = $('report-content').value;
    if (!content.trim()) { showNotification('日报内容为空', 'warning'); return; }
    window.electronAPI.exportReport({ format: 'md', report: { title, date, content } })
        .then(r => { if (r.success) showNotification('日报已导出', 'success'); else if (r.error !== '导出已取消') showNotification('导出失败: ' + r.error, 'error'); });
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------
function applySettingsToUI() {
    document.documentElement.setAttribute('data-theme', State.settings.theme);
    $('set-theme').checked = State.settings.theme === 'dark';
    $('set-density').checked = State.settings.density === 'compact';
    $('set-show-time').checked = State.settings.showTime;
    $('set-show-note').checked = State.settings.showNote;
    $('set-auto-promote').checked = State.settings.autoPromote;
    $('set-auto-archive').checked = State.settings.autoArchive;
    $('set-remind').checked = State.settings.remind;
    $('set-daily').checked = State.settings.dailyReminder;
    $('set-daily-time').value = State.settings.dailyTime;
    $('set-encrypt').checked = !!State.settings.encrypt;
    $('sort-primary').value = State.sort.by;
    $('sort-dir').value = State.sort.dir;
}

// ---------------------------------------------------------------------------
// 通用模态框 / 确认 / 口令
// ---------------------------------------------------------------------------
function openModal(id) { $(id).classList.add('show'); }
function closeModal(id) { $(id).classList.remove('show'); }

function confirmAction(text, cb) {
    $('confirm-text').textContent = text;
    State.confirmCallback = cb;
    openModal('confirm-modal');
}

function promptPass(title, hint, cb) {
    $('pass-title').textContent = title;
    $('pass-hint').textContent = hint || '';
    $('pass-input').value = '';
    State.passCallback = cb;
    openModal('pass-modal');
    setTimeout(() => $('pass-input').focus(), 100);
}

function promptUnlock() {
    return new Promise((resolve) => {
        const tryUnlock = () => {
            promptPass('数据已加密，请解锁', '输入你的加密口令', async (pass) => {
                const res = await window.electronAPI.cryptoUnlock(pass);
                if (res.success) { closeModal('pass-modal'); resolve(); }
                else { showNotification('口令错误', 'error'); tryUnlock(); }
            });
        };
        tryUnlock();
    });
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 视图 / 清单 / 主题 / 日历导航 助手（供命令面板复用）
// ---------------------------------------------------------------------------
function setView(view) {
    State.settings.currentView = view;
    State.settings.showDashboard = false;
    persist.settings(); renderDashboard(); renderCurrentView();
}
function selectList(id) {
    State.settings.currentListId = id;
    State.filters.start = ''; State.filters.end = '';
    State.selected.clear();
    persist.settings(); renderAll(); closeSidebarMobile();
}
function toggleTheme() {
    State.settings.theme = State.settings.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', State.settings.theme);
    const cb = $('set-theme'); if (cb) cb.checked = State.settings.theme === 'dark';
    persist.settings(); renderDashboard();
}
function calNavigate(dir) {
    const cal = State.calendar;
    if (cal.mode === 'week') {
        cal.weekStart = isoAddDays(cal.weekStart || mondayISO(localISO(new Date())), dir * 7);
        const d = new Date(cal.weekStart + 'T00:00:00');
        cal.year = d.getFullYear(); cal.month = d.getMonth();
    } else {
        cal.month += dir;
        if (cal.month < 0) { cal.month = 11; cal.year--; }
        if (cal.month > 11) { cal.month = 0; cal.year++; }
    }
    renderCalendar();
}
function calToday() {
    const n = new Date();
    State.calendar.year = n.getFullYear();
    State.calendar.month = n.getMonth();
    State.calendar.weekStart = mondayISO(localISO(n));
    renderCalendar();
}

// 一键自动排程：把当前周内「有日期但无时间」的任务按优先级填入 9:00–19:00 空闲小时档
function autoSchedule() {
    const cal = State.calendar;
    if (cal.mode !== 'week') { cal.mode = 'week'; }
    const start = cal.weekStart || mondayISO(localISO(new Date()));
    const days = []; for (let i = 0; i < 7; i++) days.push(isoAddDays(start, i));
    const H0 = 9, H1 = 19; // 工作时段 9:00 - 19:00
    const visible = getVisibleTodos();
    let scheduled = 0;
    days.forEach(day => {
        const dayTasks = visible.filter(t => t.date === day && !t.archived);
        const occupied = new Set();
        dayTasks.forEach(t => { if (t.dueTime) { const h = parseInt(t.dueTime.split(':')[0], 10) || 0; occupied.add(h * 60); } });
        const unscheduled = dayTasks
            .filter(t => !t.dueTime && t.status !== 'completed' && (!t.startDate || t.startDate <= day))
            .sort((a, b) => (PR_ORDER[b.priority] || 0) - (PR_ORDER[a.priority] || 0) || (a.order || 0) - (b.order || 0));
        let cursorMin = H0 * 60;
        unscheduled.forEach(t => {
            while (cursorMin + 60 <= H1 * 60 && occupied.has(cursorMin)) cursorMin += 60;
            if (cursorMin + 60 <= H1 * 60) {
                t.dueTime = `${String(Math.floor(cursorMin / 60)).padStart(2, '0')}:00`;
                t.updatedAt = new Date().toISOString();
                occupied.add(cursorMin);
                cursorMin += 60;
                scheduled++;
            }
        });
    });
    if (scheduled) { saveTodos(); renderCalendar(); showNotification(`已自动排程 ${scheduled} 个任务`, 'success'); }
    else showNotification('本周没有可自动排程的未定时任务', 'info');
}

// ---------------------------------------------------------------------------
// 命令面板 / 快捷录入（Things 3 / Raycast 风格）
// ---------------------------------------------------------------------------
function weekdayNum(ch) { return ({ '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 })[ch]; }

// 中文自然语言 → 任务草稿
function parseQuickTask(text) {
    const raw = (text || '').trim();
    let content = raw;
    let date = localISO(new Date());
    let dueTime = '';
    let priority = 'medium';
    const tags = [];
    const now = new Date();

    // 标签 #xxx
    content = content.replace(/#([^\s#]+)/g, (m, tg) => { tags.push(tg); return ' '; });
    // 优先级
    if (/紧急|重要|!!|!高/.test(content)) { priority = 'high'; content = content.replace(/紧急|重要|!!|!高/g, ' '); }
    else if (/不急|低优先|!低/.test(content)) { priority = 'low'; content = content.replace(/不急|低优先|!低/g, ' '); }

    // 日期（顺序很重要：大后天 → 后天 → 明天 → 今天）
    if (/大后天/.test(content)) { date = localISO(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3)); content = content.replace(/大后天/g, ' '); }
    else if (/后天/.test(content)) { date = localISO(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2)); content = content.replace(/后天/g, ' '); }
    else if (/明天|明日/.test(content)) { date = localISO(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)); content = content.replace(/明天|明日/g, ' '); }
    else if (/今天|今日/.test(content)) { date = localISO(now); content = content.replace(/今天|今日/g, ' '); }
    else {
        const mw = content.match(/(下)?\s*(?:周|星期)([一二三四五六日天])/);
        const mMD = content.match(/(\d{1,2})月(\d{1,2})[日号]?/);
        if (mw) {
            const target = weekdayNum(mw[2]);
            const cur = now.getDay();
            let ahead = (target - cur + 7) % 7;
            if (mw[1]) ahead += 7;              // 下周
            if (ahead === 0 && !mw[1]) ahead = 7; // 「周X」指即将到来的那天
            date = localISO(new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead));
            content = content.replace(mw[0], ' ');
        } else if (mMD) {
            date = localISO(new Date(now.getFullYear(), mMD[1] - 1, mMD[2]));
            content = content.replace(mMD[0], ' ');
        }
    }

    // 时间
    const mt = content.match(/(上午|下午|晚上|中午|凌晨)?\s*(\d{1,2})[:：点时](\d{1,2})?分?/);
    if (mt) {
        let h = parseInt(mt[2], 10); const mi = mt[3] ? parseInt(mt[3], 10) : 0;
        const per = mt[1];
        if ((per === '下午' || per === '晚上') && h < 12) h += 12;
        if (per === '中午' && h < 12) h += 12;
        if (per === '凌晨' && h === 12) h = 0;
        if (h >= 0 && h < 24 && mi >= 0 && mi < 60) {
            dueTime = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
            content = content.replace(mt[0], ' ');
        }
    }

    content = content.replace(/\s+/g, ' ').trim();
    return { content: content || raw, date, dueTime, priority, tags, listId: (State.settings.currentListId === 'all' ? 'default' : State.settings.currentListId) };
}

function createTaskFromQuick(p) {
    if (!p || !p.content) return;
    const now = new Date().toISOString();
    const maxOrder = Math.max(0, ...State.todos.map(t => t.order || 0));
    State.todos.unshift({
        id: uid(), content: p.content, note: '', priority: p.priority || 'medium',
        listId: p.listId || 'default', date: p.date || localISO(new Date()), dueTime: p.dueTime || '',
        tags: p.tags || [], subtasks: [], repeat: { type: 'none', interval: 1 },
        progress: 0,
        status: 'pending', pinned: false, archived: false, order: maxOrder + 1,
        createdAt: now, startedAt: null, completedAt: null, updatedAt: now
    });
    saveTodos(); renderAll();
    showNotification('已添加任务', 'success');
}

function getCommands() {
    const cmds = [
        { label: '新建任务', hint: '打开任务编辑框', icon: 'plus', run: () => { closeCommandBar(); openTaskModal(null); } },
        { label: '切换到 列表视图', icon: 'list', run: () => { closeCommandBar(); setView('list'); } },
        { label: '切换到 看板视图', icon: 'kanban', run: () => { closeCommandBar(); setView('kanban'); } },
        { label: '切换到 日历 / 时间块', icon: 'calendar', run: () => { closeCommandBar(); setView('calendar'); } },
        { label: (State.settings.showDashboard ? '关闭' : '打开') + ' 统计面板', icon: 'pie', run: () => { closeCommandBar(); State.settings.showDashboard = !State.settings.showDashboard; persist.settings(); renderDashboard(); } },
        { label: '打开 工作日报', icon: 'file-text', run: () => { closeCommandBar(); openReportModal(); } },
        { label: '备份与恢复', icon: 'database', run: () => { closeCommandBar(); openBackup(); } },
        { label: '打开 设置', icon: 'gear', run: () => { closeCommandBar(); openModal('settings-modal'); } },
        { label: '切换 深色 / 浅色 主题', icon: 'sun', run: () => { closeCommandBar(); toggleTheme(); } },
        { label: '跳到 今天', icon: 'calendar-week', run: () => { closeCommandBar(); if (State.settings.currentView !== 'calendar') setView('calendar'); calToday(); } },
        { label: '一键自动排程（本周）', hint: '把未定时任务填进空闲时段', icon: 'refresh', run: () => { closeCommandBar(); if (State.settings.currentView !== 'calendar') setView('calendar'); autoSchedule(); } }
    ];
    State.lists.forEach(l => cmds.push({ label: '清单：' + l.name, icon: 'folder', run: () => { closeCommandBar(); selectList(l.id); } }));
    return cmds;
}

function openCommandBar(mode = 'command') {
    State.cmdk.mode = mode;
    State.cmdk.index = 0;
    const el = $('cmdk');
    el.classList.add('show');
    const inp = $('cmdk-input');
    inp.value = '';
    inp.placeholder = mode === 'quick'
        ? '快速录入任务… 如「明天 15:00 交报告 #工作」'
        : '搜索命令，或直接输入以创建任务…';
    renderCommandBar('');
    setTimeout(() => inp.focus(), 30);
}
function closeCommandBar() { $('cmdk').classList.remove('show'); }

function renderCommandBar(q) {
    q = (q || '').trim();
    const ql = q.toLowerCase();
    const items = [];
    if (q) items.push({ kind: 'create', payload: parseQuickTask(q) });
    getCommands().filter(c => !ql || c.label.toLowerCase().includes(ql)).forEach(c => items.push({ kind: 'cmd', ...c }));
    if (q) {
        State.todos
            .filter(t => !t.archived && t.content.toLowerCase().includes(ql))
            .slice(0, 6)
            .forEach(t => items.push({ kind: 'task', task: t }));
    }
    State.cmdk.items = items;
    if (State.cmdk.index >= items.length) State.cmdk.index = 0;
    renderCommandList();
}

function renderCommandList() {
    const box = $('cmdk-list');
    const items = State.cmdk.items;
    if (!items.length) { box.innerHTML = `<div class="cmdk-empty">没有匹配项，直接输入文字即可创建任务</div>`; return; }
    box.innerHTML = items.map((it, i) => {
        let inner = '';
        if (it.kind === 'create') {
            const p = it.payload;
            const meta = [p.date, p.dueTime, p.priority === 'high' ? '高优先' : (p.priority === 'low' ? '低优先' : ''), (p.tags || []).map(x => '#' + x).join(' ')].filter(Boolean).join(' · ');
            inner = `<span class="cmdk-ic">${I('plus')}</span><span class="cmdk-main"><span class="cmdk-label">创建任务：${escapeHtml(p.content)}</span>${meta ? `<span class="cmdk-sub">${escapeHtml(meta)}</span>` : ''}</span><span class="cmdk-badge">新建</span>`;
        } else if (it.kind === 'cmd') {
            inner = `<span class="cmdk-ic">${I(it.icon || 'chevron-right')}</span><span class="cmdk-main"><span class="cmdk-label">${escapeHtml(it.label)}</span>${it.hint ? `<span class="cmdk-sub">${escapeHtml(it.hint)}</span>` : ''}</span>`;
        } else {
            const t = it.task;
            const meta = [t.date, t.dueTime, STATUS[t.status] + (t.status === 'in-progress' ? ` ${taskProgress(t)}%` : '')].filter(Boolean).join(' · ');
            inner = `<span class="cmdk-ic">${I('circle')}</span><span class="cmdk-main"><span class="cmdk-label">${escapeHtml(t.content)}</span><span class="cmdk-sub">${escapeHtml(meta)}</span></span>`;
        }
        return `<div class="cmdk-item ${i === State.cmdk.index ? 'active' : ''}" data-index="${i}">${inner}</div>`;
    }).join('');
    box.querySelectorAll('.cmdk-item').forEach(el => {
        el.addEventListener('mousemove', () => { State.cmdk.index = +el.dataset.index; highlightCmdk(); });
        el.addEventListener('click', () => execCmdkItem(+el.dataset.index));
    });
}

function highlightCmdk() { $('cmdk-list').querySelectorAll('.cmdk-item').forEach(el => el.classList.toggle('active', +el.dataset.index === State.cmdk.index)); }
function scrollCmdkIntoView() { const el = $('cmdk-list').querySelector('.cmdk-item.active'); if (el) el.scrollIntoView({ block: 'nearest' }); }

function execCmdkItem(i) {
    const it = State.cmdk.items[i];
    if (!it) return;
    if (it.kind === 'create') {
        createTaskFromQuick(it.payload);
        const inp = $('cmdk-input');
        inp.value = '';
        State.cmdk.index = 0;
        renderCommandBar('');
        inp.focus();
        return;
    }
    if (it.kind === 'cmd') { it.run(); return; }
    if (it.kind === 'task') { closeCommandBar(); openTaskModal(it.task); }
}

function syncListSwatches() {
    const box = $('list-swatches');
    if (!box) return;
    const v = $('list-color').value;
    box.querySelectorAll('.color-swatch').forEach(x => x.classList.toggle('active', x.dataset.color === v));
}

function bindEvents() {
    // 新建任务
    $('new-task-btn').addEventListener('click', () => openTaskModal(null));
    $('empty-add-btn').addEventListener('click', () => openTaskModal(null));
    $('save-task').addEventListener('click', saveTaskFromModal);

    // 任务模态框内交互
    $('f-content').addEventListener('input', debounce((e) => { showSuggestions(e.target.value); }, 150));
    $('f-content').addEventListener('blur', () => { smartParse(); setTimeout(() => $('content-suggest').classList.remove('show'), 150); });
    $('f-repeat').addEventListener('change', (e) => $('f-repeat-interval').classList.toggle('hidden', e.target.value !== 'custom'));
    $('add-subtask').addEventListener('click', () => { State.editingSubtasks.push({ id: uid(), text: '', done: false }); renderSubtaskEditor(); });

    // 完成度：range 与数字框联动，预设按钮直接落值
    $('f-progress').addEventListener('input', (e) => setModalProgress(e.target.value));
    $('f-progress-num').addEventListener('input', (e) => {
        if (e.target.value === '') return;
        const p = clampProgress(e.target.value);
        $('f-progress').value = p;
        $('f-progress-val').textContent = p + '%';
    });
    $('f-progress-num').addEventListener('blur', (e) => setModalProgress(e.target.value));
    document.querySelectorAll('[data-progress-preset]').forEach(btn => {
        btn.addEventListener('click', () => setModalProgress(btn.dataset.progressPreset));
    });

    // 搜索（防抖）
    $('search-input').addEventListener('input', debounce((e) => { State.filters.search = e.target.value.trim(); renderCurrentView(); }, 250));

    // 排序
    $('sort-primary').addEventListener('change', (e) => { State.sort.by = e.target.value; persistSort(); renderCurrentView(); });
    $('sort-dir').addEventListener('change', (e) => { State.sort.dir = e.target.value; persistSort(); renderCurrentView(); });

    // 筛选面板
    $('toggle-filter').addEventListener('click', () => $('filter-panel').classList.toggle('hidden'));
    ['filter-status', 'filter-priority', 'filter-tag', 'filter-start', 'filter-end'].forEach(id => {
        $(id).addEventListener('change', () => {
            State.filters.status = $('filter-status').value;
            State.filters.priority = $('filter-priority').value;
            State.filters.tag = $('filter-tag').value;
            State.filters.start = $('filter-start').value;
            State.filters.end = $('filter-end').value;
            renderCurrentView();
        });
    });
    $('filter-archived').addEventListener('change', (e) => { State.filters.archived = e.target.checked; renderCurrentView(); });
    $('filter-hide-unstarted').addEventListener('change', (e) => { State.filters.hideUnstarted = e.target.checked; renderCurrentView(); });
    $('clear-filters').addEventListener('click', () => {
        State.filters = { search: '', status: 'all', priority: 'all', tag: 'all', start: '', end: '', archived: false, hideUnstarted: false };
        syncFilterUI(); renderCurrentView(); showNotification('筛选已清除', 'info');
    });
    $('save-filter').addEventListener('click', () => {
        const row = $('save-filter-row');
        row.classList.remove('hidden');
        $('save-filter-name').value = '';
        setTimeout(() => $('save-filter-name').focus(), 30);
    });
    const cancelSaveFilter = () => {
        $('save-filter-row').classList.add('hidden');
        $('save-filter-name').value = '';
    };
    const commitSaveFilter = () => {
        const name = $('save-filter-name').value.trim();
        if (!name) { showNotification('请输入筛选名称', 'warning'); $('save-filter-name').focus(); return; }
        const exist = State.savedFilters.find(f => f.name === name);
        if (exist) exist.criteria = { ...State.filters };
        else State.savedFilters.push({ id: uid(), name, criteria: { ...State.filters } });
        persist.filters(); renderSavedFilters(); cancelSaveFilter();
        showNotification(exist ? `已更新筛选「${name}」` : `已保存筛选「${name}」`, 'success');
    };
    $('save-filter-confirm').addEventListener('click', commitSaveFilter);
    $('save-filter-cancel').addEventListener('click', cancelSaveFilter);
    $('save-filter-name').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitSaveFilter(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelSaveFilter(); }
    });

    // 多选 / 批量
    $('select-mode-btn').addEventListener('click', () => toggleSelectMode());
    $('bulk-cancel').addEventListener('click', () => toggleSelectMode(false));
    $('bulk-select-all').addEventListener('click', () => { getVisibleTodos().forEach(t => State.selected.add(t.id)); updateBulkBar(); renderCurrentView(); });
    $('bulk-status').addEventListener('change', (e) => {
        const v = e.target.value; if (!v) return;
        bulkApply(t => {
            t.status = v; t.updatedAt = new Date().toISOString();
            if (v === 'completed') {
                t.completedAt = new Date().toISOString(); t.progress = 100;
                if (!t.startedAt) t.startedAt = t.completedAt;
                spawnRecurring(t);
            } else if (v === 'pending') { t.completedAt = null; t.progress = 0; }
        }, '批量修改状态完成');
        e.target.value = '';
    });
    $('bulk-priority').addEventListener('change', (e) => { const v = e.target.value; if (!v) return; bulkApply(t => { t.priority = v; t.updatedAt = new Date().toISOString(); }, '批量修改优先级完成'); e.target.value = ''; });
    $('bulk-archive').addEventListener('click', () => bulkApply(t => t.archived = true, '批量归档完成'));
    $('bulk-delete').addEventListener('click', () => {
        if (!State.selected.size) { showNotification('请先选择任务', 'warning'); return; }
        confirmAction(`确定删除选中的 ${State.selected.size} 个任务吗？`, () => {
            State.todos = State.todos.filter(t => !State.selected.has(t.id));
            State.selected.clear(); saveTodos(); renderAll(); showNotification('批量删除完成', 'success');
        });
    });

    // 导入导出
    $('export-select').addEventListener('change', (e) => { if (e.target.value) { doExport(e.target.value); e.target.value = ''; } });
    $('import-select').addEventListener('change', (e) => { if (e.target.value) { doImport(e.target.value); e.target.value = ''; } });
    $('confirm-import').addEventListener('click', confirmImport);

    // 清单
    $('add-list-btn').addEventListener('click', () => {
        $('list-name').value = '';
        $('list-color').value = '#3DBE9C';
        syncListSwatches();
        openModal('list-modal');
    });
    const listSw = $('list-swatches');
    if (listSw) listSw.addEventListener('click', (e) => {
        const b = e.target.closest('.color-swatch');
        if (!b) return;
        $('list-color').value = b.dataset.color;
        syncListSwatches();
    });
    $('save-list').addEventListener('click', () => {
        const name = $('list-name').value.trim();
        if (!name) { showNotification('请输入清单名称', 'warning'); return; }
        State.lists.push({ id: uid(), name, color: $('list-color').value });
        persist.lists(); closeModal('list-modal'); renderAll(); showNotification('清单已创建', 'success');
    });

    // 日历：导航 + 月/周切换
    $('cal-prev').addEventListener('click', () => calNavigate(-1));
    $('cal-next').addEventListener('click', () => calNavigate(1));
    $('cal-today').addEventListener('click', calToday);
    $('cal-autoschedule').addEventListener('click', autoSchedule);
    document.querySelectorAll('#cal-mode-switch button').forEach(b => b.addEventListener('click', () => { State.calendar.mode = b.dataset.calmode; renderCalendar(); }));

    // 周时间块拖拽（文档级监听，仅绑定一次）
    document.addEventListener('pointermove', wtOnMove);
    document.addEventListener('pointerup', wtOnUp);

    // 命令面板 / 快捷录入
    const cmdInput = $('cmdk-input');
    cmdInput.addEventListener('input', () => { State.cmdk.index = 0; renderCommandBar(cmdInput.value); scrollCmdkIntoView(); });
    cmdInput.addEventListener('keydown', (e) => {
        const n = State.cmdk.items.length;
        if (e.key === 'ArrowDown') { e.preventDefault(); if (n) { State.cmdk.index = (State.cmdk.index + 1) % n; highlightCmdk(); scrollCmdkIntoView(); } }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) { State.cmdk.index = (State.cmdk.index - 1 + n) % n; highlightCmdk(); scrollCmdkIntoView(); } }
        else if (e.key === 'Enter') { e.preventDefault(); execCmdkItem(State.cmdk.index); }
        else if (e.key === 'Escape') { e.preventDefault(); closeCommandBar(); }
    });
    $('cmdk').addEventListener('mousedown', (e) => { if (e.target === $('cmdk')) closeCommandBar(); });

    // 侧栏底部
    $('stats-toggle').addEventListener('click', () => { State.settings.showDashboard = !State.settings.showDashboard; persist.settings(); renderDashboard(); });
    $('backup-btn').addEventListener('click', openBackup);
    $('settings-btn').addEventListener('click', () => openModal('settings-modal'));

    // 日报
    $('report-btn').addEventListener('click', openReportModal);
    $('gen-report-btn').addEventListener('click', () => { openReportModal(); newReport(); });
    $('new-report-btn').addEventListener('click', newReport);
    $('report-generate').addEventListener('click', () => generateReportContent($('report-date').value || todayISO()));
    $('report-save').addEventListener('click', saveReport);
    $('report-delete').addEventListener('click', deleteReport);
    $('report-export').addEventListener('click', exportReport);
    $('do-backup').addEventListener('click', async () => { const r = await window.electronAPI.backupNow(); if (r.success) { showNotification('备份完成', 'success'); openBackup(); } else showNotification('备份失败: ' + r.error, 'error'); });

    // 设置项
    $('set-theme').addEventListener('change', (e) => { State.settings.theme = e.target.checked ? 'dark' : 'light'; document.documentElement.setAttribute('data-theme', State.settings.theme); persist.settings(); renderDashboard(); });
    $('set-density').addEventListener('change', (e) => { State.settings.density = e.target.checked ? 'compact' : 'comfortable'; persist.settings(); renderCurrentView(); });
    $('set-show-time').addEventListener('change', (e) => { State.settings.showTime = e.target.checked; persist.settings(); renderCurrentView(); });
    $('set-show-note').addEventListener('change', (e) => { State.settings.showNote = e.target.checked; persist.settings(); renderCurrentView(); });
    $('set-auto-promote').addEventListener('change', (e) => { State.settings.autoPromote = e.target.checked; persist.settings(); runAutomations(); renderCurrentView(); });
    $('set-auto-archive').addEventListener('change', (e) => { State.settings.autoArchive = e.target.checked; persist.settings(); runAutomations(); renderAll(); });
    $('set-remind').addEventListener('change', (e) => { State.settings.remind = e.target.checked; persist.settings(); });
    $('set-daily').addEventListener('change', (e) => { State.settings.dailyReminder = e.target.checked; persist.settings(); });
    $('set-daily-time').addEventListener('change', (e) => { State.settings.dailyTime = e.target.value; persist.settings(); });
    $('set-encrypt').addEventListener('change', handleEncryptToggle);

    // 确认框
    $('confirm-ok').addEventListener('click', () => { if (State.confirmCallback) State.confirmCallback(); State.confirmCallback = null; closeModal('confirm-modal'); });

    // 口令框
    $('pass-ok').addEventListener('click', () => { const v = $('pass-input').value; if (State.passCallback) State.passCallback(v); });
    $('pass-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pass-ok').click(); });

    // 通用关闭
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(b.dataset.close)));
    document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('show'); }));

    // 移动端侧栏
    $('menu-toggle').addEventListener('click', () => { $('sidebar').classList.add('open'); $('sidebar-backdrop').classList.add('show'); });
    $('sidebar-backdrop').addEventListener('click', closeSidebarMobile);

    // 周历条点击
    $('week-strip').addEventListener('click', (e) => {
        const dayEl = e.target.closest('.week-day');
        if (!dayEl) return;
        document.querySelectorAll('.week-day').forEach(d => d.classList.remove('active'));
        dayEl.classList.add('active');
        const date = dayEl.dataset.date;
        if (date) { State.filters.start = date; State.filters.end = date; renderCurrentView(); }
    });

    // 底部浮动导航
    document.querySelectorAll('.bottom-nav-btn').forEach(btn => btn.addEventListener('click', () => {
        const nav = btn.dataset.nav;
        switch (nav) {
            case 'tasks': State.settings.showDashboard = false; State.settings.currentView = 'list'; break;
            case 'kanban': State.settings.showDashboard = false; State.settings.currentView = 'kanban'; break;
            case 'calendar': State.settings.showDashboard = false; State.settings.currentView = 'calendar'; break;
            case 'stats': State.settings.showDashboard = true; break;
            case 'report': openReportModal(); return;
            case 'settings': openModal('settings-modal'); return;
        }
        persist.settings(); renderDashboard(); renderCurrentView();
    }));

    // 全局快捷键
    document.addEventListener('keydown', handleShortcuts);
}

function persistSort() { localStorage.setItem('sortPref', JSON.stringify(State.sort)); }

function closeSidebarMobile() { $('sidebar').classList.remove('open'); $('sidebar-backdrop').classList.remove('show'); }

function handleShortcuts(e) {
    // 命令面板打开时，键盘交给面板自身处理
    if ($('cmdk').classList.contains('show')) return;

    // Esc 关闭任何打开的模态框
    if (e.key === 'Escape') {
        const open = document.querySelector('.modal.show');
        if (open) { open.classList.remove('show'); return; }
        if (State.selectMode) toggleSelectMode(false);
        return;
    }
    if (e.ctrlKey || e.metaKey) {
        // 命令面板：Ctrl / Cmd + K
        if (e.key.toLowerCase() === 'k') { e.preventDefault(); openCommandBar('command'); return; }
        // 快捷录入：Ctrl / Cmd + Shift + Space
        if (e.shiftKey && (e.code === 'Space' || e.key === ' ')) { e.preventDefault(); openCommandBar('quick'); return; }
        if (e.key === 'n') { e.preventDefault(); openTaskModal(null); }
        else if (e.key === 'f') { e.preventDefault(); $('search-input').focus(); }
    }
    // 任务模态框内 Ctrl+Enter 保存
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && $('task-modal').classList.contains('show')) {
        e.preventDefault(); saveTaskFromModal();
    }
}

// 加密开关处理
function handleEncryptToggle(e) {
    if (e.target.checked) {
        // 二次确认：连续输入两次口令，避免手抖打错导致永久锁死
        promptPass('开启数据加密 · 第 1 步', '设置一个加密口令（至少 4 位），请牢记，遗忘将无法恢复数据', (pass1) => {
            if (!pass1 || pass1.length < 4) { showNotification('口令至少 4 位', 'warning'); e.target.checked = false; closeModal('pass-modal'); return; }
            setTimeout(() => {
                promptPass('开启数据加密 · 第 2 步', '请再次输入相同口令以确认', async (pass2) => {
                    if (pass1 !== pass2) { showNotification('两次口令不一致，已取消', 'error'); e.target.checked = false; closeModal('pass-modal'); return; }
                    const res = await window.electronAPI.cryptoEnable(pass1);
                    if (res.success) { State.settings.encrypt = true; closeModal('pass-modal'); showNotification('数据加密已开启', 'success'); }
                    else { showNotification(res.error, 'error'); e.target.checked = false; }
                });
            }, 60);
        });
        // 若用户取消口令框，回退开关
        const modal = $('pass-modal');
        const observer = () => { if (!modal.classList.contains('show') && !State.settings.encrypt) e.target.checked = false; };
        setTimeout(() => { modal.addEventListener('transitionend', observer, { once: true }); }, 50);
    } else {
        promptPass('关闭数据加密', '输入当前加密口令以解除加密', async (pass) => {
            const res = await window.electronAPI.cryptoDisable(pass);
            if (res.success) { State.settings.encrypt = false; closeModal('pass-modal'); showNotification('数据加密已关闭', 'success'); }
            else { showNotification(res.error, 'error'); e.target.checked = true; }
        });
    }
}

// 恢复排序偏好
try { const sp = localStorage.getItem('sortPref'); if (sp) State.sort = JSON.parse(sp); } catch (_) {}

// 关闭窗口前同步落盘，避免防抖未触发导致最后一次改动丢失
window.addEventListener('beforeunload', () => {
    try {
        if (window.electronAPI && window.electronAPI.saveTodosSync) window.electronAPI.saveTodosSync(State.todos);
        if (window.electronAPI && window.electronAPI.saveSettingsSync) window.electronAPI.saveSettingsSync(State.settings);
    } catch (_) { /* ignore */ }
});

// 启动
document.addEventListener('DOMContentLoaded', init);
