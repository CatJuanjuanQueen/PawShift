/* All project, task and protocol content is rendered as text, never HTML. */
const desktop = acquirePawShiftApi();
const saved = desktop.getState() || {};
let data = {
    projects: [],
    tasks: [],
    executions: [],
    events: [],
    quota: { windows: [] },
    settings: {},
    approvals: [],
  },
  page = saved.page || 'queue',
  selected = saved.selected,
  search = saved.search || '',
  filter = saved.filter || '',
  projectFilter = saved.projectFilter || '',
  pageNo = 0,
  step = 1,
  draft = saved.draft || {},
  editId = null,
  formError = '',
  message = '',
  busy = false;
function platformLabel() {
  if (data.settings.executionChannel === 'managed') return 'Codex 自动执行';
  return data.settings.executionChannel === 'codex-desktop'
    ? 'GPT 软件（Codex 桌面端）'
    : 'VS Code Codex';
}
let diagnosticPreview = '';
function applyTheme() {
  const theme = data.settings.theme || 'system';
  document.documentElement.dataset.theme = theme === 'system' ? '' : theme;
}
const pending = new Map();
const navs = [
  ['queue', '任务队列'],
  ['projects', '项目管理'],
  ['quota', '额度与连接'],
  ['history', '运行记录'],
  ['recovery', '恢复检查'],
  ['settings', '设置'],
];
const labels = {
  DRAFT: '草稿',
  QUEUED: '待执行',
  CLAIMED: '准备执行',
  RUNNING: '执行中',
  RECONCILING: '正在核对',
  VERIFYING: '待验收',
  PAUSED: '已暂停',
  SUCCEEDED: '已完成',
  FAILED: '失败需处理',
  CANCELLED: '已取消',
};
function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
const glyphs = {
  queue: 'M5 6h14M5 12h14M5 18h9M3 6h.01M3 12h.01M3 18h.01',
  projects: 'M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3ZM3 11h18',
  quota: 'M4 17a9 9 0 1 1 16 0M12 13l4-5M7 16h10',
  history: 'M4 7a9 9 0 1 1-1 8M4 3v5h5M12 7v5l3 2',
  recovery: 'm12 3 10 17H2ZM12 9v4m0 3h.01',
  settings: 'M9 4h6l1 3 3 1 1 6-3 2-1 4h-6l-1-3-4-1-1-6 3-2ZM9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0',
  paw: 'M7 14c-5 4-2 8 2 6l3-1 3 1c4 2 7-2 2-6-3-4-7-4-10 0ZM4 9c-2-4 2-6 3-2s-2 5-3 2Zm5-4c-1-4 4-5 4 0s-4 4-4 0Zm7 0c1-4 5-2 3 2s-5 2-3-2Zm5 6c2-4-2-5-3-2s1 5 3 2',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6ZM8 12l3 3 5-6',
  task: 'M8 3h8v4H8ZM8 5H5v16h14V5h-3M8 12h8M8 16h5',
  play: 'm8 5 11 7-11 7Z',
  pause: 'M8 5v14M16 5v14',
  stop: 'M6 6h12v12H6Z',
  refresh: 'M20 8a8 8 0 1 0 0 8M20 3v5h-5',
  check: 'm5 12 4 4L19 6',
  plus: 'M12 5v14M5 12h14',
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', glyphs[name] || glyphs.task);
  svg.append(path);
  return svg;
}
function button(text, fn, primary = false) {
  const b = el('button', text, primary ? 'primary' : '');
  b.type = 'button';
  const glyph = {
    执行任务: 'play',
    继续执行: 'play',
    暂停调度: 'pause',
    停止全部: 'stop',
    刷新状态: 'refresh',
    关联本地项目: 'projects',
    保存设置: 'check',
    允许本次: 'check',
    拒绝本次: 'stop',
  }[text];
  if (glyph) b.prepend(icon(glyph));
  b.onclick = async () => {
    if (b.disabled) return;
    b.disabled = true;
    try {
      await fn();
    } catch (e) {
      message = String(e);
      renderMessage();
    } finally {
      b.disabled = false;
      renderMessage();
    }
  };
  return b;
}
function persist() {
  desktop.setState({ page, selected, search, filter, projectFilter, draft });
}
function navigate(next, id) {
  page = next;
  selected = id;
  formError = '';
  persist();
  render();
}
function commandError(message) {
  return Error(String(message || '操作失败').replace(/^(?:Error:\s*)+/, ''));
}
function request(type, payload = {}, id = crypto.randomUUID()) {
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    desktop.postMessage({ type, payload, commandId: id });
  });
}
async function act(type, payload = {}) {
  const r = await request(type, payload);
  if (type === 'scheduler.execute' || type === 'scheduler.enable' || type === 'scheduler.pause') {
    if (r?.status === 'blocked') throw Error(r.message);
    message =
      type === 'scheduler.pause' && data.schedulingState === 'paused'
        ? '当前任务和队列已暂停，点击继续执行可恢复。'
        : r?.message || 'AGENT 执行状态已更新';
  } else
    message =
      type === 'task.handoff'
        ? '提示词已复制，请在对应项目的' +
          platformLabel() +
          '中粘贴并提交。' +
          (r.openError ? ' 自动打开失败，请手动打开所选软件。' : '')
        : '操作已完成';
  return r;
}
function date(t) {
  return t
    ? new Date(t).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) +
        ' 北京时间'
    : '待重新检查';
}
function renderMessage() {
  const e = document.getElementById('message');
  if (e) {
    e.textContent = message;
    e.classList.toggle('status-success', !message.includes('Error') && !message.includes('失败'));
  }
}
function empty(parent, text, action) {
  const e = el('div', undefined, 'empty');
  e.append(mascot('dog'), el('p', text));
  if (action) e.append(action);
  parent.append(e);
}
function card(parent, title, text) {
  const e = el('section', undefined, 'card');
  if (title) e.append(el('h2', title));
  if (text) e.append(el('p', text, 'muted'));
  parent.append(e);
  return e;
}
function actions(parent, ...buttons) {
  const e = el('div', undefined, 'actions');
  e.append(...buttons);
  parent.append(e);
  return e;
}
const fieldHelp = {
  任务目标: '写清要做什么、预期结果和注意事项。例如：修复登录按钮无响应，并保留现有页面样式。',
  人工验收: '写下判断完成的条件，一行一条。AGENT 会按这些条件工作；可配置文件检查来核对实际产物。',
  文件验收:
    '例如 src/login.ts，路径从项目文件夹开始写。只检查文件存在；填写右侧文本后，还会检查内容是否包含它。',
  文件必须: '例如 登录成功。按原样匹配文本，不会运行测试，也不会判断功能是否正确。',
  批量标题:
    '每行创建一个任务，共用本页目标和验收。后一个任务必须等前一个验收通过，适合分阶段工作。',
  允许路径:
    '例如 src 和 tests，一行一个；点号 . 表示整个项目。交接时作为修改范围说明，实际权限由执行软件控制。',
  计划方式:
    '立即：点击执行后参与调度；指定时间：到点后参与调度；前置完成后：勾选的任务全部完成后参与调度。',
  优先级: '数字越大越靠前，10 最高，0 最低，通常用 5。不会打断正在执行的任务。',
  最早开始: '使用北京时间。调度开启时，到点且满足其他条件后自动开始。',
  截止时间:
    '过了此时间将阻止尚未交接的任务，需要修改时间后继续；不会强制停止外部软件中已开始的任务。',
  前置完成后延迟:
    '从最后一个前置任务验收通过后开始计时。0 表示无需额外等待；未选前置任务时此项无效。',
  权限档:
    '只读分析用于查看与解释。自动修改需选择项目内修改，并允许路径 .；额外权限在 PawShift 中逐次确认。',
  最大轮次: '每项自动任务提交一次。复杂目标可拆分为多个任务并设置依赖。此字段保留兼容旧任务。',
  模型活动时间:
    '用于自动执行通道的超时控制。VS Code / GPT 软件交接模式下不会到点自动停止，请在执行软件里控制。',
};
function field(parent, title, type, value, onChange) {
  const wrap = el('div', undefined, 'field');
  const id = crypto.randomUUID();
  const label = el('label', title);
  label.htmlFor = id;
  const input = el(type === 'textarea' ? 'textarea' : 'input');
  input.id = id;
  if (type !== 'textarea') input.type = type;
  input.value = value ?? '';
  input.oninput = () => onChange(input.value);
  wrap.append(label, input);
  const help = Object.entries(fieldHelp).find(([key]) => title.startsWith(key))?.[1];
  if (help) {
    const hint = el('p', help, 'muted');
    hint.id = id + '-help';
    input.setAttribute('aria-describedby', hint.id);
    wrap.append(hint);
  }
  parent.append(wrap);
  return input;
}
function select(parent, title, options, value, onChange) {
  const wrap = el('div', undefined, 'field'),
    id = crypto.randomUUID(),
    label = el('label', title),
    input = el('select');
  label.htmlFor = id;
  input.id = id;
  for (const [key, name] of options) {
    const o = el('option', name);
    o.value = key;
    input.append(o);
  }
  input.value = value || '';
  input.onchange = () => onChange(input.value);
  wrap.append(label, input);
  const help = Object.entries(fieldHelp).find(([key]) => title.startsWith(key))?.[1];
  if (help) {
    const hint = el('p', help, 'muted');
    hint.id = id + '-help';
    input.setAttribute('aria-describedby', hint.id);
    wrap.append(hint);
  }
  parent.append(wrap);
  return input;
}
function newTask() {
  draft = {
    projectId: data.projects.find((p) => !p.archived)?.id || '',
    title: '',
    objective: '',
    acceptanceText: '',
    filePath: '',
    fileContains: '',
    dependencies: [],
    priority: 5,
    permission: 'restricted',
    allowedPathsText: '.',
    schedule: 'immediate',
    notBeforeLocal: '',
    deadlineLocal: '',
    delayMinutes: 0,
    maxTurns: 1,
    maxMinutes: 30,
  };
  step = 1;
  editId = null;
  navigate('new');
}
let draftTimer;
function change(key, value) {
  draft[key] = value;
  persist();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    request('draft.save', draft).catch((e) => {
      message = '草稿保存失败：' + e;
      renderMessage();
    });
  }, 1000);
}
function mascot(cls = 'mascot') {
  const e = el('div', undefined, cls);
  e.setAttribute('role', 'img');
  e.setAttribute('aria-label', '戴着蓝色项圈的 PawShift 小狗');
  return e;
}
function render() {
  applyTheme();
  const root = document.getElementById('app');
  root.replaceChildren();
  const skip = el('a', '跳到主要内容', 'skip-link');
  skip.href = '#main';
  root.append(skip);
  const shell = el('div', undefined, 'shell'),
    aside = el('aside');
  const brand = el('div', undefined, 'brand'),
    logo = el('img');
  logo.src = 'brand.svg';
  logo.alt = '';
  logo.width = 43;
  logo.height = 43;
  brand.append(logo, el('span', 'PawShift'));
  aside.append(
    brand,
    el('div', '你的小狗工作搭子', 'brand-subtitle'),
    el('div', 'WORKSPACE', 'nav-label'),
  );
  const nav = el('nav');
  nav.setAttribute('aria-label', '主要导航');
  for (const [id, name] of navs) {
    const b = button(name, () => navigate(id));
    b.prepend(icon(id));
    const active = id === page || (id === 'queue' && ['new', 'detail'].includes(page));
    b.classList.toggle('selected', active);
    if (active) b.setAttribute('aria-current', 'page');
    nav.append(b);
  }
  aside.append(nav);
  const mobile = el('select', undefined, 'mobile-nav');
  mobile.setAttribute('aria-label', '页面导航');
  for (const [id, name] of navs) {
    const o = el('option', name);
    o.value = id;
    mobile.append(o);
  }
  mobile.value = ['new', 'detail'].includes(page) ? 'queue' : page;
  mobile.onchange = () => navigate(mobile.value);
  aside.append(mobile);
  const note = el('div', undefined, 'sidebar-note');
  note.append(
    mascot(),
    el('strong', '认真工作，也记得休息'),
    el('p', '每一个任务，都有好好照看。'),
  );
  aside.append(note);
  const sideFooter = el('div', undefined, 'sidebar-footer');
  sideFooter.append(
    icon('shield'),
    el('span', '本地工作空间'),
    el('span', 'v' + (data.version || '0.3.3')),
  );
  aside.append(sideFooter);
  const main = el('main');
  main.id = 'main';
  main.tabIndex = -1;
  const header = el('div', undefined, 'top'),
    heading = el('div');
  const descriptions = {
    queue: '安排好任务，剩下的交给小狗搭子。',
    projects: '连接你的项目，让每个任务都有归属。',
    quota: '了解执行通道与账户额度。',
    history: '回看每一步进展，找到每一次完成。',
    recovery: '核对中断的任务，安心继续。',
    settings: '把工作空间调整成你习惯的样子。',
    new: '把目标说清楚，让任务有序开始。',
    detail: '查看任务进展、执行记录与验收结果。',
  };
  heading.append(
    el('div', 'PAWSHIFT / YOUR WORK COMPANION', 'eyebrow'),
    el(
      'h1',
      page === 'new'
        ? editId
          ? '编辑任务'
          : '新建任务'
        : page === 'detail'
          ? '任务详情'
          : navs.find((n) => n[0] === page)?.[1] || '任务队列',
    ),
    el('div', descriptions[page] || descriptions.queue, 'muted'),
  );
  header.append(heading, button('＋ 新建任务', newTask, true));
  main.append(header);
  const msg = el('div', message, 'error');
  msg.id = 'message';
  msg.classList.toggle('status-success', !message.includes('Error') && !message.includes('失败'));
  msg.setAttribute('role', 'status');
  main.append(msg);
  if (data.settings.executionChannel === 'app-server' && !data.settings.sandboxValidated)
    main.append(
      el(
        'div',
        '当前可管理任务、手动交接并验收。自动执行需通过真实接入与 Windows 沙箱验证。',
        'notice',
      ),
    );
  const area = el('div');
  main.append(area);
  shell.append(aside, main);
  root.append(shell);
  (
    ({
      queue: queuePage,
      projects: projectsPage,
      quota: quotaPage,
      history: historyPage,
      recovery: recoveryPage,
      settings: settingsPage,
      new: formPage,
      detail: detailPage,
    })[page] || queuePage
  )(area);
  const footer = el('footer', undefined, 'page-footer');
  footer.append(icon('paw'), el('span', 'PawShift · 陪你把每一件事做好'));
  main.append(footer);
}
function queuePage(root) {
  const hero = el('section', undefined, 'welcome'),
    copy = el('div', undefined, 'welcome-copy'),
    kicker = el('div', undefined, 'welcome-kicker');
  kicker.append(icon('paw'), el('span', 'A LITTLE PAW, A BIG HELP'));
  copy.append(
    kicker,
    el('h2', '大事小事，一起搞定。'),
    el('p', '把想做的事放进队列，一次专注一个目标。小狗搭子陪你安排进度，照看每一步。'),
  );
  const art = el('div', undefined, 'welcome-art');
  art.append(mascot());
  hero.append(copy, art);
  root.append(hero);
  const stats = el('div', undefined, 'stats');
  const counts = [
    ['执行中', 'play'],
    ['待执行', 'queue'],
    ['等待额度', 'quota'],
    ['待处理', 'recovery'],
  ];
  for (const [label, glyph] of counts) {
    const c = el('div', undefined, 'card stat'),
      name = el('div', undefined, 'stat-label');
    name.append(icon(glyph), el('span', label));
    c.append(name, el('strong', '0'));
    stats.append(c);
  }
  root.append(stats);
  const notice = el('section', undefined, 'notice queue-control');
  notice.id = 'queueNotice';
  root.append(notice);
  updateQueueStatus();
  const approvals = el('div');
  approvals.id = 'queueApprovals';
  root.append(approvals);
  renderApprovals(approvals);
  const panel = el('section', undefined, 'task-panel'),
    title = el('div', undefined, 'section-heading');
  title.append(
    el('h2', '我的任务'),
    el(
      'span',
      data.settings.queueMode === 'sequence' ? '按队列顺序执行' : '优先级优先 · 同级按顺序',
      'muted',
    ),
  );
  panel.append(title);
  const filters = el('div', undefined, 'filters');
  const searchInput = field(filters, '搜索任务、ID 或项目', 'search', search, (v) => {
    search = v;
    pageNo = 0;
    persist();
    renderRows();
  });
  searchInput.id = 'search';
  filters.querySelector('label').htmlFor = 'search';
  searchInput.placeholder = '输入关键词，找到任务…';
  select(filters, '生命周期', [['', '全部状态'], ...Object.entries(labels)], filter, (v) => {
    filter = v;
    pageNo = 0;
    persist();
    renderRows();
  });
  select(
    filters,
    '项目',
    [['', '全部项目'], ...data.projects.map((p) => [p.id, p.name])],
    projectFilter,
    (v) => {
      projectFilter = v;
      pageNo = 0;
      persist();
      renderRows();
    },
  );
  const rows = el('div');
  rows.id = 'rows';
  panel.append(filters, rows);
  root.append(panel);
  renderRows();
}
function renderRows() {
  const root = document.getElementById('rows');
  if (!root) return;
  root.replaceChildren();
  const tasks = data.tasks
    .filter(
      (t) =>
        (!filter || t.lifecycle === filter) &&
        (!projectFilter || t.projectId === projectFilter) &&
        [t.title, t.id, data.projects.find((p) => p.id === t.projectId)?.name]
          .join(' ')
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort(
      (a, b) =>
        (data.settings.queueMode === 'sequence' ? 0 : b.priority - a.priority) ||
        (a.queueOrder || 0) - (b.queueOrder || 0) ||
        a.createdAt - b.createdAt,
    );
  const totalPages = Math.max(1, Math.ceil(tasks.length / 30));
  pageNo = Math.min(Math.max(0, pageNo), totalPages - 1);
  root.append(el('p', '当前显示 ' + tasks.length + ' 项', 'muted rows-summary'));
  if (!tasks.length) {
    empty(
      root,
      data.tasks.length ? '没有符合当前筛选的任务' : '还没有任务，创建第一个任务开始排队',
      button(
        data.tasks.length ? '清除筛选' : '新建任务',
        () => {
          if (data.tasks.length) {
            search = filter = projectFilter = '';
            pageNo = 0;
            persist();
            render();
          } else newTask();
        },
        true,
      ),
    );
    return;
  }
  for (const t of tasks.slice(pageNo * 30, (pageNo + 1) * 30)) {
    const row = el('div', undefined, 'row'),
      info = el('div', undefined, 'row-info'),
      symbol = el('div', undefined, 'task-symbol'),
      copy = el('div', undefined, 'task-copy');
    symbol.append(
      icon(t.lifecycle === 'SUCCEEDED' ? 'check' : t.lifecycle === 'RUNNING' ? 'play' : 'task'),
    );
    const title = button(t.title, () => navigate('detail', t.id));
    title.className = 'task-title';
    copy.append(
      title,
      el(
        'div',
        (data.projects.find((p) => p.id === t.projectId)?.name || '未关联项目') +
          ' · ' +
          (t.notBefore ? date(t.notBefore) : '立即 / 前置后'),
        'muted',
      ),
    );
    if (t.waitReasons.length) copy.append(el('div', t.waitReasons[0], 'muted'));
    info.append(symbol, copy);
    const state = el('div');
    state.append(
      el('span', labels[t.lifecycle] || t.lifecycle, 'tag ' + t.lifecycle.toLowerCase()),
    );
    if (t.lifecycle === 'PAUSED') {
      const resume = button('继续此任务', () => act('scheduler.execute', { taskId: t.id }));
      resume.disabled = ['starting', 'pausing'].includes(data.schedulingState);
      state.append(resume);
    }
    row.append(info, state, el('div', '优先级 ' + t.priority, 'priority'));
    root.append(row);
  }
  const pagination = el('div', undefined, 'pagination'),
    prev = button('上一页', () => {
      pageNo--;
      renderRows();
    }),
    next = button('下一页', () => {
      pageNo++;
      renderRows();
    });
  prev.disabled = pageNo === 0;
  next.disabled = pageNo >= totalPages - 1;
  pagination.append(prev, el('span', pageNo + 1 + ' / ' + totalPages), next);
  root.append(pagination);
}
function projectsPage(root) {
  actions(
    root,
    button('关联本地项目', () => act('project.add'), true),
  );
  for (const p of data.projects) {
    const count = data.tasks.filter((t) => t.projectId === p.id).length;
    const c = card(
      root,
      p.name,
      p.archived
        ? '项目已归档'
        : p.trusted !== true
          ? '尚未授权，点击执行时会请你确认项目访问。'
          : '已授权 AGENT 按任务配置访问项目',
    );
    c.append(el('pre', p.root || p.uri), el('p', count + ' 个任务', 'muted'));
    const controls = [
      button(p.archived ? '恢复项目' : '归档项目', () => act('project.archive', { id: p.id })),
      button(p.trusted === true ? '撤销项目授权' : '允许访问项目', () =>
        act('project.trust', { id: p.id, trusted: p.trusted !== true }),
      ),
    ];
    if (p.accountKey && p.accountKey !== data.quota.accountKey)
      controls.push(button('更新账户关联', () => act('project.bind', { id: p.id })));
    actions(c, ...controls);
  }
  if (!data.projects.length) empty(root, '先关联本地项目，再创建任务。');
}
function quotaPage(root) {
  const connection = card(
    root,
    'AGENT 连接',
    data.error ||
      data.quota.error ||
      (data.quota.accountKey ? 'ChatGPT 账户已连接' : '尚未确认登录状态，请检查连接或在设置中登录'),
  );
  connection.append(
    el('p', '执行组件：' + (data.capabilities?.version || '等待检查'), 'muted'),
    el(
      'p',
      data.capabilities?.sandboxReady ? '执行沙箱已就绪' : '执行沙箱尚未确认，请在设置中初始化',
      'muted',
    ),
    el('p', '更新时间：' + date(data.quota.observedAt), 'muted'),
  );
  actions(
    connection,
    button('立即检查', () => act('quota.refresh'), true),
    button('打开设置', () => navigate('settings')),
  );
  for (const w of data.quota.windows) {
    const expired = Date.now() - data.quota.observedAt > 300000;
    const c = card(
      root,
      w.name,
      w.usedPercent === null
        ? '额度未知'
        : (expired ? '上次观测，已过期：' : '剩余：') +
            Math.max(0, 100 - w.usedPercent).toFixed(1) +
            '%',
    );
    const bar = el('progress');
    bar.max = 100;
    if (w.usedPercent !== null) bar.value = Math.max(0, 100 - w.usedPercent);
    bar.setAttribute('aria-label', w.name + '剩余额度');
    c.append(
      bar,
      el(
        'p',
        '重置：' + date(w.resetsAt) + ' · 启动阈值 ' + (data.settings.quotaThreshold || 5) + '%',
        'muted',
      ),
    );
  }
  if (!data.quota.windows.length)
    card(root, '账户额度', '暂无可用观测。请检查连接；额度未知时不会自动派发任务。');
}
function settingsPage(root) {
  const c = card(
    root,
    'AGENT 与桌面设置',
    '点击执行后，PawShift 直接调用本机 Codex AGENT，在项目目录内完成任务。',
  );
  const executionChannel = 'managed';
  c.append(el('p', '执行方式：本机 Codex AGENT · ChatGPT 登录 · 自动串行执行', 'muted'));
  let queueMode = data.settings.queueMode || 'priority',
    threshold = data.settings.quotaThreshold || 5,
    codexPath = data.settings.codexPath || '',
    theme = data.settings.theme || 'system',
    closeBehavior = data.settings.closeBehavior || 'quit';
  select(
    c,
    '执行顺序',
    [
      ['priority', '优先级优先（同级按队列顺序）'],
      ['sequence', '按队列顺序'],
    ],
    queueMode,
    (v) => (queueMode = v),
  );
  const n = field(
    c,
    '额度不足时暂停阈值（5–100%）',
    'number',
    threshold,
    (v) => (threshold = Number(v)),
  );
  n.min = 5;
  n.max = 100;
  const pathInput = field(
    c,
    'Codex 执行组件路径（留空自动识别）',
    'text',
    codexPath,
    (v) => (codexPath = v),
  );
  actions(
    c,
    button('选择 Codex 程序', async () => {
      const r = await act('settings.chooseCodex');
      if (r.path) {
        codexPath = r.path;
        pathInput.value = r.path;
      }
    }),
  );
  select(
    c,
    '界面主题',
    [
      ['system', '跟随系统'],
      ['light', '浅色'],
      ['dark', '深色'],
    ],
    theme,
    (v) => (theme = v),
  );
  select(
    c,
    '关闭窗口时',
    [
      ['quit', '退出软件并停止当前执行'],
      ['tray', '隐藏至系统托盘，软件继续运行'],
    ],
    closeBehavior,
    (v) => (closeBehavior = v),
  );
  actions(
    c,
    button(
      '保存设置',
      async () => {
        await act('settings.save', {
          executionChannel,
          queueMode,
          quotaThreshold: threshold,
          codexPath,
          theme,
          closeBehavior,
        });
        applyTheme();
      },
      true,
    ),
  );
  const connection = card(
    root,
    'AGENT 连接',
    data.error ||
      (data.settings.codexDetected
        ? '已找到本机 Codex 执行组件'
        : '未找到执行组件，请选择 codex.exe'),
  );
  connection.append(
    el('p', data.quota.accountKey ? 'ChatGPT 账户已连接' : '尚未确认登录状态，请检查连接或登录'),
    el('p', data.capabilities?.sandboxReady ? '项目执行沙箱已就绪' : '首次使用请初始化执行沙箱'),
  );
  actions(
    connection,
    button('登录 ChatGPT', () => act('account.login')),
    button('初始化执行沙箱', () => act('sandbox.setup')),
    button('检查连接', () => act('quota.refresh')),
  );
  const storage = card(
    root,
    '数据与备份',
    '项目、任务和 AGENT 结果保存在本机。每天启动创建一致性备份，最多保留 7 份。',
  );
  storage.append(el('pre', data.dataDir || 'Windows 用户应用数据目录'));
  actions(
    storage,
    button('打开数据目录', () => act('storage.open')),
    button('创建一致性备份', async () => {
      const r = await act('backup.create');
      message = '备份位置：' + r.path;
      renderMessage();
    }),
    button('导入旧版 / 独立版备份', async () => {
      const r = await act('storage.import');
      if (r) {
        message = '已导入 ' + r.imported + ' 个任务，请重新授权项目并核对活动执行';
        render();
      }
    }),
  );
  const diagnostics = card(
    root,
    '脱敏诊断',
    '仅包含连接状态、任务状态与路径；不包含任务正文和 AGENT 回复。',
  );
  actions(
    diagnostics,
    button('预览脱敏诊断', async () => {
      const r = await act('diagnostics.export');
      diagnosticPreview = r.preview;
      render();
    }),
  );
  if (diagnosticPreview) {
    diagnostics.append(el('pre', diagnosticPreview, 'log'));
    actions(
      diagnostics,
      button('保存诊断 JSON', async () => {
        const r = await act('diagnostics.save');
        message = r.path ? '已保存：' + r.path : '已取消保存';
        renderMessage();
      }),
    );
  }
  card(
    root,
    '执行与恢复',
    '每次点击执行开启队列。当前任务完成并通过文件验收后，自动继续下一项。失败、中断或待确认权限会显示具体原因。重新打开软件后需再次点击执行；未确认停止的旧任务先在恢复检查中核对。',
  );
}
function historyPage(root) {
  for (const e of [...data.executions].reverse()) {
    const t = data.tasks.find((t) => t.id === e.taskId),
      c = card(root, t?.title || e.taskId, labels[e.state] || e.state);
    c.append(
      el(
        'p',
        'revision ' +
          e.revision +
          ' · ' +
          date(e.startedAt) +
          ' → ' +
          (e.endedAt ? date(e.endedAt) : '尚未结束'),
        'muted',
      ),
      el('p', '用量：协议未提供，不按 0 计算', 'muted'),
      el('pre', e.id),
    );
    actions(
      c,
      button('查看任务', () => navigate('detail', e.taskId)),
    );
  }
  if (!data.executions.length) empty(root, '尚无执行记录。');
}
function recoveryPage(root) {
  if (data.integrationPending) {
    const c = card(root, '接入验收尚未核对', '新的接入测试与自动派发已阻止。');
    c.append(el('pre', JSON.stringify(data.integrationPending, null, 2)));
    let reason = '';
    field(c, '已核对旧测试、进程与副作用停止的证据', 'textarea', '', (v) => (reason = v));
    actions(
      c,
      button('重新核对接入测试', () => act('integration.check')),
      button('人工确认测试已停止', () => act('integration.stopped', { reason })),
    );
  }
  const items = data.executions.filter((e) => e.endedAt === null && e.state === 'RECONCILING');
  for (const e of items) {
    const c = card(
      root,
      data.tasks.find((t) => t.id === e.taskId)?.title,
      '执行可能已发生，先核对再继续。现有锁保留。',
    );
    c.append(
      el(
        'pre',
        JSON.stringify(
          {
            executionId: e.id,
            threadId: e.threadId,
            turnId: e.turnId,
            sendState: e.sendState,
            baseline: e.baseline,
            evidence: e.evidence,
          },
          null,
          2,
        ),
      ),
    );
    let reason = '';
    field(
      c,
      '确认旧执行停止的证据：轮次、进程与文件副作用（至少 10 字符）',
      'textarea',
      '',
      (v) => (reason = v),
    );
    actions(
      c,
      button('重新核对', () => act('recovery.check', { id: e.id }), true),
      button('确认已停止，保持暂停', () => act('recovery.stopped', { id: e.id, reason })),
      button('查看详情', () => navigate('detail', e.taskId)),
    );
  }
  if (!items.length) empty(root, '当前没有待核对执行。');
}
function detailPage(root) {
  const t = data.tasks.find((t) => t.id === selected);
  if (!t) {
    empty(root, '任务不存在');
    return;
  }
  const c = card(root, t.title, labels[t.lifecycle]);
  c.append(
    el('pre', t.id + ' · revision ' + t.revision + ' · version ' + t.version),
    el('p', t.objective),
    el('div', t.waitReasons.join('\n') || '当前无已记录阻塞', 'notice'),
  );
  const buttons = [button('返回队列', () => navigate('queue'))];
  if (t.lifecycle === 'DRAFT')
    buttons.push(button('入队', () => act('task.resume', { id: t.id }), true));
  if (t.lifecycle === 'PAUSED')
    buttons.push(button('继续此任务', () => act('scheduler.execute', { taskId: t.id }), true));
  if (
    data.settings.executionChannel !== 'managed' &&
    (t.lifecycle === 'QUEUED' || t.lifecycle === 'DRAFT')
  )
    buttons.push(
      button('复制任务并打开 ' + platformLabel(), () => act('task.handoff', { id: t.id }), true),
    );
  if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(t.lifecycle)) {
    buttons.push(
      button('暂停任务', () => act('task.pause', { id: t.id })),
      button('取消任务', () => act('task.cancel', { id: t.id })),
    );
  }
  buttons.push(button('克隆为新草稿', () => act('task.clone', { id: t.id })));
  if (['DRAFT', 'QUEUED', 'PAUSED'].includes(t.lifecycle))
    buttons.push(
      button('编辑任务', () => {
        editId = t.id;
        draft = {
          ...t,
          acceptanceText: t.acceptance
            .filter((c) => c.type === 'manual')
            .map((c) => c.requirement)
            .join('\n'),
          filePath: t.acceptance.find((c) => c.type === 'file')?.path || '',
          fileContains: t.acceptance.find((c) => c.type === 'file')?.contains || '',
          allowedPathsText: t.allowedPaths.join('\n'),
          schedule: t.notBefore ? 'time' : 'immediate',
          notBeforeLocal: t.notBefore
            ? new Date(t.notBefore + 8 * 3600000).toISOString().slice(0, 16)
            : '',
          deadlineLocal: t.deadline
            ? new Date(t.deadline + 8 * 3600000).toISOString().slice(0, 16)
            : '',
          delayMinutes: t.delayMs / 60000,
        };
        step = 1;
        navigate('new');
      }),
    );
  actions(c, ...buttons);
  const checks = card(root, '验收标准');
  for (const item of t.acceptance)
    checks.append(el('p', (item.type === 'manual' ? '人工：' : '文件：') + item.requirement));
  const e = [...data.executions].reverse().find((e) => e.taskId === t.id);
  if (e) {
    const result = card(
      root,
      'AGENT 执行结果',
      e.activity || (e.endedAt ? '执行已结束' : '等待 AGENT 返回结果'),
    );
    result.append(el('pre', e.output || '尚无文字结果，执行进展与文件修改会持续更新。', 'log'));
    const proof = card(root, '执行与验收证据');
    proof.append(el('pre', JSON.stringify(e.evidence, null, 2)));
    if (e.state === 'VERIFYING') {
      let reason = '';
      field(
        proof,
        '人工验收理由（执行结束后填写，并核对当前 revision）',
        'textarea',
        '',
        (v) => (reason = v),
      );
      actions(
        proof,
        button(
          '检查文件 / 人工接受',
          () => act('task.accept', { executionId: e.id, reason: reason || undefined }),
          true,
        ),
      );
    }
    {
      const log = card(root, '最近执行日志');
      const events = data.events.filter((v) => v.execution_id === e.id).reverse();
      const content = el(
        'pre',
        events
          .map(
            (v) => date(v.observed_at) + ' ' + v.type + '\n' + JSON.stringify(v.payload, null, 2),
          )
          .join('\n\n'),
        'log',
      );
      log.append(content);
    }
    card(root, '工作区执行前基线').append(el('pre', JSON.stringify(e.baseline, null, 2)));
  }
}
function taskInput() {
  const checks = (draft.acceptanceText || '')
    .split('\n')
    .filter((s) => s.trim())
    .map((requirement, i) => ({ id: 'manual-' + i, type: 'manual', requirement }));
  if (draft.filePath)
    checks.push({
      id: 'file-1',
      type: 'file',
      requirement:
        '文件 ' + draft.filePath + ' 存在' + (draft.fileContains ? '且包含指定文本' : ''),
      path: draft.filePath,
      contains: draft.fileContains || undefined,
    });
  if (!checks.length && data.settings.executionChannel === 'managed')
    checks.push({ id: 'completion', type: 'manual', requirement: '执行端完成任务目标' });
  const utc = (value) => (value ? new Date(value + ':00+08:00').getTime() : null);
  return {
    projectId: draft.projectId,
    title: draft.title,
    objective: draft.objective,
    acceptance: checks,
    dependencies: draft.dependencies || [],
    priority: Number(draft.priority ?? 5),
    notBefore: draft.schedule === 'time' ? utc(draft.notBeforeLocal) : null,
    deadline: utc(draft.deadlineLocal),
    delayMs: Number(draft.delayMinutes || 0) * 60000,
    allowedPaths: (draft.allowedPathsText || '.').split('\n').filter(Boolean),
    permission: draft.permission || 'read-only',
    maxTurns: Number(draft.maxTurns || 1),
    maxMinutes: Number(draft.maxMinutes || 30),
  };
}
function taskPreview(input) {
  const summary = el('div');
  if (!input) return summary;
  const project = data.projects.find((p) => p.id === input.projectId);
  summary.append(
    el('h2', input.title || '未填写标题'),
    el('p', '项目：' + (project?.name || '未选择项目')),
    el('p', input.objective),
  );
  const checks = el('div');
  checks.append(el('h3', '验收标准'));
  for (const check of input.acceptance)
    checks.append(
      el('p', (check.type === 'manual' ? '人工确认：' : '文件检查：') + check.requirement),
    );
  summary.append(
    checks,
    el(
      'p',
      '权限：' +
        (input.permission === 'read-only' ? '只读分析' : '项目内修改') +
        '；允许路径：' +
        input.allowedPaths.join('、'),
    ),
    el(
      'p',
      '优先级：' +
        input.priority +
        '；最早开始：' +
        (input.notBefore ? date(input.notBefore) : '立即参与排队'),
    ),
    el(
      'p',
      '前置任务：' +
        (input.dependencies
          .map((id) => data.tasks.find((t) => t.id === id)?.title || id)
          .join('、') || '无') +
        '；前置延迟：' +
        input.delayMs / 60000 +
        ' 分钟',
    ),
    el(
      'p',
      '截止时间：' +
        (input.deadline ? date(input.deadline) : '不设置') +
        '；每项提交一次 / 模型活动时间 ' +
        input.maxMinutes +
        ' 分钟',
    ),
  );
  return summary;
}
function formPage(root) {
  if (!draft.projectId && data.projects.length) draft.projectId = data.projects[0].id;
  const steps = el('div', undefined, 'steps');
  ['1 目标与验收', '2 计划与权限', '3 检查并保存'].forEach((v, i) =>
    steps.append(el('span', v, step === i + 1 ? 'current' : '')),
  );
  root.append(steps);
  const c = card(root);
  if (step === 1) {
    select(
      c,
      '项目 *',
      data.projects.filter((p) => !p.archived).map((p) => [p.id, p.name]),
      draft.projectId,
      (v) => change('projectId', v),
    );
    field(c, '标题 *（最多 120 字符）', 'text', draft.title, (v) => change('title', v));
    field(c, '任务目标 *', 'textarea', draft.objective, (v) => change('objective', v));
    field(
      c,
      data.settings.executionChannel === 'managed'
        ? '完成条件（选填，一行一项）'
        : '人工验收标准 *（一行一项；文件验收也可独立使用）',
      'textarea',
      draft.acceptanceText,
      (v) => change('acceptanceText', v),
    );
    const grid = el('div', undefined, 'form-grid');
    field(grid, '文件验收：项目内相对路径（可选）', 'text', draft.filePath, (v) =>
      change('filePath', v),
    );
    field(grid, '文件必须包含的文本（可选）', 'text', draft.fileContains, (v) =>
      change('fileContains', v),
    );
    c.append(grid);
    if (!editId)
      field(
        c,
        '批量标题（选填，一行一个任务；保存时默认建立顺序依赖）',
        'textarea',
        draft.batchTitles,
        (v) => change('batchTitles', v),
      );
    field(c, '允许路径（一行一个项目内相对路径）', 'textarea', draft.allowedPathsText, (v) =>
      change('allowedPathsText', v),
    );
  }
  if (step === 2) {
    const grid = el('div', undefined, 'form-grid');
    select(
      grid,
      '计划方式',
      [
        ['immediate', '立即参与调度'],
        ['time', '指定最早开始时间'],
        ['dependency', '前置完成后'],
      ],
      draft.schedule,
      (v) => {
        change('schedule', v);
        render();
      },
    );
    field(grid, '优先级 0–10', 'number', draft.priority, (v) => change('priority', v));
    if (draft.schedule === 'time')
      field(grid, '最早开始时间（Asia/Shanghai）', 'datetime-local', draft.notBeforeLocal, (v) =>
        change('notBeforeLocal', v),
      );
    field(grid, '截止时间（可选，Asia/Shanghai）', 'datetime-local', draft.deadlineLocal, (v) =>
      change('deadlineLocal', v),
    );
    field(grid, '前置完成后延迟（分钟）', 'number', draft.delayMinutes, (v) =>
      change('delayMinutes', v),
    );
    select(
      grid,
      '权限档',
      [
        ['read-only', '只读分析'],
        ['restricted', '项目内修改（自动模式需允许路径 .）'],
      ],
      draft.permission,
      (v) => change('permission', v),
    );
    field(grid, '模型活动时间上限 1–30 分钟', 'number', draft.maxMinutes, (v) =>
      change('maxMinutes', v),
    );
    c.append(
      grid,
      el(
        'p',
        '自动模式在前置任务完成后继续后继任务；每项提交一次，失败或中断不会解除依赖。',
        'muted',
      ),
    );
    for (const t of data.tasks.filter((t) => t.projectId === draft.projectId && t.id !== editId)) {
      const l = el('label', undefined, 'checkbox'),
        i = el('input');
      i.type = 'checkbox';
      i.checked = (draft.dependencies || []).includes(t.id);
      i.onchange = () =>
        change(
          'dependencies',
          i.checked
            ? [...(draft.dependencies || []), t.id]
            : (draft.dependencies || []).filter((id) => id !== t.id),
        );
      l.append(i, el('span', t.title + ' · ' + labels[t.lifecycle]));
      c.append(l);
    }
  }
  if (step === 3) {
    let input;
    try {
      input = taskInput();
    } catch (e) {
      formError = String(e);
    }
    const batch = (draft.batchTitles || '').split('\n').filter((v) => v.trim());
    if (batch.length)
      c.append(
        el(
          'p',
          '将创建 ' + batch.length + ' 个顺序依赖任务，共用目标、验收、计划与权限。',
          'notice',
        ),
      );
    c.append(
      el(
        'p',
        ['app-server', 'managed'].includes(data.settings.executionChannel)
          ? data.enabled
            ? '调度已开启：符合门槛后执行。'
            : '调度已暂停。'
          : '保存后进入队列。请在任务详情点击交接，到' + platformLabel() + '粘贴并提交。',
        'notice',
      ),
      taskPreview(input),
      el(
        'p',
        'AGENT 完成后检查文件验收条件，并在任务详情展示结果。项目内修改需允许整个项目（路径 .）；授权请求回到 PawShift，仅允许本次操作。',
        'muted',
      ),
    );
  }
  const err = el('div', formError, 'error');
  err.setAttribute('role', 'alert');
  c.append(err);
  const saveId = crypto.randomUUID();
  const save = async (draftOnly) => {
    if (busy) return;
    busy = true;
    try {
      const input = taskInput();
      if (
        !input.projectId ||
        !input.title?.trim() ||
        !input.objective?.trim() ||
        !input.acceptance.length
      )
        throw Error('请填写项目、标题、目标和至少一项验收');
      if (draft.schedule === 'time' && !draft.notBeforeLocal) throw Error('请填写指定时间');
      if (draft.schedule === 'dependency' && !input.dependencies.length)
        throw Error('前置完成计划必须选择依赖');
      if (editId)
        await request('task.update', { id: editId, version: draft.version, task: input }, saveId);
      else {
        const titles = (draft.batchTitles || '')
          .split('\n')
          .map((v) => v.trim())
          .filter(Boolean);
        const tasks = titles.length
          ? titles.map((title, index) => ({
              ...input,
              title,
              dependencies: index ? ['@previous'] : input.dependencies,
            }))
          : [input];
        await request('task.create', { tasks, draft: draftOnly }, saveId);
      }
      draft = {};
      persist();
      navigate('queue');
    } catch (e) {
      formError = '保存失败，输入已保留：' + String(e);
      render();
    } finally {
      busy = false;
    }
  };
  const controls = [];
  if (step > 1)
    controls.push(
      button('上一步', () => {
        step--;
        render();
      }),
    );
  if (step < 3)
    controls.push(
      button(
        '下一步',
        () => {
          step++;
          render();
        },
        true,
      ),
    );
  else
    controls.push(
      button(editId ? '保存修改' : '保存并入队', () => save(false), true),
      button('仅保存草稿', () => save(true)),
    );
  controls.push(button('返回队列', () => navigate('queue')));
  actions(c, ...controls);
}
window.addEventListener('message', (event) => {
  const m = event.data;
  if (m.type === 'response') {
    const p = pending.get(m.commandId);
    if (p) {
      pending.delete(m.commandId);
      m.ok ? p.resolve(m.data) : p.reject(commandError(m.error));
    }
  }
  if (m.type === 'snapshot') {
    if (m.data.revision <= (data.revision || 0)) return;
    if (m.data.schedulingState === 'paused' && data.schedulingState === 'pausing') {
      message = '当前任务和队列已暂停，点击继续执行可恢复。';
      renderMessage();
    }
    data = m.data;
    applyTheme();
    if (!Object.keys(draft).length && data.draft) draft = data.draft;
    const focus = document.activeElement,
      editing = focus && ['INPUT', 'TEXTAREA', 'SELECT'].includes(focus.tagName);
    if (page === 'queue' && document.getElementById('rows')) {
      renderRows();
      updateQueueStatus();
      const approvals = document.getElementById('queueApprovals');
      if (approvals) renderApprovals(approvals);
    } else if (page !== 'new' && !editing) render();
  }
  if (m.type === 'navigate') {
    if (m.page === 'new') newTask();
    else navigate(m.page || 'detail', m.id);
  }
});
render();
request('view.subscribe')
  .then((snapshot) => {
    data = snapshot;
    if (!Object.keys(draft).length && data.draft) draft = data.draft;
    render();
  })
  .catch((e) => {
    message = String(e);
    render();
  });

