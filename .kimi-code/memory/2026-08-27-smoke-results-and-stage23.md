# 手动冒烟结果 + Stage 2/3 方向（2026-08-27，用户反馈）

## 冒烟测试结果

- 总体认可，同意在 TS 新代码基础上继续迭代
- **上传 PDF 异步流程 OK**（202 + job + WS）
- ⚠️ **待修 bug 1：进度条不真实**（进度显示与实际不符）
- ⚠️ **待修 bug 2：PDF 实际未上传成功**（attach 失败）——在 ts-migration 新代码上修，不回 Python

## 后续路线（用户口述，备忘）

- **Stage 2**：把 agent 接上（pi-agent extension / MCP）
- **Stage 3**：把存储库接到和 agent 相同的位置；渲染管道的 SOT（source of truth）改成与 agent 共用一套

## 仓库信息

- GitHub repo: https://github.com/HerculeWu/argelanderspace
- LICENSE 版权人：Wenjie Wu
