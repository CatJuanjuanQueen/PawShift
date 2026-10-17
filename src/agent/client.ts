import { spawn, ChildProcessWithoutNullStreams, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Adapter, Task, Project, Quota, redact } from '../domain/model';
import type { ThreadStartParams, TurnStartParams } from './protocol';
export { discoverCodex } from './discovery';
export const CODEX_VERSION = 'codex-cli 0.157.1';
export class AppServer implements Adapter {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private emitter = new EventEmitter();
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private ready?: Promise<void>;
  readonly approvals = new Map<
    string,
    {
      id: number | string;
      method: string;
      params: any;
    }
  >();
  readonly nonce = crypto.randomUUID();
  version = '';
  accountType: string | null = null;
  accountKey: string | null = null;
  lastError = '';
  private policies = new Map<string, TurnStartParams['sandboxPolicy']>();
  private selectedModel = '';
  private intentionalClose = false;
  private async selectModel() {
    const r = await this.rpc('model/list', { limit: 100 });
    const model = r.data?.find((m: any) => m.isDefault && !m.hidden);
    if (typeof model?.model !== 'string') throw Error('执行端未提供默认模型，请检查 Codex 连接');
    this.selectedModel = model.model;
    return model.model;
  }
  constructor(
    readonly binary: string,
    readonly managed = false,
  ) {}
  async connect() {
    if (this.ready) return this.ready;
    this.ready = this.open();
    try {
      await this.ready;
    } catch (e) {
      this.child?.kill();
      this.child = undefined;
      this.ready = undefined;
      throw e;
    }
  }
  private async open() {
    if (!isAbsolute(this.binary) || !/\.exe$/i.test(this.binary))
      throw Error('请选择 Codex 原生 .exe 绝对路径');
    this.version = execFileSync(this.binary, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    }).trim();
    const version = /^codex-cli (\d+)\.(\d+)\./.exec(this.version);
    if (!version || (Number(version[1]) === 0 && Number(version[2]) < 157))
      throw Error('Codex 版本过旧或无法识别：' + this.version + '；需要 0.157 或更高版本');
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.child = spawn(this.binary, ['app-server', '--listen', 'stdio://'], {
      shell: false,
      windowsHide: true,
      stdio: 'pipe',
    });
    this.child.stdout.on('data', (b: Buffer) => {
      try {
        this.ingest(this.decoder.write(b));
      } catch (e) {
        this.fail(e as Error);
        this.child?.kill();
      }
    });
    this.child.stderr.on('data', (b: Buffer) => {
      this.lastError = redact(b.toString()).slice(-4000);
    });
    this.child.stdin.on('error', (e) => this.fail(e));
    this.child.on('error', (e) => this.fail(e));
    this.child.on('exit', () => {
      this.fail(Error('App Server 已退出；先核对活动执行'));
      if (!this.intentionalClose)
        this.emitter.emit('event', 'transport/closed', {
          error: this.lastError || 'AGENT 连接已断开',
        });
      this.ready = undefined;
    });
    await this.rpc('initialize', {
      clientInfo: { name: 'pawshift-desktop', title: 'PawShift桌面版', version: '0.3.3' },
      capabilities: { experimentalApi: false },
    });
    this.send({ method: 'initialized' });
  }
  ingest(chunk: string) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024 && !this.buffer.includes('\n'))
      throw Error('协议消息超限');
    let i: number;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw Error('协议消息超限');
      const msg = JSON.parse(line);
      if (msg.method) {
        if (msg.method === 'turn/completed')
          for (const [key, a] of this.approvals)
            if (
              a.params?.threadId === msg.params?.threadId &&
              a.params?.turnId === msg.params?.turn?.id
            )
              this.approvals.delete(key);
        if (msg.id !== undefined) {
          const key = String(msg.id);
          this.approvals.set(key, { id: msg.id, method: msg.method, params: msg.params });
          this.emitter.emit('event', 'approval/request', { key, ...msg });
        } else this.emitter.emit('event', msg.method, msg.params);
      } else {
        const p = this.pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(Error(redact(JSON.stringify(msg.error))));
          else p.resolve(msg.result);
        }
      }
    }
  }
  private send(msg: any) {
    if (!this.child || this.child.stdin.destroyed) throw Error('执行通道未连接');
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }
  async rpc(method: string, params: any = {}, timeout = 15000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('RPC_TIMEOUT ' + method));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  private fail(e: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    this.approvals.clear();
  }
  async probe() {
    await this.connect();
    await this.account();
    const ready = this.managed ? await this.readiness() : null;
    return {
      version: this.version,
      canStart: this.managed,
      canReadQuota: this.accountType === 'chatgpt',
      canReconcile: this.managed,
      canInterrupt: this.managed,
      sandboxReady: ready?.status === 'ready' || ready?.ready === true,
      protocolSchemaAvailable: true,
      targetKind: 'local',
      permission: this.managed ? 'project-scoped' : 'read-only',
      pid: this.child?.pid,
      nonce: this.nonce,
      accountType: this.accountType,
      automaticGate: this.managed
        ? 'ChatGPT 登录、项目授权、执行沙箱与额度检查'
        : '需要本机只读接入验收；受限写入尚未验证',
    };
  }
  async account() {
    await this.connect();
    const r = await this.rpc('account/read', { refreshToken: false });
    const a = r.account;
    this.accountType = a?.type ?? null;
    this.accountKey =
      a?.type === 'chatgpt' && a.email
        ? createHash('sha256')
            .update(a.type + ':' + a.email)
            .digest('hex')
            .slice(0, 20)
        : null;
    return { key: this.accountKey, type: this.accountType };
  }
  async quota(): Promise<Quota> {
    await this.account();
    if (this.accountType !== 'chatgpt')
      return {
        observedAt: Date.now(),
        accountKey: this.accountKey,
        windows: [],
        error: '仅支持 ChatGPT 账户自动调度，其他付费通道未启用',
      };
    const r = await this.rpc('account/rateLimits/read');
    const buckets = r.rateLimitsByLimitId ? Object.values(r.rateLimitsByLimitId) : [r.rateLimits];
    const windows: Quota['windows'] = [];
    for (const b of buckets as any[]) {
      if (!b) continue;
      for (const k of ['primary', 'secondary']) {
        const w = b[k];
        if (w)
          windows.push({
            name:
              (b.limitName || b.limitId || '账户') +
              ' / ' +
              k +
              (w.windowDurationMins ? ' / ' + w.windowDurationMins + ' 分钟' : ''),
            usedPercent:
              typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent)
                ? w.usedPercent
                : null,
            resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null,
          });
      }
    }
    return { observedAt: Date.now(), accountKey: this.accountKey, windows };
  }
  async prepare(t: Task, p: Project, resumeThreadId?: string) {
    await this.connect();
    if (t.permission !== 'read-only' && !this.managed)
      throw Error('受限路径写入沙箱尚未验证，已禁用自动修改');
    // workspace-write includes the working directory; narrower paths are task instructions, not an OS sandbox.
    if (
      t.permission === 'restricted' &&
      (!t.allowedPaths.includes('.') || t.allowedPaths.length !== 1)
    )
      throw Error('自动修改要求允许路径为 .（整个项目）；细分路径仍需手动交接');
    const params: ThreadStartParams = {
      cwd: p.root,
      model: this.managed ? this.selectedModel || (await this.selectModel()) : undefined,
      sandbox: t.permission === 'restricted' ? 'workspace-write' : 'read-only',
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      ephemeral: false,
    };
    const r = await this.rpc(
      resumeThreadId ? 'thread/resume' : 'thread/start',
      resumeThreadId
        ? { ...params, ephemeral: undefined, threadId: resumeThreadId, excludeTurns: true }
        : params,
    );
    if (typeof r.thread?.id !== 'string') throw Error('协议不兼容：缺少 thread.id');
    if (resumeThreadId && r.thread.id !== resumeThreadId)
      throw Error('恢复会话身份不匹配，未发送任务');
    this.policies.set(
      r.thread.id,
      t.permission === 'restricted'
        ? {
            type: 'workspaceWrite',
            writableRoots: [realpathSync(p.root)],
            networkAccess: false,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          }
        : { type: 'readOnly', networkAccess: false },
    );
    return r.thread.id;
  }
  async resume(threadId: string, t: Task, p: Project) {
    return this.prepare(t, p, threadId);
  }
  async start(threadId: string, prompt: string) {
    const params: TurnStartParams = {
      threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      sandboxPolicy: this.policies.get(threadId) || { type: 'readOnly', networkAccess: false },
      approvalPolicy: 'untrusted',
    };
    const r = await this.rpc('turn/start', params);
    if (typeof r.turn?.id !== 'string') throw Error('协议不兼容：缺少 turn.id');
    return r.turn.id;
  }
  async readiness() {
    await this.connect();
    if (process.platform !== 'win32') return { ready: true };
    return this.rpc('windowsSandbox/readiness', {});
  }
  async login() {
    await this.connect();
    return this.rpc('account/login/start', { type: 'chatgpt' });
  }
  resolveApproval(key: string, allow: boolean) {
    const a = this.approvals.get(key);
    if (!a) throw Error('审批已过期');
    if (
      !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(
        a.method,
      )
    )
      throw Error('此交互暂不支持允许本次，请拒绝或停止任务');
    this.send({ id: a.id, result: { decision: allow ? 'accept' : 'decline' } });
    this.approvals.delete(key);
  }
  async read(threadId: string) {
    await this.connect();
    const thread = (await this.rpc('thread/read', { threadId, includeTurns: this.managed })).thread;
    if (!thread || thread.id !== threadId) throw Error('线程身份不匹配');
    if (this.managed) {
      if (!Array.isArray(thread.turns)) throw Error('轮次记录缺失');
      return thread;
    }
    const turns: any[] = [];
    let cursor: string | null = null;
    do {
      const result = await this.rpc('thread/turns/list', {
        threadId,
        cursor,
        limit: 100,
        sortDirection: 'desc',
        itemsView: 'full',
      });
      if (!Array.isArray(result.data)) throw Error('轮次分页结构无效');
      turns.push(...result.data);
      cursor = result.nextCursor;
      if (turns.length > 1000) throw Error('核对历史超出上限，需人工处理');
    } while (cursor);
    return { ...thread, turns };
  }
  async interrupt(threadId: string, turnId: string) {
    await this.rpc('turn/interrupt', { threadId, turnId });
  }
  rejectApproval(key: string) {
    const a = this.approvals.get(key);
    if (!a) throw Error('审批已过期');
    if (
      ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(
        a.method,
      )
    )
      this.send({ id: a.id, result: { decision: 'decline' } });
    else
      this.send({ id: a.id, error: { code: -32601, message: '本客户端未支持此交互；不扩大授权' } });
    this.approvals.delete(key);
  }
  onEvent(fn: (m: string, p: any) => void) {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }
  dispose() {
    this.intentionalClose = true;
    this.fail(Error('通道关闭'));
    this.child?.kill();
    this.emitter.removeAllListeners();
  }
}
