# Stage 6 定稿计划：阅读器四项修复（2026-09-09 grilling 三轮 Q1–Q13 拍板，用户确认开工）

> **恢复指南**：本文件自足。前置读 `product-and-architecture.md`、`pitfalls.md`。起点 = Stage 5 关闭后的 main。

## 状态

**2026-09-09：Stage 6 关闭——MS1–MS4 全部 landed + smoke R1 修复 + 用户验收通过，已 push origin main。** commit 序列（main）：定稿 memory `82c19f9` → MS1 `b518f56`（宽度+多引用）→ MS2 `b39ec86`（图尺寸+落地校正）→ MS3 `9480c6f`（作者块+迁移）→ scrollend 中间态 `5762e2f` → MS4 `0fda682`（停稳检测+手册）→ smoke R1 `69d4eda`（revtex 宏汤+\ensuremath）→ 收尾 memory（本次）。迁移备份 tarball 已删（用户验收后）。

**2026-09-09：设计 grilling 完成（三轮 Q1–Q13 全锁定，用户确认"确认"），MS1 开工。** commit/执行进度随 milestone 追加在本节。

**2026-09-09：MS1（①宽度+②多引用）landed。** 定稿 memory `82c19f9` + 代码 `b518f56`：`.reader-inner` 760px→100ch（border-box，文本列 ≈91ch）；cite 组拆 per-ref chip（raw 按 `; ` 拆分保真、wrapper/分隔符纯文本、per-ref focus/tooltip/灰化、病态 raw 回退旧单 chip 语义）。对抗审查 APPROVE（0 阻断；补 5 断言：raw+unresolved 拆分灰化/回退组灰化/键盘/prefix-suffix/方括号；roadmap Q5 措辞校正"short→可见片段"）。测试 web 105→115，四门全绿。

**2026-09-09：MS2（③定位）landed。** contracts figure 块加 optional `imgWidth/imgHeight`；core `texFigureAssetSize`（SVG 绝对单位换算 + viewBox 防御兜底 + PNG IHDR，best-effort undefined）+ ir.ts 物化后提取；golden 两颗 .json 重冻（仅 +50/+52 两字段，.md 逐字节不变=agent 冻结实证）；web FigureImage attrs + Block 传参 + store 落地校正（900/400ms、≤2、取消面含 undo）。对抗审查 APPROVE（0 阻断，8 非阻断：N1 措辞/N2 `\bwidth`咬`stroke-width`/N3 PNG 松校验/N6 undo 无测 已修——undo 取消前移顺带修出"early return 跳过取消"真 bug；N5 jpg/gif/webp 直通图无尺寸→推后 Stage 7；N7 滚动条拖拽/超长平滑滚动途中校正窗口已知盲区立此存照；N8 决策措辞已修订）。审查 Chrome 探针实证：attrs 预留不改变最终渲染、不加载时预留生效、viewBox-only 情形生产不可达。测试 core 138→151、web 105→123，四门全绿零警告。

**2026-09-09：MS3（④作者块 + 存量迁移）landed。** contracts meta 加 optional `authorDetails[{name, affiliations?: 1-based int[], email?}]`/`affiliations[]`/`email`（文档级）；core `extractAuthorBlock` 三族机械还原：aa.cls 位置系（\inst↔\institute、≥2 标记才逗号切分、机构内嵌 \email 剥出文档级）、AASTeX/revtex 顺序系（\affiliation/\affil/\altaffiliation 挂最近组、\email/顶层 \thanks 挂最近作者、\thanks 明显邮箱）、**手写数学上标族**（`$^{1,2,\star}$` 入名、`$^{N}$` 领头的 \affil 按 `\\` 切分、出现序=印刷号解析）；降级 = 平铺；签名表补 `inst/altaffiliation`；逗号切分带"逗号后修饰吸收"（sup-marker/\thanks/\email 归前位，\inst/\orcidlink 不吸收）+ Jr./Sr. 后缀归并（审查 N2 加固）。`\\` 截断手写块机构尾巴。**副作用（立此存照）：`meta.authors` 净化——`\inst` 参数不再泄入姓名、sup-marker 不再粘名（零消费字段，agent 不可见，golden 已重冻）**。web `AuthorBlock`（阅读列顶部折叠作者块）+ Reader 接线 + CSS。**迁移**：备份 `literatures.stage6-backup.tar.gz`（225MB）→ 7 篇离线重摄入（两轮：初版后抽取强化再一轮）→ `library build --offline` parity：works 36→37（+1=smoke R2 期间落在 output/ 的 latex-battery 首次入种子，非 drift）、36 篇既有 works 元数据逐字节零漂移、零悬空 doc_ids、9 works 带 doc。**真实数据验收**：7/7 作者块正确（1610.08981 全量重构、2603.03522 平铺降级、2607.17040 四封 email 归属正确）。审查两轮 APPROVE（初版 0 阻断/N1–N10；增量复审 0 阻断/R2-N1 乱序跳号静默错配、R2-N2 单机构内 \\ 误切、N2 Jr. 已加固、N6 测试缺口大部分关闭→补 6 例）。golden 两颗 .json 重冻（仅 meta 增量，.md 逐字节不变）。测试 core 138→165、web 105→128，四门全绿零警告。

