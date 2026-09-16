# Stage 12 Grilling：Writer 显式渲染 + bib 转义/ADS BibTeX 接入

- Session：stage12-grilling（交互会话）
- 创建：2026-09-16T11:05:00+02:00（约，grilling 开始）
- 更新：2026-09-16T13:05:00+02:00
- 工作状态：进行中（实施+迁移+工程验收完成，等待用户 smoke）
- 归并状态：未归并
- 范围与授权：解决 Stage 11 遗留 I030/I031；已获授权：实施代码修改（用户“实施”指令）+四门+commit+push（含 ee2095c/5569f98）；ADS 联网拉取；library build --offline 重建；迁移时精确替换两个 demo 稿件 cite key。push 前核实 gh 凭据。

## 已确认决策

### D1 — Stage 12 范围：I030 + I031（2026-09-16，Q1）
- 只处理 Stage 11 带问题关闭的两项；I002–I012 等历史开放项不混入，后续单独立项。

### D2 — 执行授权与验收（Q3、Q7）
- 授权实施 + 四门（build/test/typecheck/lint）+ 修复后 commit + push（连同 ee2095c、5569f98 两个已验收本地提交；push 前实际核实 gh 凭据）。
- 验收：四门 + 新增回归 + 真实 Chrome 验证（连续输入不跳动、Shift+Enter/Render 触发）+ 用户 smoke 通过后关闭。
- 阶段编号 Stage 12。

### D3 — I031 显式渲染方案（Q5=A、Q6=A）
- 取消全部四个自动编译入口：保存后（server PUT→scheduleNumberingCompile）、打开稿件时、外部变更后、模板切换后。自动保存保留不变。
- 无 ok 缓存/陈旧时预览区显示占位提示（"按 Shift+Enter 或 Render 渲染"），陈旧/失败保护沿用现有机制（writerNumberingForDraft/w-preview-stale）。
- Shift+Enter 语义合并：编辑态=提交当前 cell 并触发整稿渲染；非编辑态=直接渲染。IME 防护沿用现有 isComposing/compositionStarted 守门。
- 顶栏现 refresh 图标升级为带文字的 Render/渲染主按钮，编译中 spinner。

### D4 — I030 根因与修复范围（Q4、Q8、Q10）
- 两重 bug（证据见 F1）：①分号分隔多 key（用户输入层）②**核心**：`workToBibtex` 不做 LaTeX 转义，`journal = {A&A}` 裸 `&` → bibtex 原样抄入 bbl → LaTeX `! Misplaced alignment tab character &` 编译崩溃。凡引用 A&A 条目（库内 24/41 条）必炸，与模板/单多 key 无关。
- 修复：生成层转义字符集 `& % # _`；`$` 除外（保标题数学）。
- **分号诊断不做**（Q10 用户决定）：分号是错误语法，由用户自己管，不加 server/web 提示。
- "以前编译 PDF 没问题"的解释（Q8 调查）：旧 PDF 编译用作者/期刊自带 bib（`\aap`/`A\&A`）；reader 摄入管线不经 library.bib；Stage 10 Writer 单遍 pdflatex 不跑 bibtex 无 bbl，Stage 11 引入 bibtex 才暴露；真实编译缓存证实含 hunt2021 的三次编译全部炸 `&`，无一次成功。

