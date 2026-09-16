# Writer 编辑器依赖与编译链路调研

- Session：writer-deps-research
- 创建：2026-09-15T22:25:16+02:00
- 更新：2026-09-16T09:38:12+02:00
- 工作状态：本阶段已关闭（D17）：保留Report citation与自动编译交互两项问题到下一阶段，其余smoke用户确认通过；不表示全部smoke通过或两项问题已修。未commit/push，不自动启动下一阶段。
- 归并状态：未归并
- 范围与授权（截至D14的历史状态）：用户要求网络依赖/许可调研与后端链路核查，按grilling逐轮确认；Q3允许父代理直接补核网络原文。用户最终“确认共识，先将共识落盘”，授权新增共识专题并更新本session交接。未授权实施方案、代码改动、安装依赖、commit/push、正式记忆归并或真实用户数据操作。
- 历史执行授权（当前已按D17结束）：D15“请先实现确定下来的方案”已覆盖D14的仅落盘限制，授权本轮代码/约定依赖实施；共识专题头部与§9仍是D14时点记录，不代表现在禁止实施。commit/push、正式记忆归并均未获授权；D16仅另行授权本机A&A模板依赖补齐，其他真实数据操作仍未获授权。
- 共识历史入口：[Writer编辑器与渲染改进：已确认共识](../memory-reference/2026-09-15-writer-rendering-consensus.md)。本inbox保留原始决策来源、替代过程与取证；D17是后续有效修订：以显式触发替代该专题§5.1/D7的停止输入自动编译。其余产品共识不变，当前代码尚未实施此修订。

## 已确认决策

### D1 — Texifier 是性能参照，不是本阶段新增 PDF 目标
- 决策时间与来源：2026-09-15，本轮 Q1 用户回答“texifier是性能参照，至少当前阶段是”。
- 结论：保留当前 cell 编辑/预览方向；调查本机实时编译的可行性与链路，不因举 Texifier 就扩大为新增 PDF 预览。
- 覆盖：无；澄清本轮范围，不更改既有独立 reader/CLI 契约。

### D2 — 编辑辅助以现成方案能力为准，不为目标清单而自研
- 决策时间与来源：2026-09-15，本轮 Q2 用户回答“主要看解决方案能做到哪一步，这一步先不为了追求什么就自研”。
- 结论：先查成熟包实际提供的能力；不能把 agent 建议的命令/文献 key/label 三类补全视为必须自研补齐的已批准范围。选型报告须区分开箱即用、标准集成/数据接线与需自研的语义能力，具体接受范围待证据后讨论。
- 覆盖：本轮 agent 的“三类补全一起作为目标”仅建议，未获批准；Stage 11 范围草案仍无方案批准效力。

### D3 — 用户允许父会话直接恢复网络调查
- 决策时间与来源：2026-09-15，用户 Q3 回答“允许”。
- 结论：父会话可使用现有网络搜索/网页读取工具核查官方原文，不修改子代理配置、不安装依赖、不改产品代码。此为针对 F2 故障的明确恢复方式授权；未启动第二个 workflow。
- 覆盖：下方 Q1 恢复授权待确认 → 已确认；原子任务 failed 的事实不改写为成功。

### D4 — 编辑器基线采用 CodeMirror 6 + React 包装 + 官方 stex
- 决策时间与来源：2026-09-15，用户对Q4/Q5回复“全部采纳”。
- 结论：采用CodeMirror6 + `@uiw/react-codemirror` + `@codemirror/legacy-modes` 的stex作为方向；先解决成熟编辑、高亮、光标；只启用现成能力，不承诺定制LaTeX补全、不为补齐清单自研。尚未安装、钉版或批准实现细节。
- 覆盖：Stage10 D11的自研textarea/pre overlay编辑方案 → 拟以成熟编辑器替代；本次选型决定覆盖同范围旧方案，但代码尚未修改。

### D5 — 放开单遍限制，以 latexmk 按需完成编译
- 决策时间与来源：同D4，用户采纳Q5推荐。
- 结论：后台使用latexmk，按需运行文献处理与必要的多遍编译；正确性优先、复用中间产物、避免无谓重编译；仍不展示PDF。编译结果进入cell的方式、等待/错误呈现和更新时机留后续问题。
- 覆盖：Stage10 D14“单遍轻量pdflatex编号求真”的编译次数/调度边界 → 不再硬限单遍，由latexmk按需收敛；D14不展示PDF、不打断写作的方向不因此废除。不是采用LaTeXML/TeX4ht的授权。

### D6 — cell语义/编号求真，不追求PDF版式
- 决策时间与来源：2026-09-15，用户Q6按推荐。
- 结论：引用内容与格式、章节/公式/图表编号遵循模板和编译结果；保留cell流式布局，不还原PDF分页/栏宽/字体排版。citep/citet/ref/eqref各自语义不能压成同一种key芯片。
- 覆盖：Stage10正文启发式key芯片/无编号方案 → 本轮改进目标；不是给任意宏包排版兼容承诺。

### D7 — 保存后停止输入自动编译，Render可立即请求
- 决策时间与来源：2026-09-15，用户Q7按推荐。
- 结论：停止输入并保存后自动编译；Render立即请求刷新。连续修改合并，编译中仍可编辑，只补跑最新状态，不堆积全部中间版本。防抖时间经实测确定，无未经验证的性能承诺。
- 覆盖：细化现行保存后自动编译；2.5秒等当前常数不是冻结契约。

