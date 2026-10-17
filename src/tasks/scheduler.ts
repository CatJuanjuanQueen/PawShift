import { randomUUID, createHash } from 'node:crypto';
import { realpathSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Repository } from '../storage/repository';
import { IdeAdapter } from '../legacy/ide-adapter';
import { findObservation } from '../legacy/session-monitor';
import {
  Adapter,
  Task,
  Project,
  Execution,
  Quota,
  active,
  terminal,
  safeRelative,
  redact,
} from '../domain/model';
import { checkFiles } from './acceptance';
export function localIdentity(root: string) {
  const real = realpathSync(root);
  if (!statSync(real).isDirectory()) throw Error('请选择目录');
  return {
    root: real,
    key: process.platform + ':' + (process.platform === 'win32' ? real.toLowerCase() : real),
  };
}
export function inside(root: string, path: string) {
  safeRelative(path);
  const target = realpathSync(resolve(root, path)),
    r = relative(realpathSync(root), target);
  if (r.startsWith('..') || isAbsolute(r)) throw Error('符号链接越过项目边界');
  return target;
}
export function baseline(root: string): unknown {
  try {
    return {
      kind: 'git',
      head: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
      status: execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
      diffHash: createHash('sha256')
        .update(
          execFileSync('git', ['diff', 'HEAD'], {
            cwd: root,
            windowsHide: true,
            timeout: 10000,
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer: 10 * 1024 * 1024,
          }),
        )
        .digest('hex'),
    };
  } catch {
    const files: Record<string, string> = {};
    let count = 0;
    const scan = (dir: string) => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (['.git', 'node_modules', '.env'].includes(f.name) || f.isSymbolicLink()) continue;
        if (++count > 2000) throw Error('非 Git 项目文件超过基线上限，请使用 Git');
        const p = join(dir, f.name);
        if (f.isDirectory()) scan(p);
        else if (f.isFile()) {
          const s = statSync(p);
          if (s.size > 10 * 1024 * 1024) throw Error('基线文件超过 10MiB');
          files[relative(root, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
        }
      }
    };
    scan(root);
    return { kind: 'manifest', files };
  }
}
export class Scheduler {
  private disposed = false;
  private busy?: Promise<void>;
  private refreshFlight?: Promise<Quota>;
  private dispatchGeneration = 0;
  private controls = new Map<string, Promise<void>>();
  private lastRefresh = 0;
  private timer?: NodeJS.Timeout;
  private unsubscribe: () => void;
  private eventQueue = Promise.resolve();
  private logBuffer: any[] = [];
  private logTimer?: NodeJS.Timeout;
  quota: Quota = { observedAt: 0, accountKey: null, windows: [] };
  capabilities: unknown = null;
  error = '';
  constructor(
    readonly repo: Repository,
    readonly adapter: Adapter,
    readonly trusted: () => boolean,
    readonly changed: () => void = () => {},
  ) {
    this.repo.recover();
    this.unsubscribe = adapter.onEvent((m, p) => {
      if (m === 'item/agentMessage/delta') {
        this.logBuffer.push(p);
        if (!this.logTimer) this.logTimer = setTimeout(() => this.flushLogs(), 250);
        return;
      }
      this.flushLogs();
      this.enqueueEvent(m, p);
    });
  }
  private enqueueEvent(m: string, p: any) {
    if (this.disposed) return;
    this.eventQueue = this.eventQueue
      .then(() => this.event(m, p))
      .catch((e) => {
        this.error = String(e);
        this.changed();
      });
  }
  private flushLogs() {
    if (this.logTimer) clearTimeout(this.logTimer);
    this.logTimer = undefined;
    const grouped = new Map<string, any>();
    for (const p of this.logBuffer.splice(0)) {
      const key = p.threadId + ':' + p.turnId;
      const old = grouped.get(key);
      if (old) old.delta += p.delta;
      else grouped.set(key, { ...p });
    }
    for (const p of grouped.values()) this.enqueueEvent('item/agentMessage/delta', p);
  }
  startClock() {
    this.timer = setInterval(
      () => {
        void this.tick().catch((e) => {
          this.error = String(e);
          this.changed();
        });
      },
      this.adapter instanceof IdeAdapter || this.adapter.managed ? 5000 : 60000,
    );
    this.timer.unref();
  }
  private async monitorIde() {
    for (const e of this.repo
      .executions()
      .filter((e) => e.endedAt === null && e.sendState === 'ide-monitor')) {
      const p = this.repo.project(e.snapshot.projectId);
      if (!p.uri.startsWith('file:')) continue;
      const found = findObservation(e.id, p.root, e.startedAt, undefined, e.threadId);
      if (!found) continue;
      if ((e.threadId && e.threadId !== found.threadId) || (e.turnId && e.turnId !== found.turnId))
        continue;
      const previous = (e.evidence as any)?.monitor;
      if (previous?.status === found.status && previous?.observedAt === found.observedAt) continue;
      e.threadId = found.threadId;
      e.turnId = found.turnId;
      e.evidence = { ...(e.evidence as object), monitor: found };
      const t = this.repo.task(e.taskId);
      if (found.status === 'running') {
        if (t.desiredState !== 'run' || t.lifecycle === 'RECONCILING') continue;
        e.state = 'RUNNING';
        t.lifecycle = 'RUNNING';
        t.waitReasons = [];
        this.repo.saveExecution(e);
        this.repo.saveTask(t);
      } else if (t.desiredState !== 'run') {
        this.repo.finish(e, t.desiredState === 'cancel' ? 'CANCELLED' : 'PAUSED', e.evidence);
      } else if (found.status === 'completed') {
        e.state = 'VERIFYING';
        t.lifecycle = 'VERIFYING';
        t.waitReasons = [];
        this.repo.saveExecution(e);
        this.repo.saveTask(t);
        await this.verify(e.id);
      } else this.repo.finish(e, 'FAILED', e.evidence);
      this.repo.event('ide.monitor', e.id, found);
      this.changed();
    }
  }
  async refresh(force = false) {
    if (this.refreshFlight) return this.refreshFlight;
    if (!force && this.quota.observedAt > 0 && Date.now() - this.lastRefresh < 10000)
      return this.quota;
    this.lastRefresh = Date.now();
    this.refreshFlight = (async () => {
      try {
        this.capabilities = await this.adapter.probe();
        this.quota = await this.adapter.quota();
        this.repo.set('quota', this.quota);
        this.error = '';
      } catch (e) {
        this.error = String(e);
        this.quota = { observedAt: Date.now(), accountKey: null, windows: [], error: this.error };
      }
      this.changed();
      return this.quota;
    })();
    try {
      return await this.refreshFlight;
    } finally {
      this.refreshFlight = undefined;
    }
  }
  reasons(t: Task, automatic = true, now = Date.now()): string[] {
    const r: string[] = [];
    const p = this.repo.project(t.projectId);
    if (!this.trusted()) r.push('WORKSPACE：工作区未信任');
    if (p.trusted === false) r.push('WORKSPACE：项目尚未授权，请在项目管理中允许访问');
    if (p.archived) r.push('WORKSPACE：项目已归档');
    if (!p.uri.startsWith('file:')) r.push('WORKSPACE：远程项目仅支持管理与交接');
    else {
      try {
        if (localIdentity(p.root).key !== p.canonicalKey) r.push('WORKSPACE：目录身份已变化');
      } catch {
        r.push('NETWORK_WORKSPACE：目录不可访问');
      }
    }
    if (t.desiredState !== 'run') r.push('USER_PAUSE：用户已暂停');
    if (t.notBefore && t.notBefore > now) r.push('TIME：未到最早开始时间');
    if (t.deadline && t.deadline < now) r.push('DEADLINE：错过截止，需处理');
    const deps = t.dependencies.map((id) => this.repo.task(id));
    if (deps.some((d) => d.lifecycle !== 'SUCCEEDED')) r.push('DEPENDENCY：前置未成功验收');
    else if (deps.length && Math.max(...deps.map((d) => d.completedAt || 0)) + t.delayMs > now)
      r.push('TIME：等待前置完成后的延迟');
    if (automatic) {
      if (
        this.adapter.managed &&
        t.permission === 'restricted' &&
        (t.allowedPaths.length !== 1 || t.allowedPaths[0] !== '.')
      )
        r.push('POLICY：自动修改需允许整个项目（路径 .）；细分路径可手动交接');
      if (this.adapter.managed && (this.capabilities as any)?.sandboxReady !== true)
        r.push('POLICY：执行沙箱尚未就绪，请在设置中初始化');
      if (this.adapter instanceof IdeAdapter) {
        r.push('IDE：下一项请点击交接，在 VS Code Codex 中提交');
        return r;
      }
      if (this.repo.setting('integrationPending', null)) r.push('POLICY：接入测试尚有未核对执行');
      if (!this.adapter.managed && !this.repo.setting('sandboxValidated', false))
        r.push('POLICY：Windows 沙箱契约尚未验证，自动执行保持禁用');
      if (!this.adapter.managed && t.permission !== 'read-only')
        r.push('POLICY：受限写入沙箱未验证，请手动交接');
      if (!this.adapter.managed && !this.repo.setting('integrationValidated', false))
        r.push('POLICY：本机接入验收尚未通过');
      if (!this.quota.accountKey) r.push('AUTH：未确认 ChatGPT 账户');
      if (!this.adapter.managed && !p.accountKey) r.push('AUTH：项目未绑定账户，请先明确绑定');
      if (p.accountKey && p.accountKey !== this.quota.accountKey)
        r.push('AUTH：账户变化，请重新绑定项目');
      if (this.error) r.push('NETWORK_MODEL：' + this.error);
      const threshold = this.repo.setting('quotaThreshold', 5);
      if (
        now - this.quota.observedAt > 300000 ||
        !this.quota.windows.length ||
        this.quota.windows.some((w) => w.usedPercent === null)
      )
        r.push('QUOTA：额度未知或过期');
      else if (this.quota.windows.some((w) => 100 - w.usedPercent! < threshold))
        r.push('QUOTA：至少一个窗口不足');
    }
    return r;
  }
  tick() {
    if (this.busy) return this.busy;
    this.busy = this.runTick();
    return this.busy.finally(() => {
      this.busy = undefined;
    });
  }
  private async runTick() {
    const generation = this.dispatchGeneration;
    if (this.adapter instanceof IdeAdapter) {
      await this.monitorIde();
      const waiting = this.repo.all<Task>('tasks').filter((t) => t.lifecycle === 'QUEUED');
      let changed = false;
      for (const t of waiting) {
        const reasons = this.reasons(t, false);
        if (JSON.stringify(reasons) !== JSON.stringify(t.waitReasons)) {
          t.waitReasons = reasons;
          this.repo.saveTask(t);
          changed = true;
        }
      }
      if (changed) this.changed();
      return;
    }
    const running = this.repo.executions().filter((e) => e.endedAt === null);
    for (const e of running) {
      if (e.state === 'RUNNING' && Date.now() - e.startedAt > e.snapshot.maxMinutes * 60000)
        await this.control(e.taskId, 'pause', '模型活动时间已到上限');
    }
    if (!this.repo.setting('enabled', false)) return;
    if (Date.now() - this.quota.observedAt > 300000) await this.refresh();
    if (
      !this.repo.setting('enabled', false) ||
      generation !== this.dispatchGeneration ||
      this.disposed
    )
      return;
    const tasks = this.repo
      .all<Task>('tasks')
      .filter((t) => t.lifecycle === 'QUEUED')
      .sort(
        (a, b) =>
          (this.repo.setting('queueMode', 'priority') === 'priority'
            ? b.priority - a.priority
            : 0) ||
          (a.queueOrder || 0) - (b.queueOrder || 0) ||
          a.createdAt - b.createdAt,
      );
    for (const t of tasks) {
      const r = this.reasons(t);
      if (this.repo.executions().some((e) => e.endedAt === null))
        r.push('LOCK：已有活动执行，先等待或核对');
      if (JSON.stringify(t.waitReasons) !== JSON.stringify(r)) {
        t.waitReasons = r;
        this.repo.saveTask(t);
      }
    }
    this.changed();
    if (this.repo.executions().some((e) => e.endedAt === null)) return;
    const resumeId = this.repo.setting<string | null>('resumeTaskId', null);
    const candidate =
      resumeId && tasks.some((t) => t.id === resumeId)
        ? tasks.find((t) => t.id === resumeId && !t.waitReasons.length)
        : tasks.find((t) => !t.waitReasons.length);
    if (!candidate) return;
    const p = this.repo.project(candidate.projectId);
    const e = this.repo.claim(
      candidate.id,
      candidate.version,
      this.adapter.managed
        ? { kind: 'managed-project', root: realpathSync(p.root) }
        : baseline(p.root),
    );
    if (!e) return;
    this.changed();
    const previous = this.repo
      .executions()
      .filter(
        (old) =>
          old.taskId === e.taskId &&
          old.id !== e.id &&
          old.endedAt !== null &&
          old.state === 'PAUSED' &&
          old.revision === e.revision &&
          old.sendState === 'managed-sent' &&
          old.threadId &&
          old.turnId,
      )
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    const resume = this.adapter.managed && previous;
    try {
      if (resume && !this.adapter.resume)
        throw Error('当前 AGENT 不支持恢复会话，未重复发送原任务');
      if (resume && previous.runningItems?.length) {
        const thread = await this.adapter.read(previous.threadId!);
        const turn = thread.turns?.find((turn: any) => turn.id === previous.turnId);
        if (
          !turn ||
          !['completed', 'interrupted', 'failed'].includes(turn.status) ||
          !Array.isArray(turn.items) ||
          turn.items.some((item: any) => item.status === 'inProgress') ||
          thread.status?.type === 'active'
        )
          throw Error('旧任务的工具尚未确认停止，暂未恢复，请稍后核对再继续。');
        previous.runningItems = [];
        previous.activity = '已核对原轮次停止';
        this.repo.saveExecution(previous);
      }
      const threadId = resume
        ? await this.adapter.resume!(previous.threadId!, e.snapshot, p)
        : await this.adapter.prepare(e.snapshot, p);
      // Pause/cancel may finish an unsent claim while thread preparation is in flight.
      const prepared = this.repo.execution(e.id);
      if (prepared.endedAt !== null) return;
      if (
        !this.repo.setting('enabled', false) ||
        generation !== this.dispatchGeneration ||
        this.repo.task(e.taskId).desiredState !== 'run'
      ) {
        await this.control(e.taskId, 'pause');
        return;
      }
      e.threadId = threadId;
      this.repo.saveExecution(e);
      // Persist possible-send before the external request. Never replay ambiguous start.
      e.sendState = this.adapter.managed ? 'managed-sent' : 'possibly-sent';
      this.repo.saveExecution(e);
      this.repo.event('dispatch.sending', e.id, {});
      if (this.repo.setting('resumeTaskId', null) === e.taskId) this.repo.set('resumeTaskId', null);
      e.turnId = await this.adapter.start(
        e.threadId,
        this.prompt(e.snapshot, e.id) +
          (resume
            ? '\n\n这是暂停后的继续执行。沿用本会话已有上下文，先核对已完成的工作、文件和命令结果，再完成剩余目标。不要盲目重复已完成的修改或外部操作；无法确认时先说明并等待用户。'
            : ''),
      );
      const current = this.repo.execution(e.id);
      if (current.endedAt !== null || current.state === 'VERIFYING') return;
      current.turnId = e.turnId;
      current.state = 'RUNNING';
      this.repo.saveExecution(current);
      const task = this.repo.task(e.taskId);
      task.lifecycle = 'RUNNING';
      this.repo.saveTask(task);
      this.repo.event('dispatch.confirmed', e.id, { threadId: e.threadId, turnId: e.turnId });
      if (task.desiredState !== 'run')
        await this.control(task.id, task.desiredState === 'cancel' ? 'cancel' : 'pause');
    } catch (err) {
      // A terminal notification can arrive even when the start RPC response is lost.
      // Never resurrect that finished execution with the stale pre-send object.
      const current = this.repo.execution(e.id);
      if (current.endedAt !== null) return;
      if (e.sendState === 'unsent') {
        if (resume) {
          const task = this.repo.task(e.taskId);
          task.desiredState = 'pause';
          this.repo.saveTask(task);
          this.repo.set('enabled', false);
          this.repo.set('schedulingPaused', true);
          this.repo.set('pausedTaskId', task.id);
          e.activity = '恢复未启动，可重试继续';
        }
        this.repo.finish(e, 'FAILED', { error: String(err), confirmedNoTurnSent: true });
        this.changed();
        return;
      }
      current.state = 'RECONCILING';
      current.evidence = { error: String(err) };
      this.repo.saveExecution(current);
      const t = this.repo.task(e.taskId);
      t.lifecycle = 'RECONCILING';
      t.waitReasons = ['UNKNOWN_OUTCOME：' + String(err)];
      this.repo.saveTask(t);
      this.repo.event('dispatch.unknown', e.id, { error: String(err) });
    }
    this.changed();
  }
  prompt(t: Task, id?: string) {
    return [
      '任务：' + t.title,
      '目标：' + t.objective,
      '验收：' + t.acceptance.map((c) => c.requirement).join('\n'),
      '授权：' + t.permission + '；项目相对路径 ' + t.allowedPaths.join(', '),
      '不允许未经授权的外部写入、发布、付费或设备操作。',
      '执行标识：' + (id || '手动交接'),
      this.adapter.managed
        ? '逐项落实目标与完成条件，必要时运行检查。只有全部完成才正常结束；无法完成或需要用户补充时明确指出，不要宣称完成。完成后请说明做了什么、验证结果与未完成事项。PawShift会显示你的结果，并检查配置的文件验收条件。'
        : '结果请说明已做工作、验收证据、未完成事项。模型声明完成不代表验收通过。',
    ].join('\n\n');
  }
  control(id: string, action: 'pause' | 'cancel', reason = '用户操作'): Promise<void> {
    const key = id + ':' + action;
    const old = this.controls.get(key);
    if (old) return old;
    const work = this.controlTask(id, action, reason).finally(() => this.controls.delete(key));
    this.controls.set(key, work);
    return work;
  }
  private async controlTask(id: string, action: 'pause' | 'cancel', reason: string) {
    let t = this.repo.task(id);
    if (terminal.includes(t.lifecycle)) return;
    t.desiredState = action;
    this.repo.saveTask(t);
    const e = this.repo.executions().find((e) => e.taskId === id && e.endedAt === null);
    if (!e) {
      t.lifecycle = action === 'cancel' ? 'CANCELLED' : 'PAUSED';
      this.repo.saveTask(t);
      this.changed();
      return;
    }
    if (e.sendState === 'unsent') {
      this.repo.finish(e, action === 'cancel' ? 'CANCELLED' : 'PAUSED', {
        reason,
        confirmedNoTurnSent: true,
      });
      this.changed();
      return;
    }
    if (['manual', 'ide-monitor'].includes(e.sendState)) {
      e.state = 'RECONCILING';
      this.repo.saveExecution(e);
      t.lifecycle = 'RECONCILING';
      t.waitReasons = ['UNKNOWN_OUTCOME：手动交接不能远程停止，请确认原操作和副作用已停止'];
      this.repo.saveTask(t);
      this.changed();
      return;
    }
    if (e.threadId && e.turnId) {
      // A successful interrupt request is not a terminal confirmation.
      if ((e.evidence as any)?.interruptRequested === action) return;
      try {
        if (e.sendState === 'managed-sent') {
          e.state = 'RECONCILING';
          e.evidence = { ...(e.evidence as object), interruptRequested: action };
          e.activity =
            action === 'pause' ? '正在暂停，等待 AGENT 确认' : '正在取消，等待 AGENT 确认';
          this.repo.saveExecution(e);
          t = this.repo.task(id);
          t.lifecycle = 'RECONCILING';
          t.waitReasons = ['UNKNOWN_OUTCOME：已请求停止，等待执行端确认'];
          this.repo.saveTask(t);
          this.changed();
          await this.adapter.interrupt(e.threadId, e.turnId);
        } else {
          await this.adapter.interrupt(e.threadId, e.turnId);
          await this.reconcile(e.id);
        }
      } catch (err) {
        if (this.repo.execution(e.id).endedAt !== null) return;
        t = this.repo.task(id);
        const current = this.repo.execution(e.id);
        current.evidence = {
          ...(current.evidence as object),
          interruptRequested: null,
          interruptError: String(err),
        };
        this.repo.saveExecution(current);
        t.lifecycle = 'RECONCILING';
        t.waitReasons = ['UNKNOWN_OUTCOME：中断尚未确认 ' + String(err)];
        this.repo.saveTask(t);
      }
    } else {
      t.lifecycle = 'RECONCILING';
      t.waitReasons = ['UNKNOWN_OUTCOME：执行标识不完整'];
      this.repo.saveTask(t);
    }
    this.changed();
  }
  async reconcile(id: string) {
    const e = this.repo.execution(id);
    if (e.endedAt !== null) return;
    if (e.sendState === 'ide-monitor') {
      await this.monitorIde();
      this.changed();
      return;
    }
    if (e.sendState === 'manual') return;
    if (!e.threadId) {
      this.repo.event('recovery.unknown', id, { reason: '缺少线程身份，不自动重试' });
      return;
    }
    let thread: any;
    try {
      thread = await this.adapter.read(e.threadId);
    } catch (err) {
      if (e.sendState !== 'managed-sent') throw err;
      const p = this.repo.project(e.snapshot.projectId);
      const found = findObservation(e.id, p.root, e.startedAt, undefined, e.threadId);
      if (
        !found ||
        found.threadId !== e.threadId ||
        found.turnId !== e.turnId ||
        found.status === 'running'
      )
        throw Error('原执行尚未确认停止，保留恢复锁');
      thread = {
        turns: [{ id: found.turnId, status: found.status, itemsView: 'full', items: [] }],
      };
    }
    const turn = thread.turns?.find((t: any) => t.id === e.turnId);
    if (!turn) {
      this.repo.event('recovery.unknown', id, { reason: '无法核对轮次，不自动重试' });
      return;
    }
    await this.handleTurn(e, turn);
    this.changed();
  }
  private async event(method: string, p: any) {
    if (
      ['account/updated', 'account/rateLimits/updated', 'windowsSandbox/setupCompleted'].includes(
        method,
      )
    ) {
      await this.refresh(true);
      setImmediate(
        () =>
          void this.tick().catch((error) => {
            this.error = String(error);
            this.changed();
          }),
      );
      return;
    }
    if (method === 'transport/closed') {
      this.repo.set('enabled', false);
      this.repo.recover();
      this.error = p?.error || 'AGENT 连接断开，请重新连接并核对活动任务。';
      this.changed();
      return;
    }
    const e = this.repo
      .executions()
      .find((e) => e.endedAt === null && e.threadId === (p?.threadId || p?.params?.threadId));
    if (!e) {
      if (method === 'approval/request') this.changed();
      return;
    }
    const incomingTurn = p?.turnId || p?.turn?.id || p?.params?.turnId;
    if (
      !e.turnId &&
      incomingTurn &&
      this.repo
        .executions()
        .some(
          (old) => old.id !== e.id && old.threadId === e.threadId && old.turnId === incomingTurn,
        )
    )
      return;
    if (incomingTurn && e.turnId && incomingTurn !== e.turnId) return;
    if (method === 'turn/completed') {
      if (!p.turn?.id || (e.turnId && e.turnId !== p.turn.id)) return;
      if (!e.turnId) {
        e.turnId = p.turn.id;
        this.repo.saveExecution(e);
      }
      if (e.sendState === 'managed-sent') await this.handleTurn(e, p.turn);
      else await this.reconcile(e.id);
    } else if (method === 'approval/request') {
      const t = this.repo.task(e.taskId);
      if (t.desiredState !== 'run') return;
      t.waitReasons = ['APPROVAL：AGENT 正在等待本次权限，请允许或拒绝'];
      this.repo.saveTask(t);
      this.repo.event(method, e.id, { key: p.key, method: p.method, summary: p.params });
    } else if (method === 'item/agentMessage/delta') {
      if (this.adapter.managed) {
        e.output = redact((e.output || '') + (p.delta || '')).slice(-64000);
        e.activity = 'AGENT 正在处理任务';
        this.repo.saveExecution(e);
      } else this.repo.event('log.delta', e.id, { text: p.delta });
    } else if (this.adapter.managed && ['item/started', 'item/completed'].includes(method)) {
      const item = p.item;
      if (!item) return;
      const completed = method === 'item/completed';
      if (
        ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(item.type)
      ) {
        const running = new Set(e.runningItems || []);
        if (item.id) {
          if (completed) running.delete(item.id);
          else running.add(item.id);
        }
        e.runningItems = [...running];
        e.activity =
          item.type === 'fileChange'
            ? completed
              ? '文件修改完成'
              : 'AGENT 正在修改文件'
            : completed
              ? '工具执行完成'
              : 'AGENT 正在执行工具';
        this.repo.event('agent.activity', e.id, {
          type: item.type,
          status: item.status,
          command: item.command,
          exitCode: item.exitCode,
          changes: item.changes?.map((c: any) => ({ path: c.path, kind: c.kind })),
          output: item.aggregatedOutput?.slice(-2000),
        });
      } else if (item.type === 'agentMessage' && completed && typeof item.text === 'string') {
        e.output = redact(item.text).slice(-64000);
        e.activity = item.phase === 'final_answer' ? 'AGENT 已返回结果' : 'AGENT 正在处理任务';
      }
      this.repo.saveExecution(e);
      const pendingTerminal = (e.evidence as any)?.pendingTerminal;
      if (completed && pendingTerminal && this.repo.task(e.taskId).desiredState !== 'run') {
        const updated = {
          ...pendingTerminal,
          items: (pendingTerminal.items || []).map((old: any) => (old.id === item.id ? item : old)),
        };
        e.evidence = { ...(e.evidence as object), pendingTerminal: updated };
        this.repo.saveExecution(e);
        if (!e.runningItems?.length) await this.handleTurn(e, updated);
      }
    } else if (method === 'item/completed' && !this.adapter.managed)
      this.repo.event(method, e.id, p);
    this.changed();
  }
  private async handleTurn(e: Execution, turn: any) {
    const t = this.repo.task(e.taskId);
    if (turn.status === 'inProgress') {
      e.state = t.desiredState === 'run' ? 'RUNNING' : 'RECONCILING';
      this.repo.saveExecution(e);
      t.lifecycle = e.state;
      this.repo.saveTask(t);
      return;
    }
    if (!this.adapter.managed && (turn.itemsView !== 'full' || !Array.isArray(turn.items))) {
      t.lifecycle = 'RECONCILING';
      t.waitReasons = ['UNKNOWN_OUTCOME：轮次记录不完整'];
      this.repo.saveTask(t);
      return;
    }
    if (!['completed', 'interrupted', 'failed'].includes(turn.status)) {
      t.lifecycle = 'RECONCILING';
      t.waitReasons = ['UNKNOWN_OUTCOME：未知轮次终态'];
      this.repo.saveTask(t);
      return;
    }
    this.repo.event(
      'turn.terminal',
      e.id,
      e.sendState === 'managed-sent'
        ? { turnId: turn.id, status: turn.status, error: turn.error }
        : { turn },
      e.id + ':terminal:' + turn.id,
    );
    // Unknown command-process ownership is never treated as proof of stopped jobs.
    if (
      e.sendState !== 'managed-sent' &&
      turn.items?.some((i: any) => i.type === 'commandExecution')
    ) {
      e.state = 'RECONCILING';
      e.evidence = { turn };
      this.repo.saveExecution(e);
      t.lifecycle = 'RECONCILING';
      t.waitReasons = ['UNKNOWN_OUTCOME：存在命令作业，请人工核对进程与副作用'];
      this.repo.saveTask(t);
      return;
    }
    if (t.desiredState !== 'run') {
      const items = Array.isArray(turn.items) ? turn.items : [];
      const runningIds = new Set(e.runningItems || []);
      for (const item of items)
        if (item.id && item.status !== 'inProgress') runningIds.delete(item.id);
      if (
        items.some(
          (item: any) => item.type === 'commandExecution' && item.status === 'inProgress',
        ) ||
        runningIds.size
      ) {
        e.state = 'RECONCILING';
        e.evidence = { ...(e.evidence as object), pendingTerminal: turn };
        e.activity = '等待执行中的工具停止，请刷新核对';
        this.repo.saveExecution(e);
        t.lifecycle = 'RECONCILING';
        t.waitReasons = ['UNKNOWN_OUTCOME：轮次已结束，仍需核对工具是否停止'];
        this.repo.saveTask(t);
        return;
      }
      e.activity = t.desiredState === 'cancel' ? 'AGENT 已取消' : 'AGENT 已确认暂停';
      this.repo.finish(
        e,
        t.desiredState === 'cancel' ? 'CANCELLED' : 'PAUSED',
        e.sendState === 'managed-sent' ? { turnId: turn.id, status: turn.status } : { turn },
      );
      return;
    }
    if (turn.status !== 'completed') {
      this.repo.finish(
        e,
        'FAILED',
        e.sendState === 'managed-sent'
          ? { turnId: turn.id, status: turn.status, error: turn.error }
          : { turn },
      );
      return;
    }
    if (e.sendState === 'managed-sent') {
      const items = Array.isArray(turn.items) ? turn.items : [];
      const jobs = items.filter((i: any) => i.type === 'commandExecution');
      if (jobs.some((i: any) => i.status === 'inProgress') || e.runningItems?.length) {
        e.state = 'RECONCILING';
        this.repo.saveExecution(e);
        t.lifecycle = 'RECONCILING';
        t.waitReasons = ['UNKNOWN_OUTCOME：仍有命令执行中'];
        this.repo.saveTask(t);
        return;
      }
      const finalMessage = items
        .filter((i: any) => i.type === 'agentMessage' && typeof i.text === 'string')
        .at(-1);
      if (finalMessage) e.output = redact(finalMessage.text).slice(-64000);
      const acceptance = checkFiles(this.repo.project(t.projectId), e.snapshot.acceptance);
      const passed = acceptance.every((check) => check.state === 'PASSED');
      e.activity = passed ? 'AGENT 已完成' : '文件验收未通过';
      this.repo.finish(e, passed ? 'SUCCEEDED' : 'FAILED', {
        source: 'codex-agent',
        turnId: turn.id,
        status: turn.status,
        acceptance,
        completedAt: Date.now(),
      });
      this.changed();
      setImmediate(
        () =>
          void this.tick().catch((err) => {
            this.error = String(err);
            this.changed();
          }),
      );
      return;
    }
    e.state = 'VERIFYING';
    e.evidence = { turn };
    this.repo.saveExecution(e);
    t.lifecycle = 'VERIFYING';
    t.waitReasons = [];
    this.repo.saveTask(t);
    await this.verify(e.id);
  }
  async verify(id: string, manualReason?: string) {
    const e = this.repo.execution(id),
      t = this.repo.task(e.taskId);
    if (e.endedAt !== null || t.lifecycle !== 'VERIFYING') throw Error('当前执行不可验收');
    if (manualReason !== undefined && !manualReason.trim()) throw Error('填写人工验收理由');
    const p = this.repo.project(t.projectId);
    const results = e.snapshot.acceptance.map((c) => {
      if (c.type === 'manual')
        return {
          id: c.id,
          state: manualReason ? 'MANUAL_ACCEPTED' : 'UNVERIFIED',
          reason: manualReason || '待人工验收',
          source: 'user',
          revision: e.revision,
        };
      try {
        if (!p.uri.startsWith('file:')) throw Error('远程文件无法本机验证');
        const f = inside(p.root, c.path!);
        if (!statSync(f).isFile()) throw Error('不是文件');
        const b = readFileSync(f);
        if (b.length > 10 * 1024 * 1024) throw Error('验收文件超过 10MiB');
        if (c.contains && !b.toString('utf8').includes(c.contains)) throw Error('缺少所要求的内容');
        return {
          id: c.id,
          state: 'PASSED',
          hash: createHash('sha256').update(b).digest('hex'),
          path: c.path,
          checkedAt: Date.now(),
        };
      } catch (err) {
        return { id: c.id, state: 'FAILED', reason: String(err) };
      }
    });
    e.evidence = { ...(e.evidence as object), acceptance: results };
    this.repo.saveExecution(e);
    this.repo.event('acceptance.checked', e.id, results);
    if (results.every((r) => ['PASSED', 'MANUAL_ACCEPTED'].includes(r.state))) {
      this.repo.finish(e, 'SUCCEEDED', e.evidence);
      void this.tick();
    } else {
      t.waitReasons = results.some((r) => r.state === 'FAILED')
        ? ['ACCEPTANCE：验收失败，保留执行与证据']
        : ['APPROVAL：等待人工验收'];
      this.repo.saveTask(t);
    }
    this.changed();
  }
  handoff(id: string) {
    if (this.repo.setting('integrationPending', null)) throw Error('先核对接入验收执行');
    let t = this.repo.task(id);
    if (t.lifecycle === 'DRAFT') {
      t.lifecycle = 'QUEUED';
      this.repo.saveTask(t);
    }
    if (t.lifecycle !== 'QUEUED') throw Error('仅排队任务可交接');
    const reasons = this.reasons(t, false).filter((x) => !x.startsWith('WORKSPACE：远程'));
    if (reasons.length) throw Error(reasons.join('\n'));
    const p = this.repo.project(t.projectId);
    const e = this.repo.claim(
      t.id,
      t.version,
      p.uri.startsWith('file:') ? baseline(p.root) : { remote: true },
    );
    if (!e) throw Error('RESOURCE_BUSY：已有活动任务');
    const monitoring =
      this.adapter instanceof IdeAdapter &&
      this.adapter.mode === 'vscode' &&
      p.uri.startsWith('file:');
    e.state = monitoring ? 'CLAIMED' : 'VERIFYING';
    e.sendState = monitoring ? 'ide-monitor' : 'manual';
    this.repo.saveExecution(e);
    t = this.repo.task(id);
    t.lifecycle = monitoring ? 'CLAIMED' : 'VERIFYING';
    t.waitReasons = [
      monitoring
        ? 'IDE：提示词已复制，请粘贴到对应项目的 VS Code Codex 并提交；正在等待轮次开始'
        : 'APPROVAL：请将提示词提交给 Codex，执行完毕后人工验收',
    ];
    this.repo.saveTask(t);
    this.repo.event('manual.handoff', e.id, {});
    this.changed();
    return this.prompt(t, e.id);
  }
  resume(id: string, dispatch = true) {
    const t = this.repo.task(id);
    if (!['PAUSED', 'DRAFT'].includes(t.lifecycle))
      throw Error('仅草稿或暂停任务可入队；失败任务请克隆');
    if (this.repo.executions().some((e) => e.taskId === id && e.endedAt === null))
      throw Error('先核对旧执行');
    if (t.lifecycle === 'PAUSED') this.repo.set('resumeTaskId', id);
    t.lifecycle = 'QUEUED';
    t.desiredState = 'run';
    t.waitReasons = [];
    this.repo.saveTask(t);
    this.changed();
    if (dispatch) void this.tick();
  }
  async pause() {
    this.dispatchGeneration++;
    this.repo.set('enabled', false);
    this.repo.set('schedulingPaused', true);
    const execution = this.repo.executions().find((e) => e.endedAt === null);
    if (execution) {
      this.repo.set('pausedTaskId', execution.taskId);
      await this.control(execution.taskId, 'pause');
    }
    this.changed();
  }
  async stopAll() {
    await this.pause();
    const result = [];
    for (const t of this.repo.all<Task>('tasks').filter((t) => active.includes(t.lifecycle)))
      try {
        await this.control(t.id, 'pause');
        result.push({ id: t.id, ok: true, state: this.repo.task(t.id).lifecycle });
      } catch (e) {
        result.push({ id: t.id, ok: false, error: String(e) });
      }
    return result;
  }
  async shutdown() {
    if (this.timer) clearInterval(this.timer);
    await this.busy?.catch(() => {});
    await this.refreshFlight?.catch(() => {});
    this.flushLogs();
    await this.eventQueue;
    this.disposed = true;
    this.unsubscribe();
    this.adapter.dispose();
  }
  dispose() {
    if (this.timer) clearInterval(this.timer);
    if (this.logTimer) clearTimeout(this.logTimer);
    this.logBuffer = [];
    this.disposed = true;
    this.unsubscribe();
    this.adapter.dispose();
  }
}
