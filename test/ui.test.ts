import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const { JSDOM } = require('jsdom');
const code = readFileSync(join(process.cwd(), 'ui/app.js'), 'utf8');
function page() {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'https://example.test',
    runScripts: 'outside-only',
  });
  const w = dom.window;
  const messages: any[] = [];
  w.acquirePawShiftApi = () => ({
    getState: () => null,
    setState: () => {},
    postMessage: (m: any) => {
      messages.push(m);
      if (m.type === 'view.subscribe')
        setTimeout(() => {
          w.dispatchEvent(
            new w.MessageEvent('message', {
              data: {
                type: 'response',
                commandId: m.commandId,
                ok: true,
                data: {
                  revision: 1,
                  projects: [],
                  tasks: [],
                  executions: [],
                  events: [],
                  quota: { windows: [] },
                  settings: {},
                  trusted: true,
                  approvals: [],
                },
              },
            }),
          );
        }, 0);
    },
  });
  w.eval(code);
  return { dom, w, messages };
}
async function flush() {
  await new Promise((r) => setTimeout(r, 30));
}

test('暂停任务有直接继续入口，指定任务交给执行管道而非只入队', async () => {
  const { w, dom, messages } = page();
  try {
    await flush();
    w.dispatchEvent(
      new w.MessageEvent('message', {
        data: {
          type: 'snapshot',
          data: {
            revision: 6,
            enabled: false,
            schedulingState: 'paused',
            projects: [{ id: 'p', name: '项目' }],
            tasks: [{ ...task('旧版暂停任务'), lifecycle: 'PAUSED' }],
            executions: [],
            events: [],
            quota: { windows: [] },
            settings: { executionChannel: 'managed' },
            approvals: [],
          },
        },
      }),
    );
    assert.match(w.document.body.textContent, /待继续：旧版暂停任务/);
    [...w.document.querySelectorAll('button')]
      .find((b: any) => b.textContent === '继续此任务')
      .click();
    assert.ok(
      messages.some(
        (m) => m.type === 'scheduler.execute' && m.payload.taskId === 'id-旧版暂停任务',
      ),
    );
    assert.equal(
      messages.some((m) => m.type === 'task.resume'),
      false,
    );
  } finally {
    dom.window.close();
  }
});

