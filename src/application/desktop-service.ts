import { EventEmitter } from 'node:events';
import { mkdirSync, readdirSync, unlinkSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, isAbsolute, basename } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { Repository } from '../storage/repository';
import { AppServer, discoverCodex } from '../agent/client';
import { IdeAdapter } from '../legacy/ide-adapter';
import { Scheduler, localIdentity } from '../tasks/scheduler';
import { Adapter, Task, Project, TaskInput, redact, validate } from '../domain/model';
import { ExecutionController } from './execution-controller';
export const COMMANDS = new Set([
  'view.subscribe',
  'draft.save',
  'project.add',
  'project.archive',
  'project.bind',
  'project.trust',
  'task.create',
  'task.update',
  'task.clone',
  'task.resume',
  'task.pause',
  'task.cancel',
  'task.handoff',
  'task.accept',
  'recovery.check',
  'recovery.stopped',
  'approval.reject',
  'approval.allow',
  'account.login',
  'sandbox.setup',
  'scheduler.execute',
  'scheduler.enable',
  'scheduler.pause',
  'scheduler.stopAll',
  'quota.refresh',
  'settings.save',
  'settings.chooseCodex',
  'integration.validate',
  'integration.check',
  'integration.stopped',
  'diagnostics.export',
  'diagnostics.save',
  'backup.create',
  'storage.import',
  'storage.open',
]);
export interface DesktopHost {
  openCodex?(): Promise<void>;
  openGpt?(): Promise<void>;
  openLogin?(url: string): Promise<void>;
  showApproval?(): Promise<void>;
  chooseDirectory(): Promise<string | null>;
  chooseCodex(): Promise<string | null>;
  chooseBackup(): Promise<string | null>;
  confirm(title: string, message: string): Promise<boolean>;
  clipboard(text: string): Promise<void>;
  saveFile(name: string, content: string): Promise<string | null>;
  openDataDirectory(path: string): Promise<void>;
}
export interface Command {
  type: string;
  commandId: string;
  payload?: any;
}
export class DesktopService extends EventEmitter {
  viewVisible = true;
  readonly repo: Repository;
  scheduler: Scheduler;
  adapter: Adapter;
  private readonly execution: ExecutionController;
  private readonly factory: (path: string) => Adapter;
  private backupFlight?: Promise<{
    path: string;
  }>;
  private revision = 0;
  private closing = false;
  private requests = new Map<string, Promise<any>>();
  constructor(
    readonly dataDir: string,
    readonly host: DesktopHost,
    factory?: (path: string) => Adapter,
  ) {
    super();
    mkdirSync(dataDir, { recursive: true });
    this.repo = new Repository(join(dataDir, 'xsgw.db'));
    this.factory = factory || ((path: string) => new AppServer(discoverCodex(path), true));
    let channel = this.repo.setting<string>('executionChannel', factory ? 'app-server' : 'managed');
    // Old manual executions keep their recovery path; idle installations move to the single AGENT workflow.
    if (
      !factory &&
      channel !== 'managed' &&
      !this.repo.executions().some((e) => e.endedAt === null)
    ) {
      channel = 'managed';
      this.repo.set('executionChannel', channel);
    }
    this.adapter =
      channel === 'managed'
        ? new AppServer(discoverCodex(this.repo.setting('codexPath', '')), true)
        : channel === 'codex-desktop'
          ? new IdeAdapter(host.openGpt?.bind(host), 'codex-desktop')
          : channel === 'vscode'
            ? new IdeAdapter(host.openCodex?.bind(host))
            : this.factory(this.repo.setting('codexPath', ''));
    this.repo.set('enabled', false);
    this.scheduler = new Scheduler(
      this.repo,
      this.adapter,
      () => true,
      () => this.notify(),
    );
    this.watchApprovals();
    this.execution = new ExecutionController(
      this.repo,
      () => this.scheduler,
      () => this.connectAgent(),
      host.confirm.bind(host),
      () => this.notify(),
    );
  }
  private watchApprovals() {
    this.adapter.onEvent((method) => {
      if (method === 'approval/request') void this.host.showApproval?.().catch((e) => this.warn(e));
      if (method === 'account/login/completed')
        void this.scheduler.refresh().catch((e) => this.warn(e));
    });
  }
  start() {
    this.scheduler.startClock();
    void this.scheduler.refresh().catch((e) => this.warn(e));
    void this.scheduler.tick().catch((e) => this.warn(e));
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    if (this.repo.setting('backupDay', '') !== day)
      void this.createBackup()
        .then(() => this.repo.set('backupDay', day))
        .catch((e) => this.warn(e));
  }
  private async connectAgent() {
    if (this.adapter.managed) return;
    if (this.repo.executions().some((e) => e.endedAt === null))
      throw Error('请先核对并结束旧的手动交接任务。');
    const binary = discoverCodex(this.repo.setting('codexPath', ''));
    if (!binary) throw Error('未找到本机 Codex AGENT，请在设置中选择 codex.exe。');
    await this.scheduler.shutdown();
    this.adapter = new AppServer(binary, true);
    this.repo.set('executionChannel', 'managed');
    this.scheduler = new Scheduler(
      this.repo,
      this.adapter,
      () => true,
      () => this.notify(),
    );
    this.watchApprovals();
    this.scheduler.startClock();
  }
  private warn(e: unknown) {
    if (this.closing) return;
    this.scheduler.error = String(e);
    this.notify();
  }
  private tick() {
    void this.scheduler.tick().catch((e) => this.warn(e));
  }
  notify() {
    if (!this.closing && this.viewVisible) this.emit('snapshot', this.snapshot());
  }
  private schedulingState() {
    const current = this.repo.executions().find((e) => e.endedAt === null);
    if (current && this.repo.task(current.taskId).desiredState !== 'run') return 'pausing';
    if (this.repo.setting('schedulingPaused', false))
      return this.execution?.starting ? 'pausing' : 'paused';
    if (this.execution?.starting) return 'starting';
    return this.repo.setting('enabled', false) ? 'enabled' : 'idle';
  }
  snapshot() {
    return {
      revision: ++this.revision,
      projects: this.repo.all<Project>('projects'),
      tasks: this.repo.all<Task>('tasks'),
      executions: this.repo.executions(),
      events: this.repo.events(),
      enabled: this.repo.setting('enabled', false),
      schedulingState: this.schedulingState(),
      resumeTaskId:
        this.repo.setting('pausedTaskId', null) || this.repo.setting('resumeTaskId', null),
      quota: this.scheduler.quota,
      capabilities: this.scheduler.capabilities,
      error: this.scheduler.error,
      trusted: true,
      desktop: true,
      version: '0.3.3',
      dataDir: this.dataDir,
      settings: {
        executionChannel: this.adapter.managed
          ? 'managed'
          : this.adapter instanceof IdeAdapter
            ? this.adapter.mode
            : 'app-server',
        queueMode: this.repo.setting('queueMode', 'priority'),
        codexDetected: !!discoverCodex(this.repo.setting('codexPath', '')),
        quotaThreshold: this.repo.setting('quotaThreshold', 5),
        codexPath: this.repo.setting('codexPath', ''),
        theme: this.repo.setting('theme', 'system'),
        closeBehavior: this.repo.setting('closeBehavior', 'quit'),
        sandboxValidated: this.repo.setting('sandboxValidated', false),
        integrationValidated: this.repo.setting('integrationValidated', false),
      },
      integrationPending: this.repo.setting('integrationPending', null),
      draft: this.repo.setting('draft', null),
      approvals:
        this.adapter instanceof AppServer
          ? Array.from(this.adapter.approvals.entries()).map(([key, a]) => ({
              key,
              method: a.method,
              params: redact(a.params),
              canAllow:
                [
                  'item/commandExecution/requestApproval',
                  'item/fileChange/requestApproval',
                ].includes(a.method) &&
                this.repo
                  .executions()
                  .some(
                    (e) =>
                      e.endedAt === null &&
                      e.threadId === a.params?.threadId &&
                      e.turnId === a.params?.turnId &&
                      this.repo.task(e.taskId).desiredState === 'run',
                  ),
            }))
          : [],
    };
  }
  command(message: Command): Promise<any> {
    if (
      !message ||
      !COMMANDS.has(message.type) ||
      typeof message.commandId !== 'string' ||
      !message.commandId ||
      message.commandId.length > 100
    )
      return Promise.resolve({ ok: false, error: '无效桌面命令' });
    if (this.closing) return Promise.resolve({ ok: false, error: '软件正在退出，停止接受新操作' });
    if (Buffer.byteLength(JSON.stringify(message)) > 8 * 1024 * 1024)
      return Promise.resolve({ ok: false, error: '请求超过 8MiB，请拆分任务' });
    const key = message.commandId;
    const old = this.requests.get(key);
    if (old) return old;
    const work = this.execute(message)
      .then((data) => ({ ok: true, data }))
      .catch((e) => ({ ok: false, error: String(e) }))
      .finally(() => {
        this.requests.delete(key);
        if (!this.closing) this.notify();
      });
    this.requests.set(key, work);
    return work;
  }
  private async execute({ type, payload: p = {}, commandId }: Command): Promise<any> {
    if (type === 'view.subscribe') return this.snapshot();
    if (type === 'draft.save') {
      this.repo.set('draft', p);
      return null;
    }
    const cached = this.repo.db
      .prepare('SELECT result FROM command_receipts WHERE id=?')
      .get(commandId) as any;
    if (cached) return JSON.parse(cached.result);
    let result: any = null;
    switch (type) {
      case 'project.add': {
        const selected = p.uri || (await this.host.chooseDirectory());
        if (!selected) return null;
        let root = '',
          key = '',
          uri: string;
        if (typeof selected !== 'string') throw Error('项目路径格式错误');
        if (selected.startsWith('vscode-remote:')) {
          const u = new URL(selected);
          if (!u.host || !u.pathname) throw Error('远程 URI 无效');
          uri = u.toString();
          key = uri;
        } else {
          const raw = selected.startsWith('file:') ? fileURLToPath(selected) : selected;
          if (!isAbsolute(raw)) throw Error('项目目录必须为绝对路径');
          const identity = localIdentity(raw);
          root = identity.root;
          key = identity.key;
          uri = pathToFileURL(root).toString();
        }
        const name = p.name || basename(root) || new URL(uri).pathname.split('/').pop();
        if (typeof name !== 'string' || !name.trim() || name.length > 80)
          throw Error('项目名称范围 1–80 字符');
        result = this.repo.addProject({
          id: randomUUID(),
          name,
          uri,
          root,
          canonicalKey: key,
          accountKey: this.scheduler.quota.accountKey,
          archived: false,
          trusted: false,
        });
        break;
      }
      case 'project.trust': {
        const project = this.repo.project(p.id);
        if (p.trusted !== true) {
          project.trusted = false;
          this.repo.saveProject(project);
          break;
        }
        if (
          !(await this.host.confirm(
            '允许访问项目',
            project.uri +
              '\n\n允许 AGENT 按任务权限读取或修改此项目文件。项目内修改使用项目写入沙箱，额外权限仍需本次确认。',
          ))
        )
          return null;
        project.trusted = true;
        this.repo.saveProject(project);
        this.tick();
        break;
      }
      case 'project.archive': {
        const project = this.repo.project(p.id);
        project.archived = !project.archived;
        this.repo.saveProject(project);
        break;
      }
      case 'project.bind': {
        await this.scheduler.refresh();
        if (!this.scheduler.quota.accountKey) throw Error('尚未确认 ChatGPT 账户');
        const project = this.repo.project(p.id);
        project.accountKey = this.scheduler.quota.accountKey;
        this.repo.saveProject(project);
        break;
      }
      case 'task.create': {
        result = this.repo.receipt(commandId, () => this.repo.create(p.tasks, p.draft));
        this.repo.set('draft', null);
        this.tick();
        return result;
      }
      case 'task.update':
        result = this.repo.receipt(commandId, () => this.repo.update(p.id, p.version, p.task));
        this.tick();
        return result;
      case 'task.clone': {
        const t = this.repo.task(p.id);
        return this.repo.receipt(commandId, () =>
          this.repo.create([{ ...t, title: t.title.slice(0, 115) + '（重跑）' }], true),
        );
      }
      case 'task.resume':
        this.scheduler.resume(p.id);
        break;
      case 'task.pause':
        await this.scheduler.control(p.id, 'pause');
        break;
      case 'task.cancel':
        await this.scheduler.control(p.id, 'cancel');
        break;
      case 'task.handoff': {
        const prompt = this.scheduler.handoff(p.id);
        await this.host.clipboard(prompt);
        let openError: string | undefined;
        if (this.adapter instanceof IdeAdapter)
          try {
            await this.adapter.open();
          } catch (e) {
            openError = String(e);
          }
        result = { copied: true, prompt, openError };
        break;
      }
      case 'task.accept':
        await this.scheduler.verify(p.executionId, p.reason);
        break;
      case 'recovery.check':
        await this.scheduler.reconcile(p.id);
        break;
      case 'recovery.stopped': {
        const e = this.repo.execution(p.id);
        if (
          e.endedAt !== null ||
          e.state !== 'RECONCILING' ||
          typeof p.reason !== 'string' ||
          p.reason.trim().length < 10
        )
          throw Error('至少填写 10 字符，说明已核对旧轮次、进程和副作用停止');
        this.repo.finish(e, 'PAUSED', {
          source: 'user-stop-evidence',
          reason: p.reason,
          previous: e.evidence,
        });
        break;
      }
      case 'approval.allow': {
        if (!(this.adapter instanceof AppServer)) throw Error('通道不支持审批');
        const a = this.adapter.approvals.get(p.key);
        const e = this.repo
          .executions()
          .find(
            (e) =>
              e.endedAt === null &&
              e.threadId === a?.params?.threadId &&
              e.turnId === a?.params?.turnId,
          );
        if (!a || !e || this.repo.task(e.taskId).desiredState !== 'run')
          throw Error('授权请求已过期或任务已暂停');
        this.adapter.resolveApproval(p.key, true);
        this.repo.event('approval.allowed', e.id, { key: p.key, scope: 'once', method: a.method });
        const t = this.repo.task(e.taskId);
        t.waitReasons = [];
        this.repo.saveTask(t);
        break;
      }
      case 'account.login': {
        if (!(this.adapter instanceof AppServer)) throw Error('请先选择自动执行模式');
        const r = await this.adapter.login();
        if (r.type !== 'chatgpt' || typeof r.authUrl !== 'string') throw Error('登录接口响应无效');
        if (!this.host.openLogin) throw Error('当前环境无法打开登录页面');
        await this.host.openLogin(r.authUrl);
        result = { started: true };
        break;
      }
      case 'sandbox.setup': {
        if (!(this.adapter instanceof AppServer)) throw Error('请先选择自动执行模式');
        if (
          !(await this.host.confirm(
            '初始化执行沙箱',
            '配置 Codex 的本机执行沙箱，可能显示 Windows 系统授权窗口。仅需首次配置或更新时运行。',
          ))
        )
          return null;
        result = await this.adapter.rpc('windowsSandbox/setupStart', { mode: 'unelevated' });
        break;
      }
      case 'scheduler.execute':
        result = await this.execution.execute(p.taskId);
        break;
      case 'approval.reject': {
        if (!(this.adapter instanceof AppServer)) throw Error('通道不支持审批');
        const a = this.adapter.approvals.get(p.key);
        this.adapter.rejectApproval(p.key);
        const e = this.repo
          .executions()
          .find(
            (e) =>
              e.endedAt === null &&
              e.threadId === a?.params?.threadId &&
              e.turnId === a?.params?.turnId,
          );
        if (e) {
          this.repo.event('approval.rejected', e.id, { key: p.key });
          const t = this.repo.task(e.taskId);
          if (t.desiredState === 'run') {
            t.waitReasons = [];
            this.repo.saveTask(t);
          }
        }
        break;
      }
      case 'scheduler.enable':
        result = await this.execution.execute();
        break;
      case 'scheduler.pause':
        result = await this.execution.pause();
        break;
      case 'scheduler.stopAll':
        await this.execution.pause();
        result = await this.scheduler.stopAll();
        break;
      case 'quota.refresh':
        result = await this.scheduler.refresh(true);
        this.tick();
        break;
      case 'settings.chooseCodex':
        result = { path: await this.host.chooseCodex() };
        break;
      case 'settings.save': {
        const channel =
          p.executionChannel ??
          (this.adapter.managed
            ? 'managed'
            : this.adapter instanceof IdeAdapter
              ? this.adapter.mode
              : 'app-server');
        if (!['vscode', 'codex-desktop', 'app-server', 'managed'].includes(channel))
          throw Error('执行平台无效');
        const current = this.adapter.managed
          ? 'managed'
          : this.adapter instanceof IdeAdapter
            ? this.adapter.mode
            : 'app-server';
        if (channel !== current) {
          if (
            this.repo.executions().some((e) => e.endedAt === null) ||
            this.repo.setting('integrationPending', null)
          )
            throw Error('请先完成当前任务验收，或在恢复检查中确认执行已停止，再切换平台');
        }
        if (p.queueMode !== undefined && !['priority', 'sequence'].includes(p.queueMode))
          throw Error('调度顺序无效');
        if (!Number.isFinite(p.quotaThreshold) || p.quotaThreshold < 5 || p.quotaThreshold > 100)
          throw Error('额度阈值范围 5–100%');
        const theme = p.theme || 'system',
          closeBehavior = p.closeBehavior || 'quit';
        if (
          !['system', 'light', 'dark'].includes(theme) ||
          !['quit', 'tray'].includes(closeBehavior)
        )
          throw Error('设置格式错误');
        const path = p.codexPath ?? this.repo.setting('codexPath', '');
        if (
          typeof path !== 'string' ||
          (path && (!isAbsolute(path) || !/\.exe$/i.test(path) || !statSync(path).isFile()))
        )
          throw Error('请选择 Codex 原生 .exe 绝对路径');
        if (channel !== current || path !== this.repo.setting('codexPath', '')) {
          if (
            this.repo.executions().some((e) => e.endedAt === null) ||
            this.repo.setting('integrationPending', null)
          )
            throw Error('修改执行通道前需先结束或核对活动执行');
          await this.scheduler.shutdown();
          this.adapter =
            channel === 'managed'
              ? new AppServer(discoverCodex(path), true)
              : channel === 'codex-desktop'
                ? new IdeAdapter(this.host.openGpt?.bind(this.host), 'codex-desktop')
                : channel === 'vscode'
                  ? new IdeAdapter(this.host.openCodex?.bind(this.host))
                  : this.factory(path);
          this.repo.set('executionChannel', channel);
          this.scheduler = new Scheduler(
            this.repo,
            this.adapter,
            () => true,
            () => this.notify(),
          );
          this.watchApprovals();
          this.repo.set('codexPath', path);
          this.repo.set('integrationValidated', false);
          this.repo.set('sandboxValidated', false);
          this.scheduler.startClock();
          void this.scheduler.refresh().catch((e) => this.warn(e));
        }
        this.repo.transaction(() => {
          if (p.queueMode) this.repo.set('queueMode', p.queueMode);
          this.repo.set('quotaThreshold', p.quotaThreshold);
          this.repo.set('theme', theme);
          this.repo.set('closeBehavior', closeBehavior);
          this.repo.set('settingsVersion', this.repo.setting('settingsVersion', 0) + 1);
        });
        break;
      }
      case 'integration.validate':
        result =
          this.adapter instanceof IdeAdapter
            ? await this.scheduler.refresh(true)
            : await this.validateIntegration();
        break;
      case 'integration.check': {
        const pending = this.repo.setting<any>('integrationPending', null);
        if (!pending) break;
        const history = await this.adapter.read(pending.thread);
        const turn = history.turns?.find((t: any) => t.id === pending.turn);
        if (
          !turn ||
          !['completed', 'failed', 'interrupted'].includes(turn.status) ||
          turn.itemsView !== 'full' ||
          turn.items.some((i: any) => i.type === 'commandExecution')
        )
          throw Error('原接入测试仍未确认停止，请核对进程与副作用');
        this.repo.set('integrationPending', null);
        break;
      }
      case 'integration.stopped':
        if (typeof p.reason !== 'string' || p.reason.trim().length < 10)
          throw Error('请填写至少 10 字符的停止核对证据');
        this.repo.event('integration.manual-stopped', null, {
          reason: p.reason,
          pending: this.repo.setting('integrationPending', null),
        });
        this.repo.set('integrationPending', null);
        break;
      case 'diagnostics.export':
        return { preview: JSON.stringify(this.diagnostics(), null, 2) };
      case 'diagnostics.save':
        result = {
          path: await this.host.saveFile(
            'PawShift-diagnostics.json',
            JSON.stringify(this.diagnostics(), null, 2),
          ),
        };
        break;
      case 'backup.create':
        result = await this.createBackup();
        break;
      case 'storage.import':
        result = await this.importBackup();
        break;
      case 'storage.open':
        await this.host.openDataDirectory(this.dataDir);
        break;
      default:
        throw Error('未实现命令');
    }
    this.repo.db
      .prepare('INSERT OR IGNORE INTO command_receipts VALUES(?,?)')
      .run(commandId, JSON.stringify(result));
    return result;
  }
  diagnostics() {
    return redact({
      app: 'PawShift Desktop',
      version: '0.3.3',
      platform: process.platform,
      node: process.version,
      capabilities: this.scheduler.capabilities,
      quota: this.scheduler.quota,
      settings: {
        quotaThreshold: this.repo.setting('quotaThreshold', 5),
        enabled: this.repo.setting('enabled', false),
        integrationValidated: this.repo.setting('integrationValidated', false),
        sandboxValidated: false,
      },
      projects: this.repo
        .all<Project>('projects')
        .map((p) => ({ id: p.id, name: p.name, uri: p.uri, trusted: p.trusted })),
      tasks: this.repo.all<Task>('tasks').map((t) => ({
        id: t.id,
        revision: t.revision,
        lifecycle: t.lifecycle,
        waitReasons: t.waitReasons,
      })),
      executions: this.repo.executions().map((e) => ({
        id: e.id,
        taskId: e.taskId,
        state: e.state,
        threadId: e.threadId,
        turnId: e.turnId,
      })),
      integrity: this.repo.db.prepare('PRAGMA integrity_check').all(),
    });
  }
  createBackup() {
    if (this.backupFlight) return this.backupFlight;
    this.backupFlight = this.backupNow().finally(() => {
      this.backupFlight = undefined;
    });
    return this.backupFlight;
  }
  private async backupNow() {
    const dir = join(this.dataDir, 'backups');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'xsgw-' + new Date().toISOString().replace(/[:.]/g, '-') + '.db');
    await backup(this.repo.db, path);
    for (const file of readdirSync(dir)
      .filter((f) => /^xsgw-.*\.db$/.test(f))
      .sort()
      .reverse()
      .slice(7))
      unlinkSync(join(dir, file));
    return { path };
  }
  private async importBackup() {
    if (
      this.repo.executions().some((e) => e.endedAt === null) ||
      this.repo.setting('integrationPending', null)
    )
      throw Error('先核对并结束当前独立版的活动执行');
    const sourcePath = await this.host.chooseBackup();
    if (!sourcePath) return null;
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      const check = source.prepare('PRAGMA integrity_check').get() as any;
      if (
        check.integrity_check !== 'ok' ||
        Number((source.prepare('PRAGMA user_version').get() as any).user_version) !== 1
      )
        throw Error('备份不完整或数据库版本不支持');
      const tasks = (source.prepare('SELECT data FROM tasks').all() as any[]).map((r) =>
        JSON.parse(r.data),
      );
      for (const task of tasks) validate(task);
      const count = tasks.length;
      if (
        !(await this.host.confirm(
          '导入 SQLite 备份',
          sourcePath +
            '\n\n含 ' +
            count +
            ' 个任务。将先备份当前独立版数据，再替换独立版队列。原 VS Code 数据不会更改；导入后关闭自动调度，项目重新授权，未结束执行先核对。',
        ))
      )
        return null;
      await this.createBackup();
      const settings = {
        codexPath: this.repo.setting('codexPath', ''),
        theme: this.repo.setting('theme', 'system'),
        closeBehavior: this.repo.setting('closeBehavior', 'quit'),
      };
      const tables = [
        'projects',
        'tasks',
        'task_revisions',
        'dependencies',
        'executions',
        'leases',
        'events',
        'command_receipts',
        'settings',
      ] as const;
      const rows = new Map(tables.map((t) => [t, source.prepare('SELECT * FROM ' + t).all()]));
      this.repo.transaction(() => {
        for (const t of [
          'dependencies',
          'task_revisions',
          'leases',
          'events',
          'executions',
          'tasks',
          'projects',
          'command_receipts',
          'settings',
        ])
          this.repo.db.exec('DELETE FROM ' + t);
        for (const t of tables)
          for (const row of rows.get(t) as any[]) {
            const columns = Object.keys(row);
            const allowed =
              t === 'settings'
                ? ['id', 'data']
                : t === 'projects'
                  ? ['id', 'canonical_key', 'data']
                  : t === 'tasks'
                    ? ['id', 'project_id', 'lifecycle', 'version', 'data']
                    : t === 'task_revisions'
                      ? ['task_id', 'revision', 'data']
                      : t === 'dependencies'
                        ? ['task_id', 'depends_on']
                        : t === 'executions'
                          ? ['id', 'task_id', 'ended_at', 'data']
                          : t === 'leases'
                            ? ['resource_key', 'execution_id', 'expires_at']
                            : t === 'events'
                              ? [
                                  'id',
                                  'dedup_key',
                                  'execution_id',
                                  'type',
                                  'observed_at',
                                  'payload',
                                ]
                              : ['id', 'result'];
            if (columns.some((c) => !allowed.includes(c))) throw Error('备份字段与当前版本不兼容');
            this.repo.db
              .prepare(
                'INSERT INTO ' +
                  t +
                  '(' +
                  columns.join(',') +
                  ') VALUES(' +
                  columns.map(() => '?').join(',') +
                  ')',
              )
              .run(...columns.map((c) => row[c]));
          }
        this.repo.assertGraph();
        for (const project of this.repo.all<Project>('projects')) {
          project.trusted = false;
          this.repo.saveProject(project);
        }
        for (const [key, value] of Object.entries(settings)) this.repo.set(key, value);
        this.repo.set('enabled', false);
        this.repo.set('integrationValidated', false);
        this.repo.set('sandboxValidated', false);
        this.repo.set('draft', null);
        this.repo.recover();
        this.repo.event('backup.imported', null, { source: basename(sourcePath), tasks: count });
      });
      return { imported: count };
    } finally {
      source.close();
    }
  }
  private async validateIntegration() {
    if (
      this.repo.setting('integrationPending', null) ||
      this.repo.executions().some((e) => e.endedAt === null)
    )
      throw Error('先核对活动执行或旧接入测试');
    if (
      !(await this.host.confirm(
        '真实只读接入验收',
        '将产生一次模型用量，只在软件临时目录执行只读回复，不执行项目命令。通信成功不代表 Windows 权限沙箱验证通过。',
      ))
    )
      return { validated: false };
    const account = await this.adapter.account();
    if (account.type !== 'chatgpt' || !account.key)
      throw Error('独立 App Server 尚未确认 ChatGPT 登录账户');
    const root = join(this.dataDir, 'integration-fixture');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'sample.txt'), 'PawShift Desktop integration fixture');
    const thread = await this.adapter.prepare(
      { permission: 'read-only' } as Task,
      { root } as Project,
    );
    this.repo.set('integrationPending', {
      thread,
      sendState: 'possibly-sent',
      observedAt: Date.now(),
    });
    const turn = await this.adapter.start(
      thread,
      '仅回复 PAWSHIFT_READONLY_OK，不运行命令、不修改文件、不调用外部服务。',
    );
    this.repo.set('integrationPending', { thread, turn, observedAt: Date.now() });
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      const history = await this.adapter.read(thread);
      const t = history.turns?.find((t: any) => t.id === turn);
      if (t && ['completed', 'interrupted', 'failed'].includes(t.status)) {
        if (
          t.status !== 'completed' ||
          t.itemsView !== 'full' ||
          t.items.some((i: any) => ['commandExecution', 'fileChange'].includes(i.type))
        )
          throw Error('真实只读通信验收未通过，保留核对记录');
        this.repo.set('integrationValidated', true);
        this.repo.set('integrationPending', null);
        this.repo.event('integration.validated', null, {
          thread,
          turn,
          scope: 'read-only',
          version: '0.157.1',
        });
        return { validated: true };
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    await this.adapter.interrupt(thread, turn);
    throw Error('验收超时，已请求中断；请在恢复检查核对原轮次');
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    await Promise.allSettled([...this.requests.values()]);
    await this.backupFlight?.catch(() => {});
    const enabled = this.repo.setting('enabled', false);
    try {
      await this.scheduler.stopAll();
      this.repo.set('enabled', enabled);
    } finally {
      await this.scheduler.shutdown();
      this.repo.close();
      this.removeAllListeners();
    }
  }
}