function renderApprovals(root) {
  root.replaceChildren();
  for (const a of data.approvals) {
    const c = card(root, '需要本次权限', a.params?.reason || '执行端正在等待你的决定');
    c.classList.add('approval-card');
    c.append(
      el(
        'p',
        a.method === 'item/commandExecution/requestApproval'
          ? '请求运行命令'
          : a.method === 'item/fileChange/requestApproval'
            ? '请求修改文件'
            : '执行端需要交互处理',
      ),
    );
    if (a.params?.command) c.append(el('pre', a.params.command));
    if (a.params?.cwd) c.append(el('p', '工作目录：' + a.params.cwd, 'muted'));
    if (a.params?.grantRoot) c.append(el('p', '请求访问目录：' + a.params.grantRoot));
    if (!a.canAllow)
      c.append(
        el(
          'p',
          data.schedulingState === 'pausing'
            ? '任务正在暂停，此授权已禁止放行。'
            : '此授权已失效或暂不支持，可拒绝本次。',
        ),
      );
    actions(
      c,
      ...(a.canAllow
        ? [button('允许本次', () => act('approval.allow', { key: a.key }), true)]
        : []),
      button('拒绝本次', () => act('approval.reject', { key: a.key })),
    );
  }
}
function updateQueueStatus() {
  const counts = [
    data.tasks.filter((t) => ['CLAIMED', 'RUNNING'].includes(t.lifecycle)).length,
    data.tasks.filter((t) => t.lifecycle === 'QUEUED').length,
    data.tasks.filter((t) => t.waitReasons.some((r) => r.startsWith('QUOTA'))).length,
    data.tasks.filter((t) => ['RECONCILING', 'VERIFYING', 'FAILED'].includes(t.lifecycle)).length,
  ];
  document.querySelectorAll('.stat strong').forEach((e, i) => (e.textContent = String(counts[i])));
  const n = document.getElementById('queueNotice');
  if (n) {
    const state = data.schedulingState || (data.enabled ? 'enabled' : 'idle'),
      pausing = state === 'pausing',
      paused = state === 'paused',
      starting = state === 'starting';
    const copy = el('div'),
      title = el('h2');
    title.append(
      icon(data.enabled ? 'play' : 'pause'),
      el(
        'span',
        pausing
          ? '正在暂停，请稍候'
          : paused
            ? '任务和队列已暂停'
            : starting
              ? '正在连接 AGENT'
              : data.enabled
                ? '自动调度已开启'
                : '准备好，就出发',
      ),
    );
    const description = pausing
      ? '已停止派发，正在等待 AGENT 确认当前任务和工具停止。确认前不能继续；长时间未确认可核对暂停状态。'
      : paused
        ? '点击继续执行，将沿用原会话核对已有工作并完成剩余目标，再处理后续队列。'
        : starting
          ? '正在检查授权与执行环境，可以随时暂停启动。'
          : data.enabled
            ? '当前任务完成后继续下一项；暂停调度会同时暂停当前任务和队列。'
            : '点击执行任务，小狗搭子会按依赖和所选顺序逐项执行。';
    copy.append(title, el('p', description));
    const resumeTarget =
      data.tasks.find((t) => t.id === data.resumeTaskId) ||
      ((paused || starting) && data.tasks.filter((t) => t.lifecycle === 'PAUSED').length === 1
        ? data.tasks.find((t) => t.lifecycle === 'PAUSED')
        : null);
    if (resumeTarget)
      copy.append(el('p', (starting ? '正在恢复：' : '待继续：') + resumeTarget.title));
    if (data.error) copy.append(el('p', 'AGENT：' + data.error, 'error'));
    n.replaceChildren(copy);
    const run = button(paused ? '继续执行' : '执行任务', () => act('scheduler.execute'), true);
    run.disabled = pausing || starting;
    const stop = button('停止全部', () => act('scheduler.stopAll'));
    stop.classList.add('stop');
    const current = data.executions.find((e) => e.endedAt === null);
    actions(
      n,
      run,
      ...(data.enabled || starting ? [button('暂停调度', () => act('scheduler.pause'))] : []),
      ...(pausing && current
        ? [button('核对暂停状态', () => act('recovery.check', { id: current.id }))]
        : []),
      button('刷新状态', () => act('quota.refresh')),
      stop,
    );
  }
}
