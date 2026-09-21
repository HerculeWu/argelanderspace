# LaTeX 管线：现行机制与验证边界

状态：现行专题，2026-09-21 从 `46093915:.pi/memory-reference/tex-pipeline.md` 迁移。来源：Stage 5 Q1–Q13/MS1/MS2/MS3、smoke R1，Stage 6/7 作者与引用修复，Stage 11 Writer 共享主干。摄入/reader 默认行为不因 Writer opt-in 扩展而自动改变。源码位置仅作导航，不承诺旧行号；原文恢复见 [history](history.md)。改动前同时读 [契约](contracts.md)的印刷编号与 agent 冻结规则。

## 执行层

core `pipelines/tex/ports.ts` 定义编译/图端口，infra `tex/` 执行 workspace/latexmk/instrument/figures，`tex/ingest.ts` 接 source acquisition。`latex/arxiv-source.ts` 仍活跃，不因旧 latex 管线删除而删掉它；tar/zip 都有路径与 symlink 防御。

- 隔离 tmpdir 拷源，拒 symlink，2 GB/10k 护栏。main 可在子目录，wrapper 写 main 同目录、input basename，latexmk cwd 也是该目录，避免相对 input 断链。
- flags `-interaction=nonstopmode -recorder`；pdflatex → 编译失败 xelatex；任一 attempt 超时（120s）直接终止，不重试引擎。detached spawn + kill(-pid) 杀进程组，不能只杀 latexmk 留引擎。
- minted/write18 预扫描逐行剥注释再整文匹配，反斜杠奇偶决定 % 是否注释，多行 usepackage 也能识别。verbatim 示例中的同样文本仍可误拒（I012）。
- **没有加 no-shell-escape**：会破坏 TeX Live 受限白名单的 epstopdf 等可编译论文；预扫描并非通用安全沙箱，默认受限 shell 残余面属于单用户工作台已接受模型。
- 插桩失败回退干净编译并 warning；完全编译失败分类 COMPILE_ERROR/TIMEOUT/UNSUPPORTED + `!` 摘录。干净成功丢 log，降级成功留 log；warnings 经 onProgress/job log，不入 IR。
- recorder 只给引擎，不给 bibtex，fls 通常无 bib 只有 bbl；若需 bib 从 bibliography 源扫描，不能宣称 recorder 已覆盖。
- `--figure-dpi` 历史兼容接收但忽略，不代表 SVG 有 DPI；`--no-assets` 不物化图。

## 插桩与 mathnum（已验证，不作全称保证）

`argelander.sty` 事件族 cite/label/section/mathnum；没有 ref/eqref/autoref 事件。实证环境为本机 TeX Live 2023/Debian、latexmk 4.83（Stage 5 MS1），不是对所有 TeX 版本已验证。

- amsmath 存在时只 patch `tagform@`，因为它重定义 eqnnum 并内部调用 tagform@；双 patch 会双发。缺 amsmath 时 patch 内核 eqnnum。
- 环境白名单挡散文 eqref，ifmeasuring@ 挡 align/gather/multline 测量 pass。display 内 eqref 或含宏 tag 仍可出伪事件，parser 丢 number 含反斜杠的 mathnum 并计数 warning。
- hyperref 的 tag 值会包 Hy@make@anchor，曾击穿 protected edef 导致静默 fallback。捕获在 group 中 let Hy@make@anchor=empty，protected xdef 导出；hyperref fixture 锁死 tag(B)。aux 标签值可为 `{B}` 而事件是 `B`，join 必须剥外层花括号。
- number 取排号参数真值，tag 文本不推进 counter；subequations 3a/3b 已实测。tag* 绕开 tagform@，**无事件**，融合用源码 tag，不扩补丁面。
- 多行 amsmath 事件 line 是环境结束行，eqnarray/equation 可精确行；按环境块+序融合，不能只按行号一对一。
- protected write 延迟至 shipout，浮动体 label 可迟到；事件 id 因丢弃试排盒或 parser 丢事件可有缺口，不能假设连续或全族源码严格有序。
- CurrentFile 对主/子 input/include 已对齐；listoffigures 等生成文件回读可滞留 main 名，caption cite 双发的第二条 line 实为 lof 行。file 对多文件定位有用，对移动参数去重不可靠。
- battery 插桩与干净编译 aux 逐字节相同，只证明 counter/label/aux 不变；whatsit 理论上可影响极端断行，不能写“零排版副作用”。