**2026-09-09：MS4（smoke 手册 + 落地校正机制更替 + memory 收尾）landed。** 手册 `docs/manual-test-stage6.md`（§0-6，关键预期全部真实 Chrome 预实测）。**③ 落地校正机制两轮更替**（真实 Chrome 取证驱动）：固定定时器（MS2 原版）→ scrollend（`5762e2f`，实证 instant 校正在平滑动画途中被吞没、定时器在 SVG 解码竞争下迟发 ~600ms）→ **停稳检测**（最终版：采样 scrollTop、动则 250ms 节拍 re-arm 不耗次数、停稳才校正；≤2 校正/≤8 re-arm；取消面不变）——MS4 审查抓出 BLOCKER 1（scrollend 取消面元素错配：监听挂 root、取消从 el 移除→泄漏监听把 undo 后的页面拽回目标，真实 Chrome 复现），停稳检测方案使该 bug 类随 scrollend 删除整体消失；复审 APPROVE（undo 途中无拽回、长跳 1.9s 收敛 off=0.27px、过渡跳转单次校正 off=0.05px）。探针实证 9/9×3 轮（①②③④全项）+ undo-during-jump 专项。手册修订三轮（§4d 1804.10121 第 4 作者 = Mantelet 非 Demleitner、§6 停稳检测措辞+re-arm 预算、§6 补尾标点去重）。.gitignore 补 backup tarball 规则（225MB tarball 误 add 后 amend 踢出）。测试 web 128→129（+re-arm 用例），四门全绿零警告。

