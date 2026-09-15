# Stage 10 方案:Writer(cell 化 LaTeX 稿件编辑器 + LaTeX 导出)

- 状态：**已关闭**（2026-09-15 用户 smoke **未通过** 但决定关闭本阶段；发现的渲染链路问题立项下一阶段专门大修，见 [Stage 11 范围草案](2026-09-15-stage11-render-pipeline-scope.md)）
- 编制:2026-09-15;基线 main@2b433ea(工作区仅 grilling inbox 与本方案两个未跟踪文件)
- 共识来源:[session inbox](../inbox/2026-09-15-stage10-writer-grilling.md) D1–D9(Round 1 Q1–Q8 / Round 2 Q9–Q13,用户逐题确认;D9 定 UI 先行)
- 交互原型:`/tmp/argelander-writer-prototype.html`(用户提供的参考,临时文件)
- 本方案获批准且用户明确授权实施前,不动任何代码。

## 1. 目标与非目标

**目标**
1. 新增 Write 顶级视图:manuscript 扁平列表页 + cell 化稿件编辑器,功能对齐 prototype(去掉 Compile),含 Comments。
2. manuscript 与 template 的 JSON 文件存储契约(literature 式逐项录),为后续 agent 增加 template / 读写 manuscript 留稳定接口。
3. LaTeX 导出:server 组装 zip(单一 `manuscript.tex` + 被引过滤的 `references.bib` + figure 资产),浏览器下载。
4. figure 图片上传与展示。

**非目标(本阶段明确不做)**
- ~~LaTeX 编译 / PDF 预览;Compile 按钮不保留占位。~~ **(D14 修订)** 不交付/不展示 PDF,但**编译器参与编号求真**:M3 增加编号通道——保存后 debounce 单遍轻量编译(pdflatex 单遍,编号/label 单遍即定),PDF 丢弃;失败保留上次编号+陈旧标记;手动刷新入口。template 契约增依赖声明(cls/sty 随模板目录提供,内置 aa 带 aa.cls),编译 TEXINPUTS 纳入。cell 级"渲染"仍是即时本地预览。
- template 的创建/编辑/删除 UI;template 只能经文件(未来 agent)增加。
- prototype 未覆盖的 LaTeX 高阶用法;latex cell 不做完整 LaTeX 渲染(正则启发式照 prototype)。**修订(D11,2026-09-15 用户 UI 评审):数学渲染引入 KaTeX**——block 级 amsmath env/$$…$$/\[…\] 与行内 $…$/\(…\) 经 KaTeX,latex 源码编辑器加语法高亮。
- manuscript 分类/标签(用户明示后续再做);manuscript ↔ work/doc/plan 关联;manuscript 上的 annotations。
- manuscript 的 URL 深链、CLI 命令、REST 以外的 agent 接口。
- per-template 的序列化差异(用户确认:这是导出后的问题,本阶段不处理)。
- bib 内嵌 tex(thebibliography/filecontents);zip 以外的导出格式。

## 2. 里程碑总览(UI 先行,D9)

- **M1 数据契约 + web UI 全量(mock 数据层)**:contracts schemas 与序列化纯函数(纯类型/纯函数,无 server 运行时行为,UI 类型化需要);web 端 Write 视图完整交互,fixture + localStorage 作为临时数据层;References tab 直接接现有 `GET /api/library`(无需后端工作);Export 按钮 = 客户端调序列化器生成**单 .tex** 下载(无 zip/bib/资产,提前暴露序列化效果供打磨);图片上传 UI 先做,mock 内存 dataURL。
- **Gate:用户审阅 UI/交互,共同打磨**(可多轮)。打磨完成、用户明示前不进 M2。
- **M2 后端存储与同步**:core writer store + templates 加载;server REST(CRUD/资产上传与服务);watcher + WS `writer.changed`;web 数据层替换为真实 REST + autosave/rev/409;localStorage mock 删除。
- **M3 导出 zip + 编号通道**:core 导出组装(tex 生成 + bib 过滤)+ infra 最小 zip writer + server export 路由;web Export 切换为 server zip 下载。**编号通道(D14)**:`core/src/writer/numbering.ts` 复用 infra 隔离 workspace/插桩(argelander.sty 随 app 包)跑单遍 pdflatex,融合 argelander.jsonl 事件 + aux `\newlabel` 得 label↔编号/section/公式真值;`manuscripts/<id>/build/numbering.json` 存上次成功结果(仿 output/<doc>/build/);REST `GET …/:id/numbering` + 手动 POST 刷新;web outline/crossrefs 改用真值(never→正则占位,stale→陈旧标记)。figure/table cell 编号保持按序(cell 结构即真值)。
- **M4 收尾**:gitignore、agent 数据契约文档、四门、真实浏览器验证(合成数据目录)、交付用户 smoke 步骤。

