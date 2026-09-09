# Stage 6 定稿计划：阅读器四项修复（2026-09-09 grilling 三轮 Q1–Q13 拍板，用户确认开工）

> **恢复指南**：本文件自足。前置读 `product-and-architecture.md`、`pitfalls.md`。起点 = Stage 5 关闭后的 main。

## 状态

**2026-09-09：设计 grilling 完成（三轮 Q1–Q13 全锁定，用户确认"确认"），MS1 开工。** commit/执行进度随 milestone 追加在本节。

## 范围与硬约束

- 范围 = 原 known-issues「Stage 6 重点」4 项（①宽度自适应 ②多引用折行 ③右栏定位 ④作者块——④ 经 Q8 重定义，见下）；其余 known-issues 全部推后到 **Stage 7**（新编号）；标记功能（原 Stage 7 预告）顺延为 **Stage 8**。
- **硬约束（Q7）**：agent 侧输出字节冻结——CLI/skills 命令面、markdown token、`bib`/`ref` JSON、深链接逐字节不变；现存 golden .md 不重冻、继续当冻结守卫。④ 的元数据走 agent 不可见通道（meta 不进 renderIrMarkdown/bib/ref 输出，天然满足）。

## 锁定决策（Q1–Q13 合并）

1. **执行流程（Q2）**：沿用 Stage 4/5——每 MS 实现 → 四道门（`corepack pnpm -r build|test|typecheck` + 根 lint）→ subagent 独立对抗审查 → 双过自行 commit（不逐次问）；全部完成后用户 smoke（`docs/manual-test-stage6.md`），通过后 push。
2. **MS 切分（Q3）**：MS1 = ①+②（纯 web）；MS2 = ③（contracts+core+web）；MS3 = ④ + 存量迁移；MS4 = smoke 手册 + memory 收尾。
3. **① 宽度（Q4）**：`.reader-inner` max-width 760px → 流式 + 可读上限 ~90-100ch，居中留白；只动阅读器（LibraryView 主区本已流式、PlanView 固定宽维持现状）。
4. **② 多引用（Q5）**：多 key cite 组拆 **per-ref chip**——外层括号/方括号与分隔符（`; `）从 raw 保留为纯文本，chip label = 各 ref 的**可见片段**（raw 按 `; ` 拆分，打印形态逐字节不变；raw 缺失时回退 short 逐 ref 成 chip；raw 拆不成 ref 数的病态情形保持旧单 chip 语义）；chip 间自然折行、chip 内永不折断；每 chip 各点各的 ref、tooltip = 该 ref raw；同组件面（正文/caption/右栏展开 caption）一并生效。TOC float 预览用 stripMath 纯文本、无 chip，不涉及。
5. **③ 定位（Q9/Q10）**：根因 = 图异步加载无尺寸占位 + 侧栏 240ms 过渡 reflow（smooth scroll 对调用瞬间的布局算终点，途中目标被推偏）。修复 = float 块 IR 加 optional 宽高比（摄入时从 SVG viewBox 提取；`FigureImage` 用 aspect-ratio 预留位置）+ jumpTo 落地后有界重校正（≤2 次；侧栏过渡期间的跳转待 transitionend 重校正）。保持平滑滚动（Q9 选 A）。**左右栏本已共用 `store.jumpTo`**（`TocPanel.tsx:55` / `RefCard.tsx:71-79`），用户 Q10 的"模块不同"观察系误判（本人已认可可能看错），无需合并模块——修复后两边行为自然一致。
6. **④ 作者块（Q8/Q11/Q12）**：对象 = **当前文献自己的作者块**（authors + affiliation + email，arXiv HTML 式）；参考文献条目的 title/authors 填充系 memory 误读，**用户确认砍掉**。数据 100% 来自 LaTeX 源（现 meta 抽取刻意丢弃 affiliation/email，`ir.ts:286-352`）——AASTeX/revtex（`\affiliation`/`\email` 顺序关联）、aa.cls（`\institute`+`\inst` 标记）机械还原作者↔机构上标关联；email 取 `\email` + `\thanks` 里的明显邮箱；未知类降级平铺。contracts meta 加 optional 字段（agent 不可见）。显示 = 阅读列顶部（topbar 之下、Abstract 之前，随内容滚动）：默认折叠为第一作者 + "et al. (N authors)"，点击展开完整列表 + 上标关联机构 + email；无作者数据不渲染。边界：ORCID 图标/corresponding 标记/`\thanks` 脚注文本不做精细还原。
7. **存量迁移（Q13）**：备份 tarball → 7 篇可编译文档离线重摄入（一次带上 ③ 图尺寸 + ④ 作者块）→ `library build --offline` parity 校验（works 数、note/label/star/read/tags 逐字节、零悬空 doc_ids）。latex-battery 无 src 不参与。golden JSON 因 meta/图尺寸增字段重冻 + 人工抽查（普通回归流程）。
8. **"搜索联动"（Q10）**：用户澄清 = 就是 ③ 本身（右栏跳转错位），无额外事项。