**2026-09-09：smoke R1 修复（revtex 宏汤 + \ensuremath）landed，待用户复验。** 用户 smoke 发现 `arxiv-1609.05917`：eq-1 带 `\ensuremath` 残渣、citation 全是 `\@secondoftwo author` 宏汤。根因：该文把 bibtex .bbl 连同 `\providecommand` 头（`\bibinfo[0]{\@secondoftwo}` 等 catcode 技巧）贴进 inline thebibliography，宏展开层忠实展开把条目毁了。修法：① `macros.ts` expandPass 跳过 thebibliography 子树（其唯一消费者 = inline 回退读原文）；② `cleanBblText` 加 revtex 词汇（注释剥离/`\bibinfo·\bibfield` 第二参 fixpoint 解包/`\BibitemShut{X}` 连参丢弃/`\BibitemOpen` 等噪声/FORMAT 补 citenamefont·bibfnamefont·bibnamefont/`\href@noop` 兼容/孤立 `\` 行续）+ facts `extractDoi` 补 `\doibase`；③ web math katex `macros: {"\\ensuremath": "#1"}`（0.16.47 无此函数）。**关键取舍：parseOne/parseAuthors 的顺手"改进"（数字断尾/paren 切点/Jr 归并）把 golden 2012.05220 的 AASTeX author-year 打回退，已整体回退 documents/references.ts**——golden 两颗字节绿零重冻；尾部长尾伪作者与 golden ref-70 的 "Jr"/"104" 同级保留。重摄入 1609.05917/1610.08981（52/209 refs 零汤、ref-1 DOI 恢复）+ 2607.17040（新清洗严格改善其 88 refs）。真实 Chrome：eq-1 渲染正确、75 chips 全净。审查 APPROVE（0 阻断；非阻断：TEX_COMMENT_RE 对 url 内 % 编码的理论隐患=全库零发生立此存照；`\thebibliography` 宏形不在排除内=现库无此用法）。测试 core 165→168、web 129→131。

## 范围与硬约束

- 范围 = 原 known-issues「Stage 6 重点」4 项（①宽度自适应 ②多引用折行 ③右栏定位 ④作者块——④ 经 Q8 重定义，见下）；其余 known-issues 全部推后到 **Stage 7**（新编号）；标记功能（原 Stage 7 预告）顺延为 **Stage 8**。
- **硬约束（Q7）**：agent 侧输出字节冻结——CLI/skills 命令面、markdown token、`bib`/`ref` JSON、深链接逐字节不变；现存 golden .md 不重冻、继续当冻结守卫。④ 的元数据走 agent 不可见通道（meta 不进 renderIrMarkdown/bib/ref 输出，天然满足）。

## 锁定决策（Q1–Q13 合并）

1. **执行流程（Q2）**：沿用 Stage 4/5——每 MS 实现 → 四道门（`corepack pnpm -r build|test|typecheck` + 根 lint）→ subagent 独立对抗审查 → 双过自行 commit（不逐次问）；全部完成后用户 smoke（`docs/manual-test-stage6.md`），通过后 push。
2. **MS 切分（Q3）**：MS1 = ①+②（纯 web）；MS2 = ③（contracts+core+web）；MS3 = ④ + 存量迁移；MS4 = smoke 手册 + memory 收尾。
3. **① 宽度（Q4）**：`.reader-inner` max-width 760px → 流式 + 可读上限 ~90-100ch，居中留白；只动阅读器（LibraryView 主区本已流式、PlanView 固定宽维持现状）。
4. **② 多引用（Q5）**：多 key cite 组拆 **per-ref chip**——外层括号/方括号与分隔符（`; `）从 raw 保留为纯文本，chip label = 各 ref 的**可见片段**（raw 按 `; ` 拆分，打印形态逐字节不变；raw 缺失时回退 short 逐 ref 成 chip；raw 拆不成 ref 数的病态情形保持旧单 chip 语义）；chip 间自然折行、chip 内永不折断；每 chip 各点各的 ref、tooltip = 该 ref raw；同组件面（正文/caption/右栏展开 caption）一并生效。TOC float 预览用 stripMath 纯文本、无 chip，不涉及。
5. **③ 定位（Q9/Q10）**：根因 = 图异步加载无尺寸占位 + 侧栏 240ms 过渡 reflow（smooth scroll 对调用瞬间的布局算终点，途中目标被推偏）。修复 = float 块 IR 加 optional `imgWidth/imgHeight`（CSS px，摄入时从物化资产提取：SVG 根 width/height 单位换算、PNG IHDR；web `<img>` 带 width/height attrs + `height:auto` 标准响应式预留——**最终渲染尺寸不变**，Chrome 探针实证）+ jumpTo 落地后有界重校正（900ms 首查 + 400ms 复查，>4px 才 instant 校正，≤2 次封顶；wheel/touchstart/keydown/undo/新 jump 取消；rect 全零跳过=测试环境）。保持平滑滚动（Q9 选 A）。**左右栏本已共用 `store.jumpTo`**（`TocPanel.tsx:55` / `RefCard.tsx:71-79`），用户 Q10 的"模块不同"观察系误判（本人已认可可能看错），无需合并模块——修复后两边行为自然一致。**（MS2 落地修订：原定"宽高比字段 + aspect-ratio + 待 transitionend 重校正"，实现改为"绝对 px 字段 + attrs + 固定定时器"——attrs+height:auto 是标准响应式预留模式，固定定时器天然覆盖过渡场景，语义等价；viewBox 兜底在审查中证为生产不可达（pdftocairo 恒出绝对单位、pdflatex 不能吃 .svg 直通源），仅防御保留。）**
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
- **作者块已知边界（MS3 审查立此存照，Stage 7 候选）**：`\affil` 乱序/跳号时"出现序=印刷号"静默错配（被剥的 `$^{N}$` 编号含真值却丢弃，廉价改进路径=带 marker 条目用 N 当 index）；单一机构内含 `\\` 换行会被切成两条目；2603.03522 式粘在 `\author` `\\` 之后的机构行不解析（平铺降级）；`Name,\inst{1}` 逗号前置 \inst 风格不吸收（A&A 主导风格优先）；orphan `\affiliation` 占位；尾标点敏感去重；jpg/gif/webp 直通图无尺寸预留（MS2 N5）。
