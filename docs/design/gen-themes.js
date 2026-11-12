// 生成主题设计图（同一骨架 × 4 套视觉语言），并离线计算 WCAG 对比度
// 01 青瓷 Celadon / 02 墨韵 Ink / 03 苹果玻璃 iOS Glass / 04 小米柔光 HyperOS Soft Glass
const fs = require('fs');
const path = require('path');

const hex2rgb = (h) => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16)); };
const lum = (rgb) => { const a = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]; };
const cr = (a, b) => { const L1 = lum(hex2rgb(a)), L2 = lum(hex2rgb(b)); const hi = Math.max(L1, L2), lo = Math.min(L1, L2); return (hi + 0.05) / (lo + 0.05); };
const f = (n) => n.toFixed(1);

const THEMES = [
  {
    id: 'celadon', n: '01', name: '青瓷 Celadon', tag: '现状延续 · 提纯',
    desc: '保留你现在的青绿品牌色，只把底色从淡紫拉回中性，压掉多余的色相干扰。改动最小，界面语言不变，稳妥。',
    vars: {
      '--bg': '#F2F7F6', '--side-bg': '#FAFDFC', '--surface': '#FFFFFF', '--surface-2': '#EFF6F4',
      '--border': '#DDEBE7', '--text': '#17211F', '--text-2': '#4F625D', '--text-3': '#86A09A',
      '--primary': '#2FA98A', '--primary-btn': '#1E7F68', '--primary-soft': '#E4F5F0',
      '--primary-text': '#166F5B', '--on-solid': '#FFFFFF',
      '--high-bg': '#FBEBE8', '--high-fg': '#AB3D2B', '--med-bg': '#FBF2DF', '--med-fg': '#8A6114',
      '--low-bg': '#EDF3F1', '--low-fg': '#566A63', '--ok-bg': '#E6F4E0', '--ok-fg': '#3E6E22',
      '--danger-fg': '#AE3B33',
      '--r-card': '16px', '--r-btn': '10px', '--r-input': '10px', '--r-sm': '8px', '--r-logo': '9px',
      '--shadow-card': '0 1px 3px rgba(23,33,31,.05)',
      '--nav-bg': 'rgba(255,255,255,.88)',
      '--font': '"Microsoft YaHei UI","PingFang SC","Segoe UI",system-ui,sans-serif',
      '--font-head': 'inherit',
    }, extra: ''
  },
  {
    id: 'ink', n: '02', name: '墨韵 Ink', tag: '中式 · 宣纸朱砂',
    desc: '宣纸底、墨色字、朱砂点缀，标题换衬线体，圆角收到 4px。文气足，适合当「写字的地方」而不是「软件」。',
    vars: {
      '--bg': '#F5F1E7', '--side-bg': '#F0EBDF', '--surface': '#FFFDF7', '--surface-2': '#F3EEE2',
      '--border': '#DED6C4', '--text': '#1D1A15', '--text-2': '#6A6152', '--text-3': '#9A9082',
      '--primary': '#A63D2F', '--primary-btn': '#A63D2F', '--primary-soft': '#F3E4DE',
      '--primary-text': '#93352A', '--on-solid': '#FFF9F2',
      '--high-bg': '#F2DFD8', '--high-fg': '#8F3225', '--med-bg': '#F0E7CF', '--med-fg': '#7C5A12',
      '--low-bg': '#E7E7DC', '--low-fg': '#5E6350', '--ok-bg': '#E3EADF', '--ok-fg': '#3F6340',
      '--danger-fg': '#A33127',
      '--r-card': '4px', '--r-btn': '3px', '--r-input': '3px', '--r-sm': '3px', '--r-logo': '3px',
      '--shadow-card': 'none',
      '--nav-bg': 'rgba(255,253,247,.92)',
      '--font': '"Microsoft YaHei UI","PingFang SC","Segoe UI",system-ui,sans-serif',
      '--font-head': '"Songti SC","STSong","SimSun",serif',
    },
    extra: `
.t-ink .brand b{font-family:var(--font-head);letter-spacing:4px;font-size:18px}
.t-ink .li.active{background:transparent;border-left:2px solid var(--primary);border-radius:0;padding-left:10px}
.t-ink .task{border-left-width:2px}
.t-ink .tasks{gap:7px}
.t-ink .nb.on{background:var(--primary);border-radius:3px}
.t-ink .chip{border-radius:2px}
`
  },
  {
    id: 'iosglass', n: '03', name: '苹果玻璃 iOS Glass', tag: 'Glassmorphism · 液态玻璃',
    desc: '真正的玻璃拟态：底层是弥散的蓝粉绿光斑，界面是一层层半透明毛玻璃浮在上面——侧栏、卡片、底栏都能透出后面的光，边缘有一道细高光。这是 iOS 26 液态玻璃的语言。',
    vars: {
      '--bg': '#EDF1F9', '--side-bg': 'rgba(255,255,255,.42)', '--surface': '#F4F7FC', '--surface-2': 'rgba(255,255,255,.34)',
      '--border': 'rgba(255,255,255,.62)', '--text': '#14161C', '--text-2': '#4A4F5A', '--text-3': '#7C8493',
      '--primary': '#007AFF', '--primary-btn': '#0A66D6', '--primary-soft': 'rgba(0,122,255,.12)',
      '--primary-text': '#0A5FC8', '--on-solid': '#FFFFFF',
      '--high-bg': 'rgba(255,90,80,.14)', '--high-fg': '#B8302A', '--med-bg': 'rgba(255,159,10,.16)', '--med-fg': '#8A5B00',
      '--low-bg': 'rgba(120,130,150,.14)', '--low-fg': '#565C68', '--ok-bg': 'rgba(48,190,95,.16)', '--ok-fg': '#1F7A42',
      '--danger-fg': '#B8302A',
      '--glass': 'rgba(255,255,255,.46)',
      '--glass-2': 'rgba(255,255,255,.32)',
      '--glass-line': 'rgba(255,255,255,.82)',
      '--glass-blur': 'blur(26px) saturate(180%)',
      '--r-card': '22px', '--r-btn': '14px', '--r-input': '14px', '--r-sm': '12px', '--r-logo': '9px',
      '--shadow-card': '0 10px 30px -14px rgba(24,44,88,.22)',
      '--nav-bg': 'rgba(255,255,255,.55)',
      '--font': '-apple-system,"SF Pro Text","PingFang SC","Microsoft YaHei UI",system-ui,sans-serif',
      '--font-head': 'inherit',
    },
    extra: `
/* 底层：明确的彩色光球，玻璃才有东西可透 */
.screen.t-iosglass{
  background:linear-gradient(150deg,#E9EFFB 0%,#F4EDFA 48%,#E9F6F1 100%);
}
.screen.t-iosglass::before,
.screen.t-iosglass::after{
  content:"";position:absolute;border-radius:50%;z-index:0;pointer-events:none;
}
.screen.t-iosglass::before{
  width:720px;height:720px;left:18%;top:-180px;
  background:radial-gradient(circle at 50% 50%, rgba(96,150,255,.60), rgba(96,150,255,0) 70%);
}
.screen.t-iosglass::after{
  width:660px;height:660px;left:44%;bottom:-150px;
  background:radial-gradient(circle at 50% 50%, rgba(255,138,188,.52), rgba(255,138,188,0) 70%);
}
.t-iosglass .sb,.t-iosglass .mn{position:relative;z-index:1}
/* 侧栏玻璃 */
.t-iosglass .sb{
  background:var(--glass-2);
  backdrop-filter:blur(30px) saturate(180%);
  -webkit-backdrop-filter:blur(30px) saturate(180%);
  border-right:1px solid rgba(255,255,255,.55);
  box-shadow:inset -1px 0 0 rgba(255,255,255,.5);
}
/* 卡片玻璃 */
.t-iosglass .task{
  background:var(--glass);
  backdrop-filter:var(--glass-blur);
  -webkit-backdrop-filter:var(--glass-blur);
  border:1px solid var(--glass-line);
  border-left:3px solid var(--st);
  box-shadow:
    0 10px 30px -14px rgba(24,44,88,.22),
    inset 0 1px 0 rgba(255,255,255,.9),
    inset 0 -1px 0 rgba(255,255,255,.35);
}
.t-iosglass .tasks{gap:11px}
.t-iosglass .tb{padding-bottom:16px}
.t-iosglass .tb h3{font-size:26px;font-weight:800;letter-spacing:-.8px}
.t-iosglass .search,
.t-iosglass .chip{
  background:rgba(255,255,255,.45);
  backdrop-filter:blur(18px) saturate(160%);
  -webkit-backdrop-filter:blur(18px) saturate(160%);
  border:1px solid rgba(255,255,255,.7);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.85);
}
.t-iosglass .search{border-radius:14px}
.t-iosglass .chip{border-radius:14px}
.t-iosglass .btn-p{
  background:linear-gradient(180deg,#1B86F2,#0A66D6);
  box-shadow:0 8px 20px -8px rgba(10,102,214,.6), inset 0 1px 0 rgba(255,255,255,.35);
}
.t-iosglass .li{border-radius:11px}
.t-iosglass .li.active{background:rgba(255,255,255,.6);color:var(--text);box-shadow:inset 0 1px 0 rgba(255,255,255,.9), 0 2px 8px -4px rgba(24,44,88,.2)}
.t-iosglass .li.active em{color:var(--text-2)}
.t-iosglass .logo{background:linear-gradient(180deg,#5AC8FA,#007AFF);box-shadow:0 4px 12px -4px rgba(0,122,255,.6), inset 0 1px 0 rgba(255,255,255,.5)}
.t-iosglass .prog{background:rgba(255,255,255,.55);box-shadow:inset 0 0 0 1px rgba(255,255,255,.6)}
.t-iosglass .nav{
  left:226px;right:0;width:auto;transform:none;border-radius:0;
  border:none;border-top:1px solid rgba(255,255,255,.65);
  background:var(--nav-bg);
  backdrop-filter:blur(34px) saturate(190%);
  -webkit-backdrop-filter:blur(34px) saturate(190%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.85);
  padding:5px 8px 9px;justify-content:space-around;
}
.t-iosglass .nb{flex-direction:column;gap:1px;padding:5px 10px;border-radius:10px;font-size:10px;font-weight:500;color:var(--text-2)}
.t-iosglass .nb .ic{width:18px;height:18px}
.t-iosglass .nb.on{background:transparent;color:var(--primary);font-weight:600;box-shadow:none}
`
  },
  {
    id: 'hyperglass', n: '04', name: '小米柔光 HyperOS Soft Glass', tag: '柔光玻璃 · 弥散光',
    desc: '澎湃 OS 的路子：玻璃更白更「奶」，内芯接近实白，边缘是一圈柔和弥散的光晕而不是硬高光，投影带冷调蓝；圆角拉到 28px，整体透亮、软、有呼吸感。',
    vars: {
      '--bg': '#F1F4FA', '--side-bg': 'rgba(255,255,255,.62)', '--surface': '#F4F7FC', '--surface-2': 'rgba(255,255,255,.72)',
      '--border': 'rgba(255,255,255,.9)', '--text': '#0F1522', '--text-2': '#4E5A6E', '--text-3': '#8794A8',
      '--primary': '#3482FF', '--primary-btn': '#2A6BEA', '--primary-soft': 'rgba(52,130,255,.12)',
      '--primary-text': '#1B4FD1', '--on-solid': '#FFFFFF',
      '--high-bg': 'rgba(255,80,80,.13)', '--high-fg': '#BE2F2F', '--med-bg': 'rgba(255,140,30,.16)', '--med-fg': '#8A5510',
      '--low-bg': 'rgba(120,140,170,.14)', '--low-fg': '#556074', '--ok-bg': 'rgba(30,170,110,.15)', '--ok-fg': '#1B6E48',
      '--danger-fg': '#BE2F2F',
      '--glass': 'rgba(255,255,255,.78)',
      '--glass-2': 'rgba(255,255,255,.58)',
      '--glass-line': 'rgba(255,255,255,.98)',
      '--glass-blur': 'blur(30px) saturate(150%)',
      '--r-card': '28px', '--r-btn': '18px', '--r-input': '20px', '--r-sm': '14px', '--r-logo': '12px',
      '--shadow-card': '0 12px 34px -18px rgba(52,110,200,.30)',
      '--nav-bg': 'rgba(255,255,255,.78)',
      '--font': '"MiSans","PingFang SC","Microsoft YaHei UI",system-ui,sans-serif',
      '--font-head': 'inherit',
    },
    extra: `
/* 底层柔光：大范围、低强度、冷调，只为「亮」不为「透」 */
.screen.t-hyperglass{
  background:linear-gradient(180deg,#F8FBFF 0%,#EDF3FC 100%);
}
.screen.t-hyperglass::before,
.screen.t-hyperglass::after{
  content:"";position:absolute;border-radius:50%;z-index:0;pointer-events:none;
}
.screen.t-hyperglass::before{
  width:900px;height:900px;left:14%;top:-300px;
  background:radial-gradient(circle at 50% 50%, rgba(120,172,255,.32), rgba(120,172,255,0) 72%);
}
.screen.t-hyperglass::after{
  width:760px;height:760px;left:50%;bottom:-200px;
  background:radial-gradient(circle at 50% 50%, rgba(170,150,255,.24), rgba(170,150,255,0) 72%);
}
.t-hyperglass .sb,.t-hyperglass .mn{position:relative;z-index:1}
/* 侧栏：更白，柔光边 */
.t-hyperglass .sb{
  background:var(--glass-2);
  backdrop-filter:blur(34px) saturate(150%);
  -webkit-backdrop-filter:blur(34px) saturate(150%);
  border-right:1px solid rgba(255,255,255,.85);
}
/* 卡片：内芯近实白 + 弥散蓝光晕 */
.t-hyperglass .task{
  background:var(--glass);
  backdrop-filter:var(--glass-blur);
  -webkit-backdrop-filter:var(--glass-blur);
  border:1px solid var(--glass-line);
  border-left:3px solid var(--st);
  box-shadow:
    0 14px 36px -20px rgba(52,110,200,.38),
    0 4px 14px -8px rgba(52,110,200,.16),
    inset 0 1px 0 rgba(255,255,255,1);
}
.t-hyperglass .tasks{gap:12px}
.t-hyperglass .task h4{font-weight:600}
.t-hyperglass .tb h3{font-size:22px;letter-spacing:-.3px}
.t-hyperglass .search,
.t-hyperglass .chip{
  background:rgba(255,255,255,.75);
  backdrop-filter:blur(20px) saturate(140%);
  -webkit-backdrop-filter:blur(20px) saturate(140%);
  border:1px solid rgba(255,255,255,.95);
  box-shadow:0 4px 14px -10px rgba(52,110,200,.35);
}
.t-hyperglass .search{border-radius:20px;padding:10px 15px}
.t-hyperglass .chip{border-radius:16px;padding:9px 13px}
.t-hyperglass .btn-p{
  background:linear-gradient(135deg,#4A8CFF,#1B4FD1);
  box-shadow:0 10px 24px -10px rgba(43,106,234,.65), inset 0 1px 0 rgba(255,255,255,.4);
  border-radius:18px;
}
.t-hyperglass .li{border-radius:14px}
.t-hyperglass .li.active{background:rgba(255,255,255,.85);color:var(--primary-text);box-shadow:0 4px 12px -6px rgba(52,110,200,.28)}
.t-hyperglass .logo{background:linear-gradient(135deg,#63A0FF,#1B4FD1);box-shadow:0 6px 16px -6px rgba(43,106,234,.6)}
.t-hyperglass .prog{height:5px;background:rgba(255,255,255,.9)}
.t-hyperglass .nav{
  padding:7px;border-radius:30px;
  background:var(--nav-bg);
  backdrop-filter:blur(36px) saturate(150%);
  -webkit-backdrop-filter:blur(36px) saturate(150%);
  border:1px solid rgba(255,255,255,.9);
  box-shadow:0 18px 40px -18px rgba(30,60,120,.42), inset 0 1px 0 rgba(255,255,255,.9);
}
.t-hyperglass .nb{border-radius:22px;padding:8px 15px}
.t-hyperglass .nb.on{background:linear-gradient(135deg,#4A8CFF,#1B4FD1);box-shadow:0 8px 18px -8px rgba(43,106,234,.7)}
`
  },
];