TeX 实现坑：ExplSyntaxOn 放 def 体内无效（catcode 已冻结），需顶层定义并导出纯字母别名；包装 clist_if_in 时核对参数个数。

## 源树、有界宏展开与正文

- unified-latex 1.8.4（MIT），自管 macro/env signatures；input/include 相对包含文件递归、containment、环剪。节点 file WeakMap 与 CurrentFile 同形。
- fls 双向对拍过滤 wrapper/sty、tmp PWD、绝对系统文件与生成物，差异 warning。
- newcommand/renewcommand/providecommand 提取后 string 级 #N 替换再解析（AST 常将 # 和数字分节点）；支持括号和 undelimited 单 token 参数；展开节点继承调用点 file+position，对宏内 cite 事件有意义。
- def/if/csname/自递归/结构宏重名等病态构造留 raw、warning，记 unexpandableMacros；上限 2000 次/10 pass，两类耗尽都警告。不能当完整 TeX 展开器。
- 展开层跳过 **thebibliography 环境子树**，避免 revtex inline bbl 的 catcode/providecommand 宏汤；宏形 thebibliography 不在排除面，Stage 6 当时无受害者。
- comment/comment* 环境整体 DROP，不是 code；unified-latex 可能把它们标 verbatim，须按 env 名辨别。small 宏+组、组内首字体开关剥壳使嵌套 verbatim 浮出。
- 行尾 `%` 前空格被 parser 并入 comment：查原源码 start 字符补空格，`the %...\nenergy` 不能粘成 theenergy；`a%x\nb` 仍应 ab。
- 脚注正文 DROP（I003）；其中 cite backstop 保关联不等于文本存在。

## 编号、xref、cite 融合

- mathnum 按 display 环境顺序 join。align/alignat/eqnarray/gather/flalign 按行：nonumber 不消费，tag 消费并对拍，tag* 用源不消费；equation/multline 单次。环境失配警告回退 aux/计数，可一次 resync 跳杂散事件。
- 连续整数显示区间 `3–5`，否则逗号连接 `3,X`。真正未编号 display 无自产编号；带显式 tag 的处理按源码和事实，不把“未编号”误解为丢弃作者显式号。
- section 事件含 subsubsection，按序 join+aux brace-strip；缺事件走 labeled aux/计数，appendix 后一级字母，paragraph level4 无号。
- figure/table **lot/lof 优先**，aux 的 @writefile 即使没 listof* 也有；真 lof/lot 文件存在覆盖。同类浮动 FIFO 按序匹配，修 label-before-caption aux 错号；无 caption 无号，回退 aux/计数带 resync。
- ref/eqref/autoref/cref/pageref 由源码 segment+labelMap，行级 label 对行号；eqref 可见文本 `(N)`。标题/表格 cell 是 plainText/HTML、脚注 DROP、未展开宏可不产 segment。
- cite 以展开后源码可见 occurrence 为主，事件用 file/line/keys 对拍；失配查看源行：没有 cite 且无 unexpandable 宏则当移动参数双发丢，否则回退最近块 citationsByBlock。
- **不对称有意**：cite 有 backstop，xref 没有事件通道。旧 hyperlink-only 问题源于 PDF 时代，Stage 7 库内 ref→segment 零丢失后关闭；未来若真有宏隐藏 ref 受害者，参考 cite backstop，但不擅往 segments 塞合成 xref 改冻结输出。

## 表格、参考文献与图

