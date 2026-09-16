# 2026-09-16 Inbox 归并：来源、替代与保真审计

状态：已完成（2026-09-16 归并验收快照），原文保全、文档检查与保真核对通过；验收时上一阶段已提交，整理结果未提交，未push。用户随后另授权提交整理结果（原 inbox D2），实际结果：`5569f98` 提交、随 Stage 12 推送至 origin/main。该 session 原文持久定位为 `5569f98` 的 `.pi/inbox/2026-09-16-mem-merge-stage11.md`，Stage 12 关闭归并后活动副本已删。这是整理审计，不是另一套产品规则；权威分工见[索引](../memory/00-index.md)。

## 1. 授权、起点与提交边界

- 用户限定仅整理 memory inbox，不推进下一 stage。既有协议不重复提问；只问本次特殊事项。
- Q1 用户确认将刚关闭的 Writer 编辑器与渲染改进统一编号 **Stage 11**；Q2 选择先提交记忆原文，并主动追加“上一stage的代码库改动……也提交上”。整体共识后明确“开始”。来源为当前 inbox D1（尚未提交，不能删）。
- 起点 main@`e5c216401a021ba488ac52d666ee15b662a5295a`：39个tracked修改、13个untracked项，index空；其中3份未完整保全记忆，其余为上一阶段Writer实现/测试/依赖/许可证/数据模型文档。没有把旧改动当本次新代码。
- 先完成四门，再显式提交该52文件为 **`ee2095c33eb7d6255b1d119619a8de631a574c1e`**。52文件SHA256验证前后及暂存/提交树一致；不改代码、不夹带本session inbox、不push。
- 四门各exit0：1054 passed（contracts100/core293/infra67/web323/server220/CLI51），server另1个可选A&A外部依赖skip。跳过不是新实测成功；历史A&A/Chrome验证只按原记录引用。本次未运行真实用户数据或浏览器实验。
- `/tmp/mem-merge-stage11-gates-qCClKQ/` 是临时日志，非永久证据。此处摘要与提交树、仓库测试可持久定位；不把合成测试通过写成Report用户smoke通过。
- 随后才归并正式记忆/专题、修AGENTS过时阶段摘要及引用。整理结果**不自动commit/push**；不改README/业务文档以顺带扩大范围，不定位/修复I030/I031。

## 2. 删除前的原文字节保全

统一恢复基线：`ee2095c33eb7d6255b1d119619a8de631a574c1e`。

对下列11份活动原文逐份执行 `git show <基线>:<路径>` 与工作区 bytes 比较，**11/11 相同，合计178,509 bytes**。裁剪/删除前再次匹配本表 SHA256。不仅验证文件在历史里“出现过”，还验证待删的完整当前字节；旧Stage10 D16增量与writer-deps/consensus全文均由本次提交补全。

| 原路径（相对 `.pi/`） | UTF-8 bytes | SHA-256 |
|---|---:|---|
| inbox/2026-09-13-epoch-review-reader-coherence.md | 18540 | d909b0db440bf6f62fa1f6bb101c7dddfb93f2a108f0fc55e263680d0041dd7f |
| inbox/2026-09-13-mem-31b251a-memory-restructure.md | 6011 | f53b38ee5bbc69206b35e11544d7f687cda24b505470b697b7e02435f387ba3f |
| inbox/2026-09-14-stage9-i18n-grilling.md | 11021 | ea78ff546907fb7de5973aa293de0b1b926fa98ac9c152051ae36f819ba2b66d |
| inbox/2026-09-15-stage10-writer-grilling.md | 22190 | e8f600c4813a31a41940f578973fc5a5e0b207076e8cd3317cebcdf4bffde8f6 |
| inbox/2026-09-15-subagent-routing-config.md | 489 | fa6d53f17e41430d42a078d30ce4eba164937e50490d342b888a73e06706a64f |
| inbox/2026-09-15-writer-deps-research-grilling.md | 41492 | cb3f84c3d1131eb3a5ebf2d4ed258eb6b230fd2606aa2b7f3e635b41743139e8 |
| memory-reference/2026-09-13-reader-epoch-plan.md | 34697 | 70e0575dab4a04a26b8d25045e816346872b2fb6a3f02be6a76d6496a1e9faeb |
| memory-reference/2026-09-14-stage9-i18n-plan.md | 10519 | 62e1b48bd275b67ecf0dbb42d622e8c4a3d956c7db90f023bd58b08ab6909948 |
| memory-reference/2026-09-15-stage10-writer-plan.md | 18220 | 39a0b6cdd21fba11298ca0490f3d06d3e962de2543e4d8537e0ee96456b09cb4 |
| memory-reference/2026-09-15-stage11-render-pipeline-scope.md | 4255 | 2cc44bb57d1ee2deb3e439163b1f07dc3fe909fe61f5c58784e79f63fccd592e |
| memory-reference/2026-09-15-writer-rendering-consensus.md | 11075 | 5c9337319e8653a8ef36af88d59d4a2431aea5e896777aa26eae76350eb47c85 |

