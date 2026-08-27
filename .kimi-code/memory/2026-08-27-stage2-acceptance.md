# Stage 2 验收结论（2026-08-27，用户手动验收通过，标记完成）

## 验收结果（pi + skills 三件套，`docs/manual-test-stage2.md` 五组）

1. **摄入** ✅ —— agent 核对 arXiv id、跑 `library build`、带建议稿问 note，全部符合预期
2. **查询** ✅（一处瑕疵）—— 有引用、有深链接；但**空 note 问题未被主动提出**
3. **阅读** ✅ —— 正确使用 `show` 取原文
4. **维护** △ —— 加星 ✅；**已读标识在看板上找不到**
5. **失败探针** ✅ —— 假 id `9999.99999` 得到"未找到"回复，无编造

## 遗留问题（后续一并处理）

1. **空 note 不主动提出**（查询技能）：`argelander-query-paper-library` 的 SKILL.md 已写明空 note 要主动指出，但 pi 实际没做。候选修法：skills 里把该检查写成 numbered step 而非旁注；或 `search` 输出加一行 `hint: N/34 works have empty notes`（机器层提示，比 prompt 层可靠）。
2. **已读标识在 webui 找不到**：`label --read true` 已持久化（library.json/API 有），但看板列表上没有可见的已读/未读标识。归入 Stage 3 webui 缺口清单（同 note tab 占位符、label 色点不渲染、CLI 写入不推 library.changed）。
3. **pi 多次尝试读取代码库**：agent 倾向于自己读源码而不是走 CLI（skills 已要求"一切经 CLI"）。候选修法：skills 开头加硬性强硬条款（"不要读仓库源码回答文献问题——一律用 CLI；读源码 = 走错路"）；并**补独立环境的测试**（在非 repo 目录 + 绝对路径 CLI/data-dir 下跑验收，复现真实使用拓扑）。

## 环境备忘（pi）

- `pi --no-context-files`（`-nc`）：不读 AGENTS.md/CLAUDE.md——验收和日常使用建议带上，否则 pi 会被本 repo 的 memory 协议带跑
- skills 安装：`ln -sfn $PWD/skills/argelander-* ~/.pi/agent/skills/`（三个 symlink）
- 非默认端口时 `export ARGELANDERSPACE_PORT=<端口>`，否则 CLI 打的深链接端口不对

## 状态

Stage 2 完成（设计 11 决策 + MS1/MS2/MS3 全部落地，334 测试绿）。代码 commit 均在 main 本地，**尚未 push**（等用户发话）。
