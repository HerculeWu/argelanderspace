# Stage 7 定稿计划：known-issues 清账（2026-09-09 grilling 三轮 Q1–Q10 拍板，待用户最终确认开工）

> **恢复指南**：本文件自足。前置读 `product-and-architecture.md`、`pitfalls.md`、`2026-09-09-stage6-roadmap.md`。起点 = Stage 6 关闭后的 main（`69d4eda` + 收尾 memory）。

## 状态

**2026-09-10：MS2（作者块 G）+ MS2b（重摄入迁移）landed。** 代码 `437299e`：六项修复（revtex 分组**懒重置**——实害验证发现字面"挂接后即重置"会回归 2607.17040 连续 `\affiliation`，改为 affiliation 挂接置位、下一 `\author` 到达才关组；`\email[show]` 签名 `"o m"`；前置 `\email` 缓存入队 + `\correspondingauthor` 严格匹配（精确相等或 token 包含且唯一命中，否则落 meta.email）+ `correspondingauthor` 签名 `"m m"→"m"` 修幻影第二参；`\and \\` 剥前导 `\\`/whitespace 节点；`\author` 块 `\\` 尾机构行当伪 `\affil` piece；`\affil` printedToIndex 印刷号映射 + 无号 piece 最小未占用号推断）。对抗审查 1 BLOCKER（B1 教科书 article-class `\and` chunk 级错挂——tail piece 改挂本 chunk entries）+ N1–N6 顺手修（piece 尾 sup-marker/严格匹配/多前置 email/混合号推断/尾部 email 行/非数字 marker 跳组挂接），N7–N9 记录不修。测试 core 168→197，四门全绿，**golden 零 diff 未重冻**（agent 冻结守住）。MS2b 迁移（详见 `2026-09-10-stage7-ms2b-migration.md`）：备份 tarball 215MB → 4 篇受害者离线重摄入验收全过（1609.05917 McGaugh [1]、1804.10121 calj@mpia.de、2603.03522 两机构、2607.17040 Long Wang email——2607.17040 正文大 diff 已归因=旧 IR 垃圾段 `show]wanglong8@…` 消失引发 block id 级联，逐 token 对账非回归）；**5 篇 src-only 全部失败于 latexmk**（缺 aa.cls/emulateapj-rtx4.cls/aas_macros.sty 等 arXiv 自带类——1307.8124 探针实证一旦能编译即 18 作者受益；挂 known-issue 不投入修）；parity works 41=41、用户数据逐字节零漂移、零悬空 doc_ids。**顺手修 `--offline` 不 gate ADS**（deps.ts 旧 bug-for-bug 注释退役；AdsClient 加 `enabled` 镜像 Crossref 语义：缓存照读网络跳过；infra 59→60）。

**2026-09-09：MS1（小修集合 C+E+H+J+D）landed。** 定稿 memory `e4222a2` + 代码 `d7ead2d`：cite_key 只增不改（run.ts 预灌 usedKeys + `if (!w.cite_key)`）；UA HubbleSpace→ArgelanderSpace（crossref.ts:55/openalex.ts:138）；texFigureAssetSize 补 JPEG/GIF/WebP 直通图解析；TocPanel stripMath 剥 `[cite:…]`/xref 展开记号（cite→short、xref→number、无编号降级 heading/preview）；TaskModal due>planDue 软警告（`.plan-field-hint`，schema 不动）。对抗审查 1 BLOCKER（JPEG 填充字节 off-by-one：APPn 长度高字节 0xC0 可伪造 SOF 尺寸——已修+2 探针测试）+ N1（相邻 token 粘连）/N2（无编号 xref 消失）顺手修。测试 core 168→180、web 131→142，四门全绿，golden 未重冻。

**2026-09-09：设计 grilling 完成（三轮 Q1–Q10 全锁定，用户逐轮"按推荐"），用户确认开工。** commit/执行进度随 milestone 追加在本节。

## 范围与硬约束