### D8 — 陈旧/失败结果有界保留，不错绑新内容
- 决策时间与来源：2026-09-15，用户Q8按推荐。
- 结论：不阻塞输入/保存；可确定对应关系的旧显示保留并标陈旧，新增或结构变化处显示未解析占位，不能把旧编号挂到新公式。编译失败给出可查看错误，不清稿件、不假装更新成功。
- 覆盖：细化D14旧编号保留到cell正文的适用边界；不更改reader/annotations三态规则。

### D9 — 首轮覆盖现有模板与常规natbib写法
- 决策时间与来源：2026-09-15，用户Q9按推荐。
- 结论：以现有模板及其常规写法为验收边界，含natbib作者—年/数字模式、可选参数、星号变体；保留扩展能力，不承诺BibLaTeX/自定义宏/任意外部模板全覆盖；不支持必须明确暴露，不静默显示错误结果。
- 覆盖：本轮兼容性边界，latexmk可调Biber不等于本阶段承诺完整BibLaTeX渲染。

### D10 — References/Crossrefs统一插入裸key/label
- 决策时间与来源：2026-09-15，用户对Q10/Q11回复“全按推荐按”（按推荐确认）。
- 结论：References插入裸cite key，Crossrefs插入裸label；不自动包装cite/eqref命令，不根据光标位置猜测命令。命令由用户输入或现成编辑器能力提供。
- 覆盖：Stage10 D3/D8的References插入完整cite命令 → 裸key；再次明确Stage11草案P1记录的smoke修订，当前源码尚未修改。

### D11 — 缺模板依赖时保留写作/源码导出，明确预览受阻
- 决策时间与来源：同D10，用户采纳Q11。
- 结论：缺cls/sty/bst时仍可编辑、保存、导出源码；明确提示预览未完成及具体缺项，不偷偷换模板/引用样式，不伪装正常预览或已验证可编译。依赖由用户/agent本机补齐；许可未核清的文件不随npm分发。
- 覆盖：补全缺依赖用户体验与发布边界；不把某文件all-rights-reserved头等同永久禁止分发的法律判断，也不授权本轮下载/分发未核清文件。

### D12 — Q12先采纳后暂停，优先澄清reader既有管线复用
- 决策时间与来源：2026-09-15，用户先对Q12回复“按推荐”，随后立即“等一下”，问现有文档浏览latex→latexmk→中间文件→IR→消费IR为何不能复用。
- 时序与权限：用户最初采纳的是借助make4ht引用渲染、不全量接管正文数学、先设验证门槛的候选方向；后续明确暂停要求先讨论复用，不能把最初同意当成不可重议的最终选型或实施授权。D4–D11其他决定不自动撤销。
- 父代理回应：架构与模块原则上可复用；先前把选项缩成自写natbib/TeX4ht的二分不完整，TeX4ht可行探针不证明引入它有必要。暂停路线定案，先核对reader究竟保留/渲染哪些引用语义，区分共享解析融合与入库副作用。
- 同协议源码核查：原scout最新20195b1b完成后恢复为 `61c3ff10-8b5b-45cf-b8dd-1b8d0c1e3ec1`，只查核心编排/facts/source/fuse/IR/web渲染复用面，不新增编译探针、网络搜索、依赖安装或产品改动；待其附录C证据。

### D13 — 强烈确认复用既有编译→IR→展示主干，替代Q12默认方案
- 决策时间与来源：2026-09-15，用户回答“Q13 强烈同意！！！这一直是我想要的，之前没说清楚，不好意思”。用户强调这是其一直以来的目标，不是因技术受阻才临时妥协。
- 结论：Writer优先复用现有latexmk编译能力→编译事实+源码AST→IR融合→展示主干；增加Writer输入组装、源码/块到cell映射、缓存/调度/陈旧保护与展示上下文适配，补约定范围内引用语义。共享已有模块而非另外复制一条Writer渲染管线。不新增TeX4ht运行依赖，不以PDF预览替代cell。
- 覆盖：D12中曾采纳但随即暂停的make4ht/TeX4ht引用渲染默认方向 → 既有IR主干复用。F4/F5转换器探针仅保留历史可行性参考，不能继续作为拟实施架构。只有出现具体、已证明难以解决的缺口才重新讨论外部转换器。
- 冻结与范围：保持reader既有默认行为与CLI冻结输出，不借共享改动摄入身份/library/annotation副作用；D4–D11其余决定继续有效。当前仍只完成调研/设计讨论，未授权写实施方案、代码、依赖安装、commit/push或真实数据操作。
- 父代理责任：用户意图合理；先前二分遗漏复用评估是agent的问题，不将额外调研绕路归咎用户未说清。

### D14 — 整体共识确认与仅落盘授权
- 决策时间与来源：2026-09-15，用户在六点整体汇总后明确“确认共识，先将共识落盘”。
- 结论：D1–D11与D13所确定的有效方向及范围整体确认；D12/Q12旧TeX4ht默认候选已被D13替代。授权将共识单独保存到`.pi/memory-reference/2026-09-15-writer-rendering-consensus.md`，并在本session记录入口及收尾。
- 授权边界：只落盘共识，不是实施方案或代码实施授权，不安装、不迁移用户数据、不commit/push，也不顺手修改旧stage11草案或正式记忆。
- 单一共识入口：新共识文档维护本轮当前结论；本inbox继续保留各决定发生时序、理由、取证纠正与历史来源，不裁剪未入Git原文。

