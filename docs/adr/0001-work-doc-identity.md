---
status: accepted
---

# 将文献身份与具体正文分开

Work 表达书目身份，Doc 表达具体可读正文：允许无正文条目、一个 Work 多个 Doc，以及归并后多个 Work 关联同一 Doc。相比“文献就是一个文件”，这种分离让用户可以并存不同来源正文并显式选择主位；系统不替用户判断发表版本，也不把关联变更等同于删除正文。标注属于 Doc，独立稿件不是 Work 或 Doc。

## Consequences

上传目标必须焊死为用户选择的 Work，而不是重新按标题碰运气归并；主位和 cite key 各自遵守稳定规则。Doc 删除是全局物理生命周期，不是只从一个 Work 解绑。**局部边界（PDF 规格决策，2026-09-22）**：本地 PDF Doc 恰好属于用户选择的一个 Work；Library association 是唯一 owner 证明，跨 Work 相同 bytes 创建独立文件与 Doc，不共享对象。此规则只扩展新增 PDF，不迁移或收紧既有 LaTeX 多 Work 关联。完整行为见 [library](../library.md) 与 [contracts](../contracts.md)，本 ADR 不另写一版数据保护规则。

来源：Stage 3.1（2026-09-02）attach-only 身份决定，Stage 7 Q3（2026-09-10）多 Doc/主位，Stage 8（2026-09-10–12）per-doc 标注；现行记录在 `46093915:.pi/memory/contracts-and-decisions.md` §2/§4。2026-09-21 迁移成 ADR，不改变原决定时间或授权。
