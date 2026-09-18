# 当前问题与推后事项

整理：2026-09-16（Stage 12 关闭归并）；2026-09-18 Stage 15 关闭归并（新增 I035）。编号 `I001…` 稳定，跨类别移动不换号，不回收旧号。这里是状态清单，不是默认下一阶段；来源记录的“现库”指当时观测，不代表永远零受害者。详细作者/编译边界见 [tex-pipeline](../memory-reference/tex-pipeline.md)，标注机制见 [annotations](../memory-reference/annotations.md)。

## 开放问题：仍有缺陷或风险

| 编号 | 问题、影响与当前证据 | 已知方向/处理 |
|---|---|---|
| I002 | **DELETE 中途 rm 失败会部分删除**，可留下 ghost library 条目；Stage 8 MS2 审查 | library build 重建可愈；尚无完整删除事务，不因物理删除接口存在就认为全程原子 |
| I003 | **脚注正文整体 DROP**，包含其中的 ref 内容不可读（Stage 7 取证：现库 3 处脚注内 ref）；cite 可经事件 backstop 保链接，不等于正文保留 | 独立内容缺失问题；修复触及正文/agent 输出须先明确范围 |
| I004 | **5 篇 src-only 编译失败**，没有可读 IR；Stage 5/7 best-effort 已做，不能再概括成全是缺 cls | 逐篇原因在下表；换源/类 shim 是否实施需用户决定，不重复同样 best-effort |
| I005 | **作者块残余启发式边界**：单机构内换行、前置 inst、orphan affiliation、标点去重、无标记逗号作者等；Stage 7 MS2 已修真实六项受害，其余有结构歧义/当时无受害 | 具体触发面与已修路径在 tex 专题；新受害者再针对取证，不泛化重写姓名 parser |
| I006 | **主 doc 位置指针残余三边界**（Stage 7 MS3）：library.json 丢失从零 rebuild 按字母序播种会丢主位；stale IR 删后 rebuild 前版本列表可含多个 404；bridging 塌缩方向决定主位存亡 | 已有库 rebuild 保序不是独立主位持久化；修复方案未定 |
| I007 | **SICI 老 DOI URL 截断**：`10.1002/(SICI)…<…>3.0.CO;2-L` 的 <> 被 URL 正则截断，可能建错 stub（Stage 7 MS4） | 边缘输入未修 |
| I009 | **归档 banner 在外部删除 current 场景措辞欠准**（Stage 8 MS3） | cosmetic，尚未修 |
| I010 | **plans.json 未知键被 zod strip**，load/save round-trip 会抹掉外部新增字段（Stage 4 MS1） | Stage 4.1 前评估 loose schema 或明确协议；不能假设 pretty JSON 就前向无损 |
| I011 | **Markdown+数学渲染仍为启发式**：已保护 code/货币/转义/URL，但非完整 Markdown parser（Stage 4 审查） | 新腐蚀按保护区/stash 模式加回归，不恢复无差别 dollar 抽取 |
| I012 | **解析/执行潜伏边界**：tag* 插桩盲区有源码兜底；含控制序列的 mathnum 会丢弃；minted 预扫描可误伤 verbatim 示例；图名 a/b 与 a__b 编码不单射；revtex 清洗对 URL % 的理论隐患 | Stage 5/6 证据与防御见 tex 专题；不表示每项都造成现库损失 |
### I004：失败原因必须逐篇保留

来源：2026-09-10 Stage 7 MS2b 迁移。只在临时副本做过探针，没有自动改用户源文件。

| arXiv | 已验证根因/探针 |
|---|---|
| 0902.1039 | 2009 aa.cls 的 bibfont 与现代 natbib 冲突；换新版越过后又 graphicx option clash，需改源，不是单纯找缺文件 |
| 1307.2657 | emulateapj-rtx4.cls 缺；TeX Live 只有 emulateapj.cls。旧探针改名可编译，未自动应用 |
| 1307.8124 | aa.cls 缺；放新版后 longtable 非单栏错误（源有注释掉的 onecolumn）；绕过编译的作者探针已证明 18 作者/8 机构全恢复，一旦可编译即受益 |
| 2603.00229 | inline bibliography 的 na 未定义，缺 aas_macros 一类期刊宏；作者定义被注释 |
| astro-ph/9707253 | **plain TeX 而非 LaTeX**（ref/endref/bye），不是安装 cls 就能解决 |

