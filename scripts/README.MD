# 脚本导航

在项目根目录运行下列命令。TypeScript 脚本会编译到 `dist/scripts/`。

| 文件                          | 入口与用途                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `clean-build.cjs`、`copy.mjs` | `npm run build`：清理生成目录、编译并复制 UI 构建文件                                          |
| `build-webview.ps1`           | `npm run package:dir`：构建当前版本 WebView2 程序及 ZIP                                        |
| `launch-webview.cjs`          | `npm start`：启动 `package.json` 指定版本的发布程序                                            |
| `verify-release.cjs`          | `npm run verify:release`：比较当前编译输出与发布文件                                           |
| `test-native.ps1`             | `npm run test:native`：运行 .NET JSON 参数回归检查                                             |
| `webview-check.cjs`           | 实际桌面自动化；`test:desktop` 不请求模型，`test:pause` 和 `test:resume` 使用真实 AGENT        |
| `agent-check.ts`              | `npm run test:agent`：隔离项目内的真实 AGENT 和队列接续验证                                    |
| `probe.ts`                    | `npm run probe`：检查本机 AGENT、账户、额度和沙箱                                              |
| `benchmark.ts`                | `npm run benchmark`：SQLite 和队列读取性能参考检查                                             |
| `export-icons.cjs`            | `npm run icons`：从 UI 素材导出应用图标                                                        |
| `restore.ts`                  | 数据库恢复工具；使用时先阅读源码中的参数说明，正常使用优先采用界面的备份导入                   |
| `archive-project.ps1`         | `npm run archive`：收录当前源码、UI 和当前发布程序，生成 README、清单、ZIP 和 SHA-256 校验文件 |

存档脚本使用明确的收录列表，不打包 `node_modules/`、`dist/`、`.build/`、旧发布包、`backups/`、其他存档或个人任务数据库。每次创建独立的时间戳目录，不覆盖已有存档。没有当前版本发布程序时，应先运行 `npm run package:dir`。

存档包含代码格式配置、贡献说明和 GitHub Actions 配置。`docs/verification.json` 为可选的本机历史汇总；从 GitHub 新获取的源码没有该文件时，存档将历史验证数字标为 `not recorded`（未记录）。已有报告的版本不符时仍拒绝存档，避免将旧结果用于新版本。
