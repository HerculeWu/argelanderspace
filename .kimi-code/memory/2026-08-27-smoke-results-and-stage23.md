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

## Stage 3 候选（Stage 2 实施中发现的 webui 缺口，2026-08-27）

1. **CLI 写入不推 `library.changed`**：agent 经 CLI 改库后 webui 要手动 F5。修法：server 加文件监听（library.json mtime）广播，或 CLI 写入后回调 server 端点。
2. **webui "笔记" tab 是占位符**：`workToRef` 把 note 降成布尔，只显示"已有 1 条笔记"。修法：payload 带 note 全文 + 笔记 tab 渲染/编辑。
3. **`label --label <color>` 不渲染**：色点从 star 播种，不读 label 字段。修法：LibraryView 色点读 `label`。
4. 冒烟 bug（Stage 1 遗留）：上传进度条不真实；上传的 PDF 实际未 attach 成功。
