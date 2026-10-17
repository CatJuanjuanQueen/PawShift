import { Repository } from '../storage/repository';
import { Scheduler } from '../tasks/scheduler';
import { Task } from '../domain/model';
export interface ExecutionReceipt {
  status: 'started' | 'running' | 'waiting' | 'empty' | 'blocked' | 'completed' | 'paused';
  message: string;
  executionId?: string;
  taskId?: string;
  blocked?: {
    taskId: string;
    reasons: string[];
  }[];
}
/** The execute button has one pipeline: authorize projects, verify agent, dispatch, report reality. */
export class ExecutionController {
  private flight?: Promise<ExecutionReceipt>;
  private generation = 0;
  get starting() {
    return !!this.flight;
  }
  constructor(
    private readonly repo: Repository,
    private readonly getScheduler: () => Scheduler,
    private readonly connectAgent: () => Promise<void>,
    private readonly confirm: (title: string, message: string) => Promise<boolean>,
    private readonly changed: () => void = () => {},
  ) {}
  execute(taskId?: string): Promise<ExecutionReceipt> {
    if (this.flight) return this.flight;
    const generation = this.generation;
    this.flight = this.run(generation, taskId)
      .catch((error) => {
        if (generation !== this.generation)
          return { status: 'paused' as const, message: '启动已暂停，未继续派发任务。' };
        throw error;
      })
      .finally(() => {
        this.flight = undefined;
        this.changed();
      });
    this.changed();
    return this.flight;
  }
  async pause() {
    this.generation++;
    await this.getScheduler().pause();
    return {
      status: 'paused',
      message: this.repo.executions().some((e) => e.endedAt === null)
        ? '已停止派发，正在等待 AGENT 确认暂停。确认后可继续。'
        : '当前任务和队列已暂停，点击继续执行可恢复。',
    };
  }
  private async run(generation: number, taskId?: string): Promise<ExecutionReceipt> {
    const cancelled = () => generation !== this.generation;
    const paused = (): ExecutionReceipt => ({
      status: 'paused',
      message: '启动已暂停，未继续派发任务。',
    });
    const tasks = this.repo.all<Task>('tasks');
    if (
      taskId !== undefined &&
      (typeof taskId !== 'string' ||
        !tasks.some((t) => t.id === taskId && t.lifecycle === 'PAUSED'))
    )
      throw Error('请选择一项已暂停的任务继续执行。');
    const active = this.repo.executions().find((e) => e.endedAt === null);
    if (active) {
      if (
        !taskId &&
        active.sendState === 'managed-sent' &&
        active.state === 'RUNNING' &&
        this.repo.task(active.taskId).desiredState === 'run'
      ) {
        this.repo.set('enabled', true);
        this.repo.set('schedulingPaused', false);
        return {
          status: 'running',
          message: 'AGENT 正在执行当前任务，队列已继续调度。',
          executionId: active.id,
          taskId: active.taskId,
        };
      }
      throw Error('当前仍有未结束的执行，请先在恢复检查中核对，或完成待验收任务。');
    }
    let pausedTaskId = taskId || this.repo.setting<string | null>('pausedTaskId', null);
    if (!tasks.some((t) => t.id === pausedTaskId && t.lifecycle === 'PAUSED')) pausedTaskId = null;
    // Older releases and individual task pauses did not persist a global resume pointer.
    // Adopt one unambiguous interrupted task; never resume every paused task at once.
    if (
      !pausedTaskId &&
      (this.repo.setting('schedulingPaused', false) || !tasks.some((t) => t.lifecycle === 'QUEUED'))
    ) {
      const candidates = tasks.filter(
        (t) =>
          t.lifecycle === 'PAUSED' &&
          this.repo
            .executions()
            .some(
              (e) =>
                e.taskId === t.id &&
                e.state === 'PAUSED' &&
                e.endedAt !== null &&
                e.sendState === 'managed-sent' &&
                e.threadId &&
                e.turnId,
            ),
      );
      if (candidates.length > 1)
        throw Error('有多项已暂停任务，请在对应任务旁点击“继续此任务”，选择本次要恢复的任务。');
      pausedTaskId = candidates[0]?.id || null;
    }
    if (pausedTaskId) {
      this.getScheduler().resume(pausedTaskId, false);
      this.repo.set('pausedTaskId', null);
    }
    const queued = this.repo.all<Task>('tasks').filter((t) => t.lifecycle === 'QUEUED');
    this.repo.set('enabled', false);
    if (!queued.length)
      return tasks.some((t) => t.lifecycle === 'PAUSED')
        ? { status: 'blocked', message: '任务处于暂停状态，请点击对应任务旁的“继续此任务”恢复。' }
        : {
            status: 'empty',
            message: '队列中没有待执行任务。请先创建任务并保存入队；草稿需要先入队。',
          };
    const untrusted = [...new Set(queued.map((t) => t.projectId))]
      .map((id) => this.repo.project(id))
      .filter((p) => !p.archived && p.uri.startsWith('file:') && p.trusted !== true);
    if (untrusted.length) {
      const paths = untrusted.map((p) => `${p.name}\n${p.root}`).join('\n\n');
      const granted = await this.confirm(
        '允许 AGENT 执行项目任务',
        `${paths}\n\n允许 AGENT 在以上项目中按任务配置读取或修改文件。项目内修改使用项目写入沙箱，额外权限仍需单次确认。是否授权并执行？`,
      );
      if (cancelled()) return paused();
      if (!granted) throw Error('尚未授权项目，任务未启动。再次点击执行可重新授权。');
      this.repo.transaction(() => {
        for (const project of untrusted) {
          project.trusted = true;
          this.repo.saveProject(project);
        }
      });
    }
    await this.connectAgent();
    if (cancelled()) return paused();
    const scheduler = this.getScheduler();
    await scheduler.refresh(true);
    if (cancelled()) return paused();
    if (scheduler.error) throw Error('AGENT 连接失败：' + scheduler.error);
    if (!scheduler.quota.accountKey) throw Error('AGENT 尚未登录 ChatGPT，请在设置中登录后执行。');
    if ((scheduler.capabilities as any)?.sandboxReady !== true)
      throw Error('AGENT 执行沙箱尚未就绪，请在设置中初始化后执行。');
    this.repo.set('enabled', true);
    this.repo.set('schedulingPaused', false);
    await scheduler.tick();
    if (cancelled()) return paused();
    const execution = this.repo.executions().find((e) => e.endedAt === null);
    if (execution?.state === 'RUNNING')
      return {
        status: 'started',
        message: 'AGENT 已启动任务；完成后自动处理队列中的下一项。',
        executionId: execution.id,
        taskId: execution.taskId,
      };
    if (execution) throw Error('AGENT 启动结果尚未确认，请查看任务详情与恢复检查。');
    const remaining = this.repo.all<Task>('tasks').filter((t) => t.lifecycle === 'QUEUED');
    if (!remaining.length && queued.every((t) => this.repo.task(t.id).lifecycle === 'SUCCEEDED')) {
      return { status: 'completed', message: '本次队列任务已完成，可在任务详情查看 AGENT 结果。' };
    }
    const blocked = remaining.map((t) => ({ taskId: t.id, reasons: t.waitReasons }));
    const waiting =
      remaining.length > 0 &&
      remaining.some(
        (t) =>
          t.waitReasons.length > 0 &&
          t.waitReasons.every((r) => /^(TIME|DEPENDENCY|QUOTA)：/.test(r)),
      );
    if (!waiting) this.repo.set('enabled', false);
    const failed = this.repo
      .executions()
      .filter((e) => e.endedAt !== null)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    const reason =
      blocked.flatMap((b) => b.reasons)[0] ||
      ((failed?.evidence as any)?.error
        ? String((failed!.evidence as any).error)
        : failed?.state === 'FAILED'
          ? 'AGENT 启动失败，请查看任务详情。'
          : '任务已经处理完成。');
    return {
      status: waiting ? 'waiting' : 'blocked',
      message: waiting ? '调度已开启，正在等待：' + reason : '没有启动任务：' + reason,
      blocked,
    };
  }
}
