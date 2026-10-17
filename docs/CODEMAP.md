# 代码导航

当前版本：0.3.3。保留现有导入、构建及启动路径，按职责整理如下。

## 主执行链路

```text
ui/app.js（点击执行、继续此任务）
  → ui/bridge.js + native/webview-bridge.js（界面通信）
  → native/PawShift.cs（桌面窗口和原生转发）
  → src/webview-backend.ts（后台入口）
  → src/application/desktop-service.ts（命令与状态快照）
  → src/application/execution-controller.ts（授权、连接、启动与继续）
  → src/tasks/scheduler.ts（领取、派发、暂停、恢复与依赖）
  → src/agent/client.ts（AGENT 会话、轮次、事件和逐次授权）
```

## 代码职责

| 目录或文件                                | 职责                                                        |
| ----------------------------------------- | ----------------------------------------------------------- |
| `ui/`                                     | 独立界面、样式、图标、吉祥物和设计资料；UI 修改优先在此进行 |
| `native/PawShift.cs`                      | WebView2 宿主、窗口、托盘和本地对话框                       |
| `native/HostArguments.cs`                 | 原生 JSON 参数读取，兼容 ArrayList                          |
| `native/webview-bridge.js`                | 宿主注入的请求与事件桥接                                    |
| `src/webview-backend.ts`                  | 窗口与 Node 后台的通信入口                                  |
| `src/application/desktop-service.ts`      | 命令路由、项目和任务管理、设置、审批、备份与诊断            |
| `src/application/execution-controller.ts` | 点击执行的完整管道、启动撤销、旧暂停任务定位和指定任务继续  |
| `src/tasks/scheduler.ts`                  | 串行执行、依赖和时间条件、额度检查、停止确认与会话恢复      |
| `src/tasks/acceptance.ts`                 | 项目内文件路径和内容验收                                    |
| `src/agent/client.ts`                     | 本机 App Server 连接、会话恢复、轮次执行和权限回应          |
| `src/agent/discovery.ts`                  | 本机 Codex 可执行文件发现                                   |
| `src/agent/protocol.ts`                   | 当前使用的最小协议类型                                      |
| `src/domain/model.ts`                     | 领域模型、状态、任务校验和脱敏                              |
| `src/storage/repository.ts`               | SQLite、事务、执行锁、事件和持久化                          |
| `src/legacy/`                             | 旧手动交接及会话监测兼容；仍被恢复功能引用，不应直接删除    |
| `scripts/`                                | 构建、检查、图标导出及存档工具，详见该目录的 README         |
| `test/`                                   | 自动化回归测试及原生参数测试                                |
| `docs/`                                   | 操作说明、验证记录和历史变更，详见文档索引                  |

## 维护时的检查入口

| 修改范围                           | 主要检查                                     |
| ---------------------------------- | -------------------------------------------- |
| 调度、暂停、继续、数据库或 UI 行为 | `npm test`                                   |
| 桌面桥接或窗口行为                 | `npm run test:desktop`                       |
| AGENT 实际执行链路                 | `npm run test:agent` 或 `npm run test:pause` |
| 旧暂停任务继续                     | `npm run test:resume`                        |
| 发布文件与当前构建是否一致         | `npm run verify:release`                     |
| 创建干净的代码与程序快照           | `npm run archive`                            |

真实 AGENT 检查会使用账户用量；普通单元测试与存档不会发送模型任务。UI 源码与发布目录中的 `media/` 是源文件和构建副本的关系，直接修改发布副本会在下次构建时被覆盖。
