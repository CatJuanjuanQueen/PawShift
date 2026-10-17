# PawShift {{VERSION}} 存档

这是 {{VERSION}} 版本的本机快照，包含当前源码、独立 UI、可运行的 Windows 程序，以及本机存在时收录的历史验证记录。

- 存档时间：{{ARCHIVED_AT}}（北京时间）
- 存档名称：`{{ARCHIVE_NAME}}`
- 程序版本：`{{VERSION}}`

## 直接运行

1. 完整解压存档，保留文件夹结构。
2. 双击根目录 `启动PawShift.cmd`，或运行 `release-webview2/PawShift-{{VERSION}}/PawShift.exe`。
3. 若旧版仍在运行，先从托盘退出旧版，再打开本版。
4. 关联项目、创建并入队任务后，点击「执行任务」。暂停后点击「继续执行」；也可在指定暂停任务旁点击「继续此任务」。

程序面向 Windows x64，需要 .NET Framework 4.6.2+ 和系统 Evergreen WebView2 Runtime。发布目录已包含 Node.js 运行时，直接使用成品无需另外安装 Node.js。AGENT 执行需要本机 Codex 执行组件、ChatGPT 登录与执行沙箱；可在程序设置中检查和初始化。

不要只取出一个 EXE：`backend/`、`media/`、`runtime/` 和 WebView2 DLL 等运行文件必须一起保留。

## 目录说明

```text
README.MD                    本存档说明
启动PawShift.cmd              当前版本启动入口
src/                         应用、调度、AGENT、领域和存储代码
ui/                          独立 UI、样式、图标、吉祥物及设计资料
native/                      Windows WebView2 宿主与原生桥接
scripts/                     构建、启动、验证和存档工具
test/                        自动化与原生回归测试
docs/                        代码导航、使用说明、验证记录和历史参考
release-webview2/
  PawShift-{{VERSION}}/       当前版本完整可运行程序
package.json                 依赖与命令入口
package-lock.json            固定依赖版本
tsconfig.json                TypeScript 编译配置
LICENSE                      项目许可证
NOTICE                       项目版权声明
MANIFEST.json                文件清单、大小、SHA-256 和存档范围
SHA256SUMS.txt                除本文件外所有存档文件的 SHA-256
```

完整代码职责见 `docs/CODEMAP.md`，文档索引见 `docs/README.MD`，原项目使用说明保存在 `docs/PROJECT-README.MD`。上述路径均相对于生成后的存档根目录。

## 从源码构建

需要 Node.js 24+、npm 和 Windows 构建环境。

```powershell
npm ci
npm test
npm run package:dir
npm start
```

构建时会生成 `dist/` 和 `.build/`。首次打包需要从 NuGet 获取指定版本的 WebView2 SDK，构建工具使用系统 .NET Framework 编译器。UI 修改请编辑 `ui/` 中的源码，再构建；发布目录中的 `media/` 为生成副本。

## 验证与已知边界

本机历史验证汇总：自动化测试 {{UNIT_TESTS}} 项，原生检查 {{NATIVE_TESTS}} 项，桌面旧暂停任务恢复 {{DESKTOP_CHECKS}} 组。仅在本机存在对应版本的 `docs/verification.json` 时收录这些数字；`not recorded` 表示没有汇总报告，不能据此判断测试通过。从 GitHub 获取源码后可自行运行以下检查。历史记录不代表解压时自动重新运行。

```powershell
npm test                    # 普通回归；不请求模型
npm run verify:release      # 源码构建后，核对 dist 与发布文件
npm run test:desktop        # 实际桌面检查；不请求模型
npm run test:resume         # 真实 AGENT 旧暂停任务恢复；会使用账户用量
```

暂停会停止队列派发并请求中断当前轮次，确认工具停止后才显示已暂停。继续沿用原会话开启新轮次，核对已有工作后完成剩余目标；已经发生的文件修改不会回滚，也不是冻结进程后的逐条指令续接。文件验收会核对配置的路径和内容；任意业务目标仍需结合 AGENT 输出审阅。

## 数据与收录范围

PawShift 采用 PolyForm Noncommercial 1.0.0，仅授权许可证允许的用途；商业用途需另行取得权利人的授权。分发时保留根目录 `LICENSE` 与 `NOTICE`。第三方运行组件继续适用各自的许可证。

任务、项目授权和设置使用当前 Windows 用户的 `%APPDATA%\PawShift`。本存档没有打包个人任务数据库、登录凭据或 AGENT 会话；恢复这份代码不会同时恢复个人任务数据，需要的数据请另用程序的备份功能保存。

收录当前源码、UI、文档、测试与当前发布目录。排除依赖安装目录、编译中间目录、SDK 与测试缓存、旧发布版本、退役备份和其他存档。历史验证记录中的绝对路径是当时的证据，部分临时目录不会随存档收录；历史说明中的旧备份路径也不属于本快照。

## 校验与后续存档

`MANIFEST.json` 记录正文文件的路径、大小和 SHA-256；`SHA256SUMS.txt` 还包含清单本身的校验值。创建 ZIP 后，存档工具会逐文件读取压缩包并核对哈希。ZIP 外附有 `.sha256` 校验文件及 `.verification.json` 校验报告。

```powershell
Get-FileHash -Algorithm SHA256 .\{{ARCHIVE_NAME}}.zip
```

将结果与 ZIP 旁的 `.sha256` 文件比较。ZIP 解压后的目录保留原构建路径，便于直接运行和继续开发。以后需要创建新的干净快照时，在项目根目录运行 `npm run archive`。