### D15 — 用户授权实现已确认方案
- 决策时间与来源：2026-09-16，用户“请先实现确定下来的方案”。同session跨日继续本inbox。
- 结论：授权按已确认共识实现产品代码、引入约定编辑器依赖、补充测试并完成工程四门；取代D14/共识文档§9的“只落盘、尚未实施授权”这个当时执行状态。产品共识本身不变，不新增TeX4ht/PDF方案。
- 范围：父代理直接执行；原grilling的只读调查委派不扩成新的实现子代理授权。不开新workflow、不切工具配置。保持main工作树起点三个记忆文件改动，保留其他session原文。
- 不包含：真实稿件/文献库/标注操作、数据迁移、commit/push、自动记忆归并。
- 实现约束：优先共享编译/facts/source/fuse能力；Writer显式渲染适配避免改变reader默认/CLI冻结输出；输入快照/源码映射及缓存只处理派生构建数据。

### D16 — 用户授权补齐本机 A&A 模板依赖
- 决策时间与来源：2026-09-16，用户测试A&A时遇到指定目录缺aa.cls/aa.bst，明确要求“你帮我补全了”。
- 范围：允许在`/home/wwu/project/bibgraph/literatures/templates/aa.deps/`安装这两个缺失依赖；使用F8/F9已验证、hash一致的本地镜像副本，不覆盖其他文件、不修改稿件/文库/标注，不安装到系统TeX，不改变npm分发边界。
- 覆盖：D15禁止真实数据目录操作 → 仅对本次本机模板依赖补齐作窄范围例外；其余限制不变。

### D17 — 用户smoke结论、触发方式修订与阶段关闭
- 决策来源：2026-09-16，用户明确“目前report的citation渲染未通过”，“停止输入即开始编译”使编辑器总是上下移动、大文档卡顿且影响输入；决定“改成用户按下shift+enter/点击render，再一起渲染”，要求两点记录到下一个stage集中处理，并确认“其余smoke均通过”“本stage可以先关闭”。记录时间2026-09-16T09:38:12+02:00。
- 结论：**本轮Writer编辑器与渲染改进阶段关闭，保留两项已知问题（下方I1/I2）；其余smoke依据用户确认通过。** 阶段关闭不代表Report citation已通过，也不代表本轮工程合成探针能覆盖用户工作稿件。
- 新的产品决定：下一阶段将编译/渲染改为用户Shift+Enter或点击Render时统一显式触发，不再由停止输入/自动保存启动编译。理由是保护连续输入体验、避免频繁重绘/布局跳动与大文档卡顿。此决定不取消自动保存，不退回独立启发式正文renderer，不改变共享编译→IR路线及失败/陈旧保护。
- 覆盖：D7及共识专题§5.1的“停止输入并保存后自动编译” → 上述显式触发；仅修订触发方式，D5的latexmk必要多遍/缓存与D8数据保护继续有效。保留旧决定和工程证据作为历史，不能由当前仍自动编译的代码反推新决定无效。
- 执行授权：本次仅记录结论和关闭当前阶段；下一阶段集中处理I1/I2，尚未在本次开始定位或实施。当前阶段的D15实施授权随关闭结束，不继承为自动修复、commit/push或新阶段实施授权；正式记忆归并仍需单独授权。

## 已取得证据与局限

### F1 — 本地链路报告已完成
- 观测：2026-09-15，scout 正常完成，父代理已读取报告。报告引用当前源码并做合成 /tmp 编译，不曾编译真实稿件；未跑四门。
- 主要源码证据：server/src/writer-numbering.ts 编号 workspace 只写 main.tex/assets，不写 references.bib；单遍 pdflatex，无 bibtex/biber，aux 等工作目录完成即清；contracts/src/writer-numbering.ts facts 无 citation 渲染数据；web/src/writer/cells.tsx 正文不接 numbering，xref/cite 只作 key chip，真编号仅流向面板。
- 额外缺口：contracts/src/writer.ts 引用正则不识别可选参数/星号；内置 writer-templates.ts 不设 bibliographystyle，合成 report+natbib 无 style 时 latexmk exit12，补 plainnat 后成功。小稿约0.30s单遍/1.80s收敛是子代理合成探针数据，不是实际大稿指标。
- 父代理保留意见：报告把 bbl label 直接等同完整 citation 显示真值、把 pdflatex+bibtex 一遍推广为足够所有模板，以及把 KaTeX 概括为“永远无编号”均过强；用户尚未接受这条捷径。须区分 key/编号事实、bib 元数据、最终 cite 命令/包宏/模板语义。报告关于无自研补全的分级也是建议，不是用户已批数据接线。