// ---- 卡片数据 ----
const CARDS = [
  { t: '商丘航电三个季度租后检查文件替换上传', pr: '高', prc: 'high', st: '进行中', stc: 'prog', tags: ['工作'], meta: '截止 11-12 18:00', prog: 60 },
  { t: '整理 Q4 客户回访清单并分派到各区域', pr: '中', prc: 'med', st: '待办', stc: 'pend', tags: ['工作'], meta: '截止 11-13' },
  { t: '读完《深度工作》第三章并整理笔记', pr: '低', prc: 'low', st: '待办', stc: 'pend', tags: ['学习'], meta: '截止 11-15' },
  { t: '提交 10 月差旅报销单', pr: '高', prc: 'high', st: '逾期 2 天', stc: 'over', tags: ['生活'], meta: '原定 11-09' },
  { t: '整理本周项目周报初稿', pr: '中', prc: 'med', st: '已完成', stc: 'done', tags: ['工作'], meta: '完成于 11-10 16:20', done: true },
];

const LISTS = [
  ['全部任务', 12, '#4A7C66', true],
  ['工作', 8, '#B4653A', false],
  ['学习', 3, '#2563EB', false],
  ['生活', 2, '#5C8D77', false],
  ['无颜色', 1, '#C9CDD4', false],
];

