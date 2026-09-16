# Writer：现行能力、用户取舍与渲染边界

状态：现行专题，整理于 2026-09-16；Stage 10/11 已关闭，**均不能概括为全部 smoke 通过**。Stage 11 编号由本次用户确认，来源见 [本次 inbox D1](../inbox/2026-09-16-mem-merge-stage11.md)。产品硬约束与显式触发决定摘要在[契约](../memory/contracts-and-decisions.md)，当前遗留问题在 [I030/I031](../memory/known-issues.md)。

## 来源与状态分层

原始决定及覆盖过程均可从 `ee2095c33eb7d6255b1d119619a8de631a574c1e` 恢复：

- `.pi/inbox/2026-09-15-stage10-writer-grilling.md` D1–D14/D16、F3–F7：Writer 初版、UI 先行、编译求真及首次交付。
- `.pi/inbox/2026-09-15-writer-deps-research-grilling.md` D1–D17、F9/F10：成熟编辑器、共享 IR 主干、工程验收、本机依赖及带问题关闭。
- 旧 Stage 10 方案、Stage 11 scope、writer-rendering-consensus 同在该提交。scope 是历史草案，不是未做完的任务表；TeX4ht 候选已被明确否决为默认路线。Stage 10 缺失 D15/F8 的替代证据见[整理审计](2026-09-16-inbox-merge-audit.md)，不补造原文。

**当前实现与新决定分开**：Stage 11 代码仍在停止输入并保存后自动编译；用户 2026-09-16 D17 已决定改为 Shift+Enter/Render 统一显式触发，但尚未实施。自动保存不取消。不要把这项新决定写成既有能力，也不要因为代码较晚读取到旧行为而废除决定。

## 工作台与交互

- Write 顶级视图：扁平 manuscript 列表（标题、模板、更新时间）、新建选模板、删除二次确认。分类/标签以后再说；未做稿件 URL 深链。
- 三栏编辑：左 Outline（过滤、跳转、插 label）、中 cells、右 References / Crossrefs / Comments。模板切换、Info（title/authors/affiliations + 扩展字段）、Preamble（模板只读 + 用户可编辑）均保留。
- 八型 cell：latex / abstract-aa / figure / table / code / ack / appendix / recipient。行间加号、空稿首 cell 入口、激活/编辑/删除；同时仅一个编辑态。转 latex 用序列化内容保留源码，转其他类型重置 data，**有损**；模板不支持的既有 cell 无损保留并提示，不擅删。
- comments 是内嵌 per-cell 纯文本便签，who 固定 `You`，不是 reader annotations 或协作 thread 系统。
- 正文和用户 preamble 用 CodeMirror 6 + `@uiw/react-codemirror` + 官方 legacy-modes/stex。替代 Stage 10 textarea/pre overlay 的原因是实际光标/文字错位；不是继续微调 overlay 字体。
- 只启用适用的现成编辑能力，**不为补全清单自研**。stex 只有高亮，CM 补全 UI 不等于开箱接好 LaTeX 命令/文献/label 语义。
- References 只读整个 library，插入**裸 cite key**；Crossrefs 插入**裸 label**，必要时先给目标补 label。不包 cite/eqref 命令、不猜光标上下文。此为后来的明确修订，覆盖 Stage 10 完整 `\cite{key}` 插入。
- 新 UI 全程 zh/en 双语，遵循现行 i18n 规则；不是再做一套 Writer locale loader。

## 用户数据与协作接口

字段定义以 contracts schemas 为准，agent 操作说明见 [writer-data-model](../../docs/writer-data-model.md)（产品数据契约文档，不是另一个记忆副本）。

```text
<dataDir>/manuscripts/m_<8hex>/
  manuscript.json       # version/rev、元数据、template、userPreamble、infoValues、cells、comments
  assets/               # 用户原始 figure 资产
  build/                # 派生数据，非用户正文
    numbering.json      # 编号与 cell IR 投影、对应关系、错误
    latexmk/            # 可复用中间编译状态
    artifacts/          # facts/fuser 输入
    assets/             # 物化预览图
<dataDir>/templates/<id>.json
<dataDir>/templates/<id>.deps/  # cls/sty/bst 等
```