### F2 — 网络子代理失败，已有报告只作部分证据
- workflow `5792b63a-eb44-4760-89a9-9e94f50e7872` 顶层 state complete，但子任务为 1 completed / 1 failed，不能以顶层 complete 视为调查全完成。
- failed child `3276b761-3736-4522-a4aa-b84a3767ea91` 原错误：`Agent 'researcher' requested unavailable child tools: fetch_content, get_search_content, source_check.` 工具 allowlist 不负责加载扩展。未擅自换 runner/foreground/CLI、改配置或重试。
- 回执未绑定成功 outputReference，但按配置路径确有 `research/web-dependencies-and-latex.md`（27,046 bytes）；父代理已读取，保留为 partial，不伪称正式成功。文件有 CM6/Monaco/Ace 官方链接及候选栈，但多处依据搜索模型转述而非原文。
- 须补核/不得照抄：不存在任何 MIT LaTeX 补全数据/只有 texlab 的全称断言；Texifier 外部引擎只能手动、系统 TeX 不能实时的推导；GPL/AGPL“任何复用都会改整个MIT项目”式无条件断言；aa.cls 单文件头不等于全部上游许可事实；contenteditable 不保证本项目 IME 零缺陷。
- 证据根：`/home/wwu/.pi/agent/sessions/--home-wwu-project-bibgraph--/subagent-artifacts/outputs/5792b63a-eb44-4760-89a9-9e94f50e7872/research/`；本地报告 `current-writer-chain.md`，网络 partial `web-dependencies-and-latex.md`。

### F3 — 官方原文补核与关键纠正（父代理直接）
- 观测：2026-09-15。搜索只用于定位，关键事实通过 HTTP 下载官方原文后读取；临时原文/manifest 在 `/tmp/writer-web-primary-8u64vhtd/`，不承诺长期存在。首批 urllib 请求150秒超时，改有总时限的 curl IPv4 成功；不据网络超时推断包不可用。源码通过 CodeGraph 再核正文/facts/workspace 接线。
- **Texifier 用户性能参照成立**：官网 macOS 1.8.4 release notes 原文 `App-wide auto-typeset setting used with external typesetter`；preferences 原文有 Auto-typeset、`.texpadtmp` 保存中间物、BibTeX/Biber；external 文档列 MacTeX/TeXLive。TexpadTeX 是另一个内嵌 live 引擎，但不能推出外部引擎只能手动。latexmk 作者手册明确 `-pvc` 自动重编译/按需重复引擎与 BibTeX/Biber、`.fdb_latexmk` 复用。替代网络 partial 报告相反断言；不是大稿延迟保证。
- **编辑器许可证**：下载 CM state/view/language/commands/autocomplete/legacy-modes 的 LICENSE，均 MIT（所查文件字节相同）；uiw React wrapper MIT；Monaco MIT；Ace BSD-3-Clause。npm registry 本次观测 legacy-modes 6.5.4、uiw 4.25.11（React>=17）、monaco 0.56.0、ace-builds1.44.0、react-ace15.0.0（React18 peer允许），不是实施钉版。MIT项目可使用满足各自义务的宽松许可依赖，不要求所有第三方改标MIT；发布前仍须锁定版本/传递依赖及内联包notice检查。
- **CM6 LaTeX**：官方 legacy-modes/mode/stex.js 是现成stream高亮，languageData只有commentTokens，没有LaTeX语义补全源。autocomplete官网明确库负责菜单/筛选等，CompletionSource仍需应用提供数据与上下文判定。cite/label数据接线确需少量应用代码，不能偷换为完全开箱即用，也不能替用户裁定“不算自研”。
- **不可照抄搜索MIT标签**：TeXlyre codemirror-lang-latex 的当前 package.json v0.6.1明确 `AGPL-3.0-or-later`，LICENSE为AGPLv3；本轮不推荐直接内联进MIT-only分发。宽泛“任何GPL复用都强制整个项目改许可证”不采纳，外部进程/聚合/组合分发需分别看。
- **补全不是没有现成MIT数据**：LaTeX Workshop根LICENSE为MIT，`data/commands.json`有beginend/数学等现成snippet；但含VSCode占位符/动作，不能直接等同CM6即插即用；具体取用文件及来源仍需审计。撤回“无任何MIT命令数据/唯一完整方案texlab”的全称断言。Ace已核latex高亮mode，未核到有效latex专用snippet数据，不宣称现成完整LaTeX补全。
- **KaTeX无需因“不能显示编号”而换库**：官方支持tag/tag*；父代理用本项目已安装KaTeX0.16.47无写盘实测 `x=y\\tag{2.3}` 与顶层align两行独立tag均成功。现代码把align改成aligned且cleanLatex剥tag，这与库自身能力不同；MathJax能自动编号/label/ref，但其独立计数并不自动等于本机TeX模板真值。暂不建议为此引入MathJax。
- **后端有现成方案，但不同层**：latexmk是现成本机编译编排器，不生成cell HTML；LaTeX.js LICENSE MIT但官方limitations明确不能直接加载原生LaTeX包/classes；LaTeXML LICENSE公共领域/CC0等效声明，存在natbib binding（cite/citep/citet等），是完整HTML转换候选而非小型npm替换；make4ht README声明LPPL1.3，提供TeX4ht HTML链路与BibTeX/latexmk构建动作。后两者的真实模板覆盖/cell映射/速度尚未实测，不默认立项。
- **建议而非决定**：CM6+uiw+stex作为编辑器首选；后端先讨论允许latexmk按需多遍与缓存，不把既有单遍限制当永不变；编号/引用结果仍要接回cell，保留KaTeX可行；完整HTML转换路线是否值得做须由保真目标决定。