恢复示例（完整原文而非本审计摘要）：

```bash
git show ee2095c33eb7d6255b1d119619a8de631a574c1e:.pi/inbox/2026-09-15-writer-deps-research-grilling.md
```

早期提交对应见 [history](../memory/history.md)。本次新的整理决定/过程不在此提交内，当前 inbox 必须保留；不为清空目录自动制造第二个提交。2026-09-13 初次审计继续保留为历史证据，只修头部时点/来源链接，不把旧I001/I008等历史描述当当前状态。

## 3. 逐组归并去向

简称：架构=`memory/product-and-architecture`；契约=`memory/contracts-and-decisions`；问题=`memory/known-issues`；工程=`memory/engineering`；历史=`memory/history`。

| 来源组 | 结论及去向 |
|---|---|
| mem-restructure D1/F1/F2/D2 | 制度已在协议，无需复制；后续提交推送事实修正旧头部含义，原始D1定位改持久commit。旧hash/15文件迁移保初次审计，逐工具流水退出活动inbox |
| epoch D1–D6：目标、旧文字/图片、草稿、恢复、职责 | 契约共同epoch安全摘要；annotations完整读取/会话/资产/草稿机制；架构更新I001行为，不再写必须F5 |
| epoch D7：严格预算批准 | 契约、annotations、I032；明确后续通知不能重开额度，即使短暂ready，也只手动retry/切doc重置。保留用户接受手动重试的理由 |
| epoch D8/D9与F3–F6：实施、审查、用户smoke/提交 | 历史与工程保受测边界、三项真实缺陷修复教训及人工局限；不把中途BLOCK/探针失败重写成全程通过，不继承实施/提交权限 |
| epoch F1/F2：旧断点、I008更正 | 断点已修不留开放任务；I008从确定开放bug移待证：同步路径无交错实证，不能凭新加锁宣布旧bug已修；annotations保archive拷贝/重试边界 |
| Stage9 D1–D7/F1–F3 | 架构记双语能力，工程记JSON/key/运行期t/Intl/测试/包装，契约记范围。305叶子、12测试零改动、7/7与smoke仅作历史验收；旧进行中/待提交状态不再传播 |
| Stage9术语/待审校、server与库名边界 | D7用户smoke已关闭当轮审校；英文仍可后续打磨，不转成永久冻结。server detail和用户数据不翻译留契约/工程，不误报新bug |
| routing-config | 历史仅保01441a4配置-only及用户级设置不在仓库，不复制本机路由模型清单；无产品改动 |
| Stage10 D1–D9：初版范围/存储/模板/导出/UI先行 | writer现行能力/长期取舍，架构/契约安全摘要；UI先行只为当轮授权顺序，不强制所有后续任务照搬。否决的分类、模板管理UI、PDF/关联/新CLI仍保范围 |
| Stage10 D10–D14：评审、高亮/数学、真编译 | 被Stage11替代的overlay/正文regex/单遍编号仅压历史；保用户从“不编译”修订为“不展示PDF、真实求号”的理由与后续替代链 |
| Stage10 F3–F7与D16 | 内置模板TS单源、frontMatter实际位置、数据与导出契约入writer；dist测试教训入工程；工程交付不等于最终smoke通过，e5c2164提交推送入历史 |
| Stage10缺失D15/F8、Stage11 scope P1–P4 | 不补造原条目，采用旧plan头部/草案的替代证据（§4）；四类smoke促成后续架构改进入历史。草案自研补全等未获批候选不升级成需求 |
| writer-deps D1–D6/D9–D11/D13–D14 | writer/契约保成熟编辑、Texifier性能参照、必要多遍、语义非PDF版式、裸key、依赖缺失不暗换模板。用户共享IR首要意图与隔离边界明确，TeX4ht不再默认 |
| writer-deps D7/D8及D17局部覆盖 | D7自动编译被D17显式触发决定覆盖；当前代码仍旧行为在I031/架构独立标明。D8陈旧对应关系/失败保用户文字仍生效，不随触发方式修订丢掉 |
| writer-deps D12/Q12暂停、F1–F6网络/本机探针 | 工程保关键误判纠正、故障授权恢复原则；已退出路线的详细转换器探针仅Git，不把partial失败报告当成功或继续研究任务。保现有reader并非完整natbib排印的复用缺口于tex专题 |
| writer-deps D15/F8/F9实施及许可 | 架构/writer/tex保共享profile、缓存/映射/drain与reader默认冻结隔离；工程保CM/IME、打包notices、A&A hook/摘要等教训。1054+可选依赖补测/65组/发布包Chrome限定范围入历史 |
| writer-deps D16/F10本机安装 | 工程唯一记录实际版本/来源/bytes/hash及安装范围，不承诺最新官方/真实稿件通过，不误关I004，不继承用户数据操作授权 |
| writer-deps D17/I1/I2与Q1/Q2收尾 | Stage11带问题关闭；正式I030/I031，I033接受兼容边界。其余smoke用户确认通过、两项留下一阶段，但本次不立项或修复；调研Q1已解决，不再保为待答 |
| 五份旧长方案/共识 | 相同长期结论入annotations/writer/工程/契约；阶段时序入历史；旧函数草图/逐轮验收清单/候选不当现行API，原文Git保全后退出活动资料 |
| 本次D1/F2 | 阶段编号入索引/历史，提交授权边界及ee2095c事实入本审计；新原文未提交，继续留当前inbox |

