import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Repository } from '../src/storage/repository';
import { Scheduler, localIdentity } from '../src/tasks/scheduler';
import { ExecutionController } from '../src/application/execution-controller';
import { Adapter, TaskInput } from '../src/domain/model';

class Agent implements Adapter {
  managed = true;
  starts = 0;
  listeners = new Set<(method: string, params: any) => void>();
  async probe() {
    return { sandboxReady: true };
  }
  async account() {
    return { key: 'test', type: 'chatgpt' };
  }
  async quota() {
    return {
      observedAt: Date.now(),
      accountKey: 'test',
      windows: [{ name: 'codex', usedPercent: 5, resetsAt: null }],
    };
  }
  async prepare(): Promise<string> {
    return randomUUID();
  }
  async resume(threadId: string) {
    return threadId;
  }
  async start(_threadId?: string, _prompt?: string): Promise<string> {
    this.starts++;
    return randomUUID();
  }
  async read(): Promise<any> {
    return { turns: [] };
  }
  async interrupt() {}
  onEvent(fn: (method: string, params: any) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(method: string, params: any) {
    this.listeners.forEach((fn) => fn(method, params));
  }
  dispose() {}
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pawshift-execution-'));
  const project = join(root, 'project');
  mkdirSync(project);
  const repo = new Repository(join(root, 'state.db'));
  repo.addProject({
    id: 'p',
    name: 'fixture',
    root: project,
    uri: 'file:///' + project.replace(/\\/g, '/'),
    canonicalKey: localIdentity(project).key,
    archived: false,
    accountKey: null,
    trusted: false,
  });
  const agent = new Agent(),
    scheduler = new Scheduler(repo, agent, () => true);
  let consents = 0,
    allow = true;
  const controller = new ExecutionController(
    repo,
    () => scheduler,
    async () => {},
    async () => {
      consents++;
      return allow;
    },
  );
  const input: TaskInput = {
    projectId: 'p',
    title: '任务',
    objective: '完成实际任务',
    acceptance: [{ id: 'm', type: 'manual', requirement: '完成目标' }],
    dependencies: [],
    priority: 5,
    notBefore: null,
    deadline: null,
    delayMs: 0,
    allowedPaths: ['.'],
    permission: 'restricted',
    maxTurns: 1,
    maxMinutes: 5,
  };
  return {
    root,
    project,
    repo,
    agent,
    scheduler,
    controller,
    input,
    consents: () => consents,
    decline: () => {
      allow = false;
    },
    close() {
      scheduler.dispose();
      repo.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 40));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function oldPausedTask(f: ReturnType<typeof fixture>) {
  const task = f.repo.create([f.input])[0];
  await f.controller.execute();
  const execution = f.repo.executions().find((e) => e.endedAt === null)!;
  await f.scheduler.control(task.id, 'pause');
  f.agent.emit('turn/completed', {
    threadId: execution.threadId,
    turn: { id: execution.turnId, status: 'interrupted', items: [] },
  });
  await flush();
  f.repo.set('enabled', false);
  f.repo.db.prepare("DELETE FROM settings WHERE id IN ('pausedTaskId','resumeTaskId')").run();
  return { task, execution };
}

test('旧版暂停任务缺少全局恢复标记时，继续仍恢复原会话，忽略草稿和取消项', async () => {
  const f = fixture();
  try {
    const { task, execution } = await oldPausedTask(f);
    f.repo.create([f.input], true);
    const cancelled = f.repo.create([f.input])[0];
    await f.scheduler.control(cancelled.id, 'cancel');
    f.repo.set('schedulingPaused', true);
    const receipts = await Promise.all([f.controller.execute(), f.controller.execute()]);
    assert.equal(receipts[0].status, 'started');
    assert.equal(receipts[0].executionId, receipts[1].executionId);
    const resumed = f.repo.executions().find((e) => e.endedAt === null)!;
    assert.equal(resumed.taskId, task.id);
    assert.equal(resumed.threadId, execution.threadId);
    assert.equal(f.agent.starts, 2);
    assert.equal(f.repo.task(cancelled.id).lifecycle, 'CANCELLED');
  } finally {
    f.close();
  }
});

test('多项旧暂停任务不任意猜选；明确选择后只恢复指定任务', async () => {
  const f = fixture();
  try {
    const first = await oldPausedTask(f),
      second = await oldPausedTask(f);
    f.repo.set('schedulingPaused', true);
    await assert.rejects(() => f.controller.execute(), /多项已暂停/);
    assert.equal(f.agent.starts, 2);
    assert.equal((await f.controller.execute(second.task.id)).status, 'started');
    assert.equal(f.repo.task(first.task.id).lifecycle, 'PAUSED');
    assert.equal(f.repo.executions().find((e) => e.endedAt === null)?.taskId, second.task.id);
  } finally {
    f.close();
  }
});

test('恢复连接失败保留暂停与原会话，再次继续可以成功', async () => {
  const f = fixture();
  try {
    const { task, execution } = await oldPausedTask(f);
    f.agent.resume = async () => {
      throw Error('thread resume unavailable');
    };
    const failed = await f.controller.execute();
    assert.equal(failed.status, 'blocked');
    assert.match(failed.message, /thread resume unavailable/);
    assert.equal(f.repo.task(task.id).lifecycle, 'PAUSED');
    assert.equal(f.repo.setting('enabled', true), false);
    f.agent.resume = async (threadId) => threadId;
    assert.equal((await f.controller.execute()).status, 'started');
    assert.equal(f.repo.executions().find((e) => e.endedAt === null)?.threadId, execution.threadId);
  } finally {
    f.close();
  }
});

test('旧版遗留工具运行标记时先核对原轮次，不能确认停止则保持暂停', async () => {
  const f = fixture();
  try {
    const { task, execution } = await oldPausedTask(f);
    const old = f.repo.execution(execution.id);
    old.runningItems = ['old-approval'];
    f.repo.saveExecution(old);
    f.agent.read = async () => ({
      turns: [{ id: execution.turnId, status: 'inProgress', items: [] }],
    });
    assert.equal((await f.controller.execute()).status, 'blocked');
    assert.equal(f.repo.task(task.id).lifecycle, 'PAUSED');
    assert.equal(f.agent.starts, 1);
    // An interrupted approval can disappear from persisted items; terminal ownership is rechecked.
    f.agent.read = async () => ({
      status: { type: 'notLoaded' },
      turns: [{ id: execution.turnId, status: 'interrupted', items: [] }],
    });
    assert.equal((await f.controller.execute()).status, 'started');
    assert.equal(f.repo.execution(execution.id).runningItems?.length, 0);
    assert.equal(f.agent.starts, 2);
  } finally {
    f.close();
  }
});

test('只有手动暂停的排队任务也提供明确选择提示，指定后可开始', async () => {
  const f = fixture();
  try {
    const task = f.repo.create([f.input])[0];
    await f.scheduler.control(task.id, 'pause');
    const result = await f.controller.execute();
    assert.equal(result.status, 'blocked');
    assert.match(result.message, /继续此任务/);
    assert.equal((await f.controller.execute(task.id)).status, 'started');
    await assert.rejects(() => f.controller.execute('unknown-task'), /未结束|请选择/);
  } finally {
    f.close();
  }
});

test('指定继续的任务仍需等待计划时间时，不能悄悄换成其他任务执行', async () => {
  const f = fixture();
  try {
    const task = f.repo.create([{ ...f.input, notBefore: Date.now() + 60000 }])[0];
    await f.scheduler.control(task.id, 'pause');
    f.repo.create([f.input]);
    assert.equal((await f.controller.execute(task.id)).status, 'waiting');
    assert.equal(f.agent.starts, 0);
    assert.match(f.repo.task(task.id).waitReasons.join(), /TIME/);
  } finally {
    f.close();
  }
});

for (const phase of ['consent', 'connect', 'refresh', 'prepare'] as const)
  test(`启动期间暂停（${phase}）后，迟到的响应不能重新开启或发送任务`, async () => {
    const f = fixture(),
      reached = deferred<void>(),
      release = deferred<void>();
    try {
      f.repo.create([f.input]);
      const gate = async () => {
        reached.resolve();
        await release.promise;
      };
      const controller = new ExecutionController(
        f.repo,
        () => f.scheduler,
        phase === 'connect' ? gate : async () => {},
        async () => {
          if (phase === 'consent') await gate();
          return true;
        },
      );
      if (phase === 'refresh')
        f.agent.probe = async () => {
          await gate();
          return { sandboxReady: true };
        };
      if (phase === 'prepare')
        f.agent.prepare = async () => {
          await gate();
          return 'prepared';
        };
      const run = controller.execute();
      await reached.promise;
      await controller.pause();
      release.resolve();
      assert.equal((await run).status, 'paused');
      await f.scheduler.tick();
      assert.equal(f.repo.setting('enabled', true), false);
      assert.equal(f.agent.starts, 0);
      assert.equal(f.repo.executions().filter((e) => e.endedAt === null).length, 0);
      if (phase === 'prepare') assert.equal(f.repo.executions()[0].state, 'PAUSED');
    } finally {
      release.resolve();
      f.close();
    }
  });

test('定时调度刷新期间暂停也不会绕过开关派发', async () => {
  const f = fixture(),
    reached = deferred<void>(),
    release = deferred<void>();
  try {
    const p = f.repo.project('p');
    p.trusted = true;
    f.repo.saveProject(p);
    f.repo.create([f.input]);
    f.repo.set('enabled', true);
    f.agent.probe = async () => {
      reached.resolve();
      await release.promise;
      return { sandboxReady: true };
    };
    const tick = f.scheduler.tick();
    await reached.promise;
    await f.controller.pause();
    release.resolve();
    await tick;
    assert.equal(f.agent.starts, 0);
    assert.equal(f.repo.executions().length, 0);
  } finally {
    release.resolve();
    f.close();
  }
});

test('启动暂停后连接才报错时，旧请求返回已暂停并保持队列关闭', async () => {
  const f = fixture(),
    reached = deferred<void>(),
    release = deferred<void>();
  try {
    f.repo.create([f.input]);
    const controller = new ExecutionController(
      f.repo,
      () => f.scheduler,
      async () => {
        reached.resolve();
        await release.promise;
        throw Error('late connection failure');
      },
      async () => true,
    );
    const run = controller.execute();
    await reached.promise;
    await controller.pause();
    release.resolve();
    assert.equal((await run).status, 'paused');
    assert.equal(f.repo.setting('enabled', true), false);
    assert.equal(f.agent.starts, 0);
  } finally {
    release.resolve();
    f.close();
  }
});

test('暂停等待停止确认，重复暂停不重复中断，继续沿用原会话且优先完成原任务', async () => {
  const f = fixture();
  let interrupts = 0,
    resumed = '',
    resumedPrompt = '';
  try {
    const tasks = f.repo.create([
      f.input,
      { ...f.input, priority: 10, notBefore: Date.now() + 60000 },
    ]);
    f.agent.interrupt = async () => {
      interrupts++;
    };
    await f.controller.execute();
    const first = f.repo.executions()[0];
    f.agent.emit('approval/request', {
      threadId: first.threadId,
      turnId: first.turnId,
      key: 'permission',
    });
    await flush();
    await Promise.all([f.controller.pause(), f.controller.pause()]);
    assert.equal(interrupts, 1);
    assert.equal(f.repo.task(tasks[0].id).desiredState, 'pause');
    assert.equal(f.repo.task(tasks[0].id).lifecycle, 'RECONCILING');
    assert.equal(f.repo.task(tasks[1].id).lifecycle, 'QUEUED');
    await assert.rejects(() => f.controller.execute(), /未结束/);
    f.agent.emit('turn/completed', {
      threadId: first.threadId,
      turn: { id: first.turnId, status: 'interrupted', items: [] },
    });
    await flush();
    assert.equal(f.repo.task(tasks[0].id).lifecycle, 'PAUSED');
    assert.equal(f.repo.setting('enabled', true), false);
    assert.equal(f.agent.starts, 1);
    const second = f.repo.task(tasks[1].id);
    second.notBefore = null;
    f.repo.saveTask(second);
    f.agent.resume = async (threadId) => {
      resumed = threadId;
      return threadId;
    };
    const start = f.agent.start.bind(f.agent);
    f.agent.start = async (threadId?: string, prompt?: string) => {
      resumedPrompt = prompt || '';
      return start(threadId);
    };
    assert.equal((await f.controller.execute()).status, 'started');
    const next = f.repo.executions().find((e) => e.endedAt === null)!;
    assert.equal(next.taskId, first.taskId);
    assert.equal(resumed, first.threadId);
    assert.notEqual(next.turnId, first.turnId);
    assert.match(resumedPrompt, /核对已完成/);
    // Old approvals and terminal notifications must not affect a resumed turn.
    f.agent.emit('approval/request', {
      params: { threadId: first.threadId, turnId: first.turnId },
      key: 'stale',
    });
    f.agent.emit('turn/completed', {
      threadId: first.threadId,
      turn: { id: first.turnId, status: 'completed' },
    });
    await flush();
    assert.equal(f.repo.execution(next.id).endedAt, null);
    assert.equal(f.agent.starts, 2);
    assert.equal(
      f.repo.task(next.taskId).waitReasons.some((reason) => reason.startsWith('APPROVAL')),
      false,
    );
  } finally {
    f.close();
  }
});

test('发送途中暂停保留锁，收到轮次编号后中断，不派发后继任务', async () => {
  const f = fixture(),
    reached = deferred<void>(),
    release = deferred<void>();
  let interrupts = 0;
  try {
    f.repo.create([f.input, f.input]);
    f.agent.start = async () => {
      f.agent.starts++;
      reached.resolve();
      await release.promise;
      return 'late-turn';
    };
    f.agent.interrupt = async () => {
      interrupts++;
    };
    const run = f.controller.execute();
    await reached.promise;
    await f.controller.pause();
    assert.equal(f.repo.executions().filter((e) => e.endedAt === null).length, 1);
    release.resolve();
    assert.equal((await run).status, 'paused');
    assert.equal(interrupts, 1);
    const e = f.repo.executions()[0];
    f.agent.emit('turn/completed', {
      threadId: e.threadId,
      turn: { id: 'late-turn', status: 'interrupted' },
    });
    await flush();
    await f.scheduler.tick();
    assert.equal(f.repo.execution(e.id).state, 'PAUSED');
    assert.equal(f.agent.starts, 1);
  } finally {
    release.resolve();
    f.close();
  }
});

test('停止确认仍有工具运行时保留锁；核对工具已结束后才能继续', async () => {
  const f = fixture();
  try {
    f.repo.create([f.input]);
    await f.controller.execute();
    const e = f.repo.executions()[0];
    f.agent.emit('item/started', {
      threadId: e.threadId,
      turnId: e.turnId,
      item: { id: 'cmd', type: 'commandExecution', status: 'inProgress' },
    });
    await flush();
    await f.controller.pause();
    f.agent.emit('turn/completed', {
      threadId: e.threadId,
      turn: { id: e.turnId, status: 'interrupted', items: [] },
    });
    await flush();
    assert.equal(f.repo.execution(e.id).endedAt, null);
    f.agent.read = async () => ({
      turns: [
        {
          id: e.turnId,
          status: 'interrupted',
          items: [{ id: 'cmd', type: 'commandExecution', status: 'completed' }],
        },
      ],
    });
    await f.scheduler.reconcile(e.id);
    assert.equal(f.repo.execution(e.id).state, 'PAUSED');
  } finally {
    f.close();
  }
});

test('中断失败保留锁和错误说明，可重试暂停且不会开启队列', async () => {
  const f = fixture();
  let calls = 0;
  try {
    f.repo.create([f.input]);
    await f.controller.execute();
    f.agent.interrupt = async () => {
      if (++calls === 1) throw Error('connection delayed');
    };
    await f.controller.pause();
    const e = f.repo.executions()[0];
    assert.equal(f.repo.execution(e.id).endedAt, null);
    assert.match(f.repo.task(e.taskId).waitReasons.join(), /connection delayed/);
    await f.controller.pause();
    assert.equal(calls, 2);
    assert.equal(f.repo.setting('enabled', true), false);
  } finally {
    f.close();
  }
});

test('轮次中断通知早于工具结束通知时，最后一个工具结束后自动确认暂停', async () => {
  const f = fixture();
  try {
    f.repo.create([f.input]);
    await f.controller.execute();
    const e = f.repo.executions()[0];
    f.agent.emit('item/started', {
      threadId: e.threadId,
      turnId: e.turnId,
      item: { id: 'patch', type: 'fileChange', status: 'inProgress' },
    });
    await flush();
    await f.controller.pause();
    f.agent.emit('turn/completed', {
      threadId: e.threadId,
      turn: { id: e.turnId, status: 'interrupted', items: [] },
    });
    await flush();
    assert.equal(f.repo.execution(e.id).endedAt, null);
    f.agent.emit('item/completed', {
      threadId: e.threadId,
      turnId: e.turnId,
      item: { id: 'patch', type: 'fileChange', status: 'failed' },
    });
    await flush();
    assert.equal(f.repo.execution(e.id).state, 'PAUSED');
    assert.equal(f.repo.setting('enabled', true), false);
  } finally {
    f.close();
  }
});

test('多个命令的结束通知晚到时，全部结束才自动确认暂停', async () => {
  const f = fixture();
  try {
    f.repo.create([f.input]);
    await f.controller.execute();
    const e = f.repo.executions()[0];
    const items = ['a', 'b'].map((id) => ({ id, type: 'commandExecution', status: 'inProgress' }));
    for (const item of items)
      f.agent.emit('item/started', { threadId: e.threadId, turnId: e.turnId, item });
    await flush();
    await f.controller.pause();
    f.agent.emit('turn/completed', {
      threadId: e.threadId,
      turn: { id: e.turnId, status: 'interrupted', items },
    });
    await flush();
    for (const [index, item] of items.entries()) {
      f.agent.emit('item/completed', {
        threadId: e.threadId,
        turnId: e.turnId,
        item: { ...item, status: 'completed' },
      });
      await flush();
      assert.equal(f.repo.execution(e.id).state, index === 0 ? 'RECONCILING' : 'PAUSED');
    }
  } finally {
    f.close();
  }
});

test('暂停状态持久化，重建调度器后继续仍恢复原会话', async () => {
  const f = fixture();
  let next: Scheduler | undefined;
  try {
    f.repo.create([f.input]);
    await f.controller.execute();
    const e = f.repo.executions()[0];
    await f.controller.pause();
    f.agent.emit('turn/completed', {
      threadId: e.threadId,
      turn: { id: e.turnId, status: 'interrupted' },
    });
    await flush();
    f.scheduler.dispose();
    next = new Scheduler(f.repo, f.agent, () => true);
    const controller = new ExecutionController(
      f.repo,
      () => next!,
      async () => {},
      async () => true,
    );
    assert.equal((await controller.execute()).status, 'started');
    assert.equal(
      f.repo.executions().find((execution) => execution.endedAt === null)?.threadId,
      e.threadId,
    );
  } finally {
    next?.dispose();
    f.close();
  }
});

test('终态先到但启动回执丢失时，完成的任务不会被重新加锁', async () => {
  const f = fixture();
  try {
    const task = f.repo.create([f.input])[0];
    f.agent.start = async (threadId) => {
      f.agent.starts++;
      f.agent.emit('turn/completed', {
        threadId,
        turn: { id: 'early-terminal', status: 'completed', items: [] },
      });
      await flush();
      throw Error('RPC_TIMEOUT turn/start');
    };
    const receipt = await f.controller.execute();
    assert.equal(receipt.status, 'completed');
    assert.equal(f.repo.task(task.id).lifecycle, 'SUCCEEDED');
    assert.equal(f.repo.executions().filter((e) => e.endedAt === null).length, 0);
    assert.equal(f.agent.starts, 1);
  } finally {
    f.close();
  }
});

test('点击执行完成项目授权并启动 AGENT；并发点击只发送一个任务', async () => {
  const f = fixture();
  try {
    f.repo.create([f.input]);
    const receipts = await Promise.all([f.controller.execute(), f.controller.execute()]);
    assert.equal(f.consents(), 1);
    assert.equal(f.agent.starts, 1);
    assert.equal(receipts[0].status, 'started');
    assert.equal(receipts[0].executionId, receipts[1].executionId);
    assert.equal(f.repo.project('p').trusted, true);
    f.repo.set('enabled', false);
    assert.equal((await f.controller.execute()).status, 'running');
    assert.equal(f.repo.setting('enabled', false), true);
    assert.equal(f.agent.starts, 1);
  } finally {
    f.close();
  }
});
test('空队列、拒绝授权和未来计划返回实际状态，不冒充已经开始', async () => {
  const f = fixture();
  try {
    assert.equal((await f.controller.execute()).status, 'empty');
    f.repo.create([{ ...f.input, notBefore: Date.now() + 60000 }]);
    f.decline();
    await assert.rejects(() => f.controller.execute(), /尚未授权/);
    assert.equal(f.agent.starts, 0);
    const p = f.repo.project('p');
    p.trusted = true;
    f.repo.saveProject(p);
    const receipt = await f.controller.execute();
    assert.equal(receipt.status, 'waiting');
    assert.match(receipt.message, /TIME/);
    assert.equal(f.agent.starts, 0);
  } finally {
    f.close();
  }
});
test('AGENT 完成但文件验收失败时不解除后继依赖；回复结果可查看', async () => {
  const f = fixture();
  try {
    const tasks = f.repo.create([
      {
        ...f.input,
        acceptance: [{ id: 'file', type: 'file', requirement: '创建输出', path: 'result.txt' }],
      },
      { ...f.input, dependencies: ['@previous'] },
    ]);
    await f.controller.execute();
    const execution = f.repo.executions()[0];
    f.agent.emit('item/completed', {
      threadId: execution.threadId,
      turnId: execution.turnId,
      item: { type: 'agentMessage', text: '没有产物，不能假报成功。', phase: 'final_answer' },
    });
    f.agent.emit('turn/completed', {
      threadId: execution.threadId,
      turn: { id: execution.turnId, status: 'completed' },
    });
    await flush();
    await f.scheduler.tick();
    assert.equal(f.repo.task(tasks[0].id).lifecycle, 'FAILED');
    assert.equal(f.repo.task(tasks[1].id).lifecycle, 'QUEUED');
    assert.equal(f.repo.execution(execution.id).output, '没有产物，不能假报成功。');
    assert.match(f.repo.task(tasks[1].id).waitReasons.join(), /DEPENDENCY/);
    assert.equal(f.agent.starts, 1);
  } finally {
    f.close();
  }
});
test('真实文件检查通过后自动继续下一项，未知轮次事件不能写入当前结果', async () => {
  const f = fixture();
  try {
    f.repo.create([
      {
        ...f.input,
        acceptance: [
          { id: 'f', type: 'file', path: 'result.txt', contains: 'OK', requirement: '输出 OK' },
        ],
      },
      { ...f.input, dependencies: ['@previous'] },
    ]);
    await f.controller.execute();
    const e = f.repo.executions()[0];
    writeFileSync(join(f.project, 'result.txt'), 'OK');
    f.agent.emit('item/completed', {
      threadId: e.threadId,
      turnId: 'other',
      item: { type: 'agentMessage', text: '不属于当前任务' },
    });
    f.agent.emit('turn/completed', {
      threadId: e.threadId,
      turn: { id: e.turnId, status: 'completed', items: [] },
    });
    await flush();
    await f.scheduler.tick();
    assert.equal(f.repo.execution(e.id).state, 'SUCCEEDED');
    assert.equal(f.repo.execution(e.id).output, undefined);
    assert.equal(f.agent.starts, 2);
  } finally {
    f.close();
  }
});
test('AGENT 断开后暂停调度并保留执行锁，防止重复派发', async () => {
  const f = fixture();
  try {
    f.repo.create([f.input]);
    await f.controller.execute();
    f.agent.emit('transport/closed', { error: 'connection lost' });
    await flush();
    assert.equal(f.repo.setting('enabled', true), false);
    assert.equal(f.repo.executions()[0].state, 'RECONCILING');
    await assert.rejects(() => f.controller.execute(), /恢复检查/);
    assert.equal(f.agent.starts, 1);
  } finally {
    f.close();
  }
});
