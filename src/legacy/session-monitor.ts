import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
export interface Observation {
  threadId: string;
  turnId: string;
  status: 'running' | 'completed' | 'interrupted' | 'failed';
  observedAt: number;
}
// Only a submitted user message containing this execution's marker binds a turn.
export function observeSession(
  content: string,
  executionId: string,
  root: string,
  startedAt: number,
): Observation | null {
  return observeLines(content.split('\n'), executionId, root, startedAt);
}
function observeLines(
  lines: Iterable<string>,
  executionId: string,
  root: string,
  startedAt: number,
): Observation | null {
  let meta: any,
    turnId: string | null = null,
    bound: string | null = null,
    result: Observation | null = null,
    pendingMarker = false;
  const samePath = (a: string, b: string) =>
    process.platform === 'win32'
      ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
      : resolve(a) === resolve(b);
  for (const line of lines) {
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const p = row.payload;
    if (row.type === 'session_meta') {
      meta = p;
      continue;
    }
    if (
      !meta ||
      meta.source !== 'vscode' ||
      typeof meta.cwd !== 'string' ||
      !samePath(meta.cwd, root) ||
      typeof meta.id !== 'string'
    )
      continue;
    const at = Date.parse(row.timestamp);
    if (!Number.isFinite(at) || at < startedAt) continue;
    if (row.type === 'response_item' && p?.type === 'message' && p.role === 'user') {
      const message = (p.content || [])
        .filter((c: any) => c.type === 'input_text')
        .map((c: any) => c.text)
        .join('\n');
      if (message.split(/\r?\n/).some((s: string) => s === '执行标识：' + executionId)) {
        if (bound && turnId && bound !== turnId) return null;
        if (turnId) {
          bound = turnId;
          result = { threadId: meta.id, turnId, status: 'running', observedAt: at };
        } else pendingMarker = true;
      }
    }
    if (row.type !== 'event_msg') continue;
    if (p?.type === 'task_started') {
      turnId = p.turn_id;
      if (pendingMarker && typeof turnId === 'string') {
        bound = turnId;
        pendingMarker = false;
        result = { threadId: meta.id, turnId, status: 'running', observedAt: at };
      }
    }
    if (
      p?.type === 'user_message' &&
      typeof p.message === 'string' &&
      p.message.split(/\r?\n/).includes('执行标识：' + executionId)
    ) {
      if (bound && turnId && bound !== turnId) return null;
      if (turnId) {
        bound = turnId;
        result = { threadId: meta.id, turnId, status: 'running', observedAt: at };
      } else pendingMarker = true;
    }
    if (
      bound &&
      p?.turn_id === bound &&
      ['task_complete', 'turn_aborted', 'task_failed'].includes(p.type)
    ) {
      result = {
        threadId: meta.id,
        turnId: bound,
        status:
          p.type === 'task_complete'
            ? 'completed'
            : p.type === 'turn_aborted'
              ? 'interrupted'
              : 'failed',
        observedAt: at,
      };
      turnId = null;
    }
  }
  return result;
}
// Bound transient memory even for large rollout files. Oversized individual records
// cannot bind a turn; skip them until the next complete line.
function* sessionLines(path: string): Generator<string> {
  const fd = openSync(path, 'r'),
    buffer = Buffer.allocUnsafe(64 * 1024);
  let tail = Buffer.alloc(0),
    skipping = false;
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      let start = 0;
      for (let i = 0; i < count; i++)
        if (buffer[i] === 10) {
          if (!skipping && tail.length + i - start <= 4 * 1024 * 1024)
            yield Buffer.concat([tail, buffer.subarray(start, i)]).toString('utf8');
          tail = Buffer.alloc(0);
          skipping = false;
          start = i + 1;
        }
      if (!skipping) {
        if (tail.length + count - start > 4 * 1024 * 1024) {
          tail = Buffer.alloc(0);
          skipping = true;
        } else tail = Buffer.concat([tail, buffer.subarray(start, count)]);
      }
    }
    if (tail.length && !skipping) yield tail.toString('utf8');
  } finally {
    closeSync(fd);
  }
}
const observations = new Map<
  string,
  {
    mtime: number;
    size: number;
    result: Observation | null;
  }
>();
export function findObservation(
  executionId: string,
  root: string,
  startedAt: number,
  sessions = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'),
  threadId?: string | null,
): Observation | null {
  const files: {
    path: string;
    mtime: number;
    size: number;
  }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (f.isSymbolicLink()) continue;
      const path = join(dir, f.name);
      if (f.isDirectory()) walk(path, depth + 1);
      else if (
        f.isFile() &&
        f.name.endsWith('.jsonl') &&
        (!threadId || f.name.includes(threadId))
      ) {
        const s = statSync(path);
        if (s.mtimeMs >= startedAt) files.push({ path, mtime: s.mtimeMs, size: s.size });
      }
    }
  };
  try {
    walk(sessions, 0);
  } catch {
    return null;
  }
  let match: Observation | null = null,
    bytes = 0;
  for (const file of files.sort((a, b) => b.mtime - a.mtime).slice(0, 200)) {
    if (file.size > 64 * 1024 * 1024) continue;
    bytes += file.size;
    if (bytes > 128 * 1024 * 1024) break;
    try {
      const key = JSON.stringify([executionId, root, startedAt, file.path]);
      const cached = observations.get(key);
      const result =
        cached && cached.mtime === file.mtime && cached.size === file.size
          ? cached.result
          : observeLines(sessionLines(file.path), executionId, root, startedAt);
      if (!cached || cached.mtime !== file.mtime || cached.size !== file.size) {
        observations.delete(key);
        observations.set(key, { mtime: file.mtime, size: file.size, result });
        if (observations.size > 200) observations.delete(observations.keys().next().value!);
      }
      if (result) {
        if (match && (match.threadId !== result.threadId || match.turnId !== result.turnId))
          return null;
        match = result;
      }
    } catch {}
  }
  return match;
}
