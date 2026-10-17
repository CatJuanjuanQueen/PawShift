import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppServer } from '../src/agent/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Task, Project } from '../src/domain/model';

test('恢复原会话使用 thread/resume 并重申原项目沙箱，身份不匹配不发送轮次', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pawshift-resume-'));
  const server = new AppServer('unused', true),
    calls: any[] = [];
  try {
    server.connect = async () => {};
    (server as any).selectedModel = 'test-model';
    server.rpc = async (method, params) => {
      calls.push({ method, params });
      return method === 'turn/start'
        ? { turn: { id: 'new-turn' } }
        : { thread: { id: 'same-thread' } };
    };
    const task = { permission: 'restricted', allowedPaths: ['.'] } as Task,
      project = { root } as Project;
    assert.equal(await server.resume('same-thread', task, project), 'same-thread');
    assert.equal(calls[0].method, 'thread/resume');
    assert.equal(calls[0].params.cwd, root);
    assert.equal(calls[0].params.sandbox, 'workspace-write');
    assert.equal(calls[0].params.approvalPolicy, 'untrusted');
    assert.equal(calls[0].params.threadId, 'same-thread');
    await server.start('same-thread', '继续剩余目标');
    assert.equal(calls[1].params.sandboxPolicy.writableRoots[0], root);
    assert.equal(calls[1].params.sandboxPolicy.networkAccess, false);
    server.rpc = async () => ({ thread: { id: 'wrong-thread' } });
    await assert.rejects(() => server.resume('same-thread', task, project), /身份不匹配/);
  } finally {
    server.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
test('本次授权只回应原请求，拒绝过期与不支持的交互，不保存会话级授权', () => {
  const server = new AppServer('unused', true);
  const replies: any[] = [];
  (server as any).send = (m: any) => replies.push(m);
  server.ingest(
    '{"id":12,"method":"item/commandExecution/requestApproval","params":{"threadId":"t","turnId":"u","command":"echo hello"}}\n',
  );
  server.resolveApproval('12', true);
  assert.deepEqual(replies[0], { id: 12, result: { decision: 'accept' } });
  assert.throws(() => server.resolveApproval('12', true), /过期/);
  server.ingest('{"id":13,"method":"item/fileChange/requestApproval","params":{}}\n');
  server.resolveApproval('13', false);
  assert.deepEqual(replies[1], { id: 13, result: { decision: 'decline' } });
  server.ingest('{"id":14,"method":"item/tool/requestUserInput","params":{}}\n');
  assert.throws(() => server.resolveApproval('14', true), /不支持/);
  server.dispose();
});
test('JSONL 跨 chunk 和多条通知保持完整，并保留相同文本 delta', () => {
  const server = new AppServer('unused');
  const events: any[] = [];
  server.onEvent((m, p) => events.push({ m, p }));
  server.ingest('{"method":"delta","params":{"text":"');
  server.ingest('汪汪"}}\n{"method":"delta","params":{"text":"汪汪"}}\n');
  assert.equal(events.length, 2);
  assert.equal(events[0].p.text, '汪汪');
  assert.equal(events[1].p.text, '汪汪');
  server.dispose();
});
test('JSONL 无法解析与单消息超出 4MiB 必须报告协议错误', () => {
  const server = new AppServer('unused');
  assert.throws(() => server.ingest('not-json\n'));
  assert.throws(() => server.ingest('x'.repeat(4 * 1024 * 1024 + 1)), /超限/);
  server.dispose();
});
