# 许可说明

PawShift 自有代码采用 [PolyForm Noncommercial License 1.0.0](../LICENSE)。标准标识为 `PolyForm-Noncommercial-1.0.0`，与 `package.json` 及锁文件中的项目许可字段保持一致。

## 允许的用途

许可证允许非商业目的下的使用、修改和分发，并列明个人学习、无预期商业应用的兴趣项目、研究与测试等用途。许可证还对非商业组织的允许用途作出专门规定，具体范围请阅读完整条款。

商业用途不在本许可证的授权范围内，需要另行取得权利人的授权。这是源码可用许可（source-available），不应将项目标为采用 MIT 或其他允许商业用途的开源许可证。

## 分发时保留的文件

- `LICENSE`：未经改写的 PolyForm 官方许可证全文。
- `NOTICE`：项目版权声明，使用许可证规定的 `Required Notice:` 格式。
- 第三方组件的许可证和声明：第三方组件不因 PawShift 更换许可而改变授权条件。

Windows 发布程序包含的 Node.js 和 Microsoft WebView2 继续使用各自的许可证；发布目录中的 `runtime/LICENSE.txt`、`WebView2-LICENSE.txt` 与 `WebView2-NOTICE.txt` 是第三方声明。

打包时，若 Node.js 安装目录缺少许可证文件，脚本会从 Node.js 官方仓库下载与实际运行时版本一致的完整声明，并缓存在 `.build/node-licenses/`。此时首次打包需要网络连接；下载失败会中止打包。

## 维护与发布

更换或更新许可时，同步核对根目录 `LICENSE`、`NOTICE`、`package.json`、`package-lock.json`、README，以及源码包和 Windows 发布包。运行 `npm run package:dir` 重新打包，再运行 `npm run verify:release` 检查项目许可文件是否完整复制。

旧备份和历史存档不是本次重新生成的发布包。发布当前版本时，使用最新生成的源码 ZIP 和 Windows ZIP。

官方文本：[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)。许可证标识：[SPDX](https://spdx.org/licenses/PolyForm-Noncommercial-1.0.0.html)。