### D5 — ADS BibTeX 原文接入（完整路线 B，Q11–Q14 + 用户两轮修正）
- 用户拍板完整接入（"早晚要改，这是正确的方向"），非一次性迁移版。
- **架构原则（用户明确，通向 Stage 13）**：bib item 是统一的一等存储，**来源无特殊通道**——ADS 拉取 / 用户手动给 bib 全文 / 生成兜底，ADS 只是填充者之一。本阶段设计保持来源无关；library 手动导入接通是下一阶段（Stage 13 预告，本阶段不实施）。
- **存储**（Q12 用户两次修正后澄清）：现状无 bib 全文存储（work 字段清单已核对），library.bib 是派生文件。落地 = **不存 BibTeX 原文 blob**：ADS export 拉取后**解析字段、补齐 work 结构化字段**（新增 volume/number/pages/eid/month/journal_macro 等），`workToBibtex` 输出全部非空字段；library.bib 仍是唯一派生出口。用户原话："不需要单独存bib全文字段，把ads的bib全文字段的field补齐，确保能够回复"。
- **期刊字段输出**：有 `journal_macro`（如 aap）→ 输出 `journal = {\aap}`（宏注入按原方案）；无 → 转义纯文本 `{A\&A}`。venue/journal 显示层维持纯文本不变。
- **补齐原则**：bibtex 解析只补新字段，不覆盖既有字段（title/authors/year/doi/eprint 以现有 normalize 链为准）。
- **key 规则**（Q13 用户修正 + Q17 确认）：分配时有 bibcode → **cite_key = bibcode**（不区分）；无 → 现有 citeKey()；**分配后永不改**（含后来才富化出 bibcode 的条目；此时 bib 原文首行 key 替换为已分配 cite_key 的逻辑保留）。存 ADS 原文 blob 方案已被用户否决（改结构化字段）；key 语义不变：分配时有 bibcode → **cite_key = bibcode**（不区分）；无 → 现有 citeKey()；**分配后永不改**（含后来才富化出 bibcode 的条目）。
- **富化接入**（Q14 确认）：enrichAndPlan 中有 bibcode 且无已存原文 → 批量 ADS export（一次 POST 多 bibcode）；--offline 跳过；失败不阻塞、下次 build 自然重试；已存原文不自动刷新。非 ADS 条目（Crossref/OpenAlex-only）保持生成+转义兜底，不接 Crossref bibtex。
- **期刊宏**（用户确认"按之前定的走"）：`\aap` 等在 aa.cls/aa.bst/TeX Live 均无定义（F4），Writer 编译组装 preamble 注入 `\providecommand` 期刊宏组（覆盖 ADS 常见天文期刊，标注映射来源）；导出 zip 的 manuscript.tex 注入同一组；reader 管线不动。

### D6 — 存量迁移授权（Q15 授权、Q16=a、Q17）
- 一次性迁移：备份 library.json/library.bib 至 /tmp（临时证据）→ 联网批量拉 38 条 bibcode 的 ADS BibTeX 存字段 → **38 条 cite_key 批量改为 bibcode（仅此一次）** → 同步精确替换两个 demo 稿件 cite 命令内的 key（huisjes2025→2026arXiv260303522H、hunt2021→2021A&A...646A.104H；用户授权修改这两个稿件）→ library build --offline 重建 → diff 核对 → Writer 真实编译验证 → 导出 zip 自编译检查。
- **覆盖声明**：本条一次性批量改 key + 新分配规则覆盖 Stage 7"cite_key 只增不改"契约（Stage 7 Q5）的分配侧；分配后不改的精神延续。理由：bibcode 是 ADS 永久标识符，稳定性更强；note/label/star/read 挂 work id 不受影响（F5）。

## 已验证事实

### F1 — I030 根因证据链（2026-09-16 实测）
- 真实库：41 条目 24 处 `journal = {A&A}` 裸 `&`（workToBibtex 无转义的直接产物）。
- 真实稿件 m_851c91f3 编译缓存：含 hunt2021 的 3 个 latexmk 缓存全部 `! Misplaced alignment tab character &`；不含的 1 个成功。
- 隔离实验（/tmp/writer-iso-tCMpqo，临时）：`\citep{huisjes2025}` ✅；`\citep{hunt2021}` ❌（& 崩）；逗号双 key ❌（& 崩）；library.bib 转义为 `A\&A` 后逗号双 key ✅（两个 author-year 标签正确）。
- texInventory 提取本身正确：逗号拆两 key，分号整体一个 key（纯函数实测）。

### F2 — bibcode 作 cite key 可行（2026-09-16 实测）
- 隔离实验（/tmp/writer-iso2-*，临时）：report 模板 + ADS 原文 + `\providecommand{\aap}` 注入；`\citep{2021A&A...646A.104H}`（key 含 `&`）✅；双 bibcode key ✅；标签 `Hunt and Reffert(2021)`。
- 小瑕疵：ADS author 花括号分组使 IR label 带 `{}`（`{Hunt} and {Reffert}(2021)`），真实 PDF 排版不可见；preview 显示层可顺手剥括号（实施时定）。

