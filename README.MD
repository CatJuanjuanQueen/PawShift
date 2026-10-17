# PawShift

Windows 桌面任务队列，让本机 Codex 按顺序处理项目任务。

关联项目、创建任务，点击「执行任务」，由本机 Codex AGENT 读取或修改项目文件。当前任务完成后，自动继续满足依赖、时间和额度条件的下一项。

当前版本：**0.3.3** · Windows x64 · 非商业用途许可

![PawShift 浅色界面设计预览](ui/previews/redesign-queue-light.png)

## 功能

- 管理多个本地项目，按队列顺序或优先级执行任务。
- 配置任务依赖、计划时间、文件验收路径和必须包含的内容。
- 在桌面窗口中处理本次权限请求，查看 AGENT 输出、工具进展和验收结果。
- 暂停调度、核对停止状态，并沿用原会话继续任务。
- 使用本地 SQLite 保存任务，支持备份导入、诊断导出和主题设置。

## 环境要求

- Windows x64、.NET Framework 4.6.2+、Evergreen WebView2 Runtime。
- 本机 Codex 执行组件、ChatGPT 登录和 Windows 执行沙箱。
- 从源码构建另需 Node.js 24+ 和 npm。打包程序包含 Node.js 运行时。

程序会自动寻找已安装的 VS Code Codex 扩展中的原生 `codex.exe`，也可在设置中手动选择，或通过 `PAWSHIFT_CODEX_PATH` 指定。首次使用时，在「设置」中检查连接、登录并初始化沙箱。

## 安装与使用

如果仓库的 Releases 已提供 `PawShift-0.3.3-WebView2-x64.zip`，下载并完整解压，运行其中的 `PawShift.exe`。保留解压目录中的所有运行文件；升级前先退出旧版。

从源码启动：

```powershell
npm ci
npm run package:dir
npm start
```

构建后也可使用根目录的 `启动PawShift.cmd`。GitHub 的 Source code ZIP 需要先构建。

1. 在「项目管理」中关联本地项目。
2. 新建任务，填写目标及需要的验收条件，确认任务权限后保存并入队。
3. 点击「执行任务」。项目尚未授权时，先确认本次项目授权。
4. 在任务详情中查看输出、工具进展与文件验收结果；额外权限可选择「允许本次」或「拒绝本次」。
5. 当前任务成功后，队列自动开始满足条件的下一项。

每次打开软件后，需点击执行才会开启调度。任务数据位于 `%APPDATA%\PawShift`，兼容已有数据库。

## 暂停、权限与验收

暂停调度会停止后续派发并请求中断当前 AGENT。收到轮次结束和工具停止确认后，才显示已暂停；点击「继续执行」会优先恢复该任务，沿用原会话开启新轮次。已有文件修改会保留。中断尚未确认或异常退出时，执行锁继续保留，可使用「核对暂停状态」或「恢复检查」。单独暂停的其他任务不会批量恢复。

只读任务使用只读沙箱。项目内修改使用整个项目的写入沙箱，允许路径需为 `.`；细分目录配置不能替代系统沙箱。额外授权仅用于对应活动轮次的一次操作。

AGENT 正常结束后，PawShift 核对配置的文件路径、内容和文件哈希。文件检查失败时，任务标为失败，后继依赖保持等待。文字完成条件会发送给 AGENT，需结合输出审阅；没有文件检查时，「已完成」表示 AGENT 正常结束任务轮次。

## 开发与验证

```powershell
npm ci
npm run format:check
npm test
npm run package:dir
npm run verify:release
```

| 命令                     | 用途                                                     |
| ------------------------ | -------------------------------------------------------- |
| `npm run build`          | 清理输出，编译后端并复制 UI                              |
| `npm run format`         | 统一源码与文档格式                                       |
| `npm run format:check`   | 检查格式，不修改文件                                     |
| `npm test`               | 调度、数据库、执行链路、UI 和原生参数测试，不请求模型    |
| `npm run test:desktop`   | 打包并测试实际 WebView2 窗口，需要可交互桌面，不请求模型 |
| `npm run test:agent`     | 在隔离目录运行真实 AGENT 文件任务，会使用账户用量        |
| `npm run test:pause`     | 真实桌面暂停与继续验证，会使用账户用量                   |
| `npm run test:resume`    | 旧暂停数据的会话恢复验证，会使用账户用量                 |
| `npm run package:dir`    | 生成当前版本 Windows 程序与 ZIP                          |
| `npm run verify:release` | 比较当前构建与发布目录中的文件                           |
| `npm run probe`          | 构建后检查本机 AGENT、账户、额度与沙箱，不请求模型       |
| `npm run icons`          | 从 UI 矢量素材导出应用图标                               |
| `npm run archive`        | 创建本机源码与程序存档，附文件清单及 SHA-256 校验        |

发布输出为 `release-webview2/PawShift-0.3.3/` 和 `release-webview2/PawShift-0.3.3-WebView2-x64.zip`。推送到 GitHub 后，CI 自动执行格式检查、普通测试、打包和发布一致性校验。

## 项目结构

```text
.github/workflows/    GitHub Actions 自动检查
src/agent/            Codex 发现、通信与协议类型
src/application/      桌面命令和执行控制器
src/domain/           任务、项目与执行模型
src/tasks/            调度、依赖、停止、恢复和文件验收
src/storage/          SQLite 事务与持久化
src/legacy/           旧手动任务恢复兼容
src/webview-backend.ts 原生窗口与后端通信入口
native/               WebView2 窗口、托盘和本地对话框
ui/                   界面源码、主题、图标和设计预览
scripts/              构建、启动、测试和存档工具
test/                 自动化测试
docs/                 架构、维护和发布说明
```

源码与构建产物分开管理；依赖、发布目录、备份、个人数据和本机验证报告不提交到仓库。旧版恢复模块仍被兼容路径引用。

## 文档与许可

PawShift 采用 **PolyForm Noncommercial 1.0.0** 许可证。允许在许可证规定的非商业用途范围内使用、修改和分发；商业用途需要另行取得权利人的授权。完整条款以 [LICENSE](LICENSE) 为准，分发时请保留 [NOTICE](NOTICE)。第三方组件继续适用各自的许可证。

PawShift is source-available under the **PolyForm Noncommercial License 1.0.0**. Use, modification, and distribution are permitted for purposes allowed by the license. Commercial use requires separate permission from the rights holders. See [LICENSE](LICENSE) and retain [NOTICE](NOTICE) when redistributing.

- [代码导航](docs/CODEMAP.md)
- [文档索引](docs/README.MD)
- [脚本说明](scripts/README.MD)
- [参与开发](CONTRIBUTING.md)
- [GitHub 发布步骤](docs/PUBLISHING.md)
- [许可说明](docs/LICENSING.md)
- [PolyForm Noncommercial 许可证](LICENSE)

PawShift 是独立项目，非 OpenAI 官方产品。AGENT 能力和执行结果以本机 Codex 组件返回的协议事件及终态为准。