test('暂停中禁用执行并提供核对入口，确认后出现继续执行', async () => {
  const { w, dom, messages } = page();
  try {
    await flush();
    const state = (revision: number, schedulingState: string, executions: any[]) =>
      w.dispatchEvent(
        new w.MessageEvent('message', {
          data: {
            type: 'snapshot',
            data: {
              revision,
              enabled: false,
              schedulingState,
              projects: [],
              tasks: [],
              executions,
              events: [],
              quota: { windows: [] },
              settings: { executionChannel: 'managed' },
              approvals: [],
            },
          },
        }),
      );
    state(3, 'pausing', [{ id: 'active', endedAt: null }]);
    const find = (name: string) =>
      [...w.document.querySelectorAll('button')].find((b: any) => b.textContent === name);
    assert.equal(find('执行任务').disabled, true);
    assert.match(w.document.body.textContent, /正在暂停，请稍候/);
    find('核对暂停状态').click();
    assert.ok(messages.some((m) => m.type === 'recovery.check' && m.payload.id === 'active'));
    state(4, 'paused', []);
    assert.match(w.document.body.textContent, /任务和队列已暂停/);
    assert.equal(
      w.document.getElementById('message').textContent,
      '当前任务和队列已暂停，点击继续执行可恢复。',
    );
    assert.equal(find('继续执行').disabled, false);
    find('继续执行').click();
    assert.ok(messages.some((m) => m.type === 'scheduler.execute'));
    state(5, 'starting', []);
    assert.equal(find('执行任务').disabled, true);
    find('暂停调度').click();
    assert.ok(messages.some((m) => m.type === 'scheduler.pause'));
  } finally {
    dom.window.close();
  }
});
test('后端错误经过界面桥接后只显示一次 Error 前缀', async () => {
  const { w, dom, messages } = page();
  try {
    await flush();
    [...w.document.querySelectorAll('button')]
      .find((b: any) => b.textContent === '执行任务')
      .click();
    const request = messages.find((m) => m.type === 'scheduler.execute');
    assert.ok(request);
    w.dispatchEvent(
      new w.MessageEvent('message', {
        data: {
          type: 'response',
          commandId: request.commandId,
          ok: false,
          error: 'Error: Error: 尚未授权项目',
        },
      }),
    );
    await flush();
    assert.equal(w.document.getElementById('message').textContent, 'Error: 尚未授权项目');
  } finally {
    dom.window.close();
  }
});
test('自动执行页面可直接启动队列，本次授权在队列中可处理且文本安全', async () => {
  const { w, dom, messages } = page();
  try {
    await flush();
    w.dispatchEvent(
      new w.MessageEvent('message', {
        data: {
          type: 'snapshot',
          data: {
            revision: 5,
            projects: [],
            tasks: [],
            executions: [],
            events: [],
            quota: { windows: [] },
            settings: { executionChannel: 'managed', queueMode: 'sequence' },
            approvals: [
              {
                key: 'a',
                method: 'item/commandExecution/requestApproval',
                canAllow: true,
                params: { command: '<script>alert(1)</script>', reason: '运行检查' },
              },
            ],
          },
        },
      }),
    );
    const click = (name: string) =>
      [...w.document.querySelectorAll('button')].find((b: any) => b.textContent === name).click();
    assert.match(w.document.body.textContent, /需要本次权限/);
    assert.equal(w.document.querySelectorAll('script').length, 0);
    click('执行任务');
    click('允许本次');
    await flush();
    assert.ok(messages.some((m) => m.type === 'scheduler.execute'));
    assert.ok(messages.some((m) => m.type === 'approval.allow' && m.payload.key === 'a'));
  } finally {
    dom.window.close();
  }
});
test('连接与设置统一展示 AGENT 流程，不再提供多个冲突的平台入口', async () => {
  const { w, dom } = page();
  try {
    await flush();
    w.dispatchEvent(
      new w.MessageEvent('message', {
        data: {
          type: 'snapshot',
          data: {
            revision: 3,
            projects: [],
            tasks: [],
            executions: [],
            events: [],
            quota: { observedAt: Date.now(), accountKey: null, windows: [] },
            settings: { executionChannel: 'vscode' },
            approvals: [],
          },
        },
      }),
    );
    const click = (name: string) =>
      [...w.document.querySelectorAll('button')].find((b: any) => b.textContent === name).click();
    click('额度与连接');
    await flush();
    assert.match(w.document.body.textContent, /AGENT 连接/);
    assert.doesNotMatch(w.document.body.textContent, /下一项由你点击|复制提示词/);
    click('设置');
    await flush();
    assert.match(w.document.body.textContent, /AGENT 与桌面设置/);
    assert.doesNotMatch(
      w.document.body.textContent,
      /VS Code 完成监测|GPT 软件交接|运行一次真实只读验收/,
    );
    assert.equal(
      [...w.document.querySelectorAll('label')].some((l: any) => l.textContent === '执行平台'),
      false,
    );
  } finally {
    dom.window.close();
  }
});
function snapshot(w: any, tasks: any[]) {
  w.dispatchEvent(
    new w.MessageEvent('message', {
      data: {
        type: 'snapshot',
        data: {
          revision: 2,
          projects: [{ id: 'p', name: '项目 <script>alert(1)</script>', archived: false }],
          tasks,
          executions: [],
          events: [],
          quota: { windows: [] },
          settings: {},
          trusted: true,
          approvals: [],
        },
      },
    }),
  );
}
function task(title: string) {
  return {
    id: 'id-' + title,
    title,
    projectId: 'p',
    lifecycle: 'QUEUED',
    waitReasons: [],
    priority: 5,
    createdAt: 0,
    acceptance: [],
    dependencies: [],
  };
}
test('SEC01: 恶意任务 HTML 与项目名只作为文本展示', async () => {
  const { w, dom } = page();
  try {
    await flush();
    snapshot(w, [task('<img src=x onerror=alert(1)>')]);
    assert.equal(w.document.querySelectorAll('script,img:not([src="brand.svg"])').length, 0);
    assert.match(w.document.body.textContent, /<img src=x onerror=alert\(1\)>/);
  } finally {
    dom.window.close();
  }
});
test('UI01: 空队列与筛选无结果显示不同提示；搜索不丢焦点', async () => {
  const { w, dom } = page();
  try {
    await flush();
    assert.match(w.document.body.textContent, /还没有任务/);
    snapshot(w, [task('正常任务')]);
    const input = w.document.getElementById('search');
    input.focus();
    input.value = '没有';
    input.dispatchEvent(new w.Event('input'));
    assert.match(w.document.body.textContent, /没有符合当前筛选/);
    assert.equal(w.document.activeElement, input);
  } finally {
    dom.window.close();
  }
});
test('UI03: 提交失败保留输入，不跳出表单', async () => {
  const { w, messages, dom } = page();
  try {
    await flush();
    snapshot(w, []);
    const buttons = () => [...w.document.querySelectorAll('button')];
    buttons()
      .find((b: any) => b.textContent.includes('新建任务'))
      .click();
    const input = w.document.querySelector('input[type=text]');
    input.value = '必须保留的标题';
    input.dispatchEvent(new w.Event('input'));
    let area = w.document.querySelector('textarea');
    area.value = '任务目标';
    area.dispatchEvent(new w.Event('input'));
    area = w.document.querySelectorAll('textarea')[1];
    area.value = '人工确认';
    area.dispatchEvent(new w.Event('input'));
    buttons()
      .find((b: any) => b.textContent === '下一步')
      .click();
    await flush();
    buttons()
      .find((b: any) => b.textContent === '下一步')
      .click();
    await flush();
    buttons()
      .find((b: any) => b.textContent === '保存并入队')
      .click();
    await flush();
    const m = messages.find((m) => m.type === 'task.create');
    assert.ok(m);
    w.dispatchEvent(
      new w.MessageEvent('message', {
        data: { type: 'response', commandId: m.commandId, ok: false, error: '模拟磁盘写失败' },
      }),
    );
    await flush();
    assert.match(w.document.body.textContent, /保存失败，输入已保留/);
    assert.match(w.document.body.textContent, /必须保留的标题/);
  } finally {
    dom.window.close();
  }
});
test('UI05: 旧 revision 快照不覆盖新数据', async () => {
  const { w, dom } = page();
  try {
    await flush();
    snapshot(w, [task('新任务')]);
    w.dispatchEvent(
      new w.MessageEvent('message', {
        data: { type: 'snapshot', data: { revision: 1, tasks: [] } },
      }),
    );
    assert.match(w.document.body.textContent, /新任务/);
  } finally {
    dom.window.close();
  }
});