const NAV = [['i-list', '清单', true], ['i-kanban', '看板', false], ['i-cal', '日历', false], ['i-chart', '统计', false], ['i-doc', '日报', false]];
const FOOT = [['i-doc', '写日报'], ['i-chart', '统计面板'], ['i-db', '备份与恢复'], ['i-gear', '设置']];

const themeVars = (t) => Object.entries(t.vars).map(([k, v]) => `  ${k}: ${v};`).join('\n');

const metrics = (t) => {
  const v = t.vars;
  return {
    body: cr(v['--text'], v['--surface']),
    sub: cr(v['--text-2'], v['--surface']),
    btn: cr(v['--primary-btn'], v['--on-solid']),
    active: cr(v['--primary-text'], v['--surface']),
  };
};

const screenHTML = (t) => `
<div class="swrap">
  <div class="screen t-${t.id}">
    <aside class="sb">
      <div class="brand"><span class="logo"><svg class="ic"><use href="#i-check"/></svg></span><b>知行</b><i>任务 · 日报</i></div>
      <div class="sb-sec"><span>清单</span><span class="plus">+</span></div>
      <nav class="lists">
        ${LISTS.map(([n, c, col, act]) => `<a class="li${act ? ' active' : ''}"><span class="dot" style="background:${col}"></span>${n}<em>${c}</em></a>`).join('')}
      </nav>
      <div class="sb-foot">
        ${FOOT.map(([ic, n]) => `<a class="sf"><svg class="ic"><use href="#${ic}"/></svg>${n}</a>`).join('')}
      </div>
    </aside>
    <main class="mn">
      <div class="tb">
        <h3><span class="hdot"></span>全部任务</h3>
        <button class="btn-p"><svg class="ic"><use href="#i-plus"/></svg>新建任务</button>
      </div>
      <div class="bar">
        <div class="search"><svg class="ic"><use href="#i-search"/></svg><span>搜索任务（支持拼音首字母）</span></div>
        <span class="chip">排序：手动</span>
        <span class="chip"><svg class="ic"><use href="#i-filter"/></svg>筛选</span>
        <span class="chip"><svg class="ic"><use href="#i-square"/></svg>多选</span>
      </div>
      <div class="tasks">
        ${CARDS.map(c => `
        <article class="task c-${c.stc}">
          <h4 class="${c.done ? 'done' : ''}">${c.t}</h4>
          <div class="meta">
            <span class="pill p-${c.prc}">${c.pr}</span>
            <span class="pill s-${c.stc}">${c.st}</span>
            ${c.tags.map(x => `<span class="tagx">#${x}</span>`).join('')}
            <span class="dotsep"></span>
            <span class="mt">${c.meta}</span>
          </div>
          ${c.prog ? `<div class="prog"><span style="width:${c.prog}%"></span></div>` : ''}
        </article>`).join('')}
      </div>
    </main>
    <div class="nav">
      ${NAV.map(([ic, n, on]) => `<a class="nb${on ? ' on' : ''}"><svg class="ic"><use href="#${ic}"/></svg>${n}</a>`).join('')}
    </div>
  </div>
</div>`;