## 3. 数据契约(packages/contracts/src/writer.ts)

zod v4(`^4.4.3`),一律 `z.looseObject` 保留未知键(规避 I010 的 strip 遗憾,agent 协作前提)。barrel `contracts/src/index.ts` 导出。

### 3.1 Cell

```ts
CellTypeSchema = z.enum(["latex","abstract-aa","figure","table","code","ack","appendix","recipient"])
```

每型 data 为 looseObject,字段与默认值照 prototype `defaultData`:

| type | data 字段(默认) |
|---|---|
| latex / ack | `source: ""` |
| abstract-aa | `Context/Aims/Methods/Results/Conclusions: ""` |
| figure | `caption:"", label:"", placement:"left"\|"center"\|"right"="center", width:80(35–100), image: string\|null = null`(assets 内文件名) |
| table | `head:"", csv:"", caption:"", label:"", placement="center", width:92(40–100)` |
| code | `language:"Python", caption:"", label:"", lineNumbers:true, code:""` |
| appendix | `{}` |
| recipient | `name:"", organization:"", address:""` |

`CellSchema`:`z.discriminatedUnion("type", …)`,各分支 `{ id: /^c_[0-9a-f]{8}$/, type, data }`。若 zod v4 对 looseObject 的 discriminatedUnion 组合有限制,退化为 `{id, type: enum, data: z.record(...)}` + 代码侧 per-type 默认值合并,实施时验证并在交付说明记录。

### 3.2 Manuscript / Comment / Template / WS

```ts
CommentSchema(loose)   = { id: /^cm_[0-9a-f]{8}$/, cell: string, who: string = "You", body: min(1), created_at: datetime }
ManuscriptSchema(loose)= { version: literal(1), id: /^m_[0-9a-f]{8}$/, rev: int≥0,
  template: string, title: string = "Untitled manuscript",
  authors: [{ name, aff: string, email?: string }], affiliations: string[],
  userPreamble: string = "", infoValues: record(string) = {},
  cells: Cell[] = [], comments: Comment[] = [],
  created_at: datetime, updated_at: datetime }
WriterTemplateSchema(loose) = { id: /^[a-z0-9][a-z0-9-]*$/, version: literal(1),
  label: string, chip: string, preamble: string,
  types: CellType[](非空), infoFields: [{ key, label, input: "text"|"textarea" }] = [],
  frontMatter: string }
WsWriterChangedSchema  = { type: "writer.changed",
  cause: enum(["put","external","create","delete","template"]).optional(),
  id: string.optional(),   // manuscript id;template 变化时省略
  at: string }
```

`WsWriterChangedSchema` 加入 `contracts/jobs.ts` 的 `WsServerMessageSchema` union;**web dispatcher 必须加显式分支**(工程教训:else 全当 job 曾打断编译)。

## 4. 存储与同步

### 4.1 布局(共识 D5/D6)

```text
<dataDir>/manuscripts/
└── m_<8hex>/
    ├── manuscript.json   # ManuscriptSchema,pretty 2 空格,tmp+rename
    └── assets/           # figure 上传图片原样文件
<dataDir>/templates/<id>.json   # 用户/agent 扩展,同 id 覆盖内置
内置 templates:app 包资源 dist/templates/{aa,report,letter}.json
               (copy-assets.mjs 先例,参照 dist/argelander.sty;npm pack 验收含其存在性)
```

`.gitignore` 增补 `literatures/manuscripts/` 与 `literatures/templates/`(Stage 8 annotations 先例;M4)。

### 4.2 core(src/writer/store.ts,镜像 plans store)

