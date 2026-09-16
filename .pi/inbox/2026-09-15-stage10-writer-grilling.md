# Stage 10 立项 grilling:Writer(cell 化 LaTeX 稿件编辑器 + 导出)

- Session:stage10-writer-grilling
- 创建:2026-09-15T13:11:41+02:00
- 更新:2026-09-15T13:11:41+02:00(另:共识确认与 UI 先行决策,时间同会话时序)
- 工作状态:完成(Stage 10 关闭;smoke 未通过,缺陷立项 Stage 11)
- 归并状态:未归并
- 范围与授权:阶段已关闭;40+ 源码/测试/文档变更未 commit/push(待用户授权);不操作真实 literatures/ 数据

## 已确认决策

### D1 — 阶段定位与流程(R1 Q8)
- 决策时间与来源:2026-09-15,用户 Round 1 回答"Q8 可以"。
- 结论:立项 **Stage 10:Writer**。流程沿用既有模式:grilling 共识 → 实施方案落 `.pi/memory-reference/` 标"待批准" → 用户批准 → 明确授权后实施 → 四门 + 真实浏览器验证 → 用户 smoke → 用户授权后 commit/push。
- 参照原型:`/tmp/argelander-writer-prototype.html`(用户提供的交互原型,临时文件,非持久权威)。

### D2 — 用户划定的阶段边界(任务开场陈述)
- 决策时间与来源:2026-09-15 用户任务陈述。
- 本阶段**不做 LaTeX 编译 PDF,只做导出 LaTeX**;不考虑 LaTeX"高阶用法",prototype 覆盖的用法即本阶段范围;**不做 template 管理 UI**;本阶段**确定 template 存储形式**,为后续 agent 增加 template 留好协作接口。

### D3 — 功能集边界(R1 Q1–Q4)
- 决策时间与来源:2026-09-15,用户 Round 1"Q1 全做,comment 也做;Q2 你理解正确;Q4 你理解正确"。
- 全做:8 种 cell(latex / abstract-aa / figure / table / code / ack / appendix / recipient)、行间 ＋ 插入、类型转换、删除、template 不支持时无损保留并提示;左栏 Outline(过滤/跳转/插 label);右栏 References + Crossrefs 插入;**Comments 做**(per-cell 纯文本便签);Info 模态(title/authors/affiliations + template 扩展字段);Preamble 模态(template 只读 + user preamble)。
- Compile 按钮砍掉,不留占位;latex cell 渲染照 prototype 正则启发式,**不引入 KaTeX** 或更完整 LaTeX 渲染。
- template **选择/切换保留**(顶栏下拉,切换时 unsupported cell 无损保留);不做 template 内容增删改 UI。
- manuscript 数据独立:不进 library、不挂 work/doc、不支持 annotations;References 数据源 = 整个 library 经 REST 只读,插入 `\cite{key}` 完整命令。

### D4 — manuscript 管理与入口(R1 Q3)
- 决策时间与来源:2026-09-15,用户"Q3 可以,当前阶段进排列所有 manuscript,后续再增加分类等功能"。
- 新 Write 顶级视图(Shell NAV 注册)+ 扁平 manuscript 列表页(标题/模板/更新时间);新建弹窗选 template;删除二次确认;分类等功能后续再说。

### D5 — Template 存储形式(R1 Q5 + R2 Q10)
- 决策时间与来源:2026-09-15,用户 Round 1"Q5 选你推荐的(b)",Round 2"Q10 按推荐,太死不是问题……导出后的问题本阶段先不处理"。
- 每个 template 一个 JSON 文件:内置 aa / report / letter 随 app 包发布(参照 dist/argelander.sty 打包先例),`<dataDir>/templates/<id>.json` 同 id 覆盖内置;坏文件警告跳过不阻塞。
- schema:`id / version / label / chip / preamble(UI 只读)/ types[] / infoFields[]({key,label,input:text|textarea},替代 prototype 的 HTML 字符串)/ frontMatter(带 {{title}} {{authors}} {{info.xxx}} 占位符的模板字符串,导出器解释,不按 id 硬编码)`。
- cell→LaTeX 序列化规则**全局固定在代码**,template 纯声明式数据;不同期刊的导出差异本阶段不处理。
- agent 协作接口 = JSON 文件契约 + schema 文档;本阶段不做 template 管理 CLI/REST/UI。

