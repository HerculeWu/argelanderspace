---
status: accepted
---

# 标注绑定当前内容，确定替换时整批归档

标注只保证所属 Doc 当前可寻址内容成立。内容指纹成功算出且不同，才将旧批次原字节归档；不逐条 salvage、自动 re-anchor 或跨 Doc 迁移。相比启发式挽救，这一取舍避免把用户意见悄悄绑定到错误位置；想保留旧标注就保留独立旧 Doc。

## Consequences

指纹相同、成功但不同、无法计算是三个不同状态，系统错误不代表内容替换。归档权威限 server annotations GET/PUT，CLI annot 真只读；Reader 共同接纳正文、标注和资产，并保护会话草稿。**新增局部边界（PDF 规格决策，2026-09-22）**：本地 PDF 不是 LaTeX epoch；固定原件 SHA-256 成功且不同 → 409 并保持全部 PDF 用户 sidecar 原样，不归档、不清空、不重绑。坏/缺 PDF 元数据、原件或 sidecar 不得伪装成首次打开。**完整三态异常分支、PUT、删除和冻结输出以 [contracts](../contracts.md) 为唯一权威，不能用本段概括代替。**投影和恢复机制见 [annotations](../annotations.md)。

来源：Stage 8 终稿四修正与 Q1–Q20（2026-09-10–12），reader epoch D1–D9（2026-09-13/14）；`46093915:.pi/memory/contracts-and-decisions.md` §4。2026-09-21 迁移，原数据保护权限未变。