- 路径助手 `manuscriptsDir/templatesDir/manuscriptDir/manuscriptPath`。
- `loadManuscript`:缺失 → `null`;JSON 损坏/schema 失败 → **throw,绝不静默重置**(plans 先例)。
- `saveManuscript(dir, doc, {bumpRev})`:tmp+rename、pretty 2 空格、bumpRev 时 rev+1 并刷新 `updated_at`。
- `listManuscripts`:扫 `m_*` 目录读 summary(`id/title/template/updated_at/rev`);单个坏目录跳过并计 warning,不阻塞列表。
- `deleteManuscript`:物理删除整个 `m_<id>/` 目录(含 assets)。
- `loadTemplates`:内置目录(由 server deps 注入,app 包解析,dev fallback 参照 web-dist/sty 分发链)+ 用户目录;同 id 用户文件覆盖内置;坏文件(JSON 损坏/zod 失败)收集进 `warnings` 并跳过,不阻塞;返回 `{ templates, warnings }`。
- id 生成:`newManuscriptId/newCellId/newCommentId`(`m_/c_/cm_` + crypto.randomBytes 4 字节 hex,p_/t_ 先例)。

### 4.3 server REST(app.ts 新分区,平铺;`writerLock = new AsyncLock()`,与既有锁互不阻塞;每个 mutation 内 `guardCsrf`)

| 路由 | 语义 |
|---|---|
| `GET /api/writer/templates` | `{ templates, warnings }`(合并内置+用户) |
| `GET /api/writer/manuscripts` | `{ manuscripts: summary[] }`,updated_at 倒序 |
| `POST /api/writer/manuscripts` | body `{ template, title? }`;未知 template → 400;创建目录与初始 manuscript.json,广播 `writer.changed{cause:"create", id}`;201 返回完整 manuscript |
| `GET /api/writer/manuscripts/:id` | 完整 manuscript;不存在 404 |
| `PUT /api/writer/manuscripts/:id` | body 过 ManuscriptSchema;lock 内 rev 校验,不符 → 409 带当前 rev;`saveManuscript(bumpRev)`;广播 `{cause:"put", id}` |
| `DELETE /api/writer/manuscripts/:id` | 物理删除目录;不存在 404;广播 `{cause:"delete", id}` |
| `POST /api/writer/manuscripts/:id/assets?filename=…` | raw body;扩展名白名单(png/jpg/jpeg/gif/webp/svg)+ 大小上限(20 MB);重名加 `-N` 不覆盖;写 `assets/`;返回 `{ name }`;manuscript 不存在 404 |
| `GET /api/writer/manuscripts/:id/assets/:name` | 文件服务,穿越防护(badId/路径净化先例),no-cache |
| `GET /api/writer/manuscripts/:id/export` | zip 下载(M3) |

### 4.4 watcher / WS / web 数据层

- `watch.ts` 增加 manuscripts 指纹(逐 `m_*` 目录 `manuscript.json` 的 mtimeNs+size 集合)与 templates 指纹(目录文件集合);**资产不指纹**(与 epoch review D4 一致)。变化 → `writer.changed{cause:"external"|"template"}`。server 自写会再收 external,前端重取幂等(既有先例)。
- web `api/writer.ts`:fetchTemplates / fetchManuscripts / fetchManuscript / createManuscript / putManuscript(409→conflict)/ deleteManuscript / uploadAsset / exportUrl。
- web `api/ws.ts`:`writer.changed` 显式分支 + `onWriterChanged` listener set。
- WriterView 数据层(PlanView 先例,组件内 state):编辑触发 debounce(~800 ms)autosave → PUT 带 rev;409 → 重取并提示;外部变更 → 当前文档重取(本地写入中 defer,plans pendingExternal 先例);顶栏 save 状态 Saved/Saving/Error。

## 5. 导出(M3)

core `src/writer/export.ts` 纯函数:

- `buildTex(manuscript, template)`:
  `template.preamble` + `userPreamble` + frontMatter 渲染 + `\begin{document}` + cells 逐段 `serializeCell` + (存在被引 key 时)`\bibliography{references}` + `\end{document}`。
  frontMatter 占位符:`{{title}}`、`{{authors}}`(预格式化逗号连接)、`{{affiliations}}`(换行连接)、`{{info.<key>}}`;未知占位符替换为空串(行为文档化)。
- `extractCitedKeys(cells)`:扫描全部字符串字段的 `\cite*?{...}`(支持逗号多 key),按出现顺序去重。
- `buildBib(keys, libraryBibText)`:按 `@type{key,` 条目块过滤 `library/library.bib`;库中缺失的 key 在 bib 尾部留 `% missing: <key>` 注释并计入 `warnings`;**零格式化改写,原样摘块**。