现行数据契约仍引用产品 `docs/writer-data-model.md` 与schemas，不另建docs记忆副本。该文档描述的自动编译是**当前实现**，没有因记忆新决定而伪改成已实现显式触发。

## 4. 特殊歧义与替代链

### 缺失 D15/F8 的口径

只读scout核对当前/已提交Stage10文件、可定位历史及不可达对象，未找到这两个条目正文。严格可得结论是**当前与可定位Git里不可恢复**，不能证明对话从未发生，也不宣称已恢复逐字原话。

- 关闭事实替代来源：`ee2095c` 中 `.pi/memory-reference/2026-09-15-stage10-writer-plan.md` 头部“smoke未通过但用户决定关闭”。
- 四项smoke替代来源：同提交 `.pi/memory-reference/2026-09-15-stage11-render-pipeline-scope.md` P1–P4，明确是用户反馈的整理记录。
- writer-deps D15/F8是另一个session的条目，不回填。来源缺口保留于history，本次不创造新产品结论。

### 当前与旧决定

| 旧记录 | 现行处理 |
|---|---|
| 正式记忆截至Stage8、无Writer/i18n | 补Stage9–11及reader epoch事实，AGENTS只更新入口摘要；Stage4.1仍推后 |
| mem原文尚未提交、Stage9仍进行中、Stage10未提交 | 各按后续D2/D7/D16及Git实证定时点；本次新ee2095c另列，不把历史工作区干净当当前 |
| I001必须F5 | 关闭，能力边界归I032/annotations |
| I008锁外必能双归档 | 更正为历史证据不足待证，不虚构数据丢失或已修复 |
| Stage10依赖aa.cls随包 | 后续用户D11明确许可未核清不分发，可经窄授权本机补齐；最终aa.cls+aa.bst仅本机 |
| Stage10 overlay/本地正则预览/单遍pdflatex/完整cite插入 | CM6/共享IR/latexmk必要多遍/裸key，reader默认与CLI冻结不变 |
| Q12 TeX4ht候选 | 用户暂停后D13明确共享主干替代，不把研究可行性当新增运行依赖授权 |
| 旧consensus只落盘/未实施 | D15实施、F9工程完成、D17带问题关闭；执行权限已经结束 |
| 旧consensus§5.1停止输入自动编译 | D17改显式触发，新决定有效而代码未改；I031不误标完成 |
| “Stage11草案”等于正式方案或下一stage | 当前用户确认上一轮编号Stage11，已带问题关闭；草案退历史，不自动创建下一阶段 |

