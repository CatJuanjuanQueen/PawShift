/** Runs real AGENT turns only when explicitly invoked. All writes stay in a temporary fixture. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DesktopService, DesktopHost } from '../src/application/desktop-service';
import { Task, TaskInput } from '../src/domain/model';

async function main() {
  mkdirSync('.build', { recursive: true });
  const root = mkdtempSync(join(resolve('.build'), 'agent-check-'));
  const work = join(root, 'project');
  mkdirSync(work);
  writeFileSync(
    join(work, 'AGENTS.md'),
    'Only work on the exact files named in the task. Use apply_patch to create text files. No network, commands, subagents, or external services. This is an isolated integration fixture.\n',
  );
  let projectConsent = 0;
  const host: DesktopHost = {
    async chooseDirectory() {
      return work;
    },
    async chooseCodex() {
      return null;
    },
    async chooseBackup() {
      return null;
    },
    async confirm() {
      projectConsent++;
      return true;
    },
    async clipboard() {
      throw Error('Automatic execution must not copy prompts');
    },
    async saveFile() {
      return null;
    },
    async openDataDirectory() {},
  };
  const service = new DesktopService(join(root, 'data'), host);
  const command = async (type: string, payload: any = {}) => {
    const result = await service.command({ type, payload, commandId: randomUUID() });
    assert.equal(result.ok, true, result.error);
    return result.data;
  };
  try {
    const project = await command('project.add');
    const input: TaskInput = {
      projectId: project.id,
      title: 'AGENT 创建文件',
      objective:
        'Use apply_patch to create agent-result.txt containing exactly PAWSHIFT_AGENT_OK followed by a newline in the current project. Do not run shell commands or use subagents. Then report what you created.',
      acceptance: [
        {
          id: 'file',
          type: 'file',
          path: 'agent-result.txt',
          contains: 'PAWSHIFT_AGENT_OK',
          requirement: '实际创建 agent-result.txt 并写入验证内容',
        },
      ],
      dependencies: [],
      priority: 5,
      notBefore: null,
      deadline: null,
      delayMs: 0,
      allowedPaths: ['.'],
      permission: 'restricted',
      maxTurns: 1,
      maxMinutes: 5,
    };
    const tasks: Task[] = await command('task.create', {
      tasks: [
        input,
        {
          ...input,
          title: 'AGENT 接续任务',
          objective:
            'Read agent-result.txt using the available file tool. Use apply_patch to create verification.txt containing exactly PAWSHIFT_QUEUE_OK followed by a newline. No shell commands, subagents, or network. Report the result.',
          dependencies: ['@previous'],
          acceptance: [
            {
              id: 'second',
              type: 'file',
              path: 'verification.txt',
              contains: 'PAWSHIFT_QUEUE_OK',
              requirement: '前置完成后实际创建 verification.txt',
            },
          ],
        },
      ],
    });
    const receipt = await command('scheduler.execute');
    assert.equal(receipt.status, 'started');
    assert.ok(receipt.executionId);
    assert.equal(projectConsent, 1);
    console.log(JSON.stringify({ fixture: root, started: receipt }));
    let last = '';
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      await service.scheduler.tick();
      const snapshot = service.snapshot();
      const states = tasks.map((t) => service.repo.task(t.id).lifecycle);
      const progress = JSON.stringify({
        states,
        activity: snapshot.executions.find((e) => e.endedAt === null)?.activity,
        approvals: snapshot.approvals.map((a) => ({ method: a.method, params: a.params })),
      });
      if (last !== progress) {
        console.log(progress);
        last = progress;
      }
      // Only file-change approval for the deliberately isolated fixture is accepted.
      for (const approval of snapshot.approvals) {
        if (approval.method !== 'item/fileChange/requestApproval')
          throw Error('Unexpected approval: ' + JSON.stringify(approval));
        const grant = approval.params?.grantRoot;
        if (grant && resolve(grant) !== resolve(work)) throw Error('Approval outside fixture');
        await command('approval.allow', { key: approval.key });
      }
      if (states.every((state) => state === 'SUCCEEDED')) {
        assert.match(readFileSync(join(work, 'agent-result.txt'), 'utf8'), /PAWSHIFT_AGENT_OK/);
        assert.match(readFileSync(join(work, 'verification.txt'), 'utf8'), /PAWSHIFT_QUEUE_OK/);
        const executions = service.repo.executions();
        assert.equal(executions.length, 2);
        assert.ok(
          executions.every(
            (e) =>
              e.output && (e.evidence as any)?.acceptance?.every((c: any) => c.state === 'PASSED'),
          ),
        );
        assert.ok(executions[1].startedAt >= executions[0].endedAt!);
        const report = {
          passed: true,
          checkedAt: new Date().toISOString(),
          root,
          receipt,
          projectConsent,
          tasks: states,
          executions: executions.map((e) => ({
            id: e.id,
            state: e.state,
            threadId: e.threadId,
            turnId: e.turnId,
            startedAt: e.startedAt,
            endedAt: e.endedAt,
            output: e.output,
            acceptance: (e.evidence as any).acceptance,
          })),
        };
        mkdirSync('docs', { recursive: true });
        writeFileSync('docs/agent-check.json', JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
        return;
      }
      if (states.some((state) => ['FAILED', 'RECONCILING'].includes(state)))
        throw Error(
          JSON.stringify(
            snapshot.executions.map((e) => ({
              state: e.state,
              evidence: e.evidence,
              output: e.output,
            })),
          ),
        );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw Error('AGENT verification timed out; fixture retained at ' + root);
  } finally {
    await service.close();
  }
}
main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
