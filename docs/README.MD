# 文档索引

## 开发与发布

- [许可说明](LICENSING.md)：非商业用途授权范围、版权声明和第三方组件说明。

| 文件                                      | 内容                                    |
| ----------------------------------------- | --------------------------------------- |
| [CODEMAP.md](CODEMAP.md)                  | 模块职责和主执行链路                    |
| [PUBLISHING.md](PUBLISHING.md)            | 上传 GitHub、CI 与 Windows 程序发行步骤 |
| [CONTRIBUTING.md](../CONTRIBUTING.md)     | 开发环境、代码格式和提交验证            |
| [scripts/README.MD](../scripts/README.MD) | 构建、测试与存档命令                    |
| [ARCHIVE-README.MD](ARCHIVE-README.MD)    | 本机存档 README 模板                    |

## 设计与历史变更

| 文件                                               | 内容                         |
| -------------------------------------------------- | ---------------------------- |
| [RESUME-COMPATIBILITY.md](RESUME-COMPATIBILITY.md) | 0.3.3 旧暂停任务继续执行修复 |
| [PAUSE-SCHEDULING.md](PAUSE-SCHEDULING.md)         | 0.3.2 暂停与继续设计记录     |
| [NATIVE-BRIDGE-FIX.md](NATIVE-BRIDGE-FIX.md)       | 0.3.1 ArrayList 原生桥接修复 |
| [REFACTOR.md](REFACTOR.md)                         | 0.3 重构记录                 |
| [ui/README.md](../ui/README.md)                    | UI 资源与预览说明            |

测试脚本生成的 `docs/*.json`、`docs/screenshots/` 以及本机需求记录不提交到 GitHub。其中可能包含测试目录和运行环境信息。历史文档中提到的验证记录、旧发布目录与退役备份需在本机生成或查阅；公开仓库以源码和 CI 运行结果为准。