- plain table/table* 与 deluxetable 在融合层处理，无旧 aastex 预重写。caption holder 注册须用实际计算 captionNodes；tabular 查找递归 center/flushleft/flushright/minipage 与 brace 透明层，避免空表体。
- 表注保留；tableBody HTML 供 web table parser 消费。回归不仅检查 number，还检查 caption、tableBody 非空、合法 table/tr/td/th 结构与 code 库存，过去 golden 初版曾冻结缺内容。
- `.bbl` 按编译态真值，随源包 bbl 可能被 bibtex 重生：2012.05220 38→37 条是印刷真值，不是丢 ref。parseOne 对 authors/year/title 等启发式，不能冒充结构化 bib 全覆盖；venue/pages 等不可凭空补。
- revtex cleanBblText：剥注释、bibinfo/bibfield 第二参 fixpoint 解包、BibitemShut 连参丢弃、字体包装与 href@noop/续行噪声清洗；extractDoi 支持 doibase。裸 DOI 后缀要求字母，显式 doi/doi.org 不设此限。
- 不顺手改 parseOne/parseAuthors：Stage 6 尝试数字断尾/paren/Jr 会回归 AASTeX，已回退。长尾伪作者保留，URL % 编码被 TEX_COMMENT_RE 误伤是当时现库零发生的理论面（I012）。
- Web KaTeX 0.16.47 无 ensuremath，math.tsx 用恒等宏 `\\ensuremath: "#1"` shim（Stage 6 smoke）；不因编译端能处理就删渲染垫片。
- TOC预览纯文本化剥完整cite/xref记号，也丢未闭合的尾记号（Stage 7 MS5）：摄入时约60字截断可切开长xref，不能只匹配闭合token。曾选择web修复而不改变IR manifest字节，避免破坏agent冻结。
- 图命名策略归 core texFigureOutName/texFigureOutSuffix，infra 只执行；a/b.png 与 a__b.png 编码非单射为潜伏边界。
- PDF→pdftocairo SVG，EPS→gs pdfwrite（dSAFER/dEPSCrop）→pdftocairo；其余直通。dvisvgm 的三角样本不能证明真实图忠实，已退役。
- 图尺寸提取：SVG 根绝对单位换 px，viewBox 防御兜底；PNG IHDR、JPEG SOF（填充字节边界）、GIF、WebP。未知 best-effort undefined；width/height attrs+height:auto 只预留空间，不改最终响应式大小。

## 当前论文作者块：已修与残余

Stage 6 Q8 对象是当前论文，不是 bibliography 条目富化。meta 增 authorDetails（1-based affiliations）、affiliations、文档 email；agent markdown 不消费这些字段，golden JSON 允许 meta 增量。

三族机械抽取：AASTeX/revtex 顺序、aa.cls inst/institute 位置、手写数学上标+affil。未知降级平铺，ORCID/corresponding 图标及 thanks 脚注正文不做精细还原。

Stage 7 修复后的关键实现：

- revtex currentGroup **懒重置**：affiliation 挂完置位，下个 author 才关组；不能立即重置，否则连续 affiliation 回归。
- email signature `o m`，correspondingauthor `m`（不是幻影第二参）；前置 email 队列，精确或 token 包含且唯一匹配通讯作者，否则文档 email，不猜错人。
- and chunk 剥前导换行；author 尾机构行作伪 affil piece，挂本 chunk 而非全文作者。
- 手写 affil 保印刷号→列表 index 映射，无号 piece 用最小未占用号；乱序/跳号不能靠出现序。
- 逗号拆分有标记阈值（aa 至少两个），前置 sup/thanks/email 吸收归前作者，Jr/Sr 后缀归并；inst/orcidlink 不吸收是已知边界。

I005 残余触发面（Stage 7 MS2 审查，记录不修）：

1. 单机构内部换行可能切成两条；尾标点敏感去重。
2. `Name, inst{1}` 的逗号前置 inst 不归前作者；orphan affiliation 可产生占位。
3. 无标记逗号作者与 Last, First 歧义，不拆；无标记 single piece 尾部可能是第二作者，当前判机构。
4. author 内容为前导换行+Inst X 可造伪作者，与已修 and 换行形态不可区分。
5. printedToIndex 同号冲突后者静默赢；前置 thanks 邮箱走 corresponding 匹配，若碰巧命中别人可能错挂。
6. meta.authors 平铺 blob 可与 authorDetails 不同（当时 2501.17225/2603.03522），不代表 UI 结构抽取失效。