### D6 — manuscript 存储布局(R1 Q6 + R2 Q9)
- 决策时间与来源:2026-09-15,用户 Round 1"Q6 存储形式应与现在 literature 的存储形式和 agent 可读性相似,仅作一些修改",Round 2"Q9 按推荐"。
- 仿 `output/<doc_id>/` 逐项录形态,置于 dataDir 下(不放 status/):

```text
<dataDir>/manuscripts/
└── m_<8hex>/
    ├── manuscript.json   # version/rev + title/authors/affiliations/template/userPreamble/infoFieldValues + cells[] + comments[]
    └── assets/           # figure 上传图片
```

- `manuscript.json`:pretty 2 空格、tmp+rename、宽松 schema 保留未知键(规避 I010);comments 内嵌,不开 sidecar。
- agent 可读性 = 稳定 JSON 文件契约 + 文档;本阶段无新 CLI。

### D7 — 导出形态(R1 Q7 + R2 Q11)
- 决策时间与来源:2026-09-15,用户 Round 1"Q7 下载为一个包,所有内容在单个 tex 文件内,包含 bib、figure 等,现阶段支持上传",Round 2"Q11 按推荐"。
- server 端组装 zip,web 触发浏览器下载;zip = `manuscript.tex`(单文件:preamble + frontMatter + 全部 cell)+ `references.bib`(**独立文件**,只收被 `\cite` 的 key,从 `library/library.bib` 过滤)+ figure 资产原样文件。
- figure 图片本阶段支持上传,存 `manuscripts/<id>/assets/`,cell 只存文件名引用。

### D8 — 同步/删除/交互细节(R2 Q12、Q13)
- 决策时间与来源:2026-09-15,用户 Round 2 全按推荐。
- 照搬 plans/annotations 工程惯例:web debounce autosave → PUT 带 rev,409 重取提示;watcher 只指纹 manuscript.json(不含 assets,与 epoch review D4 一致);WS 新增 `writer.changed` + web dispatcher 显式分支;server 路由 guardCsrf + 独立 writerLock;删除 manuscript = 物理删除整个 `m_<id>/` 目录;本阶段不加 manuscript URL 深链。
- 交互照 prototype:单击激活、✎ 编辑、Shift+Enter/Render 提交、同时仅一个编辑态;类型转换有损(转 latex 序列化保留,转其他重置数据);无 label 目标自动补 `\label` 再插入;comments per-cell 纯文本、who 固定 "You";列表页 = 标题+template+更新时间。
- 工程约束:新 UI 文案全程 i18n 双语(新增 `writer` 命名空间,Stage 9 约束);`literatures/` 需补 manuscripts/ 的 gitignore 规则(Stage 8 annotations 先例)。

## 已验证事实

### F1 — 代码库集成侦察(scout,2026-09-15,只读)
- 新增 Write 视图 = `packages/web/src/argelander/Shell.tsx` 的 `NAV` 注册表加项 + `renderView()` 加 case;多 pane(Pane[],MAX_PANES=3)与 PaneHeader 视图切换下拉同注册。
- plans 域端到端文件图已取证(contracts/plans.ts、core plans/store.ts、server app.ts 平铺路由 + AsyncLock + guardCsrf、watch.ts 轮询指纹、ws.ts hub、web api/plans.ts + PlanView),Writer 可镜像。
- `GET /api/library` 的 `LibraryRef` 含 `cite`(cite key)/title/authors/year;客户端搜索过滤有 LibraryView 先例;无更轻端点。
- WS union 在 contracts/jobs.ts(z.discriminatedUnion),web dispatcher 在 api/ws.ts 显式 if/else 分支。
- i18n:locales zh-CN.json + en.json,useTranslation/t() 用法,tests/no-hardcoded-copy.test.ts 白名单已空、locale-parity 对拍存在。
- src 下 writer/manuscript 零命中,全新建;web 无文件下载先例(导出 BibTeX 按钮是 stub),需新建 a[download]+createObjectURL 模式;zip 上传先例在 RefDetail + POST /api/library/upload;图片服务先例 GET /images/:doc_id/... 带 sha256 校验与穿越防护。
- 报告:subagent-artifacts/outputs/92d6590b-5b5a-4315-abcc-ba812303c650/context.md(临时证据位置)。