infra `src/lib/zip.ts`:**手写最小 zip writer**(镜像 `unzip.ts` 风格与零依赖原则;stored + `deflateRawSync`;CRC32 用 Node ≥20.15 的 `zlib.crc32`,不可用时退化内置小表实现;不加 npm 依赖)。

server export 路由:zip 成员 = `manuscript.tex` + `references.bib` + `assets/<原文件名>`;`\includegraphics` 路径与 zip 内 `assets/` 前缀一致;`Content-Type: application/zip` + `Content-Disposition: attachment; filename="<title-slug>.zip"`;web 端 `a[download]` 触发(**新建下载模式,项目无既有先例**)。

## 6. cell→LaTeX 序列化映射表(全局固定,template 不可覆写;共识 D5)

| cell 类型 | LaTeX 输出 |
|---|---|
| latex | `data.source` 原样 |
| abstract-aa | `\abstract{Context}{Aims}{Methods}{Results}{Conclusions}`(prototype 五参数格式) |
| figure | `\begin{figure} \centering \includegraphics[width=<width/100>\columnwidth]{assets/<image>} \caption{…} \label{…} \end{figure}`;image 为 null → `% no asset` 注释行替代 includegraphics |
| table | `\begin{table} \centering \caption \label` + `tabular`:列数=表头列数,列格式全 `l`;规则线 `\hline`(通用,不用 booktabs);CSV = 简单逗号切分(prototype parseCsv,**不支持引号转义**——本阶段边界);行 `&` 连接 `\\` 结尾 |
| code | `\begin{lstlisting}[caption={…},label={…},numbers=left/right 省略] … \end{lstlisting}`(listings 由 template preamble 负责) |
| ack | `\begin{acknowledgements}…\end{acknowledgements}` |
| appendix | `\appendix` |
| recipient | `% recipient` 注释 + name/organization/address 原样行 |

- **不做 LaTeX 特殊字符自动转义**:cell 内容是 LaTeX 级稿件文本,caption/abstract/CSV 内允许 LaTeX 命令(与"不做高阶用法"边界一致,文档化)。
- 类型转换:→ latex 用 `serializeCell` 结果填 `source`;→ 其他类型 `defaultData` 重置(有损,共识 D8)。
- cell 渲染(web 展示)照 prototype 正则启发式:section/subsection→标题、cite/xref 上色、段落化;**数学经 KaTeX 渲染**(D11 修订):display env 抽取映射 aligned/gathered,行内 $…$/\(…\),复用 lib/math.tsx 的 Math 组件;不排印编号。latex 源码编辑器为 overlay 语法高亮(D11)。

## 7. Web UI 结构(M1)

- `Shell.tsx`:`NAV` 加 `{ k:"write", labelKey:"shell.nav.write" }`;`renderView()` 加 case。CommandPalette 与 PaneHeader 由 NAV 驱动自然获得;多 pane(MAX_PANES=3)天然支持。
- 新增 `packages/web/src/writer/`:
  - `WriterView.tsx`:pane 容器,list/editor 两态。
  - `ManuscriptList.tsx`:扁平列表(标题/template label/更新时间,updated_at 倒序);New 按钮;删除二次确认(项目惯例)。**不提供独立重命名**——标题经 Info 模态编辑(共识 Q13f 列表字段=标题+模板+更新时间)。
  - `NewManuscriptModal.tsx`:标题 + template 选择(必选)。
  - `WriterEditor.tsx`:顶栏(标题/save 状态/template 下拉/Info/Preamble/Export)+ 左 Outline + 中 cells 流 + 右 References|Crossrefs|Comments 三 tab;面板可折叠(照 prototype)。
  - `cells.tsx`(renderFor/editorFor/行间＋/类型菜单/unsupported banner)、`outline.tsx`(过滤/跳转/插 label)、`rightTabs.tsx`、`modals.tsx`(Info/Preamble/删除确认)、`model.ts`(crossrefs 派生、编号、slug、自动补 `\label`、comments 过滤等纯函数)。
  - `fixture.ts`:**M1 临时** mock(内置 template fixture + 示例 manuscript),localStorage 持久(`argelander.writer-mock`,与 Tweaks key 隔离),M2 删除并由 api client 替换;文件头部注释标"临时, M2 移除"。