- 范围 = 原 known-issues 清账（Stage 6 重编号后的 Stage 7 清单），经 Q1/Q7/Q8 取证修订；**Stage 8 = 标记功能**（不动）；Stage 4.1 仍推后。
- **硬约束（沿用）**：agent 侧输出字节冻结——CLI/skills 命令面、markdown token、`bib`/`ref` JSON、深链接逐字节不变；golden .md 不重冻、继续当冻结守卫；golden .json 因 meta 增量按普通回归重冻 + 人工抽查。
- **明确排除**：tikz/pgfplots 渲染（Q1：现库零使用，standalone 编译链成本高，等有 tikz 文档入库再立项）；MinerU/OCR 死代码（在 `ocr-features` 分支、不在 main）。

## 锁定决策（Q1–Q10 合并）

1. **执行流程（Q2）**：沿用 Stage 5/6——每 MS 实现 → 四道门（`corepack pnpm -r build|test|typecheck` + 根 lint）→ subagent 独立对抗审查 → 双过自行 commit（不逐次问）；全部完成后用户 smoke（`docs/manual-test-stage7.md`），通过后 push、memory 收尾。
2. **范围（Q1）**：纳入 A/B/C/D/E/G/H/J；F 允许取证后降级（Q8 已降级关闭）；I（tikz）推后；K（OCR 分支）排除。
3. **A re-upload 推广（Q3 = A1 并行多 doc + 主 doc 指针）**：zip 上传对任何 work 生成新 `upload-` doc 挂进 `doc_ids` 并设为主 doc；旧 doc（含 arXiv 摄入）保留可回看，UI 可切换主 doc。payload 补 `doc_ids` 列表；重传按钮不再依赖 `doc_id` 前缀、对所有 work 开放（原"先 zip 后 arXiv 摄入按钮消失"盲区随之消解）。**不做物理删除、不做 archive 目录**。
4. **B CLI 未识别源建条目（Q4）**：仅 DOI/URL 可解析源建条目（裸字符串维持报错——无标识可锚定）；建时立即 Crossref 富化（在线失败建裸条目降级）；建好提示"可用 webui 详情页上传 LaTeX zip 挂正文"（与 A1 的 attach 语义衔接）。
5. **C cite_key（Q5）**：`enrichAndPlan` 不再无条件重排——已有 `cite_key` 一律不动，只对缺失的新 work 分配，分配避让现有键冲突；删除重排逻辑。
6. **D task.due（Q6 = D3 软警告）**：允许 task.due > plan.due（计划延期是正当场景）；TaskModal 超期显示提示不阻断；schema 层不加约束（数据层宽容）。
7. **E TOC 预览**：预览纯文本化时把 `[cite:…]`/xref 展开记号剥成可读短文本。
8. **F hyperlink-only xref（Q8 = F1 关闭）**：取证结论——原始语义是 Stage 2 PDF/MinerU 时代条目（PDF 超链接合成 occurrence），Stage 3.1 纯 LaTeX 后机制不存在；现库 8 篇活文档 \ref→IR segment 逐一对账**零丢失**；LaTeX 管线下同构场景（宏隐藏 \ref/脚注/标题/表格单元格内 \ref）零受害者。修复路径中补 segment 通道会撞 agent 输出冻结硬约束（排除），侧信道 `xrefsByBlock` 属零收益预防工程（不做）。**拆记 known-issues**：①宏隐藏 \ref 未来有受害者再按 cite backstop 模板（`crossCheckCiteEvents` + argelander.sty 加 ref 事件）立项；②**"脚注内容整体 DROP"升级为独立 known-issue**（正文内容缺失，比没卡严重；本阶段不修）；③section 引用不产卡 = 设计。
9. **G 作者块（Q7，按取证"修实害、潜伏挂 known-issue"切分）**：
   - **修**：新发现 1（revtex/emulateapj 分组语义：`\affiliation` 挂"上条 affiliation 以来的整组作者"而非"最近一个 \author"——`currentGroup` 重置从 \author 分支挪到 \affiliation 挂接后，对现库 12 篇写法全兼容）+ 新发现 2（`\email[show]`：`tree.ts:92` 签名 `"m"`→`"o m"`）+ 新发现 3（`\author` 前 `\correspondingauthor`+`\email`：挂给 `\correspondingauthor` 指名作者，找不到落文档级 `meta.email`；推翻 `tex-author-block.test.ts:178` 固化"有意丢弃"的测试）+ 新发现 4（`\and \\` 吃作者：chunk 进 `truncateAtLineBreak` 前剥前导 `\\`，两分支 + `extractTexMeta` 同改）+ 边界 3（2603.03522 式机构行粘 `\author` 的 `\\` 后：尾部当伪 `\affil` piece 走同一 marker 解析）+ 边界 1 搭车（`\affil` 乱序/跳号：剥 `$^{N}$` 时提取编号建"印刷号→列表 index"映射，`markerRefs` 终解走映射——与边界 3 共用代码，零成本搭车）。
   - **不修、挂 known-issue**：边界 2（单机构内 `\\`，启发式有误判面）/4（前置 `\inst`）/5（orphan `\affiliation`）/6（尾标点去重）——现库零受害；新发现 5（无标记逗号分隔作者——与 "Last, First" 结构性歧义，高风险，继续不拆）。
   - **重摄入**：1609.05917 / 1804.10121 / 2603.03522 / 2607.17040（受害者）+ Q10 的 5 篇 src-only；`library build --offline` parity 校验（沿用 Stage 6 迁移流程：备份 tarball → 离线重摄入 → works 数/note/label/star/read/tags 逐字节、零悬空 doc_ids）。