候选：向各 src 放合适类/改必要源选项，或 infra TEXINPUTS shim；存在版本错位风险，未拍板。不要把这些无 IR 目录等同于 library 已有悬空 doc_ids。

## 接受的边界：不要重复当未修 bug

| 编号 | 当前边界与理由 | 重新讨论条件 |
|---|---|---|
| I013 | CLI 与 server 跨进程同时 mutate 同 doc 不支持；单用户操作边界，不做 filesystem lock | 用户明确需要跨进程并行写入 |
| I014 | 手动 rm output 绕过删除入口可留下 orphan annotations；不自动清理，也无 reader/agent 访问保证 | 单独批准恢复/显式迁移工作流，不能写成既有访问能力 |
| I015 | CLI 无 docId 穿越防护，与 read/show/ref 同本地单用户直读信任模型；annot corrupt IR 错误无路径，受既有 helper/冻结约束 | 安全模型或接口契约明确变更 |
| I016 | 1610.08981 同 label `Eq:dSph2` 定义两次，first-wins 到 eq-5，附录 eq-7 永不被该标签指到 | 源文修正或明确新重复 label 策略；不是 xref 发现丢失 |
| I017 | 结构 id 非印刷号，重摄入可位移；未知深链接静默，section xref 不产右栏 float 卡 | 明确批准新的寻址/卡片语义 |
| I018 | plan note 不 sanitize（用户自输入、单用户本地），API body 限制较宽；计划写入排队与 external reload 可多闪一次 409，结果收敛 | 信任/部署模型变化；相关细节在 plans 专题 |
| I019 | 文档标注只约束单 logical container；原位内容变则整批归档，不逐条挽救；archive 正常不可见 | 用户明确批准 migration 或新 target 能力；完整契约见 decisions |
| I020 | no-op DELETE 仍广播；watcher 会对被删 doc 的 current 消失发 external，web 404 容忍 | 出现可观察实害再改；目前不是数据丢失 |
| I032 | **reader epoch 恢复边界**：无资产 watcher/历史图、同步 hash 成本、单 server 而非跨进程事务；图失配的一次自动恢复额度用尽后，重复/自发通知也可能要求手动重试。2026-09-14 用户批准 v2 时明确接受 | 新的性能/自动恢复需求获批后重议；完整约束见 annotations 专题，不当作 I001 尚未修复 |
| I033 | **Writer 渲染兼容边界**：不承诺任意模板/BibLaTeX/宏；longnamesfirst、上标 citation、正文中途切样式报不支持，跨 cell 块不能安全映射则警告；没有真实大稿性能保证 | 新真实需求明确立项；Stage 12 修复的是 bib 转义根因，不以兼容边界豁免未来新受害 |
| I034 | **cite 命令语法错误由用户负责**：分号分隔多 key、全角逗号（IME 产物）等错误语法不做 server/web 诊断提示，LaTeX/bibtex 真值报错（2026-09-16 Stage 12 Q10） | 用户明确要求语法辅助/校验时再立项 |

计划 task 超过 plan deadline 的**软警告**、列表/看板拖拽不对称等是现行产品决策，权威在 [契约](contracts-and-decisions.md)及 plans 专题，不再保留划线“已修问题”。

## 推后能力：没有实施授权