- 交互照 prototype(共识 D8):单击 cell 激活、✎ 进编辑、Shift+Enter 或 Render 提交、同时仅一个编辑态;行间 ＋ 插入;cell 类型菜单含删除;unsupported cell 无损保留 + banner;References tab 接真实 `GET /api/library`,搜索过滤照 LibraryView 先例,点击插入 `\cite{key}`;Crossrefs/outline 对无 label 目标自动补 `\label` 再插入;Comments per-cell 纯文本,`who` 固定 "You"。
- M1 Export:客户端调 contracts 序列化器生成单 `.tex`,`a[download]` 下载(无 zip/bib/资产),提前暴露序列化效果供打磨;figure 上传 UI 先做(drop-zone/文件选择),mock 内存 dataURL 展示,M2 换真实资产接口。

## 8. i18n(Stage 9 约束)

- locales 双 JSON 新增 `writer.*` 命名空间 + `shell.nav.write`;**M1 即双语同写**(locale-parity 对拍与 no-hardcoded-copy 扫描自动覆盖,白名单已空,新文件 CJK 即失败)。
- key 规范沿用:域嵌套 + 英文语义 camelCase 叶子,插值 `{{var}}`,条件文案拆 key。

## 9. 测试策略

- contracts:schema round-trip;looseObject 未知键保留;discriminated union 各分支;序列化映射表逐型 golden(文本快照);frontMatter 占位符替换;extractCitedKeys(多 key/去重/无引用);buildBib(过滤正确 + missing 注释)。
- core:store load/save/tmp+rename;损坏 → throw 不静默;listManuscripts 坏目录跳过;loadTemplates 覆盖语义 + 坏文件警告跳过;id 生成格式。
- infra:zip writer round-trip(自写 unzip 解回校验成员名与字节)。
- server:REST CRUD;rev 409 带当前 rev;CSRF;assets 扩展名白名单/大小上限/重名 `-N`/穿越防护;DELETE 物理删除;export zip 成员断言(tex 含 `\bibliography{references}`、bib 仅被引条目、资产字节一致)。
- web:model 纯函数(crossrefs 派生/编号/slug/自动补 label/类型转换有损);ws dispatcher 新分支;WriterView autosave 与 409 重取(happy-dom 局限已知,rect/scroll 不作证据);i18n 两测试自动覆盖。
- 门禁:每里程碑结束四门(`corepack pnpm -r build / -r test / -r typecheck / lint`)各自 exit 0。

## 10. 验收清单

- 四门各自 exit 0;既有测试零破坏全绿;新增测试全绿。
- M1 Gate:用户真实体验 UI/交互并确认打磨完成。
- M4 真实浏览器(本地 server + 合成数据目录,**不碰真实 literatures/**):列表/新建/编辑器全交互/autosave 与 409/图片上传与展示/导出 zip(解压校验三成员)/library.changed 与 writer.changed 互不干扰/双语巡查/console 零错误。
- 用户 smoke(M1 UI 一次;M4 整体一次)通过后,commit/push 单独授权。

## 11. 风险与备注

- zod v4 looseObject 与 discriminatedUnion 组合若受限,按 §3.1 退化方案执行并在交付说明记录。
- 内置 templates 运行期定位:server deps 注入目录(app 包 `import.meta.url` 旁 `dist/templates/`,dev fallback `packages/app/…`,web-dist/argelander.sty 分发链先例);npm pack + 干净安装验收 templates 存在且可加载。
- `zlib.crc32` 在 Node v24 可用;zip writer 含退化实现,双路径有测试。
- 多 pane 同时打开同一 manuscript:本阶段依赖 rev+409 收敛,不做锁(单用户边界,与 plans 一致)。
- mock localStorage 数据 M2 随 fixture 一并移除,不留迁移负担(M1 仅 UI 审阅用途,文档化告知用户数据不保留)。
- agent 数据契约文档:M4 在 `docs/` 新增 writer 数据契约说明(manuscript.json / template JSON 字段表与覆盖语义),供未来 agent 增加 template 使用;CLI/REST 管理面仍不开。
- 全程不操作真实 `literatures/` 用户数据;验证一律合成临时目录。
