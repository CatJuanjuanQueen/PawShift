const { chromium } = require('playwright');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const live = process.argv.includes('--live-agent');
const testPause = process.argv.includes('--pause-resume');
const legacyResume = process.argv.includes('--legacy-resume');
const appDirectory = path.resolve(
  process.argv.find((a) => a.startsWith('--app-dir='))?.slice(10) ||
    'release-webview2/PawShift-' + require('../package.json').version,
);
const root = process.cwd(),
  testDir = fs.mkdtempSync(path.join(root, '.build', 'webview-test-'));
const dataDir = path.join(testDir, 'data'),
  work = path.join(testDir, 'project');
fs.mkdirSync(dataDir);
fs.mkdirSync(work);
const fixture = {
  projectDirectory: work,
  confirm: false,
  exportPath: path.join(testDir, 'diagnostics.json'),
};
const saveFixture = () =>
  fs.writeFileSync(path.join(dataDir, 'native-test-fixture.json'), JSON.stringify(fixture));
saveFixture();
const checks = [];
function checked(name) {
  checks.push(name);
  console.log('PASS: ' + name);
}
let child, browser;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const screenshots = path.join(root, 'docs/screenshots');
fs.mkdirSync(screenshots, { recursive: true });
async function launch() {
  child = spawn(
    path.join(appDirectory, 'PawShift.exe'),
    ['--pawshift-test', '--pawshift-data-dir=' + dataDir, '--debug-port=19327'],
    { windowsHide: true },
  );
  for (let i = 0; i < 100; i++) {
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:19327');
      break;
    } catch {
      await pause(250);
    }
  }
  assert.ok(browser, 'WebView2 did not start');
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('#app h1');
  return page;
}
async function command(page, type, payload = {}) {
  return page.evaluate(
    ({ type, payload }) =>
      window.pawshift.command({ type, payload, commandId: crypto.randomUUID() }),
    { type, payload },
  );
}
async function close() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await browser
    .contexts()[0]
    .pages()[0]
    .evaluate(() => window.chrome.webview.postMessage({ kind: 'test-close' }));
  await Promise.race([
    exited,
    pause(20000).then(() => {
      throw Error('Native host did not exit');
    }),
  ]);
  await browser.close();
  browser = null;
}
function restoreWindow() {
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class PawShiftTestWindow { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n); }'; $taskProcess=Get-Process -Id ${child.pid}; [void][PawShiftTestWindow]::ShowWindow($taskProcess.MainWindowHandle,9)`,
    ],
    { windowsHide: true },
  );
}
(async () => {
  let page = await launch();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  assert.equal(await page.evaluate(() => typeof require), 'undefined');
  assert.equal((await command(page, 'invalid.command')).ok, false);
  assert.equal((await command(page, 'view.subscribe')).data.settings.executionChannel, 'managed');
  await page.getByRole('button', { name: '执行任务', exact: true }).click();
  await page
    .getByText('队列中没有待执行任务。请先创建任务并保存入队；草稿需要先入队。', { exact: true })
    .waitFor();
  checked('空队列点击执行显示实际状态');
  // No project is seeded: this crosses chooseDirectory([]) in the actual native bridge.
  await page.getByRole('button', { name: '项目管理', exact: true }).click();
  await page.getByRole('button', { name: '关联本地项目', exact: true }).click();
  await page.getByRole('heading', { name: 'project', exact: true }).waitFor();
  let snapshot = (await command(page, 'view.subscribe')).data;
  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.projects[0].trusted, false);
  checked('界面关联项目经过原生空参数调用，默认未授权');
  await page.getByRole('button', { name: '＋ 新建任务', exact: true }).click();
  const title = live ? '点击执行联动 AGENT 验证' : '桌面任务保存验证';
  await page.getByLabel('标题 *（最多 120 字符）', { exact: true }).fill(title);
  await page
    .getByLabel('任务目标 *', { exact: true })
    .fill(
      live
        ? 'Use apply_patch to create button-result.txt in this project containing exactly PAWSHIFT_BUTTON_OK and a newline. Do not use shell commands, subagents, or network. Then report what you created.'
        : '验证表单、任务持久化和设置，不发送模型请求。',
    );
  if (live) {
    await page
      .getByLabel('文件验收：项目内相对路径（可选）', { exact: true })
      .fill('button-result.txt');
    await page.getByLabel('文件必须包含的文本（可选）', { exact: true }).fill('PAWSHIFT_BUTTON_OK');
  }
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  assert.equal(await page.getByLabel('权限档', { exact: true }).inputValue(), 'restricted');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '保存并入队', exact: true }).click();
  await page.getByRole('button', { name: title, exact: true }).waitFor();
  checked('三步表单创建并入队');
  // The old tests pre-authorized the project and missed this failing confirm([title,message]) call.
  await page.getByRole('button', { name: '执行任务', exact: true }).click();
  await page
    .getByText('Error: 尚未授权项目，任务未启动。再次点击执行可重新授权。', { exact: true })
    .waitFor();
  snapshot = (await command(page, 'view.subscribe')).data;
  assert.equal(snapshot.executions.length, 0);
  assert.equal(snapshot.projects[0].trusted, false);
  checked('执行前原生授权拒绝：不启动任务、不隐式授权');
  fixture.confirm = true;
  saveFixture();
  let modelRequests = 0;
  let interruptedThread = null,
    resumed = false;
  if (live) {
    await page.getByRole('button', { name: '执行任务', exact: true }).click();
    await page
      .getByText('AGENT 已启动任务；完成后自动处理队列中的下一项。', { exact: true })
      .waitFor({ timeout: 60000 });
    modelRequests = 1;
    console.log('Real desktop execute button started AGENT');
    const until = Date.now() + 600000;
    let completed = false,
      last = '';
    while (Date.now() < until) {
      const snapshot = (await command(page, 'view.subscribe')).data;
      assert.equal(snapshot.error, '', 'AGENT or native approval bridge reported an error');
      const status =
        snapshot.tasks[0].lifecycle +
        ' / ' +
        ((snapshot.executions.find((e) => e.endedAt === null) || snapshot.executions.at(-1))
          ?.activity || '');
      if (status !== last) {
        console.log(status);
        last = status;
      }
      for (const approval of snapshot.approvals) {
        assert.equal(
          approval.method,
          'item/fileChange/requestApproval',
          'Unexpected approval in isolated write fixture',
        );
        if (approval.params.grantRoot)
          assert.equal(path.resolve(approval.params.grantRoot), path.resolve(work));
        if (testPause && !resumed) {
          interruptedThread = snapshot.executions[0].threadId;
          await page.getByRole('button', { name: '暂停调度', exact: true }).click();
          let paused;
          for (let i = 0; i < 60; i++) {
            paused = (await command(page, 'view.subscribe')).data;
            assert.equal(paused.enabled, false);
            assert.equal(
              paused.approvals.some((a) => a.canAllow),
              false,
            );
            if (paused.tasks[0].lifecycle === 'PAUSED') break;
            assert.equal(paused.schedulingState, 'pausing');
            // Snapshot responses can precede delivery of the corresponding UI notification.
            // A fast terminal event can already replace the disabled button with Continue.
            await page.waitForFunction(() => {
              const buttons = [...document.querySelectorAll('button')];
              return (
                buttons.some((b) => b.textContent === '执行任务' && b.disabled) ||
                buttons.some((b) => b.textContent === '继续执行')
              );
            });
            await pause(500);
          }
          assert.equal(paused.tasks[0].lifecycle, 'PAUSED', 'AGENT interruption was not confirmed');
          assert.equal(paused.executions.length, 1);
          await page.getByRole('heading', { name: '任务和队列已暂停', exact: true }).waitFor();
          await page.screenshot({
            path: path.join(screenshots, 'pause-confirmed.png'),
            fullPage: true,
          });
          checked('等待文件权限时点击暂停，AGENT 确认中断且旧授权不能放行');
          if (legacyResume) {
            await close();
            const { DatabaseSync } = require('node:sqlite');
            const database = new DatabaseSync(path.join(dataDir, 'xsgw.db'));
            database
              .prepare("DELETE FROM settings WHERE id IN ('pausedTaskId','resumeTaskId')")
              .run();
            const row = database.prepare('SELECT id,data FROM executions').get();
            const old = JSON.parse(row.data);
            old.runningItems = [approval.params.itemId || 'legacy-pending-approval'];
            database
              .prepare('UPDATE executions SET data=? WHERE id=?')
              .run(JSON.stringify(old), row.id);
            database.close();
            page = await launch();
            page.on('pageerror', (error) => errors.push(String(error)));
            const reopened = (await command(page, 'view.subscribe')).data;
            assert.equal(reopened.tasks[0].lifecycle, 'PAUSED');
            assert.equal(reopened.resumeTaskId, null);
            await page.getByRole('heading', { name: '任务和队列已暂停', exact: true }).waitFor();
            checked('重启旧版暂停数据：缺少恢复标记并遗留工具状态，任务仍可直接继续');
          }
          await pause(1200);
          assert.equal((await command(page, 'view.subscribe')).data.executions.length, 1);
          await page.getByRole('button', { name: '继续执行', exact: true }).click();
          await page
            .getByText('AGENT 已启动任务；完成后自动处理队列中的下一项。', { exact: true })
            .waitFor({ timeout: 60000 });
          const continued = (await command(page, 'view.subscribe')).data.executions.find(
            (e) => e.endedAt === null,
          );
          assert.equal(continued.threadId, interruptedThread);
          assert.notEqual(continued.turnId, paused.executions[0].turnId);
          resumed = true;
          modelRequests++;
          checked('点击继续执行沿用原 AGENT 会话，生成新的轮次且不重复派发');
          break;
        }
        await page.getByRole('button', { name: '允许本次', exact: true }).click();
      }
      if (snapshot.tasks[0].lifecycle === 'SUCCEEDED') {
        assert.match(
          fs.readFileSync(path.join(work, 'button-result.txt'), 'utf8'),
          /PAWSHIFT_BUTTON_OK/,
        );
        assert.equal(snapshot.executions.length, testPause ? 2 : 1);
        assert.ok(snapshot.executions.at(-1).output);
        if (testPause) assert.equal(resumed, true);
        completed = true;
        break;
      }
      if (['FAILED', 'RECONCILING'].includes(snapshot.tasks[0].lifecycle))
        throw Error(JSON.stringify(snapshot.executions[0]));
      await pause(1000);
    }
    assert.ok(completed, 'Real AGENT task did not complete');
    checked('真实点击执行、项目授权、单次文件权限、文件产物和结果展示');
    await page.getByRole('button', { name: title, exact: true }).click();
    await page.getByRole('heading', { name: 'AGENT 执行结果', exact: true }).waitFor();
    await page.screenshot({
      path: path.join(screenshots, 'agent-desktop-result.png'),
      fullPage: true,
    });
  } else {
    await page.getByRole('button', { name: '项目管理', exact: true }).click();
    await page.getByRole('button', { name: '允许访问项目', exact: true }).click();
    await page.getByRole('button', { name: '撤销项目授权', exact: true }).waitFor();
    assert.equal((await command(page, 'view.subscribe')).data.projects[0].trusted, true);
    checked('原生授权接受成功，确认参数跨桥接保留');
  }
  await page.getByRole('button', { name: '设置', exact: true }).click();
  assert.equal(await page.getByLabel('执行平台', { exact: true }).count(), 0);
  // Match an interactive edit: selectOption alone does not focus the control,
  // so a background snapshot could otherwise replace it before Save is clicked.
  await page.getByLabel('界面主题', { exact: true }).focus();
  await page.getByLabel('界面主题', { exact: true }).selectOption('dark');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  checked('保存设置与深色主题');
  await page.getByRole('button', { name: '预览脱敏诊断', exact: true }).click();
  await page.getByRole('button', { name: '保存诊断 JSON', exact: true }).click();
  await page.getByText('已保存：' + fixture.exportPath, { exact: true }).waitFor();
  assert.equal(JSON.parse(fs.readFileSync(fixture.exportPath, 'utf8')).app, 'PawShift Desktop');
  assert.ok(!fs.readFileSync(fixture.exportPath, 'utf8').includes('Use apply_patch'));
  checked('诊断预览、原生保存及实际文件导出');
  await page.getByRole('button', { name: '打开数据目录', exact: true }).click();
  await page.getByRole('button', { name: '创建一致性备份', exact: true }).click();
  await page.getByText('备份位置：', { exact: false }).waitFor();
  const backups = fs
    .readdirSync(path.join(dataDir, 'backups'))
    .filter((name) => name.endsWith('.db'))
    .sort();
  assert.ok(backups.length);
  fixture.backupPath = path.join(dataDir, 'backups', backups.at(-1));
  saveFixture();
  await page.getByRole('button', { name: '导入旧版 / 独立版备份', exact: true }).click();
  await page.getByText('已导入 1 个任务，请重新授权项目并核对活动执行', { exact: true }).waitFor();
  snapshot = (await command(page, 'view.subscribe')).data;
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.projects[0].trusted, false);
  assert.equal(snapshot.enabled, false);
  checked('创建备份、原生选择备份、导入确认与数据恢复');
  await page.screenshot({ path: path.join(screenshots, 'webview2-settings.png'), fullPage: true });
  await page.getByRole('button', { name: '任务队列', exact: true }).click();
  await page.screenshot({
    path: path.join(screenshots, 'webview2-auto-queue.png'),
    fullPage: true,
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (!live) {
    await page.evaluate(() => window.chrome.webview.postMessage({ kind: 'test-minimize' }));
    await pause(12000);
    await browser.close();
    browser = null;
    restoreWindow();
    for (let i = 0; i < 100; i++) {
      try {
        browser = await chromium.connectOverCDP('http://127.0.0.1:19327');
        break;
      } catch {
        await pause(250);
      }
    }
    assert.ok(browser, 'Could not restore released WebView');
    page = browser.contexts()[0].pages()[0];
    await page.waitForSelector('#app h1');
    await page.getByRole('button', { name: '任务队列', exact: true }).click();
    await page.getByRole('button', { name: title, exact: true }).waitFor();
    checked('最小化释放界面后恢复窗口');
  }
  assert.deepEqual(errors, []);
  await close();
  const reopened = await launch(),
    persisted = (await command(reopened, 'view.subscribe')).data;
  assert.equal(persisted.tasks.length, 1);
  assert.equal(persisted.settings.theme, 'dark');
  assert.equal(persisted.enabled, false);
  assert.equal(persisted.tasks[0].lifecycle, live ? 'SUCCEEDED' : 'QUEUED');
  if (live) assert.ok(persisted.executions.at(-1).output);
  await close();
  checked('重启保留任务、主题与执行结果');
  const calls = fs
    .readFileSync(path.join(dataDir, 'native-host-calls.jsonl'), 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  for (const [method, count] of [
    ['chooseDirectory', 0],
    ['confirm', 2],
    ['saveFile', 2],
    ['openDataDirectory', 1],
    ['chooseBackup', 0],
  ]) {
    assert.ok(
      calls.some((call) => call.method === method && call.argumentCount === count),
      method + ' was not exercised',
    );
  }
  if (live)
    assert.ok(calls.some((call) => call.method === 'showApproval' && call.argumentCount === 0));
  const hostLog = path.join(dataDir, 'webview-host.log');
  assert.ok(
    !fs.existsSync(hostLog) || !fs.readFileSync(hostLog, 'utf8').trim(),
    'Native host logged errors',
  );
  checked('原生桥接多种参数数量均经过验证，宿主无异常');
  const result = {
    passed: true,
    checkedAt: new Date().toISOString(),
    runtime: 'system WebView2',
    live,
    testPause,
    legacyResume,
    appDirectory,
    tasksPersisted: 1,
    modelRequests,
    fixture: testDir,
    checks,
    nativeCalls: calls,
    dialogAnswers: 'isolated test fixture; real parsing/IPC/host routing',
    errors,
  };
  fs.writeFileSync(
    path.join(
      root,
      legacyResume
        ? 'docs/legacy-resume-check.json'
        : testPause
          ? 'docs/pause-desktop-check.json'
          : live
            ? 'docs/agent-desktop-check.json'
            : 'docs/webview-check.json',
    ),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
})().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  try {
    await close();
  } catch {
    child?.kill();
  }
});