10. **H 直通图尺寸**：`texFigureAssetSize` 补 jpg/gif/webp 直通路径（Stage 6 MS2 审查 N5）。
11. **J UA 改名**：Crossref/OpenAlex UA `HubbleSpace/0.1` → ArgelanderSpace 系（会改线上请求指纹，Q1 已拍顺手改）。
12. **MS 切分（Q9）**：MS1 小修集合（C+E+H+J+D）→ MS2 作者块（G + 重摄入 + parity）→ MS3 re-upload 推广（A1）→ MS4 CLI 建条目（B）→ MS5 收尾（smoke 手册 + memory + known-issues 更新）。
13. **Q10 src-only 5 篇顺带重摄入（best-effort，入 MS2）**：0902.1039、1307.2657、1307.8124、2603.00229、astro-ph-9707253（旧管线 build/ 残留、无 IR、阅读器 404）。能过管线的入库（1307.8124 是新发现 4 的受益者）；失败的记录原因挂 known-issue，不阻塞 MS 关闭。

## 取证存档（2026-09-09 两路 explore 子代理，直接采信）

### A. 作者块边界受害者矩阵（agent-7）

- 已摄入 7 篇 IR 文档 + src-only 5 篇逐篇核查 + `packages/core/dist` 实际跑 `extractAuthorBlock` + 合成探针验证触发条件。
- **原清单 6 边界仅边界 3 有实害**（2603.03522 平铺降级）；1/2/4/5/6 现库零受害（潜伏）。探针确认触发条件：乱序静默错配（`AFFIL_MARKER_TEXT_RE` ir.ts:291 剥掉含真值编号）；跳号静默丢弃（`ir.ts:660-663` `k <= affiliations.length` 过滤）；前置 `\inst` 划给后位作者（`absorbableAfterComma` 排除 inst，ir.ts:453-459）。
- **清单外新实害**（伤害已摄入文档）：①revtex 分组语义错挂（1609.05917 McGaugh 无机构；2603.00229 Torres/Stefanik 落空）——`ir.ts:603` 每个 `\author` 重置 `currentGroup`；②`\email[show]` 丢地址（2607.17040 Long Wang）——`tree.ts:92` 签名 `"m"` 抓错可选参；③前置 `\email` 丢弃（1804.10121 calj@mpia.de、2607.17040 wanglong8@sysu.edu.cn）——`tex-author-block.test.ts:178` 固化为"有意"；④`\and \\` 吃作者（1307.8124 18→16，丢 Schlafly/Morgan）——`truncateAtLineBreak`（ir.ts:311）对 `\\` 开头 chunk 截空。
- 逐文档概况：1610.08981/2012.05220/2501.17225 完全正确；1609.05917 结构化但 McGaugh 错配；1804.10121 结构正确丢通讯邮箱；2603.03522 平铺降级；2607.17040 机构全对丢 Long Wang email。
- 修复难度：新发现 1 低（高价值）、2 极低（一行签名）、3 低-中（需定语义，已拍）、4 低、边界 3 中、边界 1 中（搭车）、边界 4/5 低、2 低-中（误判面）、6 极低、新发现 5 中-高风险（不拆）。
- 附带：2501.17225/2603.03522 的 `meta.authors`（`extractTexMeta` 产）是逗号粘连整条 blob，与 `authorDetails` 不一致（立此存照）；astro-ph-9707253 是 plain TeX 无 `\author` 可解析。

