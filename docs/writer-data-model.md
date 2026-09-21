# Writer 数据契约：manuscript、template 与编译预览

面向 agent 的文件契约。Writer 的协作接口 = **直接读写这些 JSON 文件**（webui 经 watcher 感知外部变更）；Web 使用已有 Writer REST 路由，尚无独立 Writer CLI。

Zod schema 权威定义：`packages/contracts/src/writer.ts`。**manuscript、template 与 cell 用户数据 schema 为 looseObject——写入方新增的未知键会被保留**(不会在 round-trip 中被抹掉)。

## 目录布局

```text
<dataDir>/                        # 默认 ./literatures
├── manuscripts/
│   └── m_<8hex>/                 # 一篇稿件,id 形如 m_1a2b3c4d
│       ├── manuscript.json       # 全部内容与元数据(pretty 2 空格,UTF-8)
│       ├── assets/               # figure 图片原样文件(cell 里只存文件名)
│       └── build/
│           ├── numbering.json    # 编号 + cell IR 投影（派生缓存，勿手写）
│           ├── latexmk/          # 独立编译工作区、aux/bbl/fdb 等增量状态
│           ├── artifacts/        # 共享 facts/fuser 消费的编译产物
│           └── assets/           # 共享图管线物化的预览资产
└── templates/
    ├── <template-id>.json        # 用户/agent 增加的模板;同 id 覆盖包内置
    └── <template-id>.deps/       # 模板的 LaTeX 依赖目录（cls/sty/bst 等）
```

内置模板:`aa` / `report` / `letter`（随包发布，见 `packages/contracts/src/writer-templates.ts`)。

## manuscript.json

```jsonc
{
  "version": 1,
  "id": "m_1a2b3c4d",             // 必须与目录名一致
  "rev": 3,                       // 乐观锁:server 接受写入时 +1;手写文件请勿伪造 rev
  "template": "aa",               // 绑定的 template id
  "title": "论文标题",
  "authors": [{ "name": "…", "aff": "1", "email": "…" }],
  "affiliations": ["机构一", "…"],
  "userPreamble": "\\newcommand{\\kms}{…}",
  "infoValues": { "keywords": "…" },   // template infoFields 的取值,按 key
  "cells": [ … ],                 // 见下
  "comments": [                   // per-cell 纯文本便签
    { "id": "cm_87654321", "cell": "c_12345678", "who": "You",
      "body": "…", "created_at": "2026-09-15T09:00:00.000Z" }
  ],
  "created_at": "…", "updated_at": "…"   // ISO-8601
}
```

### cell

```jsonc
{ "id": "c_12345678", "type": "latex", "data": { … } }
```

`type` 八选一:`latex / abstract-aa / figure / table / code / ack / appendix / recipient`。`data` 字段缺省时按默认填充；各型字段与默认值见 `CellSchema`(figure:`caption/label/placement/width/image(文件名或 null)`;table:`head/csv/caption/label/placement/width`;code:`language/caption/label/lineNumbers/code`;abstract-aa:`Context/Aims/Methods/Results/Conclusions`;latex/ack:`source`;recipient:`name/organization/address`)。

### 写文件注意

- 整文件覆写（tmp+rename 由 server 保证；手写请自行保证原子性）。cell id 在稿件内必须唯一；重复 id 会阻止预览映射，不会自动重写稿件。
- **同进程 server 运行时,外部直接写文件是支持的协作方式**:watcher 按 `manuscript.json` 指纹广播 `writer.changed{cause:"external", id}`;**不要**只写 `assets/`(资产不被指纹监控,且 cell 引用不变就没有可见效果)。
- `build/` 全部是派生数据，**停止服务后**可以清理以重建；不删除 `manuscript.json` 或原始 `assets/`。不支持跨进程同时编译同一稿件。
- `build/numbering.json` 保留 `version/at/texHash/facts/lastError`，新增 `inputHash/preview`。`inputHash` 包含源码、cell 身份、bibliography、模板及其依赖、资产内容，不只检查 TeX 字符串。`preview` 是共享 IR 的 cell 投影，包含源码对应关系、引用及警告；不是用户数据或 agent 文献输出。

## template JSON(`templates/<id>.json`)

```jsonc
{
  "id": "aa",                     // 小写 slug;/^[a-z0-9][a-z0-9-]*$/;必须与文件名一致
  "version": 1,
  "label": "A&A",                 // UI 显示名
  "chip": "A&A manuscript",       // 编辑器内题头 chip
  "preamble": "\\documentclass{aa}\n…",   // 模板管理的 preamble(UI 只读)
  "types": ["latex", "abstract-aa", "figure", "table", "code", "ack", "appendix"],
  "infoFields": [{ "key": "keywords", "label": "Keywords", "input": "text" }],  // input: text|textarea
  "deps": ["aa.cls", "aa.bst"],   // 依赖文件名（不能是路径），放 <id>.deps/ 目录
  "bibliographyStyle": "aa",       // 显式 BibTeX style；report/letter 内置为 plainnat
  "frontMatter": "\\title{ {{title}} }\n\\author{ {{authors}} }\n\\maketitle"
}
```