const swatches = (t) => {
  const keys = ['--bg', '--surface', '--primary', '--primary-btn', '--text'];
  return keys.map(k => `<span class="sw" style="background:${t.vars[k]}" title="${k} ${t.vars[k]}"></span>`).join('');
};

const section = (t) => {
  const m = metrics(t);
  return `
<section class="theme" id="t-${t.id}">
  <div class="thead">
    <div class="th-l">
      <span class="th-n">${t.n}</span>
      <div>
        <div class="th-name">${t.name}<span class="th-tag">${t.tag}</span></div>
        <p class="th-desc">${t.desc}</p>
        <div class="th-cr">
          <span>正文 <b>${f(m.body)}</b></span>
          <span>次要 <b>${f(m.sub)}</b></span>
          <span>主按钮 <b>${f(m.btn)}</b></span>
          <span>强调字 <b>${f(m.active)}</b></span>
        </div>
      </div>
    </div>
    <div class="th-sw">${swatches(t)}</div>
  </div>
  ${screenHTML(t)}
</section>`;
};

const css = `*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:#12141A;color:#DFE3EA;font-family:"Microsoft YaHei UI","PingFang SC","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.sprite{position:absolute;width:0;height:0;overflow:hidden}
.ic{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
.board{max-width:1232px;margin:0 auto;padding:54px 24px 90px}
.bh{display:flex;align-items:flex-end;justify-content:space-between;gap:28px;flex-wrap:wrap}
.bh h1{font-size:31px;font-weight:800;letter-spacing:-.6px}
.bh .sub{color:#8A93A3;font-size:13.5px;margin-top:12px;line-height:1.75;max-width:700px}
.bh .meta{font-size:12px;color:#5F6879;margin-top:14px;letter-spacing:.3px}
.legend{display:flex;flex-wrap:wrap;gap:8px;margin-top:26px;padding-top:22px;border-top:1px solid #232833}
.lg{display:flex;align-items:center;gap:8px;font-size:12.5px;padding:8px 14px 8px 10px;border-radius:999px;border:1px solid #262B36;background:#191D25;color:#AEB6C4;text-decoration:none;transition:.15s}
.lg:hover{border-color:#3D4658;color:#EDF0F5;background:#1D222C}
.lg b{width:12px;height:12px;border-radius:4px;flex-shrink:0}
.theme{margin-top:74px}
.thead{display:flex;align-items:flex-start;justify-content:space-between;gap:28px;margin-bottom:16px;padding-bottom:18px;border-bottom:1px solid #232833}
.th-l{display:flex;gap:16px;align-items:flex-start}
.th-n{font-size:12px;font-weight:700;color:#4C5568;letter-spacing:1.5px;padding-top:5px;font-variant-numeric:tabular-nums}
.th-name{font-size:19px;font-weight:700;letter-spacing:.2px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.th-tag{font-size:11px;font-weight:600;color:#8A93A3;border:1px solid #2B3140;border-radius:999px;padding:3px 9px;letter-spacing:.2px}
.th-desc{font-size:13px;color:#8A93A3;margin-top:9px;line-height:1.7;max-width:660px}
.th-cr{display:flex;gap:16px;flex-wrap:wrap;margin-top:11px;font-size:11.5px;color:#66707F}
.th-cr b{color:#B9C2D0;font-weight:600;font-variant-numeric:tabular-nums}
.th-sw{display:flex;gap:6px;flex-shrink:0;padding-top:2px}
.sw{width:32px;height:32px;border-radius:9px;border:1px solid rgba(255,255,255,.14)}

/* ==== 屏幕骨架（全部由变量驱动） ==== */
.swrap{width:1120px;max-width:100%;border-radius:15px;overflow:hidden;box-shadow:0 20px 54px -22px rgba(0,0,0,.85), 0 0 0 1px rgba(255,255,255,.07)}
.screen{display:flex;width:100%;height:656px;background:var(--bg);color:var(--text);position:relative;overflow:hidden;font-family:var(--font);font-size:14px;line-height:1.5}

/* 侧栏 */
.sb{width:226px;flex-shrink:0;background:var(--side-bg);border-right:1px solid var(--border);display:flex;flex-direction:column;padding:18px 13px 13px}
.brand{display:flex;align-items:center;gap:9px;padding:0 7px 18px}
.logo{width:26px;height:26px;border-radius:var(--r-logo);background:var(--primary-btn);color:var(--on-solid);display:grid;place-items:center}
.logo .ic{width:15px;height:15px;stroke-width:2.4}
.brand b{font-size:16px;letter-spacing:.6px}
.brand i{font-size:11px;color:var(--text-3);font-style:normal}
.sb-sec{display:flex;justify-content:space-between;align-items:center;font-size:10.5px;color:var(--text-3);letter-spacing:1.4px;padding:6px 7px 8px;font-weight:600}
.sb-sec .plus{font-size:15px;font-weight:400;line-height:1}
.lists{display:flex;flex-direction:column;gap:2px}
.li{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:var(--r-sm);font-size:13.5px;color:var(--text-2);text-decoration:none;border-left:2px solid transparent}
.li .dot{width:7px;height:7px;border-radius:2px;flex-shrink:0;opacity:.85}
.li em{margin-left:auto;font-size:11.5px;font-style:normal;color:var(--text-3);font-variant-numeric:tabular-nums}
.li.active{background:var(--primary-soft);color:var(--primary-text);font-weight:700}
.li.active em{color:var(--primary-text);opacity:.7}
.sb-foot{margin-top:auto;display:flex;flex-direction:column;gap:1px;padding-top:11px;border-top:1px solid var(--border)}
.sf{display:flex;align-items:center;gap:9px;padding:8px 10px;font-size:13px;color:var(--text-2);border-radius:var(--r-sm);text-decoration:none}
.sf .ic{opacity:.8}

/* 主区 */
.mn{flex:1;min-width:0;display:flex;flex-direction:column;padding:18px 26px 0}
.tb{display:flex;align-items:center;justify-content:space-between;padding-bottom:18px}
.tb h3{font-size:21px;font-weight:700;letter-spacing:-.2px;display:flex;align-items:center;gap:9px;font-family:var(--font-head)}
.hdot{width:8px;height:8px;border-radius:2px;background:var(--primary);flex-shrink:0}
.btn-p{background:var(--primary-btn);color:var(--on-solid);border:none;border-radius:var(--r-btn);padding:9px 15px;font-size:13px;font-weight:600;display:flex;gap:6px;align-items:center;font-family:inherit;cursor:pointer}
.btn-p .ic{width:15px;height:15px;stroke-width:2.2}
.bar{display:flex;gap:8px;align-items:center;margin-bottom:15px}
.search{flex:1;display:flex;align-items:center;gap:8px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-input);padding:9px 12px;color:var(--text-3);font-size:13px;min-width:0}
.search .ic{width:15px;height:15px;opacity:.75}
.chip{display:flex;align-items:center;gap:6px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-input);padding:8px 11px;font-size:12.5px;color:var(--text-2);white-space:nowrap;font-weight:500}
.chip .ic{width:14px;height:14px;opacity:.85}

/* 任务卡 */
.tasks{display:flex;flex-direction:column;gap:9px;overflow:hidden}
.task{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--st,var(--border-strong,var(--border)));border-radius:var(--r-card);padding:12px 15px;box-shadow:var(--shadow-card);position:relative;overflow:hidden}
.task h4{font-size:14px;font-weight:600;margin-bottom:8px;color:var(--text);letter-spacing:.1px}
.task h4.done{text-decoration:line-through;color:var(--text-2);font-weight:500}
.c-pend{--st:var(--primary)}
.c-prog{--st:#5BA4CF}
.c-over{--st:var(--high-fg)}
.c-done{--st:var(--ok-fg)}
.meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:11.5px;color:var(--text-3)}
.pill{padding:2.5px 8px;border-radius:999px;font-weight:700;font-size:10.5px;letter-spacing:.2px}
.p-high{background:var(--high-bg);color:var(--high-fg)}
.p-med{background:var(--med-bg);color:var(--med-fg)}
.p-low{background:var(--low-bg);color:var(--low-fg)}
.s-pend{background:var(--surface-2);color:var(--text-2);font-weight:600;box-shadow:inset 0 0 0 1px var(--border)}
.s-prog{background:var(--primary-soft);color:var(--primary-text)}
.s-over{background:var(--high-bg);color:var(--danger-fg)}
.s-done{background:var(--ok-bg);color:var(--ok-fg)}
.tagx{color:var(--primary-text);font-weight:600;font-size:11px;opacity:.9}
.dotsep{width:2px;height:2px;border-radius:50%;background:var(--text-3);opacity:.6}
.mt{font-variant-numeric:tabular-nums}
.prog{height:4px;border-radius:999px;background:var(--surface-2);margin-top:9px;overflow:hidden}
.prog span{display:block;height:100%;border-radius:999px;background:var(--primary);opacity:.85}

/* 浮动底栏 */
.nav{position:absolute;bottom:14px;left:50%;transform:translateX(-50%);background:var(--nav-bg);border:1px solid var(--border);border-radius:999px;padding:4px 5px;display:flex;gap:2px;box-shadow:0 8px 24px -10px rgba(20,24,32,.35);backdrop-filter:blur(14px)}
.nb{display:flex;align-items:center;gap:5px;padding:7px 13px;border-radius:999px;font-size:11.5px;font-weight:600;color:var(--text-2);text-decoration:none;white-space:nowrap}
.nb .ic{width:14px;height:14px;opacity:.9}
.nb.on{background:var(--primary-btn);color:var(--on-solid)}
.nb.on .ic{opacity:1}

/* 页脚 */
.foot{margin-top:64px;padding-top:26px;border-top:1px solid #232833;color:#7A8395;font-size:12.5px;line-height:1.9;max-width:860px}
.foot b{color:#AEB6C4;font-weight:600}
@media (max-width:1220px){.swrap{overflow-x:auto}}
`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>知行 · 主题风格方案（4 版设计图）</title>
<style>
${css}
${THEMES.map(t => `.t-${t.id}{\n${themeVars(t)}\n}`).join('\n')}
${THEMES.map(t => t.extra).join('\n')}
</style>
</head>
<body>
<svg class="sprite" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
  <symbol id="i-search" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-5.4-5.4"/></symbol>
  <symbol id="i-filter" viewBox="0 0 24 24"><path d="M4 5h16l-6 7v6l-4 2v-8z"/></symbol>
  <symbol id="i-list" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.3" fill="currentColor" stroke="none"/></symbol>
  <symbol id="i-kanban" viewBox="0 0 24 24"><rect x="4" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="10" rx="1.5"/><rect x="16" y="4" width="5" height="13" rx="1.5"/></symbol>
  <symbol id="i-cal" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="16" rx="2.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/></symbol>
  <symbol id="i-chart" viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7"/><path d="M3 20h18"/></symbol>
  <symbol id="i-doc" viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/></symbol>
  <symbol id="i-gear" viewBox="0 0 24 24"><path d="M4 7h12M18 7h2M4 12h2M10 12h10M4 17h8M16 17h4"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="14" cy="17" r="2"/></symbol>
  <symbol id="i-db" viewBox="0 0 24 24"><ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v13c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-13"/><path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/></symbol>
  <symbol id="i-square" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12l2.5 2.5L16 9"/></symbol>
  <symbol id="i-check" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></symbol>
  <symbol id="i-folder" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h6a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></symbol>