### B. hyperlink-only xref 链路（agent-6）

- xref 唯一发现方式：pass 2 inline `\ref/\eqref/\pageref/\autoref/\cref` token → `xrefSegment()`（`fuse/walk.ts:1190-1192,1320-1343`），靠 pass 1 `labelMap`。不产 segment 的上下文：章节标题（`plainText` walk.ts:1418-1421）、表格单元格（`fuse/tables.ts:98` cellPlain 纯文本进 HTML）、脚注（DROP_MACROS walk.ts:171 整体丢弃）、未展开宏内部（macros.ts 展开失败只递归最后一 arg）。
- **关键不对称**：cite 有插桩事件 backstop（argelander.sty:152 citation 事件 + `crossCheckCiteEvents` walk.ts:1480-1547）；**事件流无 xref/ref 事件类型**（`facts/events.ts:79`），xref 无 token-less 兜底。
- 右栏卡两来源（RightPanel.tsx:22-50）：cite 卡 ← `citationsByBlock`（含 backstop）；float 卡 ← `xrefTargetIds` 只扫 segment（segments.tsx:258-284），floatKind 排除 section。
- **现库 8 篇活文档 \ref→segment 对账零丢失**。唯一计数差 = 1610.08981 重 label 假象（`Eq:dSph2` 定义两次，first-wins → 附录 eq-7 永不被指向；独立 quirk 立此存照，不修）。脚注内 \ref 3 处（读者看不到，脚注文本被 DROP）。自定义 ref 包装宏全库零。未解析 xref：`sec: LzE_results`（2501.17225 label key 带空格笔误）、`firstpage`（2603.03522 lastpage 伪 label）——unresolved chip 属另一问题。
- 方案定论：关闭本 issue（方案 A）；侧信道 `xrefsByBlock`（方案 B，不碰冻结但零收益）不做；补 segment 通道（方案 C）撞 agent 输出冻结硬约束（排除）。未来若做方案 B：cite backstop 是现成模板，红线 = 不得往 `segments` 塞合成 xref segment（会改 agent markdown 字节）。
- server 透传存储 JSON 无 schema 过滤（app.ts:243-263）、web 无 zod 校验（api.ts:14）→ 未来 IR 加顶层 key 自动流通。

## 推后事项（本阶段勿做）

- tikz/pgfplots 渲染（Q1 拍板，等真实受害者）；MinerU/OCR（`ocr-features` 分支）；Stage 4.1（agent 操作计划页面）；Stage 8 标记功能。
- 脚注内容整体 DROP（独立 known-issue，本阶段只记录）；作者块边界 2/4/5/6 + 新发现 5（挂 known-issue）；1610.08981 重 label quirk（立此存照）；宏隐藏 \ref（无受害者，模板已备）。
- 参考文献条目元数据填充（Stage 6 Q8 已砍，非用户诉求）。
