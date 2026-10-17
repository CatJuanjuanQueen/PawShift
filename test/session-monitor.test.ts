import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { observeSession, findObservation } from '../src/legacy/session-monitor';
import { IdeAdapter } from '../src/legacy/ide-adapter';
import { Repository } from '../src/storage/repository';
import { Scheduler, localIdentity } from '../src/tasks/scheduler';
import { TaskInput } from '../src/domain/model';

function log(
  root: string,
  id: string,
  terminal = 'task_complete',
  source = 'vscode',
  thread = 'session-1',
  turn = 'turn-1',
) {
  const at = new Date(Date.now() + 1000).toISOString();
  return (
    [
      { type: 'session_meta', payload: { id: thread, cwd: root, source } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '目标：测试\n\n执行标识：' + id }],
        },
      },
      { type: 'event_msg', payload: { type: terminal, turn_id: turn } },
    ]
      .map((r) => JSON.stringify({ timestamp: at, ...r }))
      .join('\n') + '\n'
  );
}

function writeSession(file: string, content: string) {
  writeFileSync(file, content);
  // Keep fixture metadata aligned with the future event timestamps in log().
  // Windows file timestamps can lag Date.now() by a few milliseconds.
  const at = new Date(Date.now() + 1000);
  utimesSync(file, at, at);
}
test('分块读取保留中文标识，文件追加后刷新缓存；忽略超长单行', () => {
  const root = mkdtempSync(join(tmpdir(), 'pawshift-stream-'));
  try {
    const file = join(root, 'rollout-session-1.jsonl');
    writeFileSync(file, 'x'.repeat(5 * 1024 * 1024) + '\n' + log(root, '执行测试', 'task_started'));
    assert.equal(findObservation('执行测试', root, 0, root)?.status, 'running');
    writeFileSync(file, 'x'.repeat(5 * 1024 * 1024) + '\n' + log(root, '执行测试'));
    assert.equal(findObservation('执行测试', root, 0, root)?.status, 'completed');
    assert.equal(findObservation('执行测试', root, 0, root)?.status, 'completed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('空闲轮询不重写任务版本或触发整份界面刷新', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pawshift-idle-'));
  const repo = new Repository(join(root, 'test.db'));
  let updates = 0;
  const scheduler = new Scheduler(
    repo,
    new IdeAdapter(),
    () => true,
    () => updates++,
  );
  try {
    const identity = localIdentity(root);
    repo.addProject({
      id: 'p',
      name: 'p',
      uri: 'file:///project',
      root,
      canonicalKey: identity.key,
      archived: false,
      trusted: true,
      accountKey: null,
    });
    const task = repo.create(
      [
        {
          projectId: 'p',
          title: 'idle',
          objective: 'idle',
          acceptance: [{ id: 'm', type: 'manual', requirement: '检查' }],
          dependencies: [],
          priority: 5,
          notBefore: null,
          deadline: null,
          delayMs: 0,
          allowedPaths: ['.'],
          permission: 'read-only',
          maxTurns: 1,
          maxMinutes: 5,
        },
      ],
      false,
    )[0];
    await scheduler.tick();
    await scheduler.tick();
    assert.equal(repo.task(task.id).version, task.version);
    assert.equal(updates, 0);
  } finally {
    scheduler.dispose();
    repo.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('会话监测只接受同项目、VS Code 来源和精确执行标识，忽略未写完的尾行', () => {
  const root = join(tmpdir(), 'monitor-project'),
    s = log(root, 'exec');
  assert.equal(observeSession(s + '{"type":', 'exec', root, 0)?.status, 'completed');
  assert.equal(observeSession(s, 'other', root, 0), null);
  assert.equal(observeSession(s, 'exec', join(root, 'other'), 0), null);
  assert.equal(observeSession(log(root, 'exec', 'task_complete', 'cli'), 'exec', root, 0), null);
  assert.equal(observeSession(s, 'exec', root, Date.now() + 60000), null);
  assert.equal(
    observeSession(log(root, 'exec', 'turn_aborted'), 'exec', root, 0)?.status,
    'interrupted',
  );
  assert.equal(
    observeSession(
      s + log(root, 'exec', 'task_complete', 'vscode', 'session-1', 'turn-2'),
      'exec',
      root,
      0,
    ),
    null,
  );
});
test('VS Code 监测完成后先验收，不调用模型；验收后后继可交接，中断不解锁', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pawshift-monitor-')),
    work = join(root, 'work'),
    sessions = join(root, 'sessions');
  mkdirSync(work);
  mkdirSync(sessions);
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  const repo = new Repository(join(root, 'test.db'));
  const scheduler = new Scheduler(repo, new IdeAdapter(), () => true);
  try {
    const identity = localIdentity(work);
    repo.addProject({
      id: 'p',
      name: 'project',
      uri: 'file:///project',
      root: work,
      canonicalKey: identity.key,
      archived: false,
      trusted: true,
      accountKey: null,
    });
    const input: TaskInput = {
      projectId: 'p',
      title: 'first',
      objective: 'test',
      acceptance: [{ id: 'manual', type: 'manual', requirement: '确认结果' }],
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
    const first = repo.create([input], false)[0],
      next = repo.create([{ ...input, title: 'next', dependencies: [first.id] }], false)[0];
    const prompt = scheduler.handoff(first.id),
      e = repo.executions()[0];
    assert.ok(prompt.includes('执行标识：' + e.id));
    assert.equal(e.sendState, 'ide-monitor');
    const file = join(sessions, 'rollout-session-1.jsonl');
    writeSession(file, log(work, e.id));
    await scheduler.tick();
    assert.equal(repo.task(first.id).lifecycle, 'VERIFYING');
    assert.match(scheduler.reasons(next, false).join(), /DEPENDENCY/);
    await scheduler.verify(e.id, '已检查实际结果满足标准');
    assert.equal(repo.task(first.id).lifecycle, 'SUCCEEDED');
    await scheduler.tick();
    assert.equal(repo.task(next.id).lifecycle, 'QUEUED');
    scheduler.handoff(next.id);
    const second = repo.executions().find((x) => x.taskId === next.id)!;
    writeSession(file, log(work, second.id, 'turn_aborted'));
    await scheduler.tick();
    assert.equal(repo.task(next.id).lifecycle, 'FAILED');
  } finally {
    scheduler.dispose();
    repo.db.close();
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