| 编号 | 能力及已有条件 | 用户取舍 |
|---|---|---|
| I021 | **Stage 4.1 agent 操作计划**：稳定 p_/t_ id、pretty JSON、watcher、plan.changed、CRUD 纯函数已预留 | 仍推后；先评估 I010 与并发，不把旧直读 CLI 设想写成已冻结方案 |
| I022 | **TikZ/pgfplots** 独立编译物化，当前流式页不渲染 | Stage 5 Q9/Stage 7 Q1：当时现库零使用，等实际文档需要再立项 |
| I023 | **标注扩展**：agent CRUD、显式 migration skill/正式 archive CLI surface、编辑工作流、协作 comments/threads/resolved | Stage 8 留扩展余地，不提前加字段或基础设施 |
| I024 | **webui 补全独立写路径**：note 编辑、label 持久化、已读写入口等现主要在 CLI（建条目已由 Stage 13 落地，不在本项） | 独立应用原则有效，具体范围用户另定 |
| I025 | **OCR/PDF/HTML**：只在 ocr-features 快照，相关 MinerU 两死代码问题随分支封存 | 启用前重新核实服务/工具与鉴权，不作为 main 清账任务 |
| I026 | **参考文献条目元数据富化**（bib 结构化/ADS 等）、pagedView、全局库复用 | 参考文献富化在 Stage 6 Q8 被用户确认非原诉求；其余为未来方向，不能因历史提过就启动 |
| I027 | **宏隐藏 ref 的 backstop** | Stage 7 当前库无受害者，原 PDF hyperlink-only issue 关闭；若立项可参考 cite backstop，不擅往 segments 塞合成 xref 改冻结输出 |
| I028 | **计划扩展**：anchor 链接、时间线拖期、跨计划移动等 | 原否决/推后理由见 plans；不能一概写成待实现需求 |
| I035 | **CLI 侧自动 arXiv 拉取**：webui 添加路径的自动导入已由 Stage 15 落地（server job），CLI `ingest <doi>` 与 `library build` 行为不变、不自动拉正文 | 2026-09-17 Stage 15 D8 用户明确：本期不动 CLI 并要求记入 memory；未来若要 CLI 自动拉取另立小项，重新评估冻结面与 --offline 语义 |

## 待确认事项

| 编号 | 尚待核对的历史观察 | 处理 |
|---|---|---|
| I008 | Stage 8 曾称锁外 GET ensure 可双归档；2026-09-13 epoch-review F1 的取证发现 archive/ensure 同步，未找到单 server event-loop 可交错路径。后来 GET/PUT 已入共同锁临界段，但这不是旧缺陷成立或“已修复”的证明 | 更正为**历史风险证据不足，待有实证再判**；不继续列作已证实开放 bug，也不宣称永无重复归档。新空 current 写失败后重试等独立路径仍可重复归档，保留 -N 不覆盖规则 |
| I029 | Stage 4 取证记过 web 客户端 `patchRef` 类型缺 note、server 实际支持；后续记忆未明确关闭 | 只保历史观察，不宣称本次已重验证；相关写路径任务中核对实现后再决定是否修复 |

Stage 12 已修复 I030/I031 并经用户 smoke 确认（见已关闭清单）；其余开放问题的修复方案未批准，不代表必须现在答题。未来证据/权限/覆盖歧义写入 inbox，再在授权整理时归并，不伪造优先级。

## 已关闭问题的去向

| 编号 | 关闭证据与范围 |
|---|---|
| I001 | 2026-09-14 reader epoch 工程完成及用户 smoke 确认；`3e50860`。正常合成 zip 摄入→自然通知→同 main 自动接纳新 IR/标注/图有真实 Chrome 证据，无需 F5。保守预算/资产监控/跨进程等限制另见 I032，不把批准范围外问题混回原 bug |
| I030 | 2026-09-16 Stage 12：根因为 `workToBibtex` 不做 LaTeX 转义，`journal = {A&A}` 裸 `&` 经 bibtex 入 bbl 致编译崩（库内 24/41 条必炸）；修复为生成层转义 `& % # _`（`$` 除外保标题数学）+ ADS BibTeX 字段富化与期刊宏注入。隔离实验、迁移后真实稿件编译与导出 zip 自编译验证，用户 smoke“渲染没问题”。`28472c2` |
| I031 | 2026-09-16 Stage 12：四个自动编译入口（保存后/打开/外部变更/切模板）全部取消，Shift+Enter/Render 统一显式触发、自动保存保留；无 ok 缓存时预览占位提示。真实 Chrome/CDP 探针验证连续输入 0 编译、Shift+Enter 恰好 1 次，用户 smoke 通过。`28472c2` |

UA 改名、cite_key 重排、TOC 预览记号、直通图尺寸、re-upload 推广、DOI 建条目、ADS offline、阅读器四项、Stage 8 验收均已关闭；摘要见 [history](history.md)，不留整页划线清单。Stage 8 曾被概括为“8 项”，实际混合 11 条，已按性质分配到本页、工程和专题，不再按旧数量引用。