### F2 — 真实数据布局核实(2026-09-15,只读 ls/head)
- `literatures/output/<doc_id>/<doc_id>.json + src/ + build/ + assets/`;`annotations/<doc_id>/`;`library/library.bib` 为全库单一 BibTeX 文件(当时 41 条,key 形如 huisjes2025);`status/plans.json` 单文件。
- 据此确定 D6 的 manuscripts 布局与 D7 的 bib 过滤来源。

### D9 — 共识确认与 UI 先行的实施顺序
- 决策时间与来源:2026-09-15,用户"确认。我只有一点 comment:安排实现计划时先将 ui 实现好,我先看 ui 界面和交互是否符合预期以及和你一块打磨好,然后再补后端实现"。
- 结论:D1–D8 共识确认;实施里程碑按 **UI 先行** 重排——先做 web UI/交互(可用 mock/fixture 数据),用户审阅界面与交互并共同打磨,通过后再补后端(contracts/core/server/导出/同步接线)。
- 覆盖:D1 流程内的里程碑顺序细化;其他决策不变。

### D10 — 方案批准与 M1 实施授权
- 决策时间与来源:2026-09-15,用户"批准。开始实施M1"。
- 结论:[Stage 10 方案](../memory-reference/2026-09-15-stage10-writer-plan.md)由待批准转为**已批准、执行中**;授权实施 M1(contracts schemas/序列化纯函数/web UI 全量 mock 数据层/i18n 双语/四门)。**不**含 M2+ 与 commit/push 授权。
- 覆盖:方案头部"待批准"→已批准(方案文件状态字段随后更新)。

### D11 — UI 评审三点修订(2026-09-15)
- 决策时间与来源:2026-09-15,用户审阅 M1 UI 后:"有几点可以现在就改. 1. latex语法高亮。现在完全没有语法高亮,不利于编写 2. equation无法渲染尤其是 \begin{equation}...\end{equation} 3. 新建还没有打通 这三点现在就改一下"。
- 结论:
  - (a) latex cell 源码编辑器加语法高亮:零依赖 overlay 方案(textarea 文字透明 + 下垫高亮 pre,逐 token 转义,滚动同步,IME composition 期间恢复文字颜色);不引入 CodeMirror,未来需要可再评估。
  - (b) latex cell 渲染支持数学:复用 `src/lib/math.tsx` 的 KaTeX 包装(ensuremath shim 沿用);block 级支持 `\begin{equation|align|gather|multline|eqnarray[*]}`、`$$…$$`、`\[…\]`(env 映射到 KaTeX 支持的 gathered/aligned,eqnarray `&&`→`&`);行内 `$…$`、`\(…\)`(防 `\$` 转义与 `$$` 误配);`\label` 渲染时剥离(干净 latex 先例)。
  - (c) 修复新建断点:零 cell 稿件在编辑器渲染空态提示 + 常显 ＋ 按钮(原实现只在每个 cell 后给 add-row,零 cell 时无任何入口)。
- 覆盖:D3 中"latex cell 渲染不引入 KaTeX"被 (b) **局部修订**——数学经 KaTeX 渲染,其余仍为正则启发式(无完整 LaTeX 渲染、无编号)。
- 验证:web 320 测试全绿(新增 math 分块/高亮/新建空态用例,既有测试零破坏),四门各自 exit 0;真实 Chrome 150 复验三点通过(高亮 token、equation display + inline KaTeX、空态创建首个 cell 进入编辑),console 零错误。截图 /tmp/writer-fix{1,2,3}*.png(临时证据)。

### D12 — 第二轮 UI 评审:高亮可见性修复 + equation 入 crossref(2026-09-15)
- 来源:用户"latex语法高亮还是没有。另外我发现现在equation并不会被解析到crossref"。
- 高亮:本地生产构建实测高亮正常(计算样式透明对齐正确),用户端疑似旧 bundle;同时为防御加固——overlay 选择器提升到 `.w-field .w-src-textarea` 级特异性,压过 `.w-field textarea` 的 background/color 基底规则。提示用户重建+重启 serve+硬刷新。
- equation crossref(新能力,用户明确要):deriveCrossrefs 新增 equation kind——latex cell 内非星号 numbered env(equation/align/gather/multline/eqnarray)逐块一目标(align 多行编号按块近似,代码注释已记);label 取 env 内首个 `\label`,无则生成 `eq:<n>`;CrossrefTarget 增 envIndex。withEnsuredLabel 对 equation 目标把 `\label` 插到对应 env 的 `\begin{...}` 行后(尾部追加会错挂 section)。INLINE_RE 补 `\eqref` 为 xref。Outline 增"公式/Equations"组(章节后),Crossrefs 面板同列;两面板行 key 修重(kind+cell+number)。
- 验证:web 325 测试全绿(新增 equation 派生/env 内插 label/eqref/crossref 面板用例),四门各自 exit 0;真实 Chrome 复验:outline 出公式组、crossref 卡片 `公式 1 · (1)eq:1`、高亮计算样式正确,console 零错误。