#### F3 官方证据入口
- CodeMirror：[legacy LICENSE](https://github.com/codemirror/legacy-modes/blob/main/LICENSE)、[stex source](https://github.com/codemirror/legacy-modes/blob/main/mode/stex.js)、[autocomplete example](https://codemirror.net/examples/autocompletion/)；[uiw LICENSE](https://github.com/uiwjs/react-codemirror/blob/master/LICENSE)。
- [Monaco LICENSE](https://github.com/microsoft/monaco-editor/blob/main/LICENSE.txt)、[Ace LICENSE](https://github.com/ajaxorg/ace/blob/master/LICENSE)、[TeXlyre manifest](https://github.com/TeXlyre/codemirror-lang-latex/blob/main/package.json)、[LaTeX Workshop commands](https://github.com/James-Yu/LaTeX-Workshop/blob/master/data/commands.json)。
- [Texifier 1.8.4](https://www.texifier.com/docs/apps/release-notes/macos/1.8.4)、[preferences](https://www.texifier.com/docs/apps/settings/preferences)、[latexmk 作者手册](https://www.cantab.net/users/johncollins/latexmk/latexmk-480.txt)。
- [KaTeX supported](https://katex.org/docs/supported.html)、[MathJax numbering](https://docs.mathjax.org/en/latest/input/tex/eqnumbers.html)、[LaTeX.js limitations](https://latex.js.org/limitations.html)、[LaTeXML LICENSE](https://github.com/brucemiller/LaTeXML/blob/master/LICENSE)、[make4ht README](https://github.com/michal-h21/make4ht/blob/master/README.md)。

### F4 — HTML转换探针首轮与明确补跑（2026-09-15）
- scout续跑 `def308de-e381-41e1-9bed-9c2ed013e047` 完成，报告同路径追加附录A。实测本机make4ht0.3m/tex4ht/htlatex可用，latexml/latexmlc未装（未安装）。
- 合成report+natbib默认make4ht生成正确章节/逐行公式编号、ref/eqref链接；HTML有标签id/源码行号注释，**只说明映射线索，不证明任意cell可正确分割**。默认数学部分PNG化，默认构建不跑BibTeX。
- 修正轮mk4仅加Make:bibtex导致仍未解析citation：用户mk4替换默认构建序列，缺后续LaTeXpass，已归因为探针配置错误，不作make4ht不支持natbib的证据。完整引用HTML仍未验证。
- 父代理据已读官方文档明确授权同协议补证，复用最新scout运行恢复为 `20195b1b-f67e-4347-bed4-4baa180a901d`：新/tmp源目录，完整htlatex→bibtex→htlatex→htlatex；至少检最终HTML citation，三/四作者区分star，数字/作者年对照；成功后可查mathjax输出选项是否保留数学TeX（不加载浏览器MathJax）。不安装、不改产品、不读真实数据。等待原生完成通知。
- 父代理另纠正附录A建议：相同label key不能独自证明陈旧facts可以绑定到当前目标，仍须D8对应关系证据；自行分配数字引用不是既定实现方向，编译已产生的数据不应在web再造一套。

### F5 — 正确make4ht完整序列已验证natbib可见结果
- 观测：2026-09-15，scout `20195b1b-f67e-4347-bed4-4baa180a901d` 正常完成，父代理已读同报告新增附录B。新/tmp/wp4/{authoryear,numbers,mathjax}合成稿（report+plainnat，两条假bib含四作者），mk4完整htlatex→bibtex→htlatex→htlatex。
- author-year及numbers两组HTML文内citep/citet、多key、前后注、star结果与latexmk PDF+pdftotext文本一致；四作者的非star et al.与star全名确实区分。数字模式按plainnat文献字母序（Jones=1、Smith=2），不能按正文引用先后自行编号。HTML有cite span、X<key>锚点及thebibliography区。F4/A.3未验证citation项在该report样本范围内关闭；失败过程仍保留为探针配置错误。
- 完整序列+mathjax选项：公式原TeX保留且零PNG；但本机生成物缺display真编号，align行label未入aux、对应eqref为??；HTML默认含MathJax CDN脚本（未加载/执行）。不能将此模式当无成本接KaTeX/编译真号的方案；默认模式仍有部分PNG数学。MathML/mjcli未实测。
- 小稿make4ht三组wall 1.43/1.35/1.36秒仅示意；未包含产品保存/排队/HTTP/大稿成本，不作交互延迟承诺。
- **仍未证明**：任意cell及单次citation的可靠归属/分割、A&A/letter/abstract-aa/listings等模板适配、缓存后重复编译开销、与原latexmk编号编译合一的安全性。源码行号注释只是线索，不是归属正确的证明。
- 待用户选择建议：优先考虑借助make4ht/TeX4ht现成natbib渲染能力，而非自写完整natbib格式器；不全量接管cell或数学，保留现有cell/KaTeX方向，相关片段接回需设验证门槛。此混合使用方式尚属提案，并非已实现/实测整个产品或获授权实施。

### F6 — 既有reader管线可复用，TeX4ht没有被证明是必要依赖
- 观测：2026-09-15，scout `61c3ff10-8b5b-45cf-b8dd-1b8d0c1e3ec1` completed，原报告附录C。父代理读取并用CodeGraph现源码再核formatCitation、fuseTexDoc、Segments。
- **已有复用主干**：`core/src/pipelines/tex/pipeline.ts:117` 的fuseTexDoc已将编译与融合解耦：parseTexFacts→loadTexSourceTree→buildTexDocIr；编译端已有latexmk/workspace/instrument，IR与web段渲染已有xref编译号、公式number/latex、图表号事实。不能把writer未接此主干说成必须另造管线。
- **citation并非从零做**：source/tree.ts `CITE_SIG="s o o m"`已识别命令族/star/两可选注/keys；walk.ts citeSegment已处理命令mode、前后注、多key，格式结果折入IrCiteSegment.raw。但star在融合时未消费；`fuse/cite-format.ts:44–68`按作者年语义重建，固定标点/分隔，不提供完整natbib数字模式、模板标点、star全作者。现reader关联/跳转正确，不等于引用文本与模板PDF逐字相同。
- **仍需适配**：fuser内部源码位置到cell映射尚未向Writer导出；Writer编译会话需缓存/调度/新鲜度控制；引用精确语义需扩展现有融合/格式能力而非照搬当前输出。数字应取编译数据，不在web重排。成本不宜未测即称“少量”。
- **前端不是零胶水直接挂组件**：Segments（web/src/lib/segments.tsx:37）显式useStore，引用/导航依赖reader上下文；可共享段渲染/抽纯展示并提供Writer适配，但不能直接宣称“原组件无条件可用”。
- **隔离外层与冻结面**：不复用摄入身份归并、library rebuild、doc/annotation生命周期等副作用；不因此改变reader既有默认显示与CLI冻结输出。报告把整个reader IR schema称“冻结”过宽：正式硬约束是agent输出/标注数据保护；增量内部字段须按可见影响评估。可考虑Writer显式选项/内部源码映射侧表，具体API未定。
- 结论/建议：优先共享latexmk→facts+source→IR→展示主干，Writer加输入/位置/调度/渲染上下文及限定natbib兼容适配；TeX4ht退出默认依赖候选，只有确定复用方案无法合理满足目标时再单独讨论。此为拟提交Q13的新推荐，用户尚未确认，不能自行视为覆盖D12。

### F7 — 共识落盘与文档核验完成
- 观测：2026-09-15T23:51:28+02:00。新共识专题11,075 UTF-8 bytes，标“已确认共识，非实施方案”；本inbox D14与头部给出入口。未修改旧Stage11草案、正式memory或其他session原文。
- 检查通过：两份本轮文档的本地链接4处、26项共识保真断言、文件结尾/行尾空白、D14及入口存在性、git diff --check。暂存区为空；git状态只有起点旧Stage10 inbox修改+本inbox+新共识专题。
- 纯文档落盘未跑代码四门，未安装、未改产品/用户数据、未commit/push。研究失败子任务仍按F2记录；父代理授权补核及有效证据在F3，不能将整个原workflow说成全成功。
- 收尾统计：inbox六份session文件约84KB，超过40KB整理提醒线；只提醒后续另行授权整理，不自动归并或裁剪。
- 本次任务已完成，下一步由用户决定；不自动开始实施方案或产品开发。

### F8 — 实施中间检查点（未交付，2026-09-16）
- 父代理单写者直接实现；用户中途“Retry the previous request”按继续未完成实现处理，不重置diff、不再调研选型。
- 已接入初版：CM6+uiw+stex及活光标适配；共享compile opt-in缓存/Writer元数据→facts+AST→Fuser Writer profile→IR源位置/数学逐行侧表→Writer cell投影；旧reader默认formatter/IR不变。Writer原客户端正文正则renderer已移除，侧栏源扫描只作插入目标提示，不充当印刷编号。
- 已验证：原contracts94、core293、infra63测试通过；新server共享链路7项真编译/调度测试通过（作者年/数字/opts/star/逐行公式、bib/deps/cell身份失效、失败保旧及恢复、Letter图表代码与图资产、手动/自动single-flight、删除drain防复活）；web旧状态机26与新增IR保护3/实际CM2通过。不是最终四门或完整UI验收。
- 发现并修正：natbib setcitestyle{numbers}并不等于square+comma，必须尊重编译态标点；Letter原缺thebibliography与bibsection；CodeMirror Shift-Enter须高优先级，IME检查compositionStarted而非composing（后者要首次变更后才真）。happy-dom selectionchange同步重入需测试shim，不当真实浏览器证据。
- A&A补证：官方ftp HTTPS证书域名不匹配、HTTP503；未绕过TLS，改用公开镜像bardsoftware/template-AA，仅下载/tmp/writer-aa-deps-OdsiD5。aa.cls v9.0（63,901B，SHA256 ea145a512937441ff6e8522b4c6d36b4b7d1220d5eec8c10235dfc3ac83ec743），aa.bst（32,103B，7be30a1f0cda29f0c150101e52968723bd0e0ad2785213e3e15d08f25203eec9）；未安装到系统/真实dataDir/项目或npm包，不宣称官方最新版本。
- A&A真编译初轮发现：该旧class覆盖enddocument，结束hook元数据未发；模板原把abstract放在maketitle后，PDF摘要为空但IR有文本。正在修：元数据改begindocument/end；抽象cell原文在maketitle前组装并保持cell源码映射，不修改manuscript存储顺序。待复跑A&A与完整回归确认。
- 尚未完成：完整四门、真实浏览器/打包许可检查（脚本已加新增编辑器运行依赖notice收集）、最终diff自审、操作文档与收尾。当前所有源码改动都是在制品，不能据此声称实现完成。

### F9 — 本轮实现及最终工程验收完成（2026-09-16T02:35:13+02:00）
- 覆盖F8的在制品状态。父代理直接实施和自审，未新增实施/审查子代理；未变更工具配置。工程完成不等于用户产品smoke通过或阶段关闭。
- 编辑器：CM6 + uiw + 官方stex替代textarea/高亮覆盖层；正文与用户preamble共用成熟组件。光标插入、换行、Shift-Enter和组合输入已接通；只插裸cite key/label，无自研语义补全。Render/导出/返回先排空保存队列；失败/冲突不当作保存成功，慢GET不能覆盖新本地编辑。
- 共享链路：Writer调用原compileTex/latexmk、facts+AST、Fuser/IR、数学与segment显示组件；Writer profile携带编译态natbib标点/作者年或数字语义、TOC/章节/浮动体/listing及逐行公式事实。IR源跨度投影到cell；侧栏优先用当前IR目标，未编译源码扫描只作插入提示。移除旧正文启发式渲染。没有TeX4ht依赖、PDF预览或摄入/重建library/标注生命周期副作用。
- 缓存/安全：稳定latexmk工作目录、输入未变则保留mtime；fingerprint含模板、cell身份/源码、bib、依赖和资产。请求刷新仍让latexmk检查其记录的系统样式等依赖并用当前fuser投影，不以main.tex指纹直接跳过。真测试证明未变输入时.fdb_latexmk mtime不变且事实一致。手动/自动共享single-flight、合并最新follow-up；删除取消进程组并drain，不能复活稿件。路径/符号链接防护及重复cell id fail-closed；不重写用户数据。
- 陈旧/失败：以精确cell源码、模板和引用目标对应关系保留旧投影；变更目标不套旧编号。错误和不支持内容可展开查看，输入保存不等待编译；导出保留源码并附EXPORT-WARNINGS.txt。A&A缺aa.cls/aa.bst不替换样式、不捆绑类文件。
- 模板与回归修正：Letter补必要bibliography/图表/listing环境；A&A摘要在maketitle前编排但不改变稿件cell存储顺序，编译态样式探针兼容旧aa.cls覆盖enddocument；空label不发\\label{}以免生成伪重复标签。截图发现的侧栏重复React key、comment-only行误吞词间空格均修复并补回归。
- **最终四门全部exit 0**（最后完整轮次02:26:52结束）：build、test、typecheck、lint。contracts 100 / core 293 / infra 67 / web 323 / server 220+1默认skip / CLI 51，合计1054通过；默认skip是可选外部A&A类测试。随后以F8临时类目录追加整份server writer-preview测试，**9/9通过**（02:28轮次），补齐该外部依赖分支。lint 284文件无警告，git diff --check通过；未修改冻结golden、CLI代码或真实数据。旧Stage10 inbox起点diff未动。
- 原生PDF oracle：13种引用形式×5种配置（作者年、默认数字、方括号/逗号、无额外空格的notesep、sort&compress），**65组**与pdftotext结果一致，含同作者年份合并、星号、注释、多key与重复key；不据此宣称任意natbib/自定义宏完备。A&A证据仍限F8的v9.0镜像文件，不宣称官方最新版本。
- **最终发布包离线安装+真实Chrome/CDP smoke通过**：只用临时HOME/data/profile、合成bib与稿件。校验编译引用/逐行公式及xref、CM换行无水平溢出/无旧overlay、组合输入中文保存不误触Render、活光标裸key插入、stale/fresh切换不残留侧栏重复行、Shift-Enter保存并更新IR；无runtime异常。不是仅happy-dom证据，也不替代用户真实输入法/工作稿件验收。
- 许可/打包：收集20个编辑器运行依赖MIT notices；uiw两个npm包缺LICENSE，使用与官方v4.25.11原文逐字节一致的版本限定副本。最终tar包含sty/web/notice，**不含aa.cls/aa.bst**。无发布或安装到全局。
- 临时证据（可能随/tmp清理失效）：四门日志`/tmp/writer-gate-{build,test,typecheck,lint}.log`；AA日志`/tmp/writer-aa-final.log`；最终包与安装`/tmp/writer-pack-final-HyyNlJ/`；浏览器`/tmp/writer-browser-3r9Osf/evidence.json`及`preview.png`；脚本`/tmp/writer-browser-smoke.mjs`。关键验收逻辑和回归已进入本次源码测试diff，非只依赖临时日志。
- 边界/剩余验证：不承诺任意模板/BibLaTeX/宏；natbib longnamesfirst、superscript、正文中途切换引用样式明确报不支持；跨cell块不能安全映射时明确警告；KaTeX仍受其语法边界限制。未用真实大稿件作性能基准，不能承诺Texifier延迟。构建仍有大JS chunk提示。操作与数据说明已更新`docs/writer-data-model.md`。
- 工作区仍main@e5c2164，全部实现及本轮新文件未暂存/未提交。后续由用户smoke或另行授权review/commit/push/整理；无自动后续实施任务。

### F10 — 本机 A&A 配套文件安装与合成验证通过
- 观测：2026-09-16T09:11:48+02:00。目标`literatures/templates/`原不存在；仅新建`templates/aa.deps/`和`aa.cls`、`aa.bst`，用排他创建防覆盖，未更改任何稿件或其他用户文件。
- 来源：F8的`/tmp/writer-aa-deps-OdsiD5`副本（公开bardsoftware/template-AA镜像）；安装前后SHA256与F8记录逐一一致，aa.cls 63,901B/v9.0/2016-01-01，aa.bst 32,103B。不宣称最新官方模板；原版权头原样保留。
- 验证：`WRITER_AA_DEPS=/home/wwu/project/bibgraph/literatures/templates/aa.deps corepack pnpm --filter @argelanderspace/server exec vitest run tests/writer-preview.test.ts -t 'A&A class'` → **1 passed / 8按筛选skip**；从已安装目录读取两个文件后复制到临时合成dataDir，验证摘要位置、原生引用样式和逐行公式引用。未编译真实稿件。日志`/tmp/writer-aa-local-install-test.log`为临时证据。
- `.gitignore`既有`literatures/templates/`规则生效，两个文件不进入源码/npm包。没有产品代码变动，未重复全四门、未commit/push。用户回到稿件点刷新预览即可重试依赖已补齐的编译，不需重装应用；不保证其稿件没有其他独立LaTeX错误。

## 问题变化：下一阶段集中处理

### I1 — Report 模板 citation 渲染未通过用户smoke
- 状态：**开放，转下一阶段**；来源为D17用户实际测试反馈。
- 范围：Report模板的citation显示未满足用户验收；本轮未取得具体稿件/引用命令/错误截图，根因尚未定位，不先归咎于模板、文库或用户源码。
- 证据边界：F9的65组合成引用对拍结果仍是其样本范围内的事实，但不能用这些通过记录否定本次用户反馈或宣称Report已全面通过。
- 下一阶段工作：先取得可复现输入与期望结果，再定位并补真实受害模式的回归；本次只记录，未修复。

### I2 — 停止输入自动编译造成布局跳动与输入卡顿
- 状态：**开放，转下一阶段；触发方式的新决定已确认（D17）**。
- 用户报告：频繁UI重绘表现为“编辑器总是上下来回动”，文档大时会卡顿，并影响输入；本轮未新增性能profile，不把重绘、DOM重挂载或编译CPU开销等候选机制写成已定位根因。
- 处理方向以D17为权威：取消停止输入/自动保存触发的编译，改为Shift+Enter/Render后统一编译渲染；保持自动保存与编译解耦。新行为尚未实现。
- 下阶段验证重点：连续输入和暂停时不触发编译渲染、视口/光标稳定；显式操作渲染最新已保存稿件；较大文档输入流畅，并保持编译失败/陈旧对应关系等既有数据保护。不将加长debounce冒充已确认的显式触发方案。

## 待确认事项

### Q1 — 网络调查恢复方式（已解决）
- 用户D3已允许直接补核，F3完成本轮所需关键官方事实。原故障保持记录，不修子代理配置。

### Q2 — 下一轮设计前沿
- 截至D14：本轮设计树已收敛：Q4–Q11及Q13有效，Q12旧默认方案由D13替代；用户D14已完成整体共识终确认，并仅要求先落盘。没有当前待用户补答的产品分岔，实施细节留待后续授权。
- 截至F10：D15已经授权实现，F9完成本轮工程验收；无需重新grilling已决事项。当时待用户实际smoke及后续指示。
- 当前：D17关闭本阶段，I1/I2留下一阶段集中处理，其余smoke用户确认通过。新的显式触发方向已经决定；复现资料、实现和后续阶段安排留待下一轮，不在本轮自动展开。
- 附录A/B/C均已完成（F4–F6），最新续跑61c3ff10 completed，无活跃调查子任务；不用继续探测已退出主线的TeX4ht候选。

## 调查与交接状态

- 起点：`/home/wwu/project/bibgraph`，`main@e5c2164`；已有 `.pi/inbox/2026-09-15-stage10-writer-grilling.md` 修改，保持不动。
- 唯一顶层只读并行 workflow：`5792b63a-eb44-4760-89a9-9e94f50e7872`。researcher `3276b761-3736-4522-a4aa-b84a3767ea91` 查网络官方资料与许可；scout `3304c10e-1c42-4c03-bc06-37dd4184461f` 查本地代码和合成编译证据；均 `kimi-coding/k3:high`、fresh、无实施权限。
- 网络子代理缺目录列举工具，询问两个 inbox 的准确文件名；父代理已提供全清单，未允许跳读，未切换工具/runner。
- D1/D2 已在两份报告修订文本中体现；父代理已核读，但未采纳报告的全部建议。
- 2026-09-15T22:42:10+02:00 核对：仍 main@e5c2164，同一 cwd，无独立 worktree；git status 仅起点旧 inbox 修改+本 session inbox 未跟踪。父代理捕获旧 inbox 完整 diff，未改源代码/用户数据。
- 截至F7：网络partial中的过度概括由F3逐项纠正，作为历史材料保留而不直接采信；本地报告勘误和复用核查在F4–F6。有效共识已由D14确认并写入新专题，F7文档核验及收尾完成，等待下一步指示，不自动实施。
- 截至F7：本轮写入只含自己的inbox和新共识专题；起点旧stage10 inbox修改保持不动；产品源码、依赖、真实数据、正式memory、旧stage11草案均未改，未commit/push。纯文档落盘不跑代码四门。
- 工程过程以D15/F9、本机模板依赖安装以D16/F10为准；**产品收尾以D17为准：本阶段已关闭，两项问题转下一阶段，其余smoke通过。** 原实现代码仍在未提交工作区，新显式渲染行为尚未实现；未commit/push，未自动立项或继续修复。
- 本次收尾仅更新自己的inbox，未修改产品代码、测试、正式memory/专题或其他session记录；纯记录未重跑四门。inbox当前6份session正文约96KB（D17写入前），超过40KB提醒线且阶段交界，建议另行授权整理；未自动归并/裁剪。
- 启动时 inbox 5 份正文合计 58,251 bytes，已提醒超过 40 KB 整理线；新增本文件后仍须全读，不自动归并。
