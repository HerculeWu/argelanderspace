# Writer 数据契约（Stage 10):manuscript 与 template 文件格式

面向 agent 的稳定文件契约。Writer 的协作接口 = **直接读写这些 JSON 文件**(webui 经 watcher 自动感知外部变更并广播 `writer.changed`)；本阶段没有 Writer CLI/REST 管理面。

Zod schema 权威定义：`packages/contracts/src/writer.ts`。**全部 schema 为 looseObject——写入方新增的未知键会被保留**(不会在 round-trip 中被抹掉)。

## 目录布局

```text
<dataDir>/                        # 默认 ./literatures
├── manuscripts/
│   └── m_<8hex>/                 # 一篇稿件,id 形如 m_1a2b3c4d
│       ├── manuscript.json       # 全部内容与元数据(pretty 2 空格,UTF-8)
│       ├── assets/               # figure 图片原样文件(cell 里只存文件名)
│       └── build/
│           └── numbering.json    # 编号编译缓存(派生数据,可删,勿手写)
└── templates/
    ├── <template-id>.json        # 用户/agent 增加的模板;同 id 覆盖包内置
    └── <template-id>.deps/       # 模板的 LaTeX 依赖目录(cls/sty 文件)
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

- 整文件覆写（tmp+rename 由 server 保证；手写请自行保证原子性）。
- **同进程 server 运行时,外部直接写文件是支持的协作方式**:watcher 按 `manuscript.json` 指纹广播 `writer.changed{cause:"external", id}`;**不要**只写 `assets/`(资产不被指纹监控,且 cell 引用不变就没有可见效果)。
- `build/numbering.json` 是编译缓存:`version/at/texHash/facts/lastError`,删除安全,手写无意义(下一次编号编译覆盖)。

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
  "deps": ["aa.cls"],             // LaTeX 依赖文件名列表,放 <id>.deps/ 目录
  "frontMatter": "\\title{ {{title}} }\n\\author{ {{authors}} }\n\\maketitle"
}
```

- `frontMatter` 在 `\begin{document}` 之后展开;占位符:`{{title}}`、`{{authors}}`、`{{affiliations}}`、`{{info.<key>}}`;未知占位符替换为空串。
- `types` 决定新增 cell 菜单的可选项;不含某类型的既有 cell 被无损保留(显示提示)。
- **cell→LaTeX 序列化规则全局固定在代码里**(`packages/contracts/src/writer.ts` 的 `serializeCell`),模板不可覆写。
- 同 id 的用户文件覆盖包内置模板;坏文件(JSON 损坏/schema 失败/文件内 id 与文件名不符)启动时警告并跳过,不阻塞。
- 编号编译(pdflatex 单遍,求真编号)会把 `<id>.deps/` 加入 TEXINPUTS;`deps` 里声明而缺失的文件会让编号编译以"缺依赖"失败(不影响编辑与导出)。`aa.cls` 因许可证(all rights reserved)不随包分发,需要时自行放入 `templates/aa.deps/`。

## 外部变更的可见性

- `manuscripts/<id>/manuscript.json` 与 `templates/*.json` 的 mtime+size 被轮询指纹;变化 → `writer.changed` WS 广播(cause: external / template),web 端幂等重取。
- 编号编译由 server 在保存后 debounce 触发(或手动 POST refresh),成功后广播 `writer.changed{cause:"numbering", id}`;outline/crossref 编号随之更新。