### D13 — UI 通过、进入后续实施(2026-09-15)
- 来源:用户"ok, ui可以了。可以进入之后的实现。……后端实现阶段请一并改成用编译器解析。"
- 结论:UI Gate 通过;授权实施 M2–M4(后端存储/REST/同步、导出 zip、gitignore/docs/四门/真实浏览器验证);commit/push 仍需单独授权;用户 smoke 后阶段才关闭。
- "用编译器解析"的具体语义经 D14 澄清为真编译求真编号;D8/D11/D12 中 outline/crossref 的正则派生 → 后端编译真值派生(M3 落地);其他决策不变。

### D14 — 编号求真:单遍轻量编译方案(2026-09-15)
- 来源:用户先澄清心智模型("每次按渲染是会调用 latex 编译器来解析的……真正的编译要好几次,而这里只需要获得编号就可以,先说不要继续干"),父代理摆出分歧与事实后,用户对三点拍板"都接受,可以开始实施"。
- 结论(三点全部接受):
  1. **方向**:渲染编号用真实 LaTeX 编译求真——**单遍轻量编译**(编号/label 在单遍即确定,多遍仅为 \\ref 显示稳定,本功能不要),PDF 产物丢弃不展示;编译失败保留上次成功编号 + 陈旧标记,不打断写作。
  2. **触发**:cell "渲染"按钮保持即时本地预览;编号由**保存后后台 debounce 自动编译**刷新 + 手动刷新入口兑底。
  3. **模板契约加依赖声明**:template 可声明并随模板目录提供 cls/sty 文件(如内置 aa 随包带 aa.cls——本机 TeX Live 缺 aa.cls 有现库实证);编译时 TEXINPUTS 纳入模板依赖目录;agent 未来加模板同此约定。
- 覆盖:**D2"本阶段不做 LaTeX 编译"修订为"不交付/不展示 PDF,编译器参与编号求真"**;D13 提出时父代理的 unified-latex AST 近似理解被用户修正为真编译求真编号。导出仍只是 LaTeX 源 zip(D7 不变)。
- 重新讨论条件:用户明确要求多遍编译/编译 PDF 预览,或模板 class 获取受阻需降级。

