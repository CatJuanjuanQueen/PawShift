import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { Repository } from '../src/storage/repository';
import { Task, TaskInput } from '../src/domain/model';
const dir = mkdtempSync(join(tmpdir(), 'pawshift-perf-'));
const repo = new Repository(join(dir, 'queue.db'));
try {
  repo.addProject({
    id: 'p',
    name: 'benchmark',
    uri: 'file:///fixture',
    root: 'fixture',
    canonicalKey: 'fixture',
    accountKey: null,
    archived: false,
  });
  const tasks: TaskInput[] = Array.from({ length: 1000 }, (_, i) => ({
    projectId: 'p',
    title: '性能测试任务 ' + i,
    objective: '测试筛选与分页',
    acceptance: [{ id: 'manual', type: 'manual', requirement: '人工验证' }],
    dependencies: [],
    priority: i % 11,
    notBefore: null,
    deadline: null,
    delayMs: 0,
    permission: 'read-only',
    allowedPaths: ['.'],
    maxTurns: 5,
    maxMinutes: 30,
  }));
  repo.create(tasks);
  const times: number[] = [];
  for (let i = 0; i < 50; i++) {
    const start = performance.now();
    repo
      .all<Task>('tasks')
      .filter((t) => t.title.includes('1'))
      .sort((a, b) => b.priority - a.priority || a.queueOrder - b.queueOrder)
      .slice(0, 30);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const report = {
    tasks: 1000,
    samples: 50,
    p95Ms: times[Math.ceil(times.length * 0.95) - 1],
    targetMs: 500,
    scope: 'SQLite 读取、队列筛选、排序和第一页；不包含 Electron IPC 与窗口绘制',
  };
  writeFileSync('docs/performance.json', JSON.stringify(report, null, 2));
  console.log(report);
  if (report.p95Ms >= 500) process.exitCode = 1;
} finally {
  repo.close();
  rmSync(dir, { recursive: true, force: true });
}
