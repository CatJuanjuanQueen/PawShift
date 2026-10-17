import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { DesktopService, DesktopHost } from './application/desktop-service';
const pending = new Map<
  number,
  {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }
>();
let nextId = 0,
  visible = true,
  dirty = false,
  closing = false;
function send(value: unknown) {
  process.stdout.write(JSON.stringify(value) + '\n');
}
function hostCall(method: string, args: any[] = []): Promise<any> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ kind: 'host', id, method, args });
  });
}
const host: DesktopHost = {
  openLogin: (url) => hostCall('openLogin', [url]),
  showApproval: () => hostCall('showApproval'),
  openCodex: () => hostCall('openCodex'),
  openGpt: () => hostCall('openGpt'),
  chooseDirectory: () => hostCall('chooseDirectory'),
  chooseCodex: () => hostCall('chooseCodex'),
  chooseBackup: () => hostCall('chooseBackup'),
  confirm: (title, message) => hostCall('confirm', [title, message]),
  clipboard: (text) => hostCall('clipboard', [text]),
  saveFile: (name, content) => hostCall('saveFile', [name, content]),
  openDataDirectory: (path) => hostCall('openDataDirectory', [path]),
};
const service = new DesktopService(
  process.argv[2] || join(process.env.APPDATA || '.', 'PawShift'),
  host,
);
let latest: any;
const publish = setInterval(() => {
  if (visible && dirty && !closing) {
    dirty = false;
    send({ kind: 'snapshot', data: latest });
    latest = undefined;
  }
}, 250);
service.on('snapshot', (snapshot) => {
  dirty = true;
  if (visible) latest = snapshot;
});
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(publish);
  await service.close();
  send({ kind: 'closed' });
  input.close();
  process.exit(0);
}
input.on('line', (line) => {
  void (async () => {
    try {
      const message = JSON.parse(line);
      if (message.kind === 'hostResult') {
        const request = pending.get(message.id);
        if (request) {
          pending.delete(message.id);
          message.error ? request.reject(Error(message.error)) : request.resolve(message.data);
        }
        return;
      }
      if (message.kind === 'visibility') {
        visible = message.visible === true;
        service.viewVisible = visible;
        if (visible) {
          latest = service.snapshot();
          dirty = true;
        } else latest = undefined;
        return;
      }
      if (message.kind === 'close') {
        await shutdown();
        return;
      }
      if (message.kind === 'command') {
        const result = await service.command(message.message);
        send({ kind: 'response', id: message.id, ...result });
      }
    } catch (error) {
      send({ kind: 'error', error: String(error) });
    }
  })();
});
input.on('close', () => {
  for (const request of pending.values()) request.reject(Error('本地窗口已关闭'));
  pending.clear();
  void shutdown();
});
service.start();
