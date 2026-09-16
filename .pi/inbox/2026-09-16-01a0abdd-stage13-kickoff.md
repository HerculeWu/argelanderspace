# Stage 13 Grilling：webui 手动建立文献条目

- Session：01a0abdd（stage13-kickoff）
- 创建：2026-09-16T22:22:00+02:00
- 更新：2026-09-17T00:30:00+02:00
- 工作状态：完成（Stage 12 归并 + Stage 13 实施/复验/smoke 通过；提交推送随本次收尾）
- 归并状态：未归并
- 范围与授权：用户指令“请关闭尚未关闭的stage，推进下一个stage”。关闭 = 按 inbox 协议归并 Stage 12（及 Stage 11 归并 session 残留）到正式记忆，机械应用已确认决策；**不含 commit/push 授权**。推进 = 按用户 2026-09-16 预告单开 session 定义 Stage 13（ grilling 中），实施授权待 grilling 共识后用户明确。

## 已确认决策

### D1 — Stage 13 范围与验收（Round 1 Q1，2026-09-16 用户按推荐确认）
- 只做 webui 手动建立文献条目；不混入 I024（note/label webui 写路径）、I021（Stage 4.1）或其他开放项。
- 验收：四门 + 新增回归 + 真实 Chrome 验证 + 用户 smoke 通过后关闭。

### D2 — 交互形态（Q2 按推荐）
- 文献页“新建条目”对话框，两 tab：ADS bibcode **单条**（联网拉取→预览→确认）；BibTeX 全文**多条**（本地解析→逐条预览→确认）。双语同写。

### D3 — DOI 纳入 + 复用原则（Q3）
- 第三 tab：DOI，复用 `addDoiWork`（CLI `ingest <doi>` 同款，含 Crossref 失败留裸 stub 语义）。arXiv 不提供 docless 建条目，引导摄入正文。
- 用户补充：**建立条目尽量复用现有管线**。

### D4 — 创建语义（Q4 按推荐）
- 就地建立（upsert + planFor + assignCiteKey + save + libraryChanged），不触发全库 rebuild。bibcode 模式创建时同步拉 ADS export 补字段；bib 全文模式不主动拉，留下次 build 自然补。

### D5 — 手动 bib 的 cite_key（Q5 按推荐 A）
- 尊重用户 bib key 作 cite_key；与既有键冲突→显式报错让用户改，不静默改写。分配即采用用户 key，与“分配后永不改”兼容。注意：现有 `library build --bib` 路径不尊重用户 key（系统分配），本决策限手动建条目路径。

### D6 — 失败处理（Q6 按推荐）
- bibcode 模式 fail-fast：无 token/离线/未命中→明确报错，不建裸 stub。bib 全文模式纯本地解析，离线可用。

### D7 — 重复归并（Q7 按推荐）
- 身份重合→`created:false` + 既有 ref；不新建、不覆盖既有字段与用户数据（mergeInto 只补空字段）；UI 提示“库中已存在”并打开既有条目。

### D8 — 路由与 CLI 边界（Q8 按推荐）
- 单一新路由 `POST /api/library/works`，body `{mode:…}`；guardCsrf + libraryLock，同步返回（不走 job）。core 新建函数放 `library/build.ts` 同层。**不新增 CLI/agent 命令**（冻结面无需求不扩张）。

### D9 — 入口：激活既有占位菜单（Round 2 Q9，用户确认）
- 左栏“导入文献”占位菜单（三个无 onClick 假选项）变为真功能：从标识符（DOI/arXiv）、从 ADS bibcode（新增）、导入 BibTeX 三项；**删除“从浏览器抓取”假占位**（不存在的能力）。双语重写文案。

### D10 — arXiv 输入允许（Q10 用户修正推荐）
- 用户原意：很多文章只有 arXiv id 没有正式 DOI，也会被引用和阅读，必须允许输入 arXiv id——推翻 Round 1 推荐的“只引导不创建”。

### D11 — 手动 bib 字段全保留（Q12 按推荐）
- 手动建条目保留 title/authors(规范化姓)/year/journal/volume/number/pages/eid/month/doi/eprint + journal 宏识别（`{\aap}`→journal_macro）；解析复用 `parseBibtexText` + `parseAdsBibtexFields` 两现有解析器合并；entryType 按现有 isConf（conf 否则 article）。现有 `workFromBibrecord` 不写 volume/pages 是 build --bib 路径现状，手动路径补齐。

### D12 — 批量语义与创建后行为（Q13 按推荐）
- 批量 bib 逐条部分成功：每条独立报告 已创建/已存在/解析失败/cite_key 冲突，不整批回滚。单条成功→关对话框开详情；多条→对话框内结果清单，关闭后列表刷新并选中第一个新建条目。

### D13 — arXiv 条目形态（Round 3 Q14 按推荐）
- arXiv id（`2603.05265`/`astro-ph/9707253`/URL）→ 创建 `arxiv:` 锚定 docless 条目，创建时走解析链富化；**宽容**：解析不到也建裸 stub。读正文走详情页既有上传 zip 入口（attach-only 衔接）。