## I016：重复 label 的已接受边界

1610.08981 同 label `Eq:dSph2` 定义两次，first-wins 指向 eq-5，附录 eq-7 不会被该标签指到。这不是 xref 发现丢失；只有源文修正或明确批准新重复 label 策略时重新讨论。来源：迁移基线旧 known-issues 的 I016。

## Writer opt-in 复用与隔离（Stage 11）

用户要求复用已有主干而非复制管线，长期意图/数据保护见 [writer](writer.md)。`compileTex` / latexmk、facts/source、`fuseTexDoc` / Fuser/IR 被 Writer 调用；只增加输入组装、编译态元数据、源码跨度/数学逐行侧表、cell 投影与展示上下文。Writer 不调用摄入身份归并、library rebuild 或 doc/annotation 生命周期。

- `source/tree` 的引用签名本已有 star/两可选注/keys；reader 默认作者年 formatter 不是完整模板排印。Writer 显式 profile 消费编译态 natbib 标点/模式/star/前后注，不能把 profile 默认启用在旧 reader 或重冻 CLI golden。
- 数字引用次序须取编译 bibliography，不能按正文出现顺序自排；`setcitestyle{numbers}` 不意味着 square+comma。真号/引用输出用原生 PDF 文本作限定样本 oracle，不以 `.bbl` 作者字段直接等同所有命令最终显示。
- opt-in 缓存使用稳定工作目录、保未变输入 mtime，完整输入 hash 包含cell身份/bib/deps/assets；刷新仍让 latexmk 检查系统依赖并重新融合。缓存不改变普通摄入隔离 workspace 默认语义，不把 build 派生文件当稿件正文。
- 旧 Writer 单遍事件→编号的行窗口绑定已被共享IR路线取代，不继续维护独立正则正文renderer。编译行号延迟/浮动等陷阱仍须记住，映射失败警告而非猜归属。
- A&A 旧 class 覆盖 enddocument，结束hook未必运行；Writer 元数据改于 begin-document 时取。摘要必须在 maketitle 前组装而不改存储cell顺序；Letter补 bibliography/图表/listing环境。不要把只看IR有文字当PDF实际已消费摘要的证据。
- 引擎/进程退出删除要取消进程组并 drain，防构建复活稿件。Writer 预览错误/不支持显式返回并保旧对应结果，不与摄入的编译失败硬错误/进度warning渠道混为一谈。
- 已纠正对 KaTeX 的误判：库支持 tag/tag*、顶层 align 多行tag；原将align改aligned并clean掉tag是旧实现限制，非换库的必然理由。

持久源码：core `writer/preview.ts`、`pipelines/tex/fuse/compiled-cite.ts`；infra `tex/cache.ts`；server `writer-numbering.ts`。边界/受测样本见 writer 专题，不宣称任意宏/跨cell结构完整。

## 持久证据入口

- core tests：tex-facts、tex-source、tex-fuse、tex-author-block、golden-tex；contracts tex-golden；infra tex-compile/workspace/figures、arxiv-source。
- 编译 fixture：battery/minimal/hyperref、xonly/broken/loopy/minted/commented-minted/minted-multiline/bad-sty；golden `tests/golden/tex/` 两文 2501.17225/2012.05220。
- 大量融合测试吃冻结 aux/bbl/toc/fls/jsonl，不跑编译；少量真编译 gating；golden 的最小可编译图仅验证结构/编号，真实图忠实性另用文字/位图 fixture。
- 历史人工抽查对 ar5iv/aux；ar5iv 罗马编号与 PDF/aux 不同时编译产物优先。golden ordinary regression 与 agent markdown 冻结分别守门。
- `/tmp/texToHTML` 原型曾是孤本风险，未承诺仍在；prototype pagedView/XDV/dviasm 不在现行管线。
