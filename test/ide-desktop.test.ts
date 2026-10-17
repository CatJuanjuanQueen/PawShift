import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopService, DesktopHost } from '../src/application/desktop-service';
import { AppServer } from '../src/agent/client';
import { Repository } from '../src/storage/repository';

const host: DesktopHost = {
  async chooseDirectory() {
    return null;
  },
  async chooseCodex() {
    return null;
  },
  async chooseBackup() {
    return null;
  },
  async confirm() {
    return false;
  },
  async clipboard() {},
  async saveFile() {
    return null;
  },
  async openDataDirectory() {},
};

test('新安装默认连接 AGENT，启动时暂停队列，不会自动复制交接提示词', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pawshift-default-'));
  const service = new DesktopService(dir, host);
  try {
    assert.ok(service.adapter instanceof AppServer);
    assert.equal(service.adapter.managed, true);
    assert.equal(service.snapshot().settings.executionChannel, 'managed');
    assert.equal(service.repo.setting('enabled', true), false);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('空闲旧安装自动迁移到 AGENT，保留主题等设置', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pawshift-migration-'));
  const repo = new Repository(join(dir, 'xsgw.db'));
  repo.set('executionChannel', 'vscode');
  repo.set('theme', 'dark');
  repo.set('enabled', true);
  repo.close();
  const service = new DesktopService(dir, host);
  try {
    assert.equal(service.snapshot().settings.executionChannel, 'managed');
    assert.equal(service.snapshot().settings.theme, 'dark');
    assert.equal(service.repo.setting('enabled', true), false);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