### D14 — 增量图谱与富化时机（Q15 按推荐）
- 单条三模式（bibcode/DOI/arXiv）创建时立即 `resolveWork` 全链 + **增量写 graph.json**（新节点 + 本地算出/入边 + 一次 fetchMany 补新 suggested 邻居），广播 libraryChanged。**批量 bib 例外**：只快建（纯解析入库），resolve/图谱留下次 build（避免 N×3 请求）。
- 边界（用户已接受）：增量是即时尽力可视化，推荐节点全局 top-N 截断/排序只有全量 build 权威，下次 refresh 收敛；网络失败条目照常建成、图谱后补，不阻塞创建。

### D15 — webui 与 CLI 的差异（Q16 按推荐）
- webui 三模式统一走新 core 函数（组合 resolveWork + exportBibtex + planFor + assignCiteKey + upsert + 增量图谱）；CLI `addDoiWork` 原样不动。webui DOI 比 CLI 多 ADS/OpenAlex 富化属新能力，不违反冻结面。

### D16 — 共识确认与立项（2026-09-16）
- 三轮 grilling（Q1–Q16）全部收敛，用户对完整共识汇总回答“确认”：Stage 13 立项，实施授权生效（含四门、回归、真实 Chrome 探针；用户 smoke 后关闭）。commit/push 授权本次未明确——Stage 12 归并改动保持未提交，不擅自 commit。

### D17 — arXiv 导入须显式（2026-09-16 用户 smoke 后反馈）
- 决策时间与来源：用户 smoke 后唯一 comment：“使用 arxiv id 导入，要要求给完整的 `arXiv:2609.17036` 这样的 arxiv id，带前缀。这样可以明确这是 arxiv id”。
- 结论：identifier 模式的 arXiv 输入只接受**显式形态**——`arXiv:` 前缀或 arxiv.org 链接；裸 id（如 `2609.17036`）报错并引导前缀写法。DOI/doi.org 链接不受影响。CLI `ingest` 的裸 arXiv 摄入路径不变（另一功能：正文摄入）。
- 实施：infra 新增导出 `explicitArxivId`（只认前缀/URL）；server detectIdentifier 三态化（identifier/error/null）；placeholder/sub 文案双语同步教学前缀；server 测试更新+裸 id 报错断言；探针新增 2b 场景（裸 id 拒绝）。
- 覆盖：D10/D13 中“arXiv id（2603.05265/astro-ph/…/URL）”的接受范围 → 收窄为显式形态。

### D18 — Stage 13 smoke 通过、提交授权与下一阶段（2026-09-17 凌晨，用户原话）
- “非常好，smoke通过。请commit+push。memory记录下个stage为完整跑通推荐文献查找功能，我下个session实现”。
- Stage 13 关闭（smoke 通过）。**授权 commit + push**（覆盖本 session 全部代码与记忆改动；一次性授权，不继承）。
- **下一阶段 Stage 14：完整跑通推荐文献查找功能**，用户明确下个 session 立项实施，本 session 不动；范围届时 grilling（现观测：推荐开关的 loading 是假定时器、推荐来自图谱 suggested 节点客户端过滤、GraphNodeDetail 可 add-to-library——真实缺口待下轮核实）。
- 覆盖：交接状态中的“等 smoke/提交授权” → 已全部落地。

## 已验证事实

### F2 — Stage 13 实施与验收（2026-09-16 晚）

- 实现落地（全部按 D1–D16）：
  - contracts：`ManualWorkRequestSchema`（identifier/bibcode/bib 三模式判别联合）/`ManualWorkResultSchema`/`ManualWorkResponseSchema`。
  - core `library/add-manual.ts`：`addManualIdentifier`（DOI/arXiv，容错建 stub）、`addManualBibcode`（fail-fast，ADS export→解析→全字段+bib_fields=ads）、`addManualBibText`（批量逐条部分成功，用户 key 作 cite_key，冲突逐条报错）；复用 resolveWork/parseBibtexText/parseAdsBibtexFields/planFor/assignCiteKey/upsert；就地建立不 rebuild。
  - core `graph.ts`：`mergeWorkIntoGraph` 增量图谱（节点+本地出/入边+一次 fetchMany 补 suggested；oa=null 时纯节点）；失败不阻塞创建。
  - server：`POST /api/library/works`（guardCsrf+libraryLock，逐条结果走 200 body，HTTP 错误只留给畸形请求）；identifier 检测复用 infra `arxivId`+core normDoi/arxivFromDoi（DataCite DOI 正确路由 arXiv）。
  - web：导入菜单激活为三项真功能、删浏览器假占位；`ImportDialog`（单条成功关窗开详情/exists 同，批量逐条结果清单，IME Enter 守门）；locale 双语新键；`CitationGraph` **heal 修复**。