</svg>

<div class="board">
  <header class="bh">
    <div>
      <h1>知行 · 主题风格方案</h1>
      <p class="sub">同一套界面骨架（侧栏 + 工具栏 + 任务卡 + 浮动底栏），四套视觉语言。01/02 保持不变；03/04 重做为两种玻璃质感——苹果的 Glassmorphism 与小米澎湃的柔光玻璃。骨架、间距、信息层级完全一致，落地只需替换 <code>:root</code> 变量。</p>
      <p class="meta">2026-11-12 · 4 版 · 数据为示意 · 对比度按 WCAG 2.1 实测</p>
    </div>
  </header>

  <nav class="legend">
    ${THEMES.map(t => `<a class="lg" href="#t-${t.id}"><b style="background:${t.vars['--primary-btn']}"></b>${t.name}</a>`).join('')}
  </nav>

  ${THEMES.map(section).join('\n')}

  <footer class="foot">
    <b>03 与 04 的区别：</b>同样用毛玻璃，苹果这版玻璃更透（0.58 白）、边缘有一道锐利的高光、底层光斑更饱和，能明显看出「隔着玻璃」；小米这版内芯接近实白（0.80）、高光弥散成光晕、投影带冷调蓝、圆角到 28px，观感是「发亮的白」而不是「透」的玻璃。<br>
    <b>对比度：</b>玻璃层是半透明的，这里按最暗的等效底色（近白）计算，实际显示时背景更亮、对比度只会更高，不会更低。所有主按钮与正文均 ≥ 4.5:1。<br>
    <b>落地提醒：</b>03/04 依赖 <code>backdrop-filter</code>，WebView2 / Chromium 支持，但关闭硬件加速的老机器上会退化成纯色，需要补一层 <code>@supports not (backdrop-filter: blur(1px))</code> 的实色兜底。04 的 MiSans 需随包分发，否则回退到苹方/雅黑。
  </footer>
</div>
</body>
</html>`;

const outDir = __dirname; // 与脚本同目录，换机器也能跑
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, '主题方案-2026-11-11.html');
fs.writeFileSync(outPath, html, 'utf8');

console.log('written:', outPath, (html.length / 1024).toFixed(1) + 'KB');
THEMES.forEach(t => { const m = metrics(t); console.log(t.name.padEnd(28), '正文', f(m.body), '| 次要', f(m.sub), '| 按钮', f(m.btn), '| 强调', f(m.active)); });