- `frontMatter` 在 `\begin{document}` 之后展开;占位符:`{{title}}`、`{{authors}}`、`{{affiliations}}`、`{{info.<key>}}`;未知占位符替换为空串。
- `types` 决定新增 cell 菜单的可选项;不含某类型的既有 cell 被无损保留(显示提示)。
- **cell→LaTeX 序列化规则全局固定在代码里**(`packages/contracts/src/writer.ts` 的 `serializeCell`),模板不可覆写。
- 同 id 的用户文件覆盖包内置模板;坏文件(JSON 损坏/schema 失败/文件内 id 与文件名不符)启动时警告并跳过,不阻塞。
- 编译输入会安全复制 `<id>.deps/` 与稿件资产，不跟随 symlink。声明的依赖缺失时明确失败，不偷偷更换 class 或引用样式。`aa.cls/aa.bst` 的分发许可未完成核查，**不随 npm 包提供**；使用 A&A 时需自行准备到 `templates/aa.deps/`。
- `bibliographyStyle` 用于补充 `\\bibliographystyle{…}`；源码中的显式声明优先，注释和代码示例不算声明。旧自定义模板若未配置 style，仍需自行声明，不能假定系统会用 plainnat 替代。
- A&A 的五段 abstract 必须在 `\\maketitle` 前供 class 消费；组装器会在该位置输出 abstract cells 并保留其源码映射。稿件 JSON 的 cell 顺序不被重写。
- 导出仍是源码 zip：单 manuscript.tex、独立 references.bib、被引原始图，以及经与编译相同校验的模板 cls/sty/bst 依赖（放 zip 根目录）。编译和导出注入相同期刊宏定义。缺依赖／未验证编译／缺文献等问题通过响应头和包内 `EXPORT-WARNINGS.txt` 提示；下载成功不等于该稿已验证可编译。

## 外部变更的可见性

- `manuscripts/<id>/manuscript.json` 与 `templates/*.json` 的 mtime+size 被轮询指纹;变化 → `writer.changed` WS 广播(cause: external / template),web 端幂等重取。
- 自动保存保留，但停止输入、保存、打开稿件、外部变更和模板切换均不自动编译。只有 Shift+Enter 或 Render 显式触发渲染；先等待保存成功，再请求刷新。显式请求按 dataDir＋稿件 id 隔离 single-flight，运行中只保留一个最新状态的补跑，不排队所有中间版本。此为 Stage 12 已交付规则，详见 [Writer 工作流](writer.md)。
- 成功和失败都会广播 `writer.changed{cause:"numbering", id}`，正文和侧栏同时更新。外部改写模板依赖、资产或 bibliography 后，刷新会重算内容指纹；这些文件并非都受 watcher 监控，必要时手动刷新。
- 删除稿件会取消并等待该稿件的编译结束，再删除目录，避免后台构建复活已删除目录。

## 编辑与预览边界

- LaTeX 源码与用户导言区采用 CodeMirror 6＋官方 stex；没有自研补全引擎。References 插入裸 key，Crossrefs 插入裸 label，不猜测／包裹引用命令。
- Writer 复用现有 **latexmk → 编译事实＋源码 AST → IR → 展示**；不另建 TeX4ht 链路，也不展示 PDF。
- 正文显示引用格式及章节／逐行公式／图表的编译真值，保留 cell 流式布局，不还原 PDF 分页。数学与段展示复用 reader 能力；reader 默认输出和 CLI 冻结契约不变。
- 旧预览只可保留在源码仍对应的 cell 上，并标陈旧；被替换目标的引用显示未解析，不能按旧环境序号或同名 label 错绑新公式。尚无对应 IR 的 cell 显示待编译提示和源码，而不是另一套启发式正文渲染。
- 当前验证范围包括内置模板、natbib 作者—年／数字、前后注、多 key、星号及编译态标点。不承诺任意宏／BibLaTeX 兼容；`longnamesfirst`、上标引用和正文中动态切换 citation style 暂明确报不支持。把 style 配置放在导言区。
- 一个 IR 块跨多个 cell 的情形会提示无法归属，暂不拼接猜测；完整环境应放在同一个 cell。未知命令等融合警告会显示，不能把部分预览冒充完整还原。
- 稿件未进入文献库，不触发摄入身份、library rebuild 或标注生命周期。
