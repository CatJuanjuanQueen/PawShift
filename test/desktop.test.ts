import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DesktopService, DesktopHost } from '../src/application/desktop-service';
import { Adapter, TaskInput, Project, Task } from '../src/domain/model';
import { AppServer } from '../src/agent/client';
import { Scheduler } from '../src/tasks/scheduler';
class Fake implements Adapter {
  starts = 0;
  async probe() {
    return { fake: true };
  }
  async account() {
    return { key: 'test-account', type: 'chatgpt' };
  }
  async quota() {
    return {
      observedAt: Date.now(),
      accountKey: 'test-account',
      windows: [{ name: 'test', usedPercent: 10, resetsAt: null }],
    };
  }
  async prepare() {
    return 'test-thread';
  }
  async start() {
    this.starts++;
    return 'test-turn';
  }
  async read() {
    return { turns: [] };
  }
  async interrupt() {}
  onEvent() {
    return () => {};
  }
  dispose() {}
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pawshift-desktop-'));
  const work = join(root, 'project');
  mkdirSync(work);
  let backupPath: string | null = null,
    allowed = true,
    copied = '';
  const host: DesktopHost = {
    async chooseDirectory() {
      return work;
    },
    async chooseCodex() {
      return null;
    },
    async chooseBackup() {
      return backupPath;
    },
    async confirm() {
      return allowed;
    },
    async clipboard(text) {
      copied = text;
    },
    async saveFile(name, content) {
      const path = join(root, name);
      writeFileSync(path, content);
      return path;
    },
    async openDataDirectory() {},
  };
  const adapter = new Fake();
  const data = join(root, 'data');
  const service = new DesktopService(data, host, () => adapter);
  const command = (type: string, payload: any = {}, commandId = randomUUID()) =>
    service.command({ type, payload, commandId });
  const input = (projectId: string, title = '独立版任务'): TaskInput => ({
    projectId,
    title,
    objective: '任务目标应不出现在诊断正文',
    acceptance: [{ id: 'manual', type: 'manual', requirement: '人工检查实际结果' }],
    dependencies: [],
    priority: 5,
    notBefore: null,
    deadline: null,
    delayMs: 0,
    permission: 'read-only',
    allowedPaths: ['.'],
    maxTurns: 5,
    maxMinutes: 30,
  });
  return {
    root,
    work,
    data,
    service,
    adapter,
    host,
    command,
    input,
    setBackup: (v: string) => (backupPath = v),
    setAllowed: (v: boolean) => (allowed = v),
    getCopied: () => copied,
    async close() {
      await service.close();
      const checked = resolve(root);
      assert.ok(checked.startsWith(resolve(tmpdir()) + require('node:path').sep));
      rmSync(checked, { recursive: true, force: true });
    },
  };
}
test('桌面自动执行：授权仅作用于活动任务的当前轮次，过期与跨轮次请求不能放行', async () => {
  const f = fixture();
  const a = new AppServer('unused', true);
  const replies: any[] = [];
  (a as any).send = (message: any) => replies.push(message);
  a.probe = async () => ({ sandboxReady: true }) as any;
  a.quota = async () => ({
    observedAt: Date.now(),
    accountKey: 'test-account',
    windows: [{ name: 'test', usedPercent: 0, resetsAt: null }],
  });
  a.prepare = async () => 'managed-thread';
  a.start = async () => 'managed-turn';
  a.interrupt = async () => {
    a.ingest(
      JSON.stringify({
        method: 'turn/completed',
        params: {
          threadId: 'managed-thread',
          turn: { id: 'managed-turn', status: 'interrupted', items: [] },
        },
      }) + '\n',
    );
  };
  try {
    f.service.scheduler.dispose();
    f.service.adapter = a;
    f.service.scheduler = new Scheduler(f.service.repo, a, () => true);
    const p = (await f.command('project.add')).data;
    await f.command('project.trust', { id: p.id, trusted: true });
    await f.command('task.create', { tasks: [f.input(p.id)] });
    assert.equal((await f.command('scheduler.execute')).ok, true);
    assert.equal(f.getCopied(), '');
    a.ingest(
      JSON.stringify({
        id: 11,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'managed-thread', turnId: 'wrong-turn', command: 'test' },
      }) + '\n',
    );
    assert.equal((await f.command('approval.allow', { key: '11' })).ok, false);
    a.ingest(
      JSON.stringify({
        id: 12,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'managed-thread', turnId: 'managed-turn', command: 'test' },
      }) + '\n',
    );
    assert.equal((await f.command('approval.allow', { key: '12' })).ok, true);
    assert.equal(replies.at(-1).result.decision, 'accept');
    assert.equal((await f.command('approval.allow', { key: '12' })).ok, false);
    a.ingest(
      JSON.stringify({
        id: 13,
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'managed-thread', turnId: 'managed-turn' },
      }) + '\n',
    );
    assert.equal((await f.command('approval.reject', { key: '13' })).ok, true);
    assert.equal(replies.at(-1).result.decision, 'decline');
    await new Promise((r) => setTimeout(r, 25));
  } finally {
    await f.close();
  }
});
test('桌面：原生目录关联默认未授权，拒绝授权不改变状态，手动交接与验收闭环', async () => {
  const f = fixture();
  try {
    const p = (await f.command('project.add')).data as Project;
    assert.equal(p.trusted, false);
    assert.match(p.uri, /^file:/);
    const t = (await f.command('task.create', { tasks: [f.input(p.id)] })).data[0] as Task;
    assert.equal((await f.command('task.handoff', { id: t.id })).ok, false);
    f.setAllowed(false);
    await f.command('project.trust', { id: p.id, trusted: true });
    assert.equal(f.service.repo.project(p.id).trusted, false);
    f.setAllowed(true);
    await f.command('project.trust', { id: p.id, trusted: true });
    assert.equal((await f.command('task.handoff', { id: t.id })).ok, true);
    assert.match(f.getCopied(), /任务目标/);
    const e = f.service.repo.executions()[0];
    assert.equal(
      (
        await f.command('task.accept', {
          executionId: e.id,
          reason: '人工核实实际结果与验收标准一致',
        })
      ).ok,
      true,
    );
    assert.equal(f.service.repo.task(t.id).lifecycle, 'SUCCEEDED');
    assert.equal(f.adapter.starts, 0);
  } finally {
    await f.close();
  }
});
test('桌面：真实重复 IPC 命令幂等；设置持久化；未知命令与无效设置拒绝', async () => {
  const f = fixture();
  try {
    const p = (await f.command('project.add')).data;
    const id = randomUUID();
    const results = await Promise.all([
      f.command('task.create', { tasks: [f.input(p.id)] }, id),
      f.command('task.create', { tasks: [f.input(p.id)] }, id),
    ]);
    assert.equal(results[0].data[0].id, results[1].data[0].id);
    assert.equal(f.service.repo.all('tasks').length, 1);
    assert.equal((await f.command('open-arbitrary-path')).ok, false);
    assert.equal((await f.command('settings.save', { quotaThreshold: 4 })).ok, false);
    assert.equal(
      (
        await f.command('settings.save', {
          quotaThreshold: 8,
          theme: 'dark',
          closeBehavior: 'tray',
          codexPath: '',
        })
      ).ok,
      true,
    );
    await f.service.close();
    const reopened = new DesktopService(f.data, f.host, () => f.adapter);
    try {
      assert.equal(reopened.snapshot().settings.theme, 'dark');
      assert.equal(reopened.snapshot().settings.closeBehavior, 'tray');
      assert.equal(reopened.repo.all('tasks').length, 1);
      assert.equal(reopened.snapshot().settings.sandboxValidated, false);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});
test('桌面：一致性备份导入保留活动核对、关闭自动执行、撤销项目授权，不更改来源', async () => {
  const f = fixture();
  try {
    const p = (await f.command('project.add')).data;
    await f.command('project.trust', { id: p.id, trusted: true });
    const t = (await f.command('task.create', { tasks: [f.input(p.id)] })).data[0];
    await f.command('task.handoff', { id: t.id });
    f.service.repo.set('enabled', true);
    const path = (await f.command('backup.create')).data.path;
    const hash = () => createHash('sha256').update(readFileSync(path)).digest('hex');
    const before = hash();
    await f.command('task.accept', {
      executionId: f.service.repo.executions()[0].id,
      reason: '已核实实际任务结果并确认验收通过',
    });
    f.setBackup(path);
    const r = await f.command('storage.import');
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.imported, 1);
    assert.equal(f.service.repo.setting('enabled', true), false);
    assert.equal(f.service.repo.project(p.id).trusted, false);
    assert.equal(f.service.repo.task(t.id).lifecycle, 'RECONCILING');
    assert.equal(f.service.repo.executions()[0].endedAt, null);
    assert.equal(hash(), before);
    assert.equal(f.service.repo.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally {
    await f.close();
  }
});
test('桌面：诊断预览与原生保存内容一致，不包含目标和提示词', async () => {
  const f = fixture();
  try {
    const p = (await f.command('project.add')).data;
    await f.command('task.create', { tasks: [f.input(p.id)] });
    const preview = (await f.command('diagnostics.export')).data.preview;
    assert.ok(!preview.includes('任务目标应不出现在诊断正文'));
    assert.equal(JSON.parse(preview).app, 'PawShift Desktop');
    const saved = (await f.command('diagnostics.save')).data.path;
    assert.equal(JSON.parse(readFileSync(saved, 'utf8')).tasks.length, 1);
  } finally {
    await f.close();
  }
});
