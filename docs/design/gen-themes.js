// 生成主题设计图（同一骨架 × 6 套视觉语言），并离线计算 WCAG 对比度
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
    id: 'mist', n: '02', name: '晨雾 Mist', tag: '中性 · 克制',
    desc: '雾绿降饱和，灰调加重，几乎没有色彩情绪。长时间盯屏最不累，适合当成日常默认。',
    vars: {
      '--bg': '#F3F6F5', '--side-bg': '#FAFCFB', '--surface': '#FFFFFF', '--surface-2': '#F1F5F3',
      '--border': '#E2E8E5', '--text': '#1C2421', '--text-2': '#566159', '--text-3': '#8B968F',
      '--primary': '#5C8D77', '--primary-btn': '#4A7C66', '--primary-soft': '#EBF2EE',
      '--primary-text': '#3D6952', '--on-solid': '#FFFFFF',
      '--high-bg': '#FBEDEA', '--high-fg': '#A9432F', '--med-bg': '#FBF3E2', '--med-fg': '#8A6416',
      '--low-bg': '#EEF2F0', '--low-fg': '#5D6B62', '--ok-bg': '#EAF3E6', '--ok-fg': '#46702B',
      '--danger-fg': '#B0413A',
      '--r-card': '14px', '--r-btn': '10px', '--r-input': '10px', '--r-sm': '8px', '--r-logo': '8px',
      '--shadow-card': '0 1px 3px rgba(28,36,33,.05)',
      '--nav-bg': 'rgba(255,255,255,.86)',
      '--font': '"Microsoft YaHei UI","PingFang SC","Segoe UI",system-ui,sans-serif',
      '--font-head': 'inherit',
    }, extra: ''
  },
  {
    id: 'sand', n: '03', name: '暖砂 Sand', tag: '暖调 · 大圆角',
    desc: '燕麦底配陶土橙，纸感、温度感强，圆角再放大一档。适合不追求工具冷感、希望界面有「手感」的人。',
    vars: {
      '--bg': '#F7F1E6', '--side-bg': '#F2EBDD', '--surface': '#FFFCF6', '--surface-2': '#F3EDE0',
      '--border': '#E9DECC', '--text': '#342A20', '--text-2': '#7A6955', '--text-3': '#A5947E',
      '--primary': '#B4653A', '--primary-btn': '#A4552C', '--primary-soft': '#F7E8DC',
      '--primary-text': '#97502A', '--on-solid': '#FFFBF5',
      '--high-bg': '#F8E2D5', '--high-fg': '#A34A24', '--med-bg': '#F8EEDA', '--med-fg': '#86601A',
      '--low-bg': '#EEE8DA', '--low-fg': '#6B6252', '--ok-bg': '#E9F0DC', '--ok-fg': '#4F6E2E',
      '--danger-fg': '#A83E30',
      '--r-card': '18px', '--r-btn': '12px', '--r-input': '12px', '--r-sm': '10px', '--r-logo': '10px',
      '--shadow-card': '0 2px 8px rgba(122,105,85,.07)',
      '--nav-bg': 'rgba(255,252,246,.90)',
      '--font': '"Microsoft YaHei UI","PingFang SC","Segoe UI",system-ui,sans-serif',
      '--font-head': 'inherit',
    }, extra: ''
  },
  {
    id: 'ink', n: '04', name: '墨韵 Ink', tag: '中式 · 宣纸朱砂',
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
    id: 'graphite', n: '05', name: '石墨 Graphite', tag: '极简 · 高密度',
    desc: '冷灰中性色 + 单一电光蓝，圆角 4px，去掉全部阴影，只留 1px 描边。信息密度最高，最像专业工具。',
    vars: {
      '--bg': '#F6F7F9', '--side-bg': '#FBFBFC', '--surface': '#FFFFFF', '--surface-2': '#F1F3F5',
      '--border': '#E3E6EA', '--text': '#0F1216', '--text-2': '#545C66', '--text-3': '#8A929C',
      '--primary': '#2563EB', '--primary-btn': '#1D4ED8', '--primary-soft': '#EDF2FE',
      '--primary-text': '#1D4ED8', '--on-solid': '#FFFFFF',
      '--high-bg': '#FDECEC', '--high-fg': '#C02B2B', '--med-bg': '#FFF4DF', '--med-fg': '#8A5C00',
      '--low-bg': '#EFF1F4', '--low-fg': '#5A626C', '--ok-bg': '#E8F3EC', '--ok-fg': '#2C6B45',
      '--danger-fg': '#C02B2B',
      '--r-card': '4px', '--r-btn': '4px', '--r-input': '4px', '--r-sm': '4px', '--r-logo': '5px',
      '--shadow-card': 'none',
      '--nav-bg': 'rgba(255,255,255,.94)',
      '--font': '"Microsoft YaHei UI","PingFang SC","Segoe UI",system-ui,sans-serif',
      '--font-head': 'inherit',
    },
    extra: `
.t-graphite .task{padding:10px 13px}
.t-graphite .tasks{gap:6px}
.t-graphite .bar{gap:6px}
.t-graphite .tb{padding-bottom:14px}
.t-graphite .task h4{font-weight:600;margin-bottom:6px}
.t-graphite .chip{border-radius:3px;padding:5px 9px}
.t-graphite .nb.on{background:var(--primary-btn);border-radius:4px}
.t-graphite .brand i{display:none}
`
  },
  {
    id: 'midnight', n: '06', name: '深夜靛 Midnight', tag: '深色 · 玻璃质感',
    desc: '不是纯黑，是带蓝的墨靛底，青色作唯一亮色，配发光描边和半透明面板。夜里用最舒服，也最有「工作台」氛围。',
    vars: {
      '--bg': '#0E1016', '--side-bg': '#12151D', '--surface': '#171B24', '--surface-2': '#1D222D',
      '--border': '#262C39', '--text': '#E9ECF2', '--text-2': '#9BA4B6', '--text-3': '#6B7488',
      '--primary': '#4CC9E8', '--primary-btn': '#3FC9E0', '--primary-soft': '#1B2C33',
      '--primary-text': '#7DDCF1', '--on-solid': '#07161B',
      '--high-bg': '#3C282F', '--high-fg': '#FF9B9B', '--med-bg': '#383024', '--med-fg': '#F5C46B',
      '--low-bg': '#292E38', '--low-fg': '#A9B2C4', '--ok-bg': '#203423', '--ok-fg': '#8FDB6B',
      '--danger-fg': '#FF8F8F',
      '--r-card': '12px', '--r-btn': '9px', '--r-input': '9px', '--r-sm': '8px', '--r-logo': '8px',
      '--shadow-card': '0 1px 0 rgba(255,255,255,.03)',
      '--nav-bg': 'rgba(23,27,36,.86)',
      '--font': '"Microsoft YaHei UI","PingFang SC","Segoe UI",system-ui,sans-serif',
      '--font-head': 'inherit',
    },
    extra: `
.t-midnight .screen{background-image:radial-gradient(760px 380px at 80% -8%, rgba(63,201,224,.13), transparent 68%)}
.t-midnight .btn-p{box-shadow:0 0 0 1px rgba(63,201,224,.30), 0 8px 20px -8px rgba(63,201,224,.55)}
.t-midnight .task{background-image:linear-gradient(180deg, rgba(255,255,255,.02), transparent)}
.t-midnight .nav{box-shadow:0 10px 32px -12px rgba(0,0,0,.9), 0 0 0 1px rgba(255,255,255,.04)}
.t-midnight .nb.on{background:var(--primary-btn);color:var(--on-solid);box-shadow:0 4px 14px -4px rgba(63,201,224,.6)}
.t-midnight .logo{color:#07161B}
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
    active: cr(v['--primary-text'], v['--primary-soft']),
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
          <span>选中项 <b>${f(m.active)}</b></span>
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
.bh .sub{color:#8A93A3;font-size:13.5px;margin-top:12px;line-height:1.75;max-width:660px}
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
.th-desc{font-size:13px;color:#8A93A3;margin-top:9px;line-height:1.7;max-width:640px}
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
.foot{margin-top:64px;padding-top:26px;border-top:1px solid #232833;color:#7A8395;font-size:12.5px;line-height:1.9;max-width:820px}
.foot b{color:#AEB6C4;font-weight:600}
@media (max-width:1220px){.swrap{overflow-x:auto}}
`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>知行 · 主题风格方案（6 版设计图）</title>
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
      <p class="sub">同一套界面骨架（侧栏 + 工具栏 + 任务卡 + 浮动底栏），配六种视觉语言。每版的底色、主色、圆角、阴影、字体都不同，但布局、间距、信息层级完全一致——选定后只需替换 <code>:root</code> 里那套变量。</p>
      <p class="meta">2026-11-11 · 6 版 · 数据为示意 · 对比度按 WCAG 2.1 实测</p>
    </div>
  </header>

  <nav class="legend">
    ${THEMES.map(t => `<a class="lg" href="#t-${t.id}"><b style="background:${t.vars['--primary-btn']}"></b>${t.name}</a>`).join('')}
  </nav>

  ${THEMES.map(section).join('\n')}

  <footer class="foot">
    <b>怎么用：</b>选中一版后，我把它的变量写进 <code>styles.css</code> 的 <code>:root</code>，并在设置页加一个「主题风格」下拉（现有浅色/深色之外再挂这套），可随时切换、跟系统深色联动需要再做一层映射。<br>
    <b>注意：</b>第 06 版本身就是深色，与现有深色主题会合并成一个；第 04 版用了衬线字体，若系统缺 Songti 会回退到雅黑。所有主按钮与正文对比度均 ≥ 4.5:1。
  </footer>
</div>
</body>
</html>`;

const outDir = __dirname; // 与脚本同目录，换机器也能跑
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, '主题方案-2026-11-11.html');
fs.writeFileSync(outPath, html, 'utf8');

console.log('written:', outPath, (html.length / 1024).toFixed(1) + 'KB');
THEMES.forEach(t => { const m = metrics(t); console.log(t.name.padEnd(18), '正文', f(m.body), '| 次要', f(m.sub), '| 按钮', f(m.btn), '| 选中', f(m.active)); });