- manuscript 独立于 work/doc/library，放 dataDir 而非 statusDir，不挂 annotations，不因预览自动入库或重建文库。
- JSON pretty 2 空格、tmp+rename、rev 乐观锁；manuscript/template/cell 使用 loose schema 保留未知键，规避 plans 的 I010。损坏抛错不静默 reset；列表可跳过单个坏目录并给 warning。
- 稿件、cell、comment id 分别 `m_` / `c_` / `cm_` 加 8hex。cell id 必须唯一，重复会阻止映射，不自动改用户文件。
- web debounce autosave 串行 PUT；rev 冲突 409 提示并接纳 current。后续 Render/导出/返回先排空保存队列，失败/冲突不能当保存成功；慢 GET 不得覆盖新本地编辑。
- Writer REST 提供模板读取、稿件 CRUD、资产、export、numbering GET/刷新 POST；写路由有 guardCsrf 和独立 writerLock。协作接口为稳定 JSON 文件契约，**尚无独立 Writer CLI，也无 template 管理 CRUD UI/CLI/REST**。
- watcher 指纹 manuscript.json 与模板 JSON，WS `writer.changed` 有显式 dispatcher 分支；本地写入时 external 重取 defer。资产/模板依赖/bibliography 并非都受监控，必要时手动刷新；不能只写资产就承诺 UI 立即更新。
- 单用户、多 pane 依赖 rev+409 收敛，不做跨进程同稿件同时编译保证。外部原子文件写入是协作接口，不等于任意并发写安全。
- 删除稿件物理删除整个目录；先取消进程组并 drain 正在编译的任务，再 rm，避免后台构建复活目录。`build/` 只在停止服务后可清理重建；不能连同 manuscript.json/原始 assets 当缓存删除。
- `literatures/manuscripts/`、`literatures/templates/` 已被 gitignore；操作前仍实际核实范围，不整体 git add 用户库。

## Template 与导出