### F3 — ADS export API 可用
- `POST /v1/export/bibtex`（token ~/.ads/dev_key）实测返回出版方质量 BibTeX：volume/pages/eid/month/doi/eprint 齐全，journal 为 `\aap` 宏，key 为 bibcode。41 works 中 38 有 bibcode；无 bibcode 的 3 条：`work`、`stage5fixt`（测试残留）、`dempsteretal1977`（Crossref/统计学）。

### F4 — 期刊宏无现成定义
- aa.cls/aa.bst 不含 `\aap`（aa.cls 用 `\journalname` 机制）；TeX Live 无 aas_macros.sty（kpsewhich 未找到；I004 的 2603.00229 同因）。宏注入是本接入的必要新建机制。

### F6 — 实施与迁移结果（2026-09-16 午后）
- 四门全绿：1065 passed + 1 可选 skip（Stage 11 基线 1054；净增：I031 web 2、server 保存不编译 1、转义 2、ADS 接入 3、exportBibtex 2、latexmk 缓存自愈 1，删除 debounce scheduler 2）。
- 迁移执行完毕：38 条 ADS 字段补齐（全部命中）、38 条 cite_key→bibcode、Report demo cell 替换（rev 80）；library.bib diff 核对仅预期差异（key/宏/新字段）；note/label/read/star/tags 逐字段核对不变；备份在 /tmp/stage12-migration-backup（临时）。
- **计划外新 bug（已修）**：latexmk 稳定缓存在编译失败后死锁——“Nothing to do”+“previous invocation error”，坏 bbl 阻断 bibtex 重跑。compileTex 失败路径新增清理 aux/bbl/blg/fdb_latexmk/log（输入不动），真实验证（AA demo 修逗号后自动恢复编译成功）。
- 真实 Chrome/CDP 探针（/tmp/stage12-cdp-probe.mjs，临时）：打开 0 编译、输入+暂停 0 编译且 autosave PUT 正常、Shift+Enter 恰好 1 次 refresh、预览渲染出 [Huisjes and Hernández, 2025]（迁移后真实稿件）、再编辑不重编译、Render 按钮第 2 次。全过。
- 导出 zip 内容自编译检查：buildTexDocument+buildBib 产物 latexmk EXIT=0，PDF 引用与书目正确。
- **遗留待用户处理**：AA demo（m_6e480849）cell 里是**全角逗号** `\citep{2026arXiv260303522H，2023A&A...673A.114H}`（IME 产物），natbib 不认全角分隔 → 编译失败属 LaTeX 真值（隔离副本改半角后编译成功）。按 D4（错误语法用户自己管）未代改；key 替换已做。
- CDP 探针教训：Runtime.evaluate 的 returnByValue 不能序列化 DOM 节点（waitFor 表达式需 Boolean() 包裹）；点击类 evaluate 返回值序列化偶发 -32000，用效果断言代替调用成功。
- note/label/read/star/tags 均挂 work id（`doi:`/`arxiv:` 等），不经 cite_key——改 key 不丢用户数据。
- cite_key 消费面：workToBibtex key、graph API `cite` 字段、search 输出、Writer References 侧栏、用户稿件 `\citep{...}`（唯一硬耦合，经 D6 迁移处理）。
- agent 冻结面是输出**格式**非内容；CLI 无输出 library.bib 文本的命令，ref JSON 来自 doc IR 不经 workToBibtex。fixture golden 若含自动 key 生成结果，随已批准行为变更更新。

### F5 — cite_key 变更的用户数据影响面（迁移前排查）

## 待确认事项

- 无未决设计问题；Q18 已确认。等待用户 smoke 后关闭并 commit+push。

## 交接状态

- Stage 12 代码与迁移完成，工作区未提交；等待用户 smoke。
- 下一步（用户确认后）：实施 I031 + I030（转义兜底 + ADS 接入）→ 四门/回归/真实 Chrome → 存量迁移（D6）→ 用户 smoke → commit + push。
- Stage 13 预告（用户 2026-09-16 提出，**未立项未授权**）：library 手动导入接通——用户可给 bibcode 从 ADS 选，也可手动给 bib 条目全文；遵循 D5 的来源无关架构。
- 隔离实验目录 /tmp/writer-iso-tCMpqo、/tmp/writer-iso2-* 为临时证据，可能已清理；关键结论已自包含于本文件。
