import { AppServer, discoverCodex } from '../src/agent/client';
import { mkdirSync, writeFileSync } from 'node:fs';
import { redact } from '../src/domain/model';
async function main() {
  const binary = process.argv[2] || discoverCodex();
  if (!binary) throw Error('未找到 Codex AGENT，请提供 codex.exe 的绝对路径。');
  const agent = new AppServer(binary, true);
  try {
    const capabilities = await agent.probe();
    const quota = await agent.quota();
    const report = redact({
      observedAt: new Date().toISOString(),
      capabilities,
      accountConfirmed: !!quota.accountKey,
      windows: quota.windows,
      error: quota.error,
      modelRequests: 0,
    });
    mkdirSync('docs', { recursive: true });
    writeFileSync('docs/agent-connection.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    agent.dispose();
  }
}
main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
