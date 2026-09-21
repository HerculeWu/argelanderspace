---
status: accepted
---

# 使用编译事实与源码融合的共享 IR

LaTeX 编译事实和源码 AST 融合成 IR，IR 直接存储并供展示与 agent 接口使用；编号求编译真值，编译失败不做无编译全文降级。Writer 通过显式 profile 复用同一主干而不复制另一条转换管线：这是用户优先复用现有模块的意图，不是外部转换器受阻后的妥协。

## Considered Options

旧 pandoc/Document 桥与自产 display 号已退役；图片方案由真实字形/位图 smoke 证伪 dvisvgm 后改为 pdftocairo+gs。Writer 不采用 TeX4ht 默认运行链，也不恢复独立正则正文 renderer。UI 的流式布局不追求 PDF 分页/字体复刻。

## Consequences

共享编译、facts/source/fuse/IR 与展示，不共享 Work 身份归并、library rebuild 或 Doc/annotation 生命周期副作用。Reader 默认输出和 CLI 冻结继续有效。实现细节与受测边界见 [tex-pipeline](../tex-pipeline.md)、[writer](../writer.md)；显式 Render 是工作流规则，不由共享管线暗中恢复自动编译。

来源：Stage 5 Q2/Q4 与图转换 smoke（2026-09-04–09），Writer D13（2026-09-15，“这一直是我想要的”）；原文入口见 [history](../history.md)。迁移基线 `46093915` 的旧 contracts-and-decisions、tex-pipeline、writer 为当前结论来源；2026-09-21 迁移，不重新开放旧方案。
