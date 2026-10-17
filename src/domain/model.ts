export type Lifecycle =
  | 'DRAFT'
  | 'QUEUED'
  | 'CLAIMED'
  | 'RUNNING'
  | 'RECONCILING'
  | 'VERIFYING'
  | 'PAUSED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';
export const active = ['CLAIMED', 'RUNNING', 'RECONCILING', 'VERIFYING'];
export const terminal = ['SUCCEEDED', 'FAILED', 'CANCELLED'];
export interface Check {
  id: string;
  type: 'manual' | 'file';
  requirement: string;
  path?: string;
  contains?: string;
}
export interface TaskInput {
  projectId: string;
  title: string;
  objective: string;
  acceptance: Check[];
  dependencies: string[];
  priority: number;
  notBefore: number | null;
  deadline: number | null;
  delayMs: number;
  allowedPaths: string[];
  permission: 'read-only' | 'restricted';
  maxTurns: number;
  maxMinutes: number;
}
export interface Task extends TaskInput {
  id: string;
  revision: number;
  version: number;
  lifecycle: Lifecycle;
  desiredState: 'run' | 'pause' | 'cancel';
  waitReasons: string[];
  createdAt: number;
  queueOrder: number;
  completedAt: number | null;
}
export interface Project {
  id: string;
  name: string;
  uri: string;
  root: string;
  canonicalKey: string;
  archived: boolean;
  accountKey: string | null;
  trusted?: boolean;
}
export interface Execution {
  id: string;
  taskId: string;
  revision: number;
  state: Lifecycle;
  threadId: string | null;
  turnId: string | null;
  startedAt: number;
  endedAt: number | null;
  snapshot: Task;
  baseline: unknown;
  sendState: string;
  evidence: unknown;
  output?: string;
  activity?: string;
  runningItems?: string[];
}
export interface Quota {
  observedAt: number;
  accountKey: string | null;
  windows: {
    name: string;
    usedPercent: number | null;
    resetsAt: number | null;
  }[];
  error?: string;
}
export interface Adapter {
  readonly managed?: boolean;
  probe(): Promise<unknown>;
  account(): Promise<{
    key: string | null;
    type: string | null;
  }>;
  quota(): Promise<Quota>;
  prepare(task: Task, project: Project): Promise<string>;
  resume?(threadId: string, task: Task, project: Project): Promise<string>;
  start(threadId: string, prompt: string): Promise<string>;
  read(threadId: string): Promise<any>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  onEvent(callback: (method: string, params: any) => void): () => void;
  dispose(): void;
}
export function validate(input: TaskInput) {
  if (!input.title?.trim() || input.title.length > 120) throw Error('标题必须为 1–120 字符');
  if (!input.objective?.trim() || input.objective.length > 20000)
    throw Error('目标必须为 1–20000 字符');
  if (!Array.isArray(input.acceptance) || !input.acceptance.length) throw Error('至少填写一项验收');
  if (!Array.isArray(input.dependencies) || !Array.isArray(input.allowedPaths))
    throw Error('依赖和允许路径格式错误');
  if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 10)
    throw Error('优先级范围 0–10');
  if (!['read-only', 'restricted'].includes(input.permission)) throw Error('权限档无效');
  if (
    !Number.isInteger(input.maxTurns) ||
    input.maxTurns < 1 ||
    input.maxTurns > 5 ||
    !Number.isFinite(input.maxMinutes) ||
    input.maxMinutes < 1 ||
    input.maxMinutes > 30
  )
    throw Error('轮次范围 1–5，活动时间范围 1–30 分钟');
  if (!Number.isFinite(input.delayMs) || input.delayMs < 0) throw Error('前置延迟无效');
  for (const t of [input.notBefore, input.deadline])
    if (t !== null && (!Number.isFinite(t) || t < 0)) throw Error('计划时间无效');
  if (input.notBefore && input.deadline && input.deadline < input.notBefore)
    throw Error('截止时间早于计划时间');
  const ids = new Set<string>();
  for (const c of input.acceptance) {
    if (!c.id || ids.has(c.id) || !c.requirement?.trim() || !['file', 'manual'].includes(c.type))
      throw Error('验收格式无效');
    ids.add(c.id);
    if (c.type === 'file') safeRelative(c.path || '');
  }
  for (const p of input.allowedPaths) safeRelative(p);
}
export function safeRelative(p: string) {
  if (
    !p ||
    p.includes('\0') ||
    /^[\\/]|^[a-z]:/i.test(p) ||
    p.split(/[\\/]/).some((x) => x === '..') ||
    p.includes(':')
  )
    throw Error('路径必须在项目内，不能越界');
  return p;
}
export function redact(value: any): any {
  if (typeof value === 'string')
    return value
      .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[\w-]+/g, '[REDACTED]')
      .replace(/((?:token|api[_-]?key|password|cookie|authorization)=)[^\s&]+/gi, '$1[REDACTED]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /token|secret|password|authorization|cookie|api.?key/i.test(k) ? '[REDACTED]' : redact(v),
      ]),
    );
  return value;
}
