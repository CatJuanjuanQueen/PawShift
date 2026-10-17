import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Repository } from '../src/storage/repository';
import { Scheduler, localIdentity } from '../src/tasks/scheduler';
import { Adapter, Task, TaskInput, Project, Quota, redact } from '../src/domain/model';
class Fake implements Adapter {
  starts = 0;
  threads = new Map<string, any>();
  listeners: ((m: string, p: any) => void)[] = [];
  failStart = false;
  interruptEnds = true;
  quotaValue: Quota = {
    observedAt: Date.now(),
    accountKey: 'account',
    windows: [
      { name: 'short', usedPercent: 10, resetsAt: null },
      { name: 'long', usedPercent: 20, resetsAt: null },
    ],
  };
  async probe() {
    return { fake: true };
  }
  async account() {
    return { key: 'account', type: 'chatgpt' };
  }
  async quota() {
    return this.quotaValue;
  }
  async prepare() {
    const id = randomUUID();
    this.threads.set(id, { turns: [] });
    return id;
  }
  async start(threadId: string) {
    this.starts++;
    const id = randomUUID();
    this.threads
      .get(threadId)
      .turns.push({ id, status: 'inProgress', items: [], itemsView: 'full' });
    if (this.failStart) throw Error('response lost');
    return id;
  }
  async read(id: string) {
    return this.threads.get(id) || { turns: [] };
  }
  async interrupt(threadId: string, turnId: string) {
    if (this.interruptEnds)
      this.threads.get(threadId).turns.find((t: any) => t.id === turnId).status = 'interrupted';
  }
  onEvent(cb: (m: string, p: any) => void) {
    this.listeners.push(cb);
    return () => {};
  }
  dispose() {}
  end(thread: string, turn: string, status = 'completed', items: any[] = []) {
    Object.assign(
      this.threads.get(thread).turns.find((t: any) => t.id === turn),
      { status, items },
    );
    for (const l of this.listeners)
      l('turn/completed', { threadId: thread, turn: this.threads.get(thread).turns[0] });
  }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pawshift-test-'));
  const repo = new Repository(join(root, 'state.db'));
  const workspace = join(root, 'work');
  mkdirSync(workspace);
  const identity = localIdentity(workspace);
  const project: Project = {
    id: randomUUID(),
    name: '测试',
    uri: 'file:///' + workspace.replace(/\\/g, '/'),
    root: workspace,
    canonicalKey: identity.key,
    accountKey: 'account',
    archived: false,
  };
  repo.addProject(project);
  repo.set('integrationValidated', true);
  repo.set('sandboxValidated', true);
  const adapter = new Fake();
  const scheduler = new Scheduler(repo, adapter, () => true);
  const input = (title = 'A', dependencies: string[] = []): TaskInput => ({
    projectId: project.id,
    title,
    objective: '验证实际调度行为',
    acceptance: [{ id: 'manual', type: 'manual', requirement: '实际人工确认' }],
    dependencies,
    priority: 5,
    notBefore: null,
    deadline: null,
    delayMs: 0,
    permission: 'read-only',
    allowedPaths: ['.'],
    maxTurns: 5,
    maxMinutes: 30,
  });
  const dispose = () => {
    scheduler.dispose();
    repo.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, repo, project, adapter, scheduler, input, dispose };
}
async function flush() {
  await new Promise((r) => setTimeout(r, 25));
}
test('自动分配不扫描项目输出，大文件不会阻止任务启动', async () => {
  const f = fixture();
  try {
    Object.assign(f.adapter, { managed: true });
    f.adapter.probe = async () => ({ fake: true, sandboxReady: true }) as any;
    writeFileSync(join(f.project.root, 'large-output.bin'), Buffer.alloc(11 * 1024 * 1024));
    f.repo.create([f.input()]);
    f.repo.set('enabled', true);
    await f.scheduler.tick();
    assert.equal(f.adapter.starts, 1);
    assert.equal((f.repo.executions()[0].baseline as any).kind, 'managed-project');
  } finally {
    f.dispose();
  }
});
test('自动分配：完成状态释放依赖并自动继续，回复正文不进入运行记录', async () => {
  const f = fixture();
  try {
    Object.assign(f.adapter, { managed: true });
    f.adapter.probe = async () => ({ fake: true, sandboxReady: true }) as any;
    const a = f.repo.create([f.input('第一项')])[0],
      b = f.repo.create([f.input('第二项', [a.id])])[0];
    f.repo.set('enabled', true);
    await f.scheduler.tick();
    const e = f.repo.executions()[0];
    assert.equal(e.sendState, 'managed-sent');
    f.adapter.end(e.threadId!, e.turnId!, 'completed', [
      { type: 'agentMessage', text: '不应存储的回复正文' },
      { type: 'commandExecution', status: 'completed', exitCode: 0 },
    ]);
    await flush();
    await f.scheduler.tick();
    assert.equal(f.repo.task(a.id).lifecycle, 'SUCCEEDED');
    assert.equal(f.repo.task(b.id).lifecycle, 'RUNNING');
    assert.equal(f.adapter.starts, 2);
    assert.ok(!JSON.stringify(f.repo.events()).includes('不应存储的回复正文'));
  } finally {
    f.dispose();
  }
});
test('自动分配：优先级和队列顺序可选，时间与依赖仍然有效', async () => {
  for (const mode of ['priority', 'sequence']) {
    const f = fixture();
    try {
      Object.assign(f.adapter, { managed: true });
      f.adapter.probe = async () => ({ fake: true, sandboxReady: true }) as any;
      f.repo.set('queueMode', mode);
      const a = f.repo.create([{ ...f.input('先入队'), priority: 1 }])[0],
        b = f.repo.create([{ ...f.input('高优先级'), priority: 10 }])[0];
      f.repo.set('enabled', true);
      await f.scheduler.tick();
      assert.equal(f.repo.executions()[0].taskId, mode === 'priority' ? b.id : a.id);
      const execution = f.repo.executions()[0];
      await f.scheduler.control(execution.taskId, 'pause');
      assert.equal(f.repo.execution(execution.id).state, 'RECONCILING');
      f.adapter.end(execution.threadId!, execution.turnId!, 'interrupted');
      await flush();
      assert.equal(f.repo.execution(execution.id).state, 'PAUSED');
    } finally {
      f.dispose();
    }
  }
});
test('自动分配：失败不解除后继依赖，细分写入路径不冒充沙箱边界', async () => {
  const f = fixture();
  try {
    Object.assign(f.adapter, { managed: true });
    f.adapter.probe = async () => ({ fake: true, sandboxReady: true }) as any;
    const a = f.repo.create([f.input('失败项')])[0],
      b = f.repo.create([f.input('后继', [a.id])])[0];
    f.repo.set('enabled', true);
    await f.scheduler.tick();
    const e = f.repo.executions()[0];
    f.adapter.end(e.threadId!, e.turnId!, 'failed');
    await flush();
    await f.scheduler.tick();
    assert.equal(f.repo.task(a.id).lifecycle, 'FAILED');
    assert.equal(f.adapter.starts, 1);
    assert.match(f.repo.task(b.id).waitReasons.join(), /DEPENDENCY/);
    assert.match(
      f.scheduler
        .reasons({ ...f.input(), permission: 'restricted', allowedPaths: ['src'] } as Task)
        .join(),
      /整个项目/,
    );
  } finally {
    f.dispose();
  }
});
test('AC01: 依赖只有验收成功才解锁，模型结束不代表完成', async () => {
  const f = fixture();
  try {
    const a = f.repo.create([f.input()])[0],
      b = f.repo.create([f.input('B', [a.id])])[0],
      c = f.repo.create([f.input('C', [b.id])])[0];
    f.repo.set('enabled', true);
    await f.scheduler.tick();
    assert.equal(f.adapter.starts, 1);
    let e = f.repo.executions()[0];
    f.adapter.end(e.threadId!, e.turnId!);
    await flush();
    assert.equal(f.repo.task(a.id).lifecycle, 'VERIFYING');
    assert.equal(f.adapter.starts, 1);
    await f.scheduler.verify(e.id, '已核实任务结果');
    await flush();
    assert.equal(f.adapter.starts, 2);
    assert.equal(f.repo.task(c.id).lifecycle, 'QUEUED');
    e = f.repo.executions().find((e) => e.taskId === b.id)!;
    f.adapter.end(e.threadId!, e.turnId!);
    await flush();
    await f.scheduler.verify(e.id, '前置验收实际通过');
    await flush();
    assert.equal(f.adapter.starts, 3);
  } finally {
    f.dispose();
  }
});
test('AC02: 前置失败与取消不会解锁后继', async () => {
  const f = fixture();
  try {
    const a = f.repo.create([f.input()])[0],
      b = f.repo.create([f.input('B', [a.id])])[0];
    await f.scheduler.control(a.id, 'cancel');
    f.repo.set('enabled', true);
    await f.scheduler.tick();
    assert.equal(f.adapter.starts, 0);
    assert.match(f.repo.task(b.id).waitReasons.join(), /DEPENDENCY/);
  } finally {
    f.dispose();
  }
});
test('AC03: 缺失与跨项目引用批量事务回滚；循环更新不改变原 revision', () => {
  const f = fixture();
  try {
    assert.throws(() => f.repo.create([f.input('bad', ['missing']), f.input('second')]));
    assert.equal(f.repo.all('tasks').length, 0);
    const a = f.repo.create([f.input()])[0],
      b = f.repo.create([f.input('B', [a.id])])[0];
    assert.throws(() => f.repo.update(a.id, a.version, { ...a, dependencies: [b.id] }), /成环/);
    assert.deepEqual(f.repo.task(a.id).dependencies, []);
    assert.equal(f.repo.task(a.id).revision, 1);
  } finally {
    f.dispose();
  }
});
test('AC04: 两数据库连接 CAS 领取仅一次；全局跨项目也串行', () => {
  const f = fixture();
  const other = new Repository(join(f.root, 'state.db'));
  try {
    const a = f.repo.create([f.input()])[0],
      b = f.repo.create([f.input('B')])[0];
    assert.ok(f.repo.claim(a.id, a.version, {}));
    assert.equal(other.claim(a.id, a.version, {}), null);
    assert.equal(other.claim(b.id, b.version, {}), null);
    assert.equal(f.repo.executions().length, 1);
  } finally {
    other.close();
    f.dispose();
  }
});
test('AC06/07: 未开启调度以及未来时间都没有模型请求', async () => {
  const f = fixture();
  try {
    f.repo.create([{ ...f.input(), notBefore: Date.now() + 60000 }]);
    await f.scheduler.tick();
    assert.equal(f.adapter.starts, 0);
    f.repo.set('enabled', true);
    await f.scheduler.tick();
    assert.equal(f.adapter.starts, 0);
  } finally {
    f.dispose();
  }
});
test('AC08/09/10: 多窗口额度、未知额度与过期同时阻止派发', async () => {
  const f = fixture();
  try {
    const t = f.repo.create([f.input()])[0];
    f.repo.set('enabled', true);
    f.adapter.quotaValue.windows[1].usedPercent = 99;
    await f.scheduler.tick();
    assert.equal(f.adapter.starts, 0);
    assert.match(f.repo.task(t.id).waitReasons.join(), /QUOTA/);
    f.scheduler.quota.windows[1].usedPercent = null;
    assert.match(f.scheduler.reasons(f.repo.task(t.id)).join(), /未知/);
    f.scheduler.quota.observedAt = 1;
    assert.match(f.scheduler.reasons(f.repo.task(t.id)).join(), /过期/);
  } finally {
    f.dispose();
  }
});
test('AC11: 并发唤醒只提交一个轮次', async () => {
  const f = fixture();
  try {
    f.repo.create([f.input()]);
    f.repo.set('enabled', true);
    await Promise.all(Array.from({ length: 20 }, () => f.scheduler.tick()));
    assert.equal(f.adapter.starts, 1);
  } finally {
    f.dispose();
  }
});
test('AC14/22: 提交回执丢失进入核对，重启仍保留锁，不盲目重发', async () => {
  const f = fixture();
  try {
    const t = f.repo.create([f.input()])[0];
    f.adapter.failStart = true;
    f.repo.set('enabled', true);
    await f.scheduler.tick();
    assert.equal(f.repo.task(t.id).lifecycle, 'RECONCILING');
    f.repo.recover();
    await f.scheduler.tick();
    assert.equal(f.adapter.starts, 1);
    assert.equal(f.repo.executions().filter((e) => e.endedAt === null).length, 1);
    assert.equal(f.repo.db.prepare('SELECT count(*) AS n FROM leases').get()!.n, 1);
  } finally {
    f.dispose();
  }
});
test('AC17: 重复终态通知只保留一个权威终态事件', async () => {
  const f = fixture();
  try {
    f.repo.create([f.input()]);
    f.repo.set('enabled', true);
    await f.scheduler.tick();
    const e = f.repo.executions()[0];
    f.adapter.end(e.threadId!, e.turnId!);
    f.adapter.end(e.threadId!, e.turnId!);
    await flush();
    assert.equal(f.repo.events(e.id).filter((e) => e.type === 'turn.terminal').length, 1);
  } finally {
    f.dispose();
  }
});
test('AC19/20: 用户暂停/取消意图优先，不会被完成或额度恢复撤销', async () => {
  const f = fixture();
  try {
    const t = f.repo.create([f.input()])[0];
    f.repo.set('enabled', true);
    await f.scheduler.tick();
    const e = f.repo.executions()[0];
    await f.scheduler.control(t.id, 'pause');
    assert.equal(f.repo.task(t.id).lifecycle, 'PAUSED');
    f.adapter.end(e.threadId!, e.turnId!);
    await flush();
    await f.scheduler.tick();
    assert.equal(f.adapter.starts, 1);
    assert.equal(f.repo.task(t.id).desiredState, 'pause');
  } finally {
    f.dispose();
  }
});
test('AC21: 中断回执不等于实际停止，轮次还活着时不释放锁', async () => {
  const f = fixture();
  try {
    const t = f.repo.create([f.input()])[0];
    f.repo.set('enabled', true);
    await f.scheduler.tick();
    f.adapter.interruptEnds = false;
    await f.scheduler.control(t.id, 'cancel');
    assert.equal(f.repo.executions()[0].endedAt, null);
    assert.equal(f.repo.db.prepare('SELECT count(*) AS n FROM leases').get()!.n, 1);
  } finally {
    f.dispose();
  }
});
test('AC25/26: 文件验收失败、人工验收缺失都不成功', async () => {
  const f = fixture();
  try {
    const t = f.repo.create([
      {
        ...f.input(),
        acceptance: [{ id: 'file', type: 'file', requirement: '存在证据', path: 'evidence.txt' }],
      },
    ])[0];
    f.scheduler.handoff(t.id);
    const e = f.repo.executions()[0];
    await f.scheduler.verify(e.id);
    assert.equal(f.repo.task(t.id).lifecycle, 'VERIFYING');
    writeFileSync(join(f.project.root, 'evidence.txt'), 'verified');
    await f.scheduler.verify(e.id);
    assert.equal(f.repo.task(t.id).lifecycle, 'SUCCEEDED');
    assert.ok((f.repo.execution(e.id).evidence as any).acceptance[0].hash);
  } finally {
    f.dispose();
  }
});
test('UI02: commandId 去重包含创建事务，仅产生一个任务', () => {
  const f = fixture();
  try {
    const first = f.repo.receipt('same', () => f.repo.create([f.input()]));
    const second = f.repo.receipt('same', () => f.repo.create([f.input()]));
    assert.equal(first[0].id, second[0].id);
    assert.equal(f.repo.all('tasks').length, 1);
  } finally {
    f.dispose();
  }
});
test('UI04: 运行任务不可改权限，执行快照保留版本', () => {
  const f = fixture();
  try {
    const t = f.repo.create([f.input()])[0];
    const e = f.repo.claim(t.id, t.version, {})!;
    assert.throws(() =>
      f.repo.update(t.id, f.repo.task(t.id).version, { ...t, permission: 'restricted' }),
    );
    assert.equal(e.snapshot.permission, 'read-only');
  } finally {
    f.dispose();
  }
});
test('SEC02: 越界路径和无效验收批量拒绝', () => {
  const f = fixture();
  try {
    for (const path of ['../escape', 'C:\\escape', '/etc/passwd', 'dir/../../escape'])
      assert.throws(() => f.repo.create([{ ...f.input(), allowedPaths: [path] }]));
    assert.equal(f.repo.all('tasks').length, 0);
    assert.throws(() => f.repo.create([{ ...f.input(), acceptance: [] }]));
  } finally {
    f.dispose();
  }
});
test('SEC04: 未信任工作区与受限写任务不自动执行', async () => {
  const f = fixture();
  try {
    f.repo.create([{ ...f.input(), permission: 'restricted' }]);
    f.repo.set('enabled', true);
    await f.scheduler.tick();
    assert.equal(f.adapter.starts, 0);
    const untrusted = new Scheduler(f.repo, f.adapter, () => false);
    assert.match(untrusted.reasons(f.repo.all<Task>('tasks')[0]).join(), /未信任/);
    untrusted.dispose();
  } finally {
    f.dispose();
  }
});
test('SEC05: 诊断递归脱敏密钥与敏感 URL 参数', () => {
  assert.deepEqual(
    redact({
      nested: { Authorization: 'Bearer xxx', token: 'abc' },
      log: 'https://host/?token=abc&x=1 sk-secret',
    }),
    {
      nested: { Authorization: '[REDACTED]', token: '[REDACTED]' },
      log: 'https://host/?token=[REDACTED]&x=1 [REDACTED]',
    },
  );
});
test('数据库完整性及真实事务回滚', () => {
  const f = fixture();
  try {
    assert.throws(() =>
      f.repo.transaction(() => {
        f.repo.set('volatile', true);
        throw Error('disk failure simulation');
      }),
    );
    assert.equal(f.repo.setting('volatile', false), false);
    assert.equal(f.repo.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally {
    f.dispose();
  }
});

test('批量一行一个任务默认构建顺序依赖，整批不可部分保存', () => {
  const f = fixture();
  try {
    const tasks = f.repo.create([
      f.input('A'),
      f.input('B', ['@previous']),
      f.input('C', ['@previous']),
    ]);
    assert.deepEqual(tasks[1].dependencies, [tasks[0].id]);
    assert.deepEqual(tasks[2].dependencies, [tasks[1].id]);
    assert.equal(f.repo.all('tasks').length, 3);
  } finally {
    f.dispose();
  }
});
