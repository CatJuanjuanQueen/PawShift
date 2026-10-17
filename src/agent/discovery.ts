import { isAbsolute, join, delimiter } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
export function discoverCodex(explicit = ''): string {
  if (explicit) return explicit;
  const appRoot = join(__dirname, '../..');
  const candidates = [
    process.env.PAWSHIFT_CODEX_PATH || '',
    join(appRoot, 'runtime/codex.exe'),
    join(appRoot, 'runtime/codex/codex.exe'),
  ];
  for (const folder of ['.vscode', '.vscode-insiders']) {
    const extensions = join(homedir(), folder, 'extensions');
    try {
      const versions = readdirSync(extensions)
        .filter((n) => n.startsWith('openai.chatgpt-'))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const name of versions)
        candidates.push(join(extensions, name, 'bin', 'windows-x86_64', 'codex.exe'));
    } catch {
      /* An editor extension is optional. */
    }
  }
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (directory) candidates.push(join(directory.replace(/^"|"$/g, ''), 'codex.exe'));
  }
  return (
    candidates.find((p) => {
      try {
        return isAbsolute(p) && statSync(p).isFile();
      } catch {
        return false;
      }
    }) || ''
  );
}
