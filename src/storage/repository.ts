import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  Task,
  TaskInput,
  Project,
  Execution,
  active,
  terminal,
  validate,
  redact,
} from '../domain/model';
export class Repository {
  readonly db: DatabaseSync;
  private txDepth = 0;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;',
    );
    const v = Number((this.db.prepare('PRAGMA user_version').get() as any).user_version);
    if (v > 1) throw Error('数据库版本较新，禁止写入');
    this.transaction(() => {
      this.db.exec(`
   CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,canonical_key TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),lifecycle TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS task_revisions(task_id TEXT REFERENCES tasks(id),revision INTEGER,data TEXT NOT NULL,PRIMARY KEY(task_id,revision));
   CREATE TABLE IF NOT EXISTS dependencies(task_id TEXT REFERENCES tasks(id),depends_on TEXT REFERENCES tasks(id),PRIMARY KEY(task_id,depends_on),CHECK(task_id!=depends_on));
   CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),ended_at INTEGER,data TEXT NOT NULL);
   CREATE UNIQUE INDEX IF NOT EXISTS one_active_execution_per_task ON executions(task_id) WHERE ended_at IS NULL;
   CREATE UNIQUE INDEX IF NOT EXISTS one_global_execution ON executions((1)) WHERE ended_at IS NULL;
   CREATE TABLE IF NOT EXISTS leases(resource_key TEXT PRIMARY KEY,execution_id TEXT REFERENCES executions(id),expires_at INTEGER);
   CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,dedup_key TEXT UNIQUE,execution_id TEXT,type TEXT NOT NULL,observed_at INTEGER NOT NULL,payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS command_receipts(id TEXT PRIMARY KEY,result TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS settings(id TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS queued_tasks ON tasks(lifecycle);
   CREATE INDEX IF NOT EXISTS event_history ON events(execution_id,id);
   PRAGMA user_version=1;`);
    });
  }
  transaction<T>(fn: () => T): T {
    const depth = this.txDepth++;
    const name = 'nested_' + depth;
    let begun = false;
    try {
      this.db.exec(depth ? 'SAVEPOINT ' + name : 'BEGIN IMMEDIATE');
      begun = true;
      const r = fn();
      this.db.exec(depth ? 'RELEASE ' + name : 'COMMIT');
      return r;
    } catch (e) {
      if (begun) {
        this.db.exec(depth ? 'ROLLBACK TO ' + name : 'ROLLBACK');
        if (depth) this.db.exec('RELEASE ' + name);
      }
      throw e;
    } finally {
      this.txDepth--;
    }
  }
  all<T>(table: string): T[] {
    if (!['projects', 'tasks', 'executions'].includes(table)) throw Error('table');
    return this.db
      .prepare(`SELECT data FROM ${table}`)
      .all()
      .map((r: any) => JSON.parse(r.data));
  }
  task(id: string): Task {
    const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id) as any;
    if (!row) throw Error('任务不存在');
    return JSON.parse(row.data);
  }
  project(id: string): Project {
    const p = this.all<Project>('projects').find((p) => p.id === id);
    if (!p) throw Error('项目不存在');
    return p;
  }
  addProject(p: Project) {
    this.db
      .prepare('INSERT INTO projects VALUES(?,?,?)')
      .run(p.id, p.canonicalKey, JSON.stringify(p));
    return p;
  }
  saveProject(p: Project) {
    this.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(p), p.id);
  }
  saveTask(t: Task) {
    const expected = t.version;
    t.version++;
    const result = this.db
      .prepare('UPDATE tasks SET lifecycle=?,version=?,data=? WHERE id=? AND version=?')
      .run(t.lifecycle, t.version, JSON.stringify(t), t.id, expected);
    if (!result.changes) {
      t.version = expected;
      throw Error('CONFLICT：任务状态已变化');
    }
  }
  create(inputs: TaskInput[], draft = false): Task[] {
    return this.transaction(() => {
      if (!Array.isArray(inputs) || !inputs.length || inputs.length > 1000)
        throw Error('一次创建 1–1000 个任务');
      const order = Math.max(0, ...this.all<Task>('tasks').map((t) => t.queueOrder || 0));
      const result = inputs.map((i, index) => {
        validate(i);
        this.project(i.projectId);
        return {
          ...i,
          id: randomUUID(),
          revision: 1,
          version: 1,
          lifecycle: draft ? 'DRAFT' : 'QUEUED',
          desiredState: 'run',
          waitReasons: [],
          createdAt: Date.now(),
          queueOrder: order + index + 1,
          completedAt: null,
        } as Task;
      });
      for (const t of result) {
        this.db
          .prepare('INSERT INTO tasks VALUES(?,?,?,?,?)')
          .run(t.id, t.projectId, t.lifecycle, t.version, JSON.stringify(t));
        this.db
          .prepare('INSERT INTO task_revisions VALUES(?,?,?)')
          .run(t.id, t.revision, JSON.stringify(t));
      }
      for (let index = 0; index < result.length; index++) {
        const t = result[index];
        t.dependencies = t.dependencies.map((id) => {
          if (id === '@previous') {
            if (!index) throw Error('首个任务不能依赖前一项');
            return result[index - 1].id;
          }
          return id;
        });
        this.saveTask(t);
        this.db
          .prepare('UPDATE task_revisions SET data=? WHERE task_id=? AND revision=?')
          .run(JSON.stringify(t), t.id, t.revision);
        this.setDependencies(t);
      }
      this.assertGraph();
      return result;
    });
  }
  update(id: string, expected: number, input: TaskInput) {
    return this.transaction(() => {
      validate(input);
      const t = this.task(id);
      if (t.version !== expected) throw Error('CONFLICT：任务已被其他窗口修改');
      if (active.includes(t.lifecycle) || terminal.includes(t.lifecycle))
        throw Error('活动或终态任务请克隆为新任务');
      if (input.projectId !== t.projectId) throw Error('不能迁移任务项目');
      Object.assign(t, input);
      t.revision++;
      this.saveTask(t);
      this.setDependencies(t);
      this.assertGraph();
      this.db
        .prepare('INSERT INTO task_revisions VALUES(?,?,?)')
        .run(t.id, t.revision, JSON.stringify(t));
      return t;
    });
  }
  setDependencies(t: Task) {
    this.db.prepare('DELETE FROM dependencies WHERE task_id=?').run(t.id);
    for (const id of t.dependencies) {
      const other = this.task(id);
      if (other.projectId !== t.projectId) throw Error('依赖必须属于同一项目');
      this.db.prepare('INSERT INTO dependencies VALUES(?,?)').run(t.id, id);
    }
  }
  assertGraph() {
    const tasks = this.all<Task>('tasks'),
      map = new Map(tasks.map((t) => [t.id, t])),
      seen = new Set<string>(),
      stack = new Set<string>();
    const visit = (id: string) => {
      if (stack.has(id))
        throw Error('依赖成环：' + [...stack, id].map((i) => map.get(i)?.title).join(' → '));
      if (seen.has(id)) return;
      stack.add(id);
      for (const d of map.get(id)!.dependencies) {
        if (!map.has(d)) throw Error('依赖缺失');
        visit(d);
      }
      stack.delete(id);
      seen.add(id);
    };
    tasks.forEach((t) => visit(t.id));
  }
  executions() {
    return this.all<Execution>('executions');
  }
  execution(id: string) {
    const e = this.executions().find((e) => e.id === id);
    if (!e) throw Error('执行不存在');
    return e;
  }
  saveExecution(e: Execution) {
    this.db
      .prepare('UPDATE executions SET ended_at=?,data=? WHERE id=?')
      .run(e.endedAt, JSON.stringify(e), e.id);
  }
  claim(id: string, expected: number, baseline: unknown, now = Date.now()): Execution | null {
    return this.transaction(() => {
      const t = this.task(id),
        p = this.project(t.projectId);
      if (
        t.version !== expected ||
        t.lifecycle !== 'QUEUED' ||
        t.desiredState !== 'run' ||
        p.archived ||
        this.executions().some((e) => e.endedAt === null)
      )
        return null;
      if (
        (t.notBefore && t.notBefore > now) ||
        (t.deadline && t.deadline < now) ||
        t.dependencies.some((d) => this.task(d).lifecycle !== 'SUCCEEDED')
      )
        return null;
      const readyAt = Math.max(...t.dependencies.map((d) => this.task(d).completedAt || 0), 0);
      if (t.dependencies.length && readyAt + t.delayMs > now) return null;
      const e: Execution = {
        id: randomUUID(),
        taskId: id,
        revision: t.revision,
        state: 'CLAIMED',
        threadId: null,
        turnId: null,
        startedAt: now,
        endedAt: null,
        snapshot: structuredClone(t),
        baseline,
        sendState: 'unsent',
        evidence: null,
      };
      this.db.prepare('INSERT INTO executions VALUES(?,?,NULL,?)').run(e.id, id, JSON.stringify(e));
      this.db.prepare('INSERT INTO leases VALUES(?,?,?)').run(p.canonicalKey, e.id, now + 60000);
      t.lifecycle = 'CLAIMED';
      t.waitReasons = [];
      this.saveTask(t);
      this.event('dispatch.intent', e.id, { revision: t.revision });
      return e;
    });
  }
  finish(e: Execution, state: 'SUCCEEDED' | 'FAILED' | 'PAUSED' | 'CANCELLED', evidence: unknown) {
    this.transaction(() => {
      const current = this.execution(e.id);
      if (current.endedAt !== null) return;
      const t = this.task(e.taskId);
      if (t.desiredState === 'cancel') state = 'CANCELLED';
      else if (t.desiredState === 'pause') state = 'PAUSED';
      t.lifecycle = state;
      t.waitReasons = [];
      t.completedAt = state === 'SUCCEEDED' ? Date.now() : null;
      this.saveTask(t);
      e.state = state;
      e.endedAt = Date.now();
      e.evidence = evidence;
      this.saveExecution(e);
      this.db.prepare('DELETE FROM leases WHERE execution_id=?').run(e.id);
      this.event('execution.' + state, e.id, evidence);
    });
  }
  event(type: string, id: string | null, payload: unknown, dedup: string | null = null) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO events(dedup_key,execution_id,type,observed_at,payload) VALUES(?,?,?,?,?)',
      )
      .run(dedup, id, type, Date.now(), JSON.stringify(redact(payload)));
  }
  events(id?: string) {
    return (
      id
        ? this.db
            .prepare('SELECT * FROM events WHERE execution_id=? ORDER BY id DESC LIMIT 200')
            .all(id)
        : this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 200').all()
    ).map((r: any) => ({ ...r, payload: JSON.parse(r.payload) }));
  }
  setting<T>(id: string, fallback: T): T {
    const r = this.db.prepare('SELECT data FROM settings WHERE id=?').get(id) as any;
    return r ? JSON.parse(r.data) : fallback;
  }
  set(id: string, value: unknown) {
    this.db
      .prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(id, JSON.stringify(value));
  }
  receipt<T>(id: string, fn: () => T): T {
    return this.transaction(() => {
      const r = this.db.prepare('SELECT result FROM command_receipts WHERE id=?').get(id) as any;
      if (r) return JSON.parse(r.result);
      const result = fn();
      this.db
        .prepare('INSERT INTO command_receipts VALUES(?,?)')
        .run(id, JSON.stringify(result ?? null));
      return result;
    });
  }
  recover() {
    this.transaction(() => {
      for (const e of this.executions().filter((e) => e.endedAt === null)) {
        e.state = 'RECONCILING';
        this.saveExecution(e);
        const t = this.task(e.taskId);
        t.lifecycle = 'RECONCILING';
        t.waitReasons = ['UNKNOWN_OUTCOME'];
        this.saveTask(t);
      }
    });
  }
  close() {
    this.db.close();
  }
}
