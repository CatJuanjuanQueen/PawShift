import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, renameSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Repository } from '../src/storage/repository';
async function main() {
  const [sourceArg, targetArg, proof] = process.argv.slice(2);
  if (!sourceArg || !targetArg || !proof || proof.trim().length < 10)
    throw Error(
      '用法：node dist/scripts/restore.js 备份.db 原数据库.db "已关闭PawShift软件、Codex 受控进程及外部作业，已核对副作用"',
    );
  const sourcePath = realpathSync(sourceArg),
    target = resolve(targetArg);
  if (!target.endsWith('.db')) throw Error('目标必须为 .db 文件');
  if (existsSync(target) && realpathSync(target).toLowerCase() === sourcePath.toLowerCase())
    throw Error('备份与目标不能相同');
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const check = source.prepare('PRAGMA integrity_check').get() as any;
  if (check.integrity_check !== 'ok') throw Error('备份完整性失败');
  const version = Number((source.prepare('PRAGMA user_version').get() as any).user_version);
  if (version !== 1) throw Error('仅恢复 schema 1');
  for (const table of ['tasks', 'executions', 'projects', 'settings'])
    source.prepare('SELECT count(*) FROM ' + table).get();
  const stage = join(dirname(target), 'xsgw-restore-' + randomUUID() + '.db');
  await backup(source, stage);
  source.close();
  let previous: string | null = null;
  if (existsSync(target)) {
    const old = new DatabaseSync(target);
    const wal = old.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as any;
    if (wal.busy) {
      old.close();
      throw Error('数据库仍被使用，请关闭其他窗口与进程');
    }
    old.close();
    previous = target + '.before-restore-' + Date.now();
    renameSync(target, previous);
  }
  try {
    renameSync(stage, target);
    const restored = new Repository(target);
    restored.set('enabled', false);
    restored.set('integrationValidated', false);
    restored.set('sandboxValidated', false);
    for (const project of restored.all<any>('projects')) {
      project.trusted = false;
      restored.saveProject(project);
    }
    restored.recover();
    restored.event('backup.restored', null, { source: sourcePath, proof, previous });
    restored.close();
    console.log(
      JSON.stringify(
        { target, previous, schedulingEnabled: false, requiresReconciliation: true },
        null,
        2,
      ),
    );
  } catch (e) {
    if (previous && !existsSync(target)) renameSync(previous, target);
    throw e;
  }
}
main().catch((e) => {
  console.error(String(e));
  process.exitCode = 1;
});
