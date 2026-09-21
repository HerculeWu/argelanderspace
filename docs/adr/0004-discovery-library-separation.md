---
status: accepted
---

# 临时探索不拥有文献库状态

Library Graph 只显示已存 Work，Discovery 从一篇 seed 经 ADS similar/useful 返回临时候选；所有图边只有引用含义。旧全库候选池按被引量排序容易漂向高影响力通用文献，不能代替当前论文的主题相关性，因此退役该推荐机制，不自研相似度排名或自动多跳。

## Consequences

Discovery 不写 Library、不进长 job 或拥有服务端 session；provider 检索缓存不等于持久收藏。候选入库只走既有 bibcode mutation，成功后就地更新，不重置探索。无 ADS 明确失败，不回退旧推荐。Library 派生图缓存可锁内版本化自愈，与 Discovery 无用户状态副作用并不冲突。完整契约见 [discovery](../discovery.md)，arXiv 自动获取由入库路径继承，见 [library](../library.md)。

来源：Stage 14 D1–D15 与用户最终补充（2026-09-17），`46093915:.pi/memory-reference/stage14-discovery-plan.md`；Stage 15 入库后自动获取是后续局部增量，不把 Discovery GET 变成写路径。2026-09-21 迁移。
