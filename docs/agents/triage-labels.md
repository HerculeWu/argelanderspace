# Local triage vocabulary

本项目使用本地 Markdown，不创建 GitHub 标签。Matt 五种 canonical triage 角色映射如下：

| Matt 角色 | 本地 `Status:` | 含义 |
|---|---|---|
| `needs-triage` | `needs-triage` | 待评估、验证或明确范围 |
| `needs-info` | `needs-info` | 等待报告者补充信息 |
| `ready-for-agent` | `ready-for-agent` | 已批准且足够明确，可交给 agent 实施 |
| `ready-for-human` | `ready-for-human` | 已明确，但需要人工实施 |
| `wontfix` | `wontfix` | 明确不做，不等于推后或已完成 |

## 本仓库扩展：deferred

`Status: deferred` 表示用户已经决定暂不做。不是 `needs-info`、`ready-for-human` 或 `wontfix` 的别名。

- 保留推后理由、适用范围、决策来源、重新讨论条件。
- 不进入可执行 frontier；不能因为缺少默认五态标签而自动改成 `needs-triage`。
- 只有用户明确重开后才重新评估范围和状态；不能直接从推后推断已批准实施。
- 重新讨论不等于此前约束全部作废，局部修订须标出覆盖范围。

这些是分诊/就绪状态，不承担完整生命周期。普通实施票据另用 `Progress: not-started | in-progress | blocked | completed`；标记完成必须有对应验收证据，不能把 `wontfix` 当完成。`Progress: blocked` 可表示执行期障碍，静态依赖仍用 `Blocked by:`。

Wayfinder 的 decision-ticket 使用原技能约定的 `claimed` / `resolved` 生命周期，必须声明 `Type:`，不与普通实施票据的 readiness 混用。它产生决定，不自动产生产品交付。
