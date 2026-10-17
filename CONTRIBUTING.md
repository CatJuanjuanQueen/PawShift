# 参与开发

PawShift 使用 TypeScript 后端、原生 JavaScript UI 和 C# WebView2 宿主。开发环境为 Windows x64、Node.js 24+、.NET Framework 4.6.2+ 及 Evergreen WebView2 Runtime。

```powershell
npm ci
npm test
npm run package:dir
npm start
```

提交前运行：

```powershell
npm run format
npm run format:check
npm test
```

格式化覆盖 TypeScript、JavaScript、CSS、HTML、JSON、Markdown 和 YAML。C# 与 PowerShell 遵循 `.editorconfig`，按现有结构维护。

修改窗口或原生桥接后，还应运行 `npm run test:desktop`。该检查需要可交互的 Windows 桌面。真实 AGENT 测试需要本机 Codex 和登录，会使用账户用量，请参考 [脚本说明](scripts/README.MD)。CI 运行普通测试、原生参数测试和打包校验。

请在 Pull Request 中说明问题、修改后的行为和实际执行的验证。新增行为使用合适的回归测试；纯文档或格式调整无需新增测试。模块职责见 [代码导航](docs/CODEMAP.md)。

本机数据库、凭据、诊断报告和测试截图不提交到仓库。报告问题时，请先去除账户信息、项目路径、任务内容与密钥。