- 内置 aa/report/letter 随包，以 contracts TS 常量为单源；**旧方案 dist/templates/*.json 未采用**。用户 `<id>.json` 同 id 覆盖；坏 JSON/schema 或文件名与内部 id 不符则 warning 跳过。
- 模板是声明式数据：preamble、types、infoFields（text/textarea）、frontMatter、deps、bibliographyStyle。cell→LaTeX 序列化规则全局固定在代码，模板不提供执行代码或自定义序列化器；不做 template 内容管理 UI，但选择/切换保留。
- frontMatter 在 begin document 之后展开 title/authors/affiliations/info 占位符，未知占位符为空串。A&A abstract 在 maketitle 前组装供 class 消费，同时保留 cell 源码映射，**不改存储顺序**。
- 内置 Report/Letter bibliographyStyle 为 plainnat；源码有效显式声明优先，注释/代码示例不算。旧自定义模板没 style 就需自行声明，不暗换 plainnat。
- 资产上传原样保存，cell 只存文件名，净化路径、重名加 -N 不覆盖。序列化不自动转义 LaTeX 特殊字符；表格 CSV 仍是简单逗号分割、不支持引号转义。
- server 导出 zip = 单个 `manuscript.tex` + **独立** `references.bib`（只收被引 key、原条目原样摘块、不重新格式化）+ 被引 figure 原资产。缺 key 留 missing 注释/警告；新能力兼容可选参数/星号引用，不回退旧简单正则。
- 缺依赖、缺引用、未验证编译等通过响应头及 `EXPORT-WARNINGS.txt` 提示。下载成功不等于可编译；仍可编辑、保存、导出源码，不偷偷换模板或样式。
- `.cls/.sty/.bst` 放 `<id>.deps/` 并安全复制到编译输入，拒 symlink。**aa.cls/aa.bst 不随 npm 分发**：许可未核清；不能从单文件 all-rights-reserved 头推出一切分发永久不合法，也不能自行改标 MIT。
- 本机 A&A 安装事实与 hash 只记于[工程环境](../memory/engineering.md)，不复制环境状态；未来分发重新核查许可。

## 编译与 IR：共享主干，隔离外层副作用

核心意图（2026-09-15 D13，用户“这一直是我想要的”）：**不是因转换器受阻才妥协，而是优先复用已有模块，不再造 Writer 渲染管线。**

`cells + template + bib + assets → 输入组装/源码映射 → compileTex/latexmk → facts + source AST → 共享 Fuser/IR → cell 投影/展示上下文适配`。

- latexmk 按需跑文献处理与必要多遍，放开 Stage 10 单遍 pdflatex 限制；PDF 产物不展示。不引入 TeX4ht/make4ht 运行依赖；只有具体、已证实且难以合理解决的复用缺口才重新向用户讨论。
- 复用编译、插桩、事实/源码解析、融合、数学和段展示；Writer profile 显式扩展编译态 natbib 语义及映射。**保持 reader 默认显示、CLI 冻结输出和 annotations 契约**；不共享摄入身份归并/library rebuild/doc 删除归档副作用。
- 引用内容/格式、章节、逐行公式、图表号遵循模板编译事实；citep/citet/ref/eqref 不压成同一种 key 芯片。不在 web 自行排号。保留 KaTeX/cell 流式布局，不追求 PDF 分页、栏宽、字体/像素复刻。
- IR 源跨度投影到 cell；侧栏优先当前 IR，未编译源码扫描只作插入目标提示，不是印刷编号真值。旧正文正则 renderer 已移除；无 IR 时待编译提示/源码，不以启发式冒充已编译预览。
- 稳定 latexmk 工作目录保留中间物，输入未变保 mtime。input fingerprint 包括模板、cell 身份/源码、bib、deps、资产；仅 main.tex hash 不足。刷新仍交 latexmk 检查其记录的系统样式依赖，并以当前 fuser 投影，不直接缓存短路。
- 手动/自动入口目前共享按 dataDir+稿件隔离的 single-flight，合并一个最新 follow-up，不积压全部中间版本。新显式触发决定见本文开头；不将加长 debounce 当成完成修复。
- 输入/保存不等待编译；只能在精确源码、模板、目标仍对应时保留旧投影并标陈旧。**同名 label/旧 envIndex 不足以绑定新目标**；新增或结构变化处未解析。失败提供可查看错误，不清稿件、不假装成功。

## 兼容性与验收解释

- 首轮目标：现有模板、常规 natbib 作者年/数字、多 key、前后注/可选参数、星号、编译态标点。已测 `sort&compress` 等不等于任意 natbib 宏完整兼容。
- 明确不承诺 BibLaTeX/任意外部模板/自定义宏全覆盖；longnamesfirst、superscript、正文中途切 citation style 明确报不支持。跨 cell 的单个 IR 块无法安全归属时警告、不猜测；完整环境应放同一 cell。KaTeX 仍受其语法边界约束。
- Stage 10 工程四门/合成浏览器通过，但用户 smoke 指出引用插入/样式、xref、正文公式无号、overlay 光标四类问题后决定关闭；不能把 UI Gate 通过当整个产品通过。
- Stage 11 四门、65 组合成引用与 PDF 文本对拍、A&A 临时类测试、发布包离线安装与真实 Chrome/CDP 通过均有原始记录；仅证明受测范围。用户 Report citation 仍未通过，自动编译影响输入，其余 smoke 用户确认通过（I030/I031）。不以工程绿覆盖用户反馈。
- 未用真实大稿做性能基准；Texifier 只是性能参照，不是延迟承诺或新增 PDF 目标。OS IME/任意浏览器/宏包不作全称保证。
- 持久回归入口：contracts writer-rendering、infra tex-cache、server writer-preview/writer-numbering、web writer-preview/writer-codemirror/writer-view；源码提交和验收摘要见[历史](../memory/history.md)。
