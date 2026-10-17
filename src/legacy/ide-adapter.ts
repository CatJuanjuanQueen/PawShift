import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Adapter, Quota, Task, Project } from '../domain/model';
export class IdeAdapter implements Adapter {
  get mode() {
    return this.platform;
  }
  get label() {
    return this.platform === 'vscode' ? 'VS Code Codex' : 'GPT 软件（Codex 桌面端）';
  }
  constructor(
    private readonly openPanel?: () => Promise<void>,
    readonly platform: 'vscode' | 'codex-desktop' = 'vscode',
  ) {}
  async probe() {
    if (this.platform === 'codex-desktop')
      return {
        mode: this.mode,
        executionOwner: this.label,
        role: '复制交接后由用户提交，完成后人工验收',
        canStart: false,
        canReadQuota: false,
        canReconcile: false,
        canInterrupt: false,
        installed: null,
      };
    const versions: string[] = [];
    for (const folder of ['.vscode', '.vscode-insiders'])
      try {
        const root = join(homedir(), folder, 'extensions');
        for (const name of readdirSync(root))
          if (name.startsWith('openai.chatgpt-'))
            try {
              const p = JSON.parse(readFileSync(join(root, name, 'package.json'), 'utf8'));
              if (p.publisher === 'openai' && p.name === 'chatgpt') versions.push(p.version);
            } catch {}
      } catch {}
    return {
      mode: this.mode,
      installed: versions.length > 0,
      versions,
      executionOwner: this.label,
      role: '完成监测与验收；下一项由用户点击提交',
      canStart: false,
      canReadQuota: false,
      canReconcile: true,
      canInterrupt: false,
      monitorSource: '本机 Codex 会话记录；仅匹配任务执行标识',
    };
  }
  async open() {
    if (!this.openPanel) throw Error('当前环境无法打开' + this.label);
    await this.openPanel();
  }
  async account() {
    return { key: null, type: null };
  }
  async quota(): Promise<Quota> {
    return { observedAt: Date.now(), accountKey: null, windows: [] };
  }
  async prepare(_task: Task, _project: Project): Promise<string> {
    throw Error('请点击交接，在 VS Code Codex 中提交任务');
  }
  async start(_threadId: string, _prompt: string): Promise<string> {
    throw Error('下一项由用户在 VS Code Codex 中提交');
  }
  async read(_threadId: string): Promise<any> {
    throw Error('通过本机会话记录监测，请刷新任务状态');
  }
  async interrupt(_threadId: string, _turnId: string): Promise<void> {
    throw Error('请在 VS Code Codex 中停止任务，再核对实际执行状态');
  }
  onEvent(_callback: (method: string, params: any) => void) {
    return () => {};
  }
  dispose() {}
}