- **计划外新 bug（已修，探针实证）**：① CitationGraph 位置表只在首挂载初始化，payload 刷新带来新节点 id → 渲染期 `P.current[id].x` undefined → 整树卸载（真实 Chrome 探针抓获；heal 修复+回归测试可证伪验证：无 heal 必败）。② resolveWork 的 fill() 不填 title → 裸标识符条目标题空、UI 显示 id；补 title 填空白（高优先级源优先），对既有有标题 work 无行为变化。
- **调研勘误**：`classify` 无匹配时把原期刊串当 label 返回——宏期刊经 latexenc 变 "åp" 会穿透 venue；workFromBib 的 label 仅在 publisher 命中时采用，宏条目回退 WRITER_JOURNAL_MACROS 展开（去转义）。
- 四门：build/typecheck/lint exit 0；test 1092 passed + 1 可选 skip（contracts101/core310/infra70/web332/server228/cli51），净增 26（core10/server8/web7，含 CitationGraph 回归）。
- 真实 Chrome/CDP 探针（/tmp/stage13-probe.mjs，临时证据，临时 dataDir，真实网络含 ADS）**14/14**：菜单三真项无浏览器占位、bib 批量两条 created+结果清单+关窗选中首条、宏期刊 venue 展开、arXiv 容错创建（解析出真标题与期刊 DOI 后 canonical id 归并 doi:10.1017/pasa.2026.10175）、DOI 创建+重复 exists 不重复建、bibcode 真实 ADS 创建（cite_key=bibcode、venue=A&A、bib_fields=ads、volume/eid 落盘）。
- **D17 复验**：四门全绿（1066→1092+1 不变）；探针 **15/15**（新增裸 arXiv id 拒绝引导场景通过）。
- 未动真实文献库/稿件/标注；ADS 联网仅探针内单条 export+解析链。

### F1 — Stage 12 关闭归并已执行（2026-09-16T22:22+02:00）

- Git 起点：HEAD=origin/main=`bf3bf83`，工作区干净；两份待归并 inbox（mem-merge-stage11、stage12-grilling）当前字节均已入 Git（5569f98 / 28472c2+00434d5+bf3bf83）。
- 归并内容：
  - `00-index`：当前状态推进至 Stage 12 关闭；Stage 13 方向记录为用户已提出、grilling 定义中。
  - `known-issues`：I030/I031 转入已关闭清单（根因、修复、smoke 证据、28472c2）；新增接受边界 I034（cite 语法错误用户自负，含全角逗号）；I033 重议条件措辞同步。
  - `contracts`：§6 显式触发决定标记已实施；新增 Stage 12 bib/ADS 决策组（来源无关一等存储、结构化字段不存 blob、转义字符集、cite_key=bibcode 分配规则与一次性迁移覆盖声明、富化接入、期刊宏注入、语法责任）；§1 记录 Stage 13 方向；§7 提交事实改指 5569f98。
  - `history`：Stage 12 行（交付、1066+1、smoke 通过、28472c2 已推送、00434d5/bf3bf83）；mem-merge D2 实际结果落为 5569f98；两份 session 原文持久定位 bf3bf83。
  - `product-and-architecture`：Writer 显式触发/导出 deps、ADS 富化字段与 library.bib 派生规则、cite_key 分配修订。
  - `engineering`：Stage 12 验证规模与 CDP 教训、latexmk 缓存自愈、ADS export 实测可用（2026-09-16）。
  - `writer` 专题：头部状态、显式触发机制、缓存自愈、bib/宏、导出 zip deps、Stage 12 验收证据；来源链接改持久提交。
  - 归并审计头部：D2 结果落为 5569f98 已推送。
- 两份旧 inbox 原文经 `git rm` 删除（字节已在 bf3bf83 树中，工作区干净确认一致）。inbox 现仅 README 与本文件。
- **未 commit/push**：归并改动在工作区与 index（git rm 已暂存删除），等待用户授权提交。

## 待确认事项

### Q1 — 预存假占位（不在 Stage 13 范围）
- 文献工具栏另有 "exportBibtex" 按钮无 onClick（与旧导入菜单同批假占位）。本阶段未授权处理；建议下次立项删除或实现导出。

## 交接状态

- Stage 12 正式关闭、Stage 13 正式关闭（smoke 均通过）；正式记忆/AGENTS 已同步至 Stage 14 方向。
- 提交：`3f814e4` feat（Stage 13 代码；误夹带两份旧 inbox 删除——其原文已在 bf3bf83 保全，删除本应属 docs 批，内容无差）；docs 批（.pi 记忆归并 + 本 session 原文 + AGENTS 同步）随后提交，hash 以 Git 为准。push 结果以远端为准。
- 探针/调试脚本在 /tmp（stage13-probe.mjs 等），临时证据；关键结论已自包含于 F2。
- 归并去向：D1–D16 范围/设计 → 契约§2“手动建条目”、架构能力/图谱增量、cite_key 规则；D17 → 契约§2+工程；D18 → 索引/契约§1/历史 Stage 14 方向；F2 → 历史 Stage 13 行+工程教训；Q1（exportBibtex 假占位）留下轮归并待确认。