## 取证存档（2026-09-09 两路 explore 子代理 + 主 agent 补查，直接采信）

### A. 阅读器 UI 三问题（agent-0）

- 布局：DocPane 三栏 `.reader-main` flex（styles.css:92）；侧栏固定 `--left-w: 290px`/`--right-w: 380px`、收起 34px rail（:7-9,:103-105）带 **240ms 宽度过渡**（:100）；中列 `.reader-col { flex: 1 1 auto }` 本已流式（:156-163）。**钉死正文的唯一规则 = `.reader-inner { max-width: 760px }`（styles.css:170-178）**。
- LibraryView 主区流式（argelander.css:307）；PlanView 固定 max-width（列表 860 :500 / 时间线 920 :563 / 聚焦 720 :548）——Q4 决定不动。
- 多 key cite = **一个 segment 含 N refs**（doc-ir.ts:78-84；walk.ts:1262-1306 `citeSegment`），渲染为**一个不可分割的** `<span class="chip cite-chip">`（label=整串 raw，segments.tsx:105-144）；`.chip { white-space: nowrap }`（styles.css:244）→ 长串无法折行。chip 共享面：正文（Block.tsx:48）/caption（:77,91,128）/右栏展开 caption（RefCard.tsx:151）。整组点击只 focus 第一个 resolved ref（segments.tsx:120；segments.test.tsx:110-123 有断言）。
- jumpTo（store.tsx:157-180）：querySelector `[data-block-id]` → `scrollIntoView({block:"start",behavior:"smooth"})` + flash；无手动 offset，顶部留白靠 scroll-margin（`.block` 16px :186 / `.sec` 20px :179-181）；topbar 非 sticky 不参与。reading band（store.tsx:19,116-127）只决定右栏卡内容、不参与跳转。不精确三来源：① `<img loading="lazy">` 无 width/height（FigureImage.tsx:132-140）滚动途中加载推偏目标；② 侧栏过渡 reflow；③ 无 scroll 结束重校正（deeplink.ts:44 的 850ms 定时器是间接承认）。现有 deeplink 测试只断言"滚到哪个元素"、不断言落点像素（happy-dom 无布局）。
- ①↔③ 耦合：宽度改流式后侧栏过渡/分屏拖拽引发 reflow，会放大 ③ 漂移——③ 排 ① 后。

### B. 参考文献/元数据层（agent-1）

- Reference schema 早有 authors/year/title/venue/volume/pages 字段位（doc-ir.ts:30-47）但从未被填；.bbl facts 刻意不猜（bbl.ts:8-11 "unknown beats guessed-wrong"），下游 fuse/references.ts:149-165 跑 parseOne 启发式（title 仅引号形、从不产 venue/pages）。
- **存量 .bib 家底**：8 篇存 IR 文档只 3 篇 src/ 带 .bib（2012.05220 / 2603.03522 / 2607.17040）；doi 覆盖参差（2501.17225 0/76）。→ Q8 后此路整体砍掉（参考文献填充非用户诉求）。
- graph `offlineEdges` 消费 reference 的 doi/arxiv/title（graph.ts:101-109）——若补 title 会新增匹配边；随砍掉而失效。
- **meta 抽取刻意丢 affiliation/email**：`ir.ts:286-352` 清洗 `\author` 时剥 `\affiliation`/`\affil`/`\email` 命令并截尾；meta.authors = 干净姓名。agent `read` markdown 从 `# Abstract` 直接开始、通篇无标题/作者块（golden .md 实证）→ 作者块对 agent 输出零影响，Q7 冻结天然成立。
- 阅读器 topbar 只有 title + "N pp · M refs · K figs"（DocPane.tsx:98-120），无作者行。
- cite token 三段式 `[cite: ref-N | short | title: …]`（title 有才出现，render.ts:173-180）本在契约内——随参考文献填充砍掉，此冻结风险消失。

## 推后事项（本阶段勿做）

- 参考文献条目元数据填充（.bib 解析/ADS 富化）——Q8 用户确认非其诉求；若未来想要，单独立项。
- **Stage 7（新编号）** = 其余 known-issues（tikz/re-upload 推广/CLI 未识别源建条目/task.due 语义/TOC 预览 `[cite:…]`/hyperlink-only xref 卡）；**Stage 8** = 标记功能。Stage 4.1 仍推后。
- PlanView 固定宽维持（Q4 只动阅读器）。
