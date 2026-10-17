# 发布到 GitHub

## 上传源码

仓库包含源码、测试、UI 资源、构建脚本和公开文档。依赖、编译产物、历史备份、本机验证报告和数据文件由 `.gitignore` 排除，本机原文件仍保留。

首次发布前运行：

```powershell
npm ci
npm run format:check
npm test
npm run package:dir
npm run verify:release
```

在 GitHub 创建空仓库，不自动添加 README 或许可证。在项目根目录执行下列命令，将 `YOUR_NAME` 和 `YOUR_REPOSITORY` 替换为实际值：

```powershell
git init -b main
git add .
git diff --cached --stat
git commit -m "Prepare PawShift 0.3.3 for GitHub"
git remote add origin https://github.com/YOUR_NAME/YOUR_REPOSITORY.git
git push -u origin main
```

提交前检查暂存列表，确认没有额外加入本机数据。项目采用 PolyForm Noncommercial 1.0.0，根目录的 `LICENSE` 与 `NOTICE` 需一起提交；不要在 GitHub 另加 MIT 许可证。许可范围见 [许可说明](LICENSING.md)。GitHub Actions 在推送和 Pull Request 时进行 Windows 构建、测试与发布文件一致性检查，成功后保留 ZIP artifact。

## 发布 Windows 程序

1. 运行 `npm run package:dir` 和 `npm run verify:release`。
2. 在 GitHub Releases 创建与 `package.json` 一致的版本标签，例如 `v0.3.3`。
3. 上传 `release-webview2/PawShift-0.3.3-WebView2-x64.zip`，或使用对应提交的 CI artifact 内的 ZIP。
4. 在发行说明中写明 Windows x64、.NET Framework 和 WebView2 Runtime 要求，以及该版本的变更。

程序包含完整运行目录，用户解压后运行 `PawShift.exe`。GitHub 自动生成的 Source code ZIP 包含源码，需要按 README 构建后使用。

不要把 `node_modules/`、本机 `archives/` 或整个 `release-webview2/` 作为 Git 提交。更新版本时，同时更新 `package.json`、`package-lock.json`、README 版本说明与根目录启动脚本中的版本路径。
