import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { Check, Project, safeRelative } from '../domain/model';

export function checkFiles(project: Project, checks: Check[]) {
  return checks
    .filter((c) => c.type === 'file')
    .map((check) => {
      try {
        if (!project.uri.startsWith('file:')) throw Error('远程文件无法在本机验收');
        safeRelative(check.path || '');
        const root = realpathSync(project.root);
        const file = realpathSync(resolve(root, check.path!));
        const rel = relative(root, file);
        if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel))
          throw Error('验收文件越过项目边界');
        const info = statSync(file);
        if (!info.isFile()) throw Error('不是文件');
        if (info.size > 10 * 1024 * 1024) throw Error('验收文件超过 10MiB');
        const content = readFileSync(file);
        if (check.contains && !content.toString('utf8').includes(check.contains))
          throw Error('文件缺少要求的内容');
        return {
          id: check.id,
          state: 'PASSED',
          path: check.path,
          hash: createHash('sha256').update(content).digest('hex'),
          checkedAt: Date.now(),
        };
      } catch (error) {
        return { id: check.id, state: 'FAILED', path: check.path, reason: String(error) };
      }
    });
}
