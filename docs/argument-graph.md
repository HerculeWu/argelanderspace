# 论证图：数据、审计与读写接口

状态：数据层与 HTTP 接口已实施（论证图票 02，2026-10-12）。界面、CLI、Copilot 工具、Work 合并跟随尚未实施，见 `.scratch/argument-graph/`。归属取舍见 [ADR 0009](adr/0009-argument-graph-work-owned.md)，数据保护与冻结边界以 [contracts](contracts.md)「论证图」一节为准，本文只写技术机制。

## 存储

- 位置：`<dataDir>/argument-graphs/<编码后的 work id>.json`，每个 Work 一个文件；不进 `library.json`，不是 Doc；数据保护与冻结边界（不参与指纹/归档/物理删除等）见 [contracts](contracts.md)「论证图」一节，不在此重述。
- 文件名编码：work id 的 UTF-8 字节逐个编码，`[A-Za-z0-9_-]` 原样，其余（含 `:`、`/`、`.`、`%`）写成 `%XX`（大写十六进制）。单射且可逆，名字里没有 `/`，也不会是 `.` 或 `..`；解码只接受规范形式。含 `.json` 的文件名不超过 240 字节（编码后的主干 ≤ 235 个字符），超出的 id 被拒绝（`unsafe_id`）；空 id 和非良构 Unicode（孤立代理项；否则会都编成 U+FFFD 而撞名）同样 `unsafe_id`。大小写不敏感的文件系统上仅大小写不同的 id 会撞名，Work id 里没有这种情况，不额外处理。
- pretty JSON（2 空格）；`rev` 乐观锁；同目录 `<name>.json.tmp` 写完后 rename，与 plans 同一做法。同进程写入由 server 的论证图锁串行化（不与其他锁互堵）；跨进程并发写的边界见 contracts，不加文件锁。
- 没有文件 = 空图（`rev: 0`，不创建文件）。文件读不出来（是目录、无权限等）、不是合法 JSON、不满足 schema、`work_id` 与文件名不符、或 `version` 大于 1，都是系统错误（`ArgumentGraphFileError`：`corrupt`（含读取失败与非法 JSON，消息区分）/ `wrong_work` / `future_version`），不当作「没有图」，不重置，也不会被后续写入覆盖。
- 代码：contracts `argument-graph.ts`，core `argument-graphs/store.ts`，server `argument-graph-actions.ts` 与 `app.ts` 的路由。

## Schema 要点（`version: 1`）

```
{ version: 1, rev, work_id,
  arguments: [{ id, title, claim, grounds, warrant, backing, qualifier, rebuttal,
                warrant_implicit, kind: native|end|normal,
                sources: [{ text, target?: { doc_id, anchor? | page? } }] }],
  edges: [{ from, to, role: grounds|warrant|backing|rebuttal }] }
```

- 全部对象 strict：未知键是写入失败；读侧同理——磁盘文件里出现未知键即 schema 失败，按系统错误处理（不静默丢弃、不重写），需手工修复文件。六个 Toulmin 字段、`warrant_implicit`、`kind`、`sources` 缺省为 `""` / `false` / `normal` / `[]`。
- `from → to` 表示 `from` 的 Claim 在 `to` 中充当 `role`。出处目标恰好一种跳转：`{doc_id, anchor}`（共享 IR Doc，结构 id）或 `{doc_id, page}`（PDF Doc，页码从 1 起）；只带 `doc_id`、或 `anchor` 与 `page` 都带，是写入失败。目标可整个省略（只剩显示文字）。只作参考，不校验 Doc 是否仍属于该 Work。
- 规模上限（论证 / 边 / 标题 / 字段 / 出处数经用户 2026-10-12 同意）：论证 ≤ 500、边 ≤ 5000、论证 id ≤ 64、短标题 ≤ 80、每个 Toulmin 字段 ≤ 20 000、每个论证出处 ≤ 50（出处文字同 20 000）、出处目标 `doc_id` 与 `anchor` 各 ≤ 512。所有「字符」都按 UTF-16 码元计（`String.length`），超限是写入失败。

## 写入时的结构校验

schema 内（`checkArgumentGraphStructure`，zod `superRefine`）：论证 id 唯一；短标题 trim 后非空；每条边两端都存在；无自环；同一对论证（有向）同一角色至多一条边。**环、缺 Claim/Grounds/Warrant、End 有出边、Native 有入边都不是写入失败**，由审计报告。

## 论证审计

`auditArgumentGraph(graph)`，纯函数，web 与 server 共用，结果永不落盘。返回：

| 字段 | 含义 |
|---|---|
| `cycles` | 强连通分量（≥ 2 个论证）：`{ arguments, edges }`，id 按图中顺序 |
| `noPathToEnd` | 不是 End 且沿边（from→to）到不了任何 End 的论证；图中没有 End 时为空（只报 `noEnd`，不逐个列出） |
| `noEnd` | 图中有论证但没有 End；论证数为 0 的空图不报（审计无发现） |
| `endWithOutEdge` | 有出边的 End |
| `nativeWithInEdge` | 有入边的 Native |
| `incomplete` | `{ id, missing }`：Claim 为空白；Grounds / Warrant 既无文字也无对应角色的**入边**。`warrant_implicit` 不算满足 Warrant（隐含的 Warrant 仍应写出文字） |

## HTTP

`:workId` 是 URL 编码的 Work id（含 `:` 和 `/`）。

- `GET /api/works/:workId/argument-graph`：Work 不在库中 404；没有图返回空图 `rev: 0`（200，不是 404）；文件不可读 500。`Cache-Control: no-store`。
- `PUT /api/works/:workId/argument-graph`：body 是整张图，`rev` 必须等于当前 rev；成功返回 `rev + 1` 的图。Work 不存在 404；body 不是合法 JSON/不满足 schema 或结构规则、或 `work_id` 与 URL 不符 400（`detail` 含前 20 条原因）；`rev` 不符 409 `{ detail: "rev mismatch", rev: <当前> }`，不覆盖；已存在的文件不可读 500，不覆盖。CSRF 守卫同其他写接口。
- 「覆盖非空图须带替换标志」等确认流程属于 CLI/Copilot/页面各自的票，这两个接口只做整图替换。

## WebSocket

`{ type: "argument-graph.changed", work_id, cause?: "put" | "external", at }`。`work_id` 是原始 Work id，不是文件名编码。server 自己的 PUT 成功后立即广播 `put`；watcher 轮询 `argument-graphs/*.json` 的 mtime+size 指纹（按 Work，回调带解码后的 id，已排序；tmp 文件和不是 store 写出的名字被忽略），变化时广播 `external`。server 自写会再触发一次 `external`，与 plans 先例相同，接收方的重取是幂等的。