### F3 — M1 contracts 域落地(2026-09-15)
- contracts 新增 `src/writer.ts`(CellType/Cell discriminatedUnion + per-type data looseObject + Manuscript/Comment/WriterTemplate/WsWriterChanged schemas;serializeCell/extractCitedKeys/renderFrontMatter/buildTexDocument/defaultCellData 纯函数)与 `src/writer-templates.ts`(BUILTIN_WRITER_TEMPLATES = aa/report/letter,内容照 prototype);jobs.ts WS union 加 WsWriterChangedSchema;barrel 导出。
- 实施调整(不违反决策):内置 template 单源放 contracts TS 常量(web mock 与未来 server 共用),方案 §4.1 的 app dist JSON 分发随之不再必要,agent 面对的文件契约(dataDir/templates/*.json)不变;frontMatter 注入点定为 `\begin{document}` 之后(模板自带 \maketitle,方案§5 措辞为前置,实施时修正);cell data 省略时用 zod v4 `.prefault({})`(v3 式 default 签名不收 {})。
- 验收:contracts build/typecheck/test(79 通过,新增 26)/根 lint 各自 exit 0。

### F4 — M1 完成(2026-09-15)
- coder 子代理(da53b9cf,30 分钟超时于 lint 收尾)完成 web UI 主体;父代理接手修复 20 处 noLabelWithoutControl(htmlFor/id,placement 标签改 span + `.w-field-label` CSS)。
- 新增 `packages/web/src/writer/`(WriterView/ManuscriptList/NewManuscriptModal/WriterEditor/cells/outline/rightTabs/modals/model/fixture + writer.css,共 ~3200 行),Shell NAV 注册 write 视图,ws.ts 显式 writer.changed 分支 + onWriterChanged(M1 未接线使用),locales 双 JSON `writer.*` 各 114 叶子 + `shell.nav.write`。
- 数据层:fixture + localStorage(`argelander.writer-mock`,M2 移除);References tab 接真实 `/api/library`;Export = 客户端 buildTexDocument 单 .tex 下载;figure 上传 UI 存 dataURL(mock)。
- 测试:web 27 文件 311 用例(新增 writer-model/writer-view/ws-writer-branch,既有测试零改动)。四门各自 exit 0(build/test/typecheck/lint 260 文件)。
- 真实 Chrome 150 smoke(合成数据目录 /tmp/writer-smoke-data,已清理):Write 导航、稿件列表、编辑器九 cell 渲染、outline 分组、右栏三 tab、零 console 错误;截图 /tmp/writer-list.png 与 /tmp/writer-editor.png(临时证据)。

### F5 — 编号求真管线核心假设已实证(2026-09-15)
- 环境:TeX Live 本机,pdflatex 单遍;探针 /tmp/wx(临时)。
- `kpsewhich aa.cls` 缺失(与 I004 一致);report/letter/booktabs/listings/graphicx/amsmath 均在。
- **aa.cls 获取**:aanda.org 被 DataDome 403(与工程记忆一致);经 gh code search 在 scottkosty/install-tl-ubuntu 的 aa-package 镜像取得 aa.cls v9.1(2016/09/01),文件头 **Copyright EDP Sciences, all rights reserved**——不宜打进 MIT npm 包再分发;D14 第 3 点的落地形态随之调整:模板依赖目录约定照做(`templates/<id>.deps/`),aa.cls 由用户/agent 放入本机依赖目录,不随包发布(待用户确认此调整)。
- **单遍编译求真编号可行**:wrapper 方式(`\RequirePackage{argelander}` + `\input{main}`,与摄入管线 instrument.ts 一致;直接 \usepackage 进 preamble 不产事件),输出在 `<wrapper名>.argelander.jsonl`;单遍即得 section 事件(number+title+file+line)、mathnum 事件(env+number,align 多行按编号行逐行,\nonumber 不消费)、label 事件(key+file+line);aux `\newlabel` 同得。report 类章节化编号(1.1/1.2)真实呈现。
- **cell 归属方案**:buildTexDocument 组装时记录每 cell 在 main.tex 的起始行,事件按 file+line 映射回 cell,无需正则归因。
- PDF 产物存在但丢弃不展示(符合 D14)。

### F6 — M2a/M2b/M3 离线件完成(2026-09-15)
- M2a(coder ef5015a5):core `writer/store.ts`(缺失→null/损坏→throw/tmp+rename/bumpRev 刷 updated_at/listManuscripts 坏目录跳过+warning/loadTemplates 用户覆盖+坏文件警告+文件名 id 不一致跳过/deleteManuscript 物理删/资产写读净化+碰撞 -N 不覆盖);server writer 9 路由(writerLock/guardCsrf/409 带 {detail,rev,current});watch.ts writer 指纹 + server.ts 接线 writer.changed。core 290/server 202 全绿。交接入 subagent-artifacts outputs/ef5015a5。
- M2b(coder 7f5c744f):web 数据层换真 REST(api/writer.ts 全客户端;fixture.ts 删除;WriterEditor 乐观更新+800ms debounce 串行 PUT 链+409 采纳 current+error 态+onWriterChanged defer;ManuscriptList 三态;图片上传走资产接口);writer-view 测试改 vi.hoisted 内存 mock(语义仿真 rev/409);web 330 全绿,四门绿。
- M3 离线件(父代理):contracts `writer-bib.ts`(buildBib 原样摘条目/引用顺序/去重/missing 注释;修 @comment 跳过与输入去重两自伤);infra `lib/zip.ts`(零依赖 zip writer,zlib.crc32+deflateRawSync,与 unzip.ts round-trip);core `writer/export.ts`(buildWriterExport:tex+cited-only bib+被引资产,404/unknown-template 分类);server 导出路由(X-Writer-Bib-Missing 头)+ web doExport 换 server zip(fetch→blob→a[download],缺引 toast);contracts `writer-numbering.ts`(编号文件/响应 schema + parseAuxLabels + fuseNumberingEvents,真实探针事件做 fixture)+ buildTexDocumentMapped(cell↔行号映射,字节恒等钉死)+ template.deps 字段 + WS cause numbering。contracts 94/core 293/infra 63/server 204/web 330 全绿,lint 零警告。
- 待办:M3b 编号通道 server 编排+web 接线(coder fb5c52f5 进行中);M4 收尾。

### F7 — M3/M4 完成与端到端验证(2026-09-15)
- M3b(coder fb5c52f5,60 分钟超时于 web 接线收尾;父代理接手):infra proc.ts 加 env 透传;server `writer-numbering.ts`(单遍 pdflatex + wrapper 插桩 + 事件/aux 融合 + `manuscripts/<id>/build/numbering.json` 缓存 + 2.5s debounce 单飞 scheduler + 手动 refresh);REST GET/POST numbering;PUT 后自动 schedule;web applyNumbering(sections 按 cell+序、equations 按 cell+envIndex、labels[] aux 优先)+ 面板 stale 标记 + ⟳ 手动按钮。
- **label 绑定经三轮修正**:coder 的 ±1 偏好 -1 在探针 fixture 下错绑(chapter label 毒化 section);最终**按 owner 类型分窗**(section:label 在自身行或下一行;mathnum:±1 行),两套真实证据(父代理探针 + coder 真编译测试)均绿。tex-pipeline 记忆"write 延迟至 shipout 行为不定"再次应验。
- **M4 真实浏览器端到端(合成数据目录,已清理)抓到一个真产品 bug**:report 模板 preamble 无 natbib,`\citep` 致编号编译失败——内置 report preamble 已补 amsmath+natbib;同时修了 regex 兜底派生里 section label 全 cell 抓第一个的问题(改为窗口绑定)。复验:typed→autosave→debounce→outline 显示 **1.1 Intro/1.1 eq:vc**(章节化真编号),edit→stale→自动回 ok;figure 上传+UI img 200;export zip 经 Python zipfile 独立解析验证(tex 完整含 natbib/bib 仅被引/资产字节一致);console 零错误。
- 收尾:`.gitignore` 补 `literatures/manuscripts/`、`literatures/templates/`;新增 `docs/writer-data-model.md`(agent 数据契约:布局/manuscript.json/template JSON/deps 目录/可见性)与 `docs/manual-test-stage10.md`(用户 smoke 手册)。
- 最终四门各自 exit 0:contracts 94 / core 293 / infra 63 / web 335 / server 212 / cli 51(计 1048),lint 274 文件零警告;40 个变更/新增文件。
- 测试陷阱记录:web vitest 走 workspace **dist** 解析,改 contracts/core 后须先 build 再跑下游测试(一次 500 假惊吓)。

### D16 — 提交与推送(2026-09-15)
- 来源:用户"先commit+push"。
- 结果:**`e5c2164`**(51 文件,+9442/−8:Stage 10 全部源码/测试 + docs 两份 + .pi 三份),已推送 `origin main`(`01441a4..e5c2164`,正常 push 非强推,一次性 `git -c credential.helper='!gh auth git-credential'`,未落配置)。工作区干净。
- 提交前树与 F7 最终验收树仅差 .gitignore/docs/.pi 文档,复用该四门证据,未重跑。

## 交接状态

- **Stage 10 已关闭(smoke 未通过,D15)**;[方案](../memory-reference/2026-09-15-stage10-writer-plan.md)已标已关闭;[Stage 11 范围草案](../memory-reference/2026-09-15-stage11-render-pipeline-scope.md)已写入,下一阶段立项由用户拍板。
- 工程交付保留:M1–M4 全部实施并四门绿(1048 测试),真实浏览器端到端验证通过(F7);smoke 否决的是渲染与插入语义的产品形态(F8),进 Stage 11。
- 工作区:**已提交推送 `e5c2164`**(D16),干净。
- 记忆提醒:inbox 现有 5 份未归并 session 文件(epoch-review、mem-31b251a、stage9-i18n、subagent-routing、stage10-writer),接近 8 份阈值且阶段已交界——建议近期安排一次归并整理授权。
- 未操作真实 literatures/ 数据;aa.cls 在本机 /tmp/aa.cls(临时,all-rights-reserved 不随包),用户需要 A&A 编号编译时自行放入 `literatures/templates/aa.deps/aa.cls`。