## 5. 保真重点与检查结果

最终核验通过（父代理内容核对；子代理仅做Git/缺失来源事实调查，不冒充独立内容审查）：

- 标注三态及全部异常分支原段逐字保留；冻结输出、CLI真只读、server归档权威、原字节archive、PUT双校验、全局删除/跨进程边界不变。
- 共同epoch读取证明、CLI legacy隔离、同fingerprint完整IR接纳、rev0、所有图surface、严格一次恢复预算、草稿显式重选/禁存、会话限定、自然上传受测范围完整。
- Writer各层分离，显式触发“已决定/未实施”、Report反馈优先于合成通过，缺依赖/不支持/许可边界、未知键/缓存/删除drain等不丢。
- 每个D/F/I/Q来源组有现行去向或明确历史；旧问题I001–I029不丢号、不重用，新增I030–I033性质区分；缺失原文与研究失败不涂改。
- 原文恢复、所有本地链接/锚点、UTF-8/空白、改动范围/index、体量和未提交原文保护。

具体结果：15份Markdown（含AGENTS）、71个本地链接可达，UTF-8/末尾换行/行尾空白通过；11份删除原文再次从Git恢复，byte数及SHA256匹配。四段原文逐字比较不变：指纹三态全异常分支、agent冻结、归档权限/PUT、CLI annot契约全文。I001–I033每号一个表行、无重复/丢号，26条未涉及的旧问题表行逐字不变；42项覆盖词检查配合上述逐组人工核对。git diff --check通过，index空，提交后diff仅记忆与AGENTS，产品源码/依赖/业务文档无新改动。

文档检查第一轮因探针要求“尚未实施”等而实际文本为“未实施”停止；核对语义后改正验证脚本的过严字面断言，完整复验通过，未修改/放宽契约来凑绿。不是代码四门失败。之后仅补收尾事实并再核链接/范围，不为纯文档归并重跑全构建或历史实验。

恢复演练（只依现行启动材料）：能区分Stage11带问题关闭与全部smoke通过；能定位I030/I031及“显式触发已决定、未实施”；能恢复旧D13共享IR的用户理由、原archive/CLI冻结、reader一次恢复预算和无跨进程承诺；能正确回答原文未提交不能删除、本次未push且不自动提交整理结果。阶段草案已退历史，不会顺着旧方案自动开工。

## 6. 体量与交接

整理前（ee2095c树）：正式6文件46,159 B；inbox协议8,045 B + 6 session 99,743 B；启动必读合计153,947 B（不含AGENTS）；专题/方案/初次审计9文件124,899 B。全部记忆278,846 B。

归并验收时（2026-09-16T10:20:25+02:00）的体量快照：正式6份66,760 B；活动session **6份→1份**（当时只留本次未提交原文），协议仍在；启动体量约减半。下表不包含随后D2提交授权及相应来源说明的少量追加，不作为永久不变的当前字节数。

| 范围 | 整理前 UTF-8 bytes | 整理后 UTF-8 bytes |
|---|---:|---:|
| 正式memory | 46,159 | 66,760 |
| session inbox（不含协议） | 99,743 | 6,426 |
| 启动必读（memory+协议+session，不含AGENTS） | 153,947 | 81,347 |
| 全部记忆（另含专题/审计） | 278,846 | 163,289 |

正式memory比35–50KB参考预算大，原因是新增reader共同epoch与Writer安全/产品边界；保真优先，不以删三态分支/未实施决定来达标。11份旧session/方案原文共178KB已退出活动资料，专题现行规则与历史恢复可按需读。inbox未达8份/40KB提醒线。

本次inbox原文未提交，保留是协议要求，不为达到“零inbox”擅自删掉。未push、整理结果不自动提交；后续等待用户，无默认开发任务。
