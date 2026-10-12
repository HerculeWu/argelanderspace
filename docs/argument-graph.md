# 论证图：数据、审计与读写接口

状态：数据层与 HTTP 接口已实施（论证图票 02，2026-10-12）；画布（票 03）、只读视图（票 04）、手动编辑（票 05）与 Work 合并跟随（票 06，2026-10-12）已实施。CLI（票 07，2026-10-12）已实施；Copilot 工具尚未实施，见 `.scratch/argument-graph/`。归属取舍见 [ADR 0009](adr/0009-argument-graph-work-owned.md)，数据保护与冻结边界以 [contracts](contracts.md)「论证图」一节为准，本文只写技术机制。

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

## CLI（票 07；`packages/cli/src/argument.ts`）

外部 agent（Claude Code）读写论证图与取得 PDF 原件路径。CLI 直读直写磁盘，不依赖 server；与页面、HTTP 共用 `ArgumentGraphSchema`（含结构规则）与 core `loadArgumentGraph` / `replaceArgumentGraph`（rev 乐观检查、同目录 tmp＋rename 原子写）。读命令真只读：不建目录、不写文件。目标 Work 不在库中（含被合并掉的 Work，其遗留图文件不展示）一律按未知 Work 报错并给候选，沿用 `note` 的形态。

| 命令 | 行为 |
| --- | --- |
| `argument get <workId>` | 整张图的 JSON（缩进 2 空格，`version: 1`，含 `rev`）。没有图时是空图、`rev: 0`，exit 0。图文件不可读（损坏、schema 不符、未来版本、属于别的 Work，以及 `argument-graphs/` 目录本身读不了）是系统错误：`error: …`、exit 1、stdout 为空，不输出空图。只有「文件不存在」（ENOENT，父目录不存在也算）才是没有图 |
| `argument put <workId> <file> --rev <n> [--replace]` | 从文件读整张图（`-` 读 stdin），校验后原子写入；成功时 stdout 一行 `{"work_id":…,"rev":<新 rev>,"link":"http://localhost:<port>/#argument/<URL 编码的 work id>"}`。端口取法同其他带深链接的命令：`ARGELANDERSPACE_PORT` > config `port` > 8000；路由格式与 web 的 `lib/argument-route.ts` 一致 |
| `pdf-path <docId>` | 只读，stdout 一行 PDF Doc 原件的绝对路径（dataDir 经 realpath）。**不要求 Doc 挂在某个 Work 上，也不核对 hash**：这与 Reader 的原件端点（核对归属与 hash）不同，与既有 CLI `read` / `show` 的直读信任模型一致——本机命令行，调用者本来就能读 dataDir。不读 PDF 内容 |

`put` 的规则

- 检查顺序：先解析 `--rev`（缺失或非法即报错，此时还没读任何东西）→ 读库并查 Work（不在库中、`library.json` 不可读、id 不能作文件名）→ 读输入文件或 stdin → 是否合法 JSON → 文件里的 `work_id` 是否一致 → schema 与结构校验 → 读已存图（不可读则报错）→ `rev` → `--replace` → 写入。任何一步失败都零写入（不建 `argument-graphs/`，不留 tmp）。
- `--rev` 必填，是调用方读到的 rev（没有图为 0），必须是非负整数。与存储的 rev 不符即拒绝、零写入，报告当前 rev，要求重新 `get` 并在新版本上重做改动。
- 存储里已有**非空**图（至少一个论证）时必须另带 `--replace`，否则拒绝、零写入。零论证的图算「没有图」，无需 `--replace`，但 `--rev` 仍要等于存储的 rev。
- 文件里的 `work_id` 可省；若有必须与命令行的 Work 一致，不一致拒绝（不静默纠正，避免把一张图写到错误的 Work 上）。文件里的 `rev` 不作依据，以 `--rev` 为准。`version` 也可省（缺省按 1）；写了就必须是 1（否则 `version: must be 1`）；`get` 的输出始终带 `version: 1`。`work_id` 不是字符串（数字、`null`）单独一句 `work_id in <file> must be a string`。其余键沿用 schema：未知键拒绝（含名为 `__proto__` 的键：`JSON.parse` 把它留作自有属性，CLI 在校验前逐层检查并按未知字段报出，而不是静默忽略），省略的论证字段取默认值。
- 校验失败逐条报告，**每条一行，位置加我们自己的句子**，去重、最多列 100 条，exit 1，零写入。位置是 JSON 路径，**下标 0 起始**（`arguments[1].title`、`edges[0].to`，根为 `<root>`）。句子由 CLI 按 zod issue 的 `code` 与参数自己写（`must be at most 80 characters`、`unknown field "x"`、`must be a boolean`、`must be one of native, end, normal`、`is required` 等），没映射到的种类用固定兜底句子；结构规则（重复 id、悬空边、自环、重复边）与字段级的两条自定义规则（短标题仅空白 `blank_title`、出处目标 `target_anchor_or_page`）的种类都由 contracts 在 issue 的 `params.rule` 里给出（只加 params，message 与 schema 形状不变），CLI 按 rule 映射，不看路径末段；句子同样是我们的。去重按完整内容（两个前 100 字符相同的未知键各占一行，显示时才截断）。引用 id 与路径一律按 JSON 字符串转义（id 并截到 100 字符），并且额外把 U+007F、C1 控制符（U+0080–U+009F，含 U+0085）、U+2028/2029、bidi 标记与控制符（U+061C、U+200E/F、U+202A–U+202E、U+2066–U+2069）写成 `\uXXXX`，所以含换行或这些字符的 id 不会伪造出额外的行，也不会改变显示顺序。同一轮报出哪些问题的组合与行的顺序不冻结，冻结的是每类问题的行形与文案。存在类型级错误（缺字段、值类型不对）时，zod 不运行结构规则（superRefine），所以重复 id、悬空边这些不在同一轮报出：改完类型错误再提交才会看到；长度/规模超限不阻止结构规则，会和它们一起报。不可读的已存图永不被覆盖（`put` 同样报错）。
- 从 stdin 读用 `-`（便于管道，不落临时文件）。**异步**读到 EOF（`put` 的 action 是 async，由 `parseAsync` 等待；其余命令仍同步）：等待写端时事件循环照常运转，所以 Ctrl-C / SIGTERM 立即结束进程（先前的同步等待循环让 `signal-exit` 的处理器转不起来，只能 SIGKILL）；也不会因 stdin 管道 fd 是非阻塞（依赖在加载时设的）而得 `EAGAIN`。字节先拼完再解码，多字节字符被切在两块之间不出错。stdin 是终端（TTY）时直接拒绝，不等待：`error: stdin is a terminal; "-" reads the graph from a pipe or a redirected file`，exit 1，零写入（检查顺序在读输入这一步：`--rev` 与 Work 先查）。stdin 是目录报 `cannot read stdin (EISDIR)`。其余既有命令不读 stdin，这是本命令的约定。
- 写盘失败时不留图文件与 tmp，也不留下本次调用刚建、仍为空的 `argument-graphs/`（`replaceArgumentGraph` 清理时自己的错误不盖掉原始错误）。`ConfigError`（坏的 `config.toml`）的文案是本仓库自己的，原样透出，与 `note` 同形。`pdf-path` 只把 ENOENT 当作「没有这个 Doc」，`output/` 或 Doc 目录的权限与 I/O 错误是系统错误，与图 store 一致。

**消息措辞**：所有 `error: …` 都是单行、由本仓库措辞，不转述 zod、commander（用法错误除外）、V8 / Node 的原句；系统错误只可在末尾括号里附 errno 码（如 `(EACCES)`）。底层错误码本身不属于冻结面。缺位置参数、多余参数、未知选项、裸 `argument`、`--rev` 缺值这些 commander 的用法错误不冻结（exit 1，stderr 为帮助/用法文本）。

`get` 的键序是确定的：`version, rev, work_id, arguments, edges`；论证 `id, title, claim, grounds, warrant, backing, qualifier, rebuttal, warrant_implicit, kind, sources`；出处 `text, target`；目标 `doc_id` 然后 `anchor` 或 `page`；边 `from, to, role`。输出由固定顺序的构造函数生成，不依赖存储文件的键序；构造函数的对象字面量带「覆盖 schema 全部键」的类型约束，schema 以后增字段时编译失败，而不会让 `get` 静默丢字段（随后的整图替换会把它抹掉）。

**并发**：工作台可能在运行。`rev` 检查挡住基于旧读取的写入，server 的 watcher 发现文件变化后通知页面刷新。读 rev 与写入之间没有跨进程锁：两个进程在同一瞬间写同一张图不支持，也不加文件锁（contracts I013）。CLI 写图与 server 端的 Work 合并（`followWorkFolds` 在库锁内移动图）之间同样没有跨进程互斥，这个竞态属于 I013 的边界：合并期间不要同时用 CLI 写入该 Work 的图。

**冻结**：命令的 stdout / stderr / exit code、JSON 字段与键序有 golden 测试（`packages/cli/tests/argument.test.ts`），完整清单在 `.scratch/argument-graph/issues/07-cli.md` 的 Comments；票 10 用户验收通过后才算发布生效。既有命令（`search` / `read` / `show` / `ref` / `note` / `label` / `list` / `annot`）输出不变。

## WebSocket

`{ type: "argument-graph.changed", work_id, cause?: "put" | "external", at }`。`work_id` 是原始 Work id，不是文件名编码。server 自己的 PUT 成功后立即广播 `put`；watcher 轮询 `argument-graphs/*.json` 的 mtime+size 指纹（按 Work，回调带解码后的 id，已排序；tmp 文件和不是 store 写出的名字被忽略），变化时广播 `external`。server 自写会再触发一次 `external`，与 plans 先例相同，接收方的重取是幂等的。

## Work 合并（票 06；`core/src/argument-graphs/merge.ts`）

每个 Work 至多一张图，所以两个 Work 合并成一个时要决定图的去向。合并只发生在 `LibraryStore.upsert`：一条记录同时命中两个已存 Work 时，后者并入前者（幸存者）并从库中删除。`upsert` 把每次折叠记在 `store.folds`（`{absorbed, survivor, stored, absorbedWork, survivorWork}`；`stored` 按 **Work 对象身份**判断，表示被并入的这个对象在本次加载时已在文件里，才可能有图文件——同一批里后来新建、碰巧复用了已折叠 Work 的 id 的对象不是它。**例外**：本批新建的 Work 在本次 `followWorkFolds` 的前面某一步里确实接手过图（该步 `moved`，幸存者就是这个对象）之后，它名下的文件才算它的图，它再被并入别人时第二步照样处理；按对象身份记录，不靠 id，所以一个与本批无关的同 id 遗留文件不会被误当成它的图）。调用方在**库文件保存成功之后**调用 `followWorkFolds(dataDir, store.folds)`：它**按折叠发生的顺序一步一步**套用下面的规则（链不折叠：C 并入 A、A 再并入 D，第二步里 A 的图是第一步之后的 A 的图；中间环节 A 即使是本批新建的也一样，只要它在前一步接手了图），每一步产生自己的说明，永不抛错，处理完把 `store.folds` 清空（同一个 store 实例再调一次不会重报）。

「有图」的含义：**零论证的图文件算没有图**（2026-10-12 父代理补定，待用户终验确认；契约条文只说「没有图 / 有图」，未写明空图；schema 允许手写的 `rev: 0` 文件，故下面的 rev 规则不假定「有文件则 rev ≥ 1」）。

| 被并入 Work | 幸存 Work | 结果（`outcome`） |
|---|---|---|
| 没有文件，或只有零论证的空图 | 任意 | 无事发生，不产生说明；空图文件留在原处 |
| 有图 | 没有文件 | `moved`：新内容（`work_id` 改成幸存者的 id，`rev` 取 max(原 rev, 1)）发布在幸存者名下，**随后**删除被并入者的原文件 |
| 有图 | 文件是零论证的可读空图 | `moved`：同上，但用原子 rename **替换**空文件，`rev` = max(两者 rev) + 1（持旧 rev 的写入方得 409）；替换前重新确认它仍是同一张可读的空图 |
| 有图 | 有图 | `kept_survivor`：幸存者的原样不动；被并入者的留在原处，不展示、不删除 |
| 有图 | 文件在但读不出来（损坏、是目录、符号链接等） | `kept_survivor` 加 `survivor_unreadable`：不覆盖，如实报告 |
| 被并入者的文件读不出来 | 任意 | `transfer_failed`（`error: absorbed_unreadable`），文件不动 |
| 有图，但写入或发布失败 / 幸存者 id 不能作文件名 | 没有图 | `transfer_failed`（`write_failed` / `survivor_name_unusable`），被并入者的文件原样；合并照样生效 |

`error` 是固定的 kind，不带系统消息或路径；说明里的文件位置：core 与 CLI 是绝对路径（本机命令行），HTTP 响应与页面是相对 dataDir 的 `argument-graphs/<编码>.json`（`relativeMergeNote`）。`survivor_file` 是幸存者的图文件位置，仅当幸存者 id 不能作文件名时为 `""`。

### 真移动与崩溃状态

用户 2026-10-12 裁决：只有被并入者有图时，转移成功后被并入者的原文件**不再保留**，磁盘上只有一张图（取代实施轮的「拷贝加保留原件」）。步骤与任意两步之间进程被杀时的磁盘状态——**每个状态下至少有一份完整的图在一个已发布的文件名下**：

1. 在幸存者文件名旁写 `<幸存者文件名>.m<6位十六进制>.tmp`（即 `….json.mXXXXXX.tmp`，比 store 自己的 `.json.tmp` 只长 8 字节，store 能写的 id 这里也能转移），**写完全部字节**（`writeSync` 的短写不是错误，循环写到底，没有进展就抛错）并 fsync，再把临时文件读回与预期字节逐字节比对。被杀：被并入者的文件原样；残留一个不完整或完整的临时文件。
2. 发布：幸存者没有文件时用硬链接（目标已存在则失败，绝不覆盖；只有「文件系统不支持硬链接」的错误码 `EPERM` / `ENOTSUP` / `EOPNOTSUPP` / `ENOSYS` 才退回检查后 rename，其余错误直接 `transfer_failed`）；幸存者是空图时用 rename 替换。被杀（发布前）：同 1。发布是原子的，不存在半个文件。
3. 发布成功、删临时文件前被杀：幸存者名下有完整的图，被并入者的原文件还在，临时文件还在（硬链接路径上临时文件与幸存者的文件是同一个 inode，两个名字一份内容；rename 路径上没有这一状态）。
4. **回读确认**：发布后用 store 自己的读取函数读幸存者名下的文件，确认可读、`work_id` 是幸存者、`rev` 与论证、边内容与预期一致。不符则**不删**原文件，撤掉刚发布的文件（仅当它仍是本次发布的那个文件：设备号与 inode 一致），报告 `transfer_failed`（`write_failed`）。幸存者原来是零论证空图（rename 替换路径）时，替换前把它的原内容留在内存里（已确认可读的零论证图）；撤掉坏文件后，在名下仍没有别的文件的前提下用原子写（临时文件加 rename）把它放回，`rev` 不变；放回也失败则幸存者名下暂时没有文件（等同「没有图」），仍如实报告 `transfer_failed`（`write_failed`），被并入者的原文件原样。
5. 回读通过、删原文件前被杀：幸存者名下有完整的图，被并入者的原文件还在（两份相同内容；原文件已无主，无视图读它）。
6. 删原文件之后：只有幸存者名下一份。
- 两轮重试都输给并发写入者：按此刻实际情况报告——幸存者文件存在且有论证则 `kept_survivor`，存在但读不出来则 `kept_survivor` 加 `survivor_unreadable`（与首轮同一状态同一报告），否则 `transfer_failed`。
- 发布失败：原文件原样，报告 `transfer_failed`，不删任何东西。发布成功但删原文件失败：图已在幸存者名下，原文件仍在，说明为 `moved` 加 `absorbed_file_left`，文字里写明原文件还在、不再使用。
- 库保存与整个图处理之间被杀（`library.json` 已含合并、图一步未动）：被并入者的图原样留在原处，幸存者没有（或保留自己的）图，没有说明；按下面的办法手工找回。
- 临时文件的清理：每次处理折叠前删除目录里超过一小时的 `*.json.m<hex>.tmp`（及旧版的 `*.json.merge-*.tmp`）（崩溃残留；一小时内的可能是另一进程正在写，不动）。这些文件不是 `.json`，不被 store 当作图、不被 watcher 看见。

- **时机**：先保存 `library.json`（各调用路径自己的写法不变），保存成功才动图。库保存失败（`library.json` 没被替换）时调用方抛错、一张图都没动。**半失败**：`library.json` 已被替换而随后写 `library.bib` 失败时，合并已落盘，图必须跟上。是否已替换**由保存流程自己记录**：`LibraryStore.save` 与 `saveWorksNarrow` 的 `commit` 在 `library.json` 的 rename 成功之后才失败时，给抛出的错误打标记（`markLibraryJsonReplaced`）；`followFoldsAfterFailedSave` 只在错误带这个标记时处理折叠，不从文件内容推断（id 在同批里被新 Work 复用时，保存前后的 id 集合可以相同，推断会在 staging 阶段失败、`library.json` 逐字节未变时把图移走）。说明挂在抛出的错误上（`argumentGraphMerges`）、追加进错误消息（相对路径）；HTTP 导入此时答 500 加 `argument_graph_merges`，导入对话框照样显示说明。`rebuild` 在图处理之后写图缓存（`graph.json`）失败，同样把说明挂在错误上（`attachMergeNotes`）。`lockedRebuild` 里 `restoreUnknownKeys` 失败同理（rebuild 已完成，说明随错误带出）。
- **与论证图 PUT 的互斥**：合并在库锁内、`library.json` 被替换之后的同一个同步回合里处理折叠；论证图 PUT 在论证图锁内、**同一个同步回合里**重新读 `library.json` 检查「Work 仍在库」再写。单线程下两者不可能交错：PUT 要么先落盘（合并随后把它的最新内容带走），要么发现 Work 已不在库而答 404、零写入。读请求体之前的那次检查只是早退，不再是保证。跨进程仍不支持。

### 各调用路径与说明的呈现

| 路径 | 能否合并 | 说明送到哪里 |
|---|---|---|
| 页面导入菜单（`POST /api/library/works`：标识符 / bibcode / BibTeX） | 能 | 响应体在有说明时多 `argument_graph_merges`（相对路径；没有则保持 `{results}` 原样）；导入对话框在有说明时不自动关闭，列出说明与位置，关闭时再打开该 Work。库保存半失败：500 加同一键，对话框显示说明加固定提示 |
| 探索视图（Discovery）的「Add to library」 | 能（同一个 `POST /api/library/works`，默认合并） | `explore-state` 的 `addToLibrary` 把响应里的说明留在 `mergeNotes`，探索视图顶部显示一条可关闭的提示（与导入对话框同一组件、同一文案），下一次不产生合并的 Add 不动它，产生合并的 Add 把新说明接在后面，用户关闭才消失 |
| Copilot `library` 工具的 `import_works`、`save_candidate` | 会合并的导入整条拒绝（`bridge: "reject"`，零写入），不会产生合并 | 既有行为，不变；core 测试断言拒绝时图也不动 |
| `add-manual` 单条（`commitWork`）与批量（`addManualBibText`，说明挂在触发折叠的那一条上，按折叠对象而不是 id 对应） | 能 | core 测试 |
| `library build`、`library build --bib`、`acquire`（含 `--fetch`/`--fetch-remaining` 的二次 rebuild） | 能 | stdout 的摘要 JSON 多可选键 `argument_graph_merges`（绝对路径）；`acquire` 的最终摘要带上**所有阶段**的说明；无合并时输出一字不变 |
| `POST /api/library/refresh` | 能 | 响应摘要多同一个可选键（相对路径） |
| Files 标签页：上传 zip 的任务、`?sync=1`、获取 arXiv LaTeX 的任务（`attach_arxiv` 同一任务） | 能（任务里的 rebuild） | 任务结果（`job.result`）多可选键 `argument_graph_merges`（相对路径；`?sync=1` 的响应体同键，`?sync=1` 在 rebuild 之后才失败时 500 的错误体也带这个键；`POST /api/library/refresh` 成功时的任务记录与响应同样是相对路径）；**任务在 rebuild 已合并并移动图之后才失败时，失败任务的 `result` 同样带这个键**（其余失败的任务 `result` 仍为 `null`）。服务端保留每条任务记录（`jobs/<id>.json`，没有清理），`hello` 重放整张任务表（含 `result`）。页面的通知**来自任务记录本身**：模块级的 `merge-notices` 在应用外壳挂载时订阅任务事件，有已完成（或带说明的失败）任务的 Work，打开其 Files 标签页就显示一条可关闭的提示，不要求「本页面看着它跑完」，所以关闭 Work 详情、切到 Reader、刷新页面都不丢；「已关闭」按任务 id 记在浏览器 `localStorage`（键 `argelander.dismissedGraphMergeNotices`，最多 300 条，写回前先与本地已有集合取并集、淘汰最旧的；`storage` 事件同步多标签页），重载后不重现已关闭的；Copilot 的任务行（`read_jobs`、`attach_arxiv` 的 `job`）多可选字段 `argumentGraphMerges`，模型据此如实告知用户（工具描述文字未改，受 footprint 预算约束）。服务端日志照旧各写一行 |
| 自动 arXiv 摄入（`autoIngestArxiv`） | 不会：只提交 arXiv PDF 任务，那条路径不 rebuild | 说明 |
| `acquire --dry-run` | 内存里的 store，不落盘，不碰图 | 说明 |
| CLI `ingest <DOI>`（`addDoiWork`） | 不会：记录只有一个未命中的新 DOI 加一个标题，最多命中一个已存 Work | core 测试 |
| `ingest`（LaTeX）/ Doc 挂载 / PATCH / 上传 | 不改 Work 集合，只改 `doc_ids` 等 | 说明 |

合并移动了图（`moved`）之后，server 立刻为幸存者和被并入者各广播一次 `argument-graph.changed`（`cause: external`），不等 watcher 轮询；覆盖导入、各 rebuild 路径（含失败后带说明的）。

### 留在磁盘上的图

真移动之后，只有「两边都有图」（含幸存者的文件读不出来）和「转移失败」「原文件删不掉」三种情形会在磁盘上留下被并入者的文件：

- 位置：`<dataDir>/argument-graphs/<编码后的被并入 Work id>.json`（编码见「存储」；例：`doi:10.1051/0004-6361/202039341` → `doi%3A10%2E1051%2F0004-6361%2F202039341.json`），即它一直所在的地方。说明里的 `absorbed_file` 在页面是相对路径，在 CLI 是绝对路径。
- 它的 Work 已不在库里，所以没有任何视图读它：`GET /api/works/:id/argument-graph` 对该 id 是 404（「Work 不在库中」），Work 详情没有入口，Copilot 工具读不到。watcher 按文件名与 mtime+size 取指纹、不检查 Work 是否还在库、不读内容，所以它既不会报错，也不会反复广播；合并本身不改它。没有任何自动清理。
- 手工找回：确认目标 Work 在目标名下没有文件，把它复制成目标 Work 的文件名，并把文件里的 `"work_id"` 改成目标 Work 的 id（否则读取报 `wrong_work`）；工作台的 watcher 会发现新文件。没有界面。
- 注意：若之后又出现一个 id 与被并入者相同的 Work（例如重新导入它的 DOI，而幸存者已有另一个 DOI），这个遗留文件会被它读到，因为文件名与 `work_id` 都对得上。这是同一篇文献的图，不判为错误；逐步套用的链里则相反：一个**本批新建**的 Work 名下的文件，只有在本批前面的步骤确实把图转给了这个对象（按对象身份记录）时才算它的图并被带走；与本批无关的同 id 遗留文件不会被当作它的图移走（它会让转给这个新 Work 的那一步报 `kept_survivor`）。本批之前就在库里的 Work 则始终按「它名下此刻有没有图文件」处理。

### Work id 在 rebuild 后会变吗（调查，不处理）

`docs/library.md` 提到 rebuild 后 id 被改的 Work 无法对回。现状：已存 Work 的 id **从不被改**——`id` 只在新记录建立时由 `canonicalId` 计算（`seedFromOutput`、`workFromBibrecord`、手动添加的 `recanonicalize`），`upsert` 命中已存 Work 时幸存者保留自己的 id，`resolveWork`/`enrichAndPlan` 即使补出 DOI 也不动 id（core 测试覆盖）。所以 rebuild 不会让图失联，唯一会让已存图「失联」的 rebuild 事件是上面的合并（被并入者的 id 消失）。另外两种仍可能：`library.json` 丢失后从零 rebuild，id 按 `canonicalId` 对当时的 DOI/arXiv/标题重新推导，可能与原来不同；手工改了 `library.json` 里的 id。两种情形下图文件都留在磁盘上、不展示、不删除，找回办法同上。本票不处理。

## 画布（`packages/web/src/graph/`、`argument/`；票 03，只有渲染，页面入口与写入在后续票）

共享图 renderer 有两种布局：`GraphCanvas`（力导向，Library 与 Discovery 两个 adapter）和 `LayeredGraphCanvas`（分层，论证图 adapter）。两者共用缩放控件 `GraphZoomControls`、`cg-*` 样式和视口状态机 `useGraphViewport`（`graph/useGraphViewport.ts`：画布尺寸、视图与 stash、缩放上下限 0.3–3.2、滚轮、平移、双指缩放、拖节点、hover 与 tooltip 锚点、hover 邻域、节点 `g` 的键盘与焦点外壳）；分层 renderer 不认识「论证」，只收到节点（短标题、颜色、双环、置底/置顶、角标）和边（颜色、静止色、虚线/点线、可选文字）。领域语义全部在 `argument/`：`canvasModel.ts`（种类与角色到颜色、线型、置底置顶；审计角标与环上的边取自 contracts 的 `auditArgumentGraph`）和 `ArgumentGraphCanvas.tsx`（图例、tooltip、双语文案 `argument.canvas.*`）。

- **共享视口与各自保留的部分**：`useGraphViewport` 不认识节点怎么画、怎么摆；renderer 以回调接入——`onNodeDrag` / `onNodeRelease`（力导向：钉住并 reheat；分层：直接移动点）、`onUserView`（用户接管视图，分层据此停止自动适应）、`gesture`（在特殊目标上起手的拖拽，分层的连边手柄）、`tooltipAt`（力导向夹取 tooltip）；适应窗口的规则、物理、布局、controller 由各 renderer 自己写，经 `setView` 落回。controller（放大、缩小、适应、重新布局）由 renderer 用 `zoomCenter` 加自己的 fit / relayout 组装，见 `GraphCanvas`；分层 renderer 暂未暴露 controller。
- **布局是纯函数**（`graph/layered/layout.ts`）：Native 在底、End 在顶，其余按最长支撑链；闭合环的边只在分层时忽略、照常绘制，并在 `backEdges` 里报告；跨层的边经不可见路径点；每个论证的列宽 = 它自己短标题的宽度（按最大字号 14 预留）；同输入同输出。短标题（`layered/text.ts`）：拉丁文在空白与连字符处断行，单词超过一行才在词内断，中文逐字断，最多两行、超出以 `…` 截断；宽度按字符类别估算（窄字母、小写、大写、宽大写 W/M/O/Q、数字、全角），偏保守，纯函数、不量 DOM。短标题与边标签的避让也是纯函数（`placement.ts`）：右侧被占时改下、左、上里最空的一侧。
- **结构、置底置顶或短标题变化即重新布局**，拖动只在此之前有效，不保存；视图适应窗口时避开标题和图例（量实际尺寸；缩放控件在右缘，由右留白避开），画布尺寸变化时若未手动平移或缩放则重新适应，选中的论证保持在可见范围内。
- **画布拖拽连边**：选中论证左侧出现手柄，拖到任一论证（含自己）后回调 `onConnect(from, to, 屏幕位置)`；自环拒绝、角色选择与写入由调用方（票 05）负责。手势在松手时用当时最新的 `onConnect` 与节点集合（拖动中父组件重渲染不会使它作废）。键盘选中（Enter）后焦点仍在节点上，整条链路保持点亮；没有选中时焦点才点亮一跳邻域，指针悬停始终是一跳邻域。

## 视图（`packages/web/src/argument/`；票 04）

文献页（Library 页）内的临时模式，与探索模式同级，二者互斥；不是新的页面或活动栏项。

- **入口**：Work 详情底部的「论证图」按钮（与「探索相关文献」并列；`WorkArgumentEntry` 读该 Work 的图，按钮上写论证数，没有图时写 `—`；无后端的示例数据下禁用；没有正文、没有 bibcode 的 Work 同样可进）。Reader 顶部的「论证图」按钮（LaTeX/文本 Doc 的 topbar，PDF Doc 的工具栏）：按下时才用文库 refs 查 Doc 所属 Work（Reader 平时不读文库），经 `Workspace.openArgumentGraph` 切到一个 Library 页并打开该 Work 的图：当前窗格是 Library 页就用它，否则用布局里第一个 Library 页，一个也没有时当前窗格变成 Library 页。要用哪个窗格由 Shell 选定并写进总线请求（`paneId`），总线只投递给这个窗格，多个 Library 页时不会选一个、投另一个。查不到所属 Work 时在按钮旁说明、不跳转：文库读不出来与「没有 Work 持有该 Doc」是两句不同的说明；按下后若 Reader 已切到别的 Doc，迟到的回答作废、不带用户走。
- **深链接**：`#argument/<URL 编码的 work id>`（`lib/argument-route.ts`；与 `explore-route.ts` 共用 `lib/hash-route.ts` 的前缀路由与总线工厂）。从 UI 进入时 pushState 一条历史，浏览器后退回到文献库；从正在探索的窗格进入时也只写这一条（探索被让位而不再写它自己的「回到普通 URL」那条）。Shell 的启动与 hashchange/popstate 把 hash 交给 `argumentBus`，**没有 Library 页时（启动，以及 popstate 回到 `#argument/…` 而 Reader 已占了窗格时）先建一个**（`ensureLibraryPane`；popstate 路径先问离开保护），请求挂起到 Library 页注册。popstate/hashchange 到任何不是 `#argument/…` 的 URL（含 Doc 路由）都先退出视图。F5 或直接打开回到同一视图；选中的论证不进 URL。坏链接、Work 不存在、文件损坏都是可返回文献库的正常错误态，不破坏 shell。
- **读取与刷新**：`api/argument-graph.ts` 的 `fetchArgumentGraph` 走 `apiRequest`，结果为 `ok / not-found（404）/ corrupt（500 且 detail 以固定文案 "argument graph file is unreadable" 开头）/ error`；无图是服务端给的空图（`rev: 0`），显示空图状态，**不与 corrupt 混淆**。`useArgumentGraph` 在收到本 Work 的 `argument-graph.changed`（`put` 与 `external` 一视同仁）后重取；重取期间保留旧图，内容相同的重取不换对象（server 自写会再触发一次 external）。socket 重连（`hello`）也重取一次，事件可能在断线时丢了。重取遇到 404 或文件损坏如实切到对应错误态，文件修好后下一次事件恢复；遇到瞬时错误（无应答、其他 server 失败）则**保留已显示的图**，在标题栏下给出非阻断的提示与「重试」，下一次成功的读取清除它（首次读取没有图可留，失败仍是错误态）。损坏的识别用 contracts 的 `ARGUMENT_GRAPH_UNREADABLE_PREFIX`（server 的固定文案前缀），两端引用同一常量，server 测试绑定它。选中是视图自己的状态：论证仍在则保留，被删除（图读成功但不含它）才清除；错误态不清除。
- **页面上下文（Copilot，ADR 0005）**：视图把 `ArgumentPage`（contracts `argument-ops.ts`，strict）经 Library pane adapter 发布为 `PageContext.argument`，打开期间它代替 `library`（与 Discovery 同样不再把 Library 页当作当前页；`library: null`）。形状：`work {id,title}`、`phase`（loading / ready / empty / not-found / corrupt / error）、`rev`（读到的文件版本，无图时 null）、`counts {arguments,edges}`、`audit`（`total`、环、无通路、无 End、End 有出边、Native 有入边、不完整，均按论证 id）、`selectedId`、`partial`、`reduction`（partial 页才有，null 即整图，见下「容量」），以及三选一的内容：`partial:false` 时 `graph` 是整张图；`partial:true` 时 `graph` 为 null，`outline`（每个论证的 id、短标题、种类、六个字段各自是否有内容、`warrantImplicit`、出处数）、`edges`（全部边）和 `selected`（选中的论证，完整）；`note` 是页面对自己的说明（所有形态都说明这是只读的论证图、Library 页动作此时不可用；partial 页另说明省略了什么）。status：ready 与 empty 是 `complete`，loading 是 `unavailable`，not-found / corrupt / error 是 `error`（coverage 校验在 `PageContext`）。上下文对象标识是 Work id 加图的 `rev`，名字是 Work 标题。
  - **容量**（硬上限 `ARGUMENT_PAGE_MAX` = 150 000 个 UTF-16 码元，整页 JSON，任何图、任何选中下都不超过；整图预算 `ARGUMENT_PAGE_FULL_MAX` = 100 000 指 `graph` 本身）：整张图 JSON 不超过 100 000 且整页不超过 150 000 时发布整图。否则发布 partial 形态，`reduction` 字段说明省略了什么，取**能满足 150 000 的最小级别**，且**不选比整页更长的形态**（整页不超过上限而没有任何级别更短时仍发整页）。级别逐级缩减：① `outline` 列出每个论证的 id、短标题、种类、六个字段各自是否有内容、`warrantImplicit`、出处数，`edges` 列全部边，`selected` 是选中论证全文；② `selected` 的每个字段截到 4000、每条出处文字截到 500 个字符（`reduction.textLimit`，被截的写进 `reduction.truncated`，如 `claim`、`sources.3.text`；出处目标不动）；③ `edges` 只留与选中论证相连的边（至多 300 条，`counts.edges` 仍是总数；没有选中则为空）；④ `outline` 只留 id、短标题、种类，选中论证再截到 1000 / 200，相连的边至多 100 条，审计各清单封顶（每类 30 个 id，环 5 个、每个 20 个 id，`audit.total` 仍是真实发现数，`reduction.auditTruncated`），`outline` 在整页逼近上限时只列放得下的（总含选中那条，其余数量写在 `reduction.outlineOmitted`；选中论证的尾部出处放不下时写在 `reduction.sourcesOmitted`），所以第 4 级无论图多大都不超上限。实测最坏情况（500 个论证、id 64 字符、标题 80 字符、5000 条边、选中论证六个字段各 20 000 加 50 条满长出处，整图约 2.1 MB）：选中时 145 895、不选 97 446；500 个短论证（整图 108 960，超整图预算）发 ③ 级 111 408，比整页短。schema 对各级别做交叉校验（保持 strict）：`reduction` 恰在 partial 页出现，`outline` 与 `reduction.outlineOmitted` 之和等于论证数，第 1–2 级 `edges` 等于边总数，第 3 级起只含选中论证的边，第 4 级条目只有 id / title / kind，`selected` 不长于 `textLimit`；整页另校验 `graph.work_id === work.id`。省略的文字在票 09 的论证图读取工具上线前模型拿不到，页面 `note` 要求如实说「看不到」，不要猜。**每个 phase、每种形态的 `note`（≤ 900 字符）都说明「论证图视图打开期间 Library 页面动作不可用」**，Copilot 看到被拒绝的动作就知道原因；最近一次重取失败而界面仍显示旧图时，`note` 追加「图可能不是最新的」（`ARGUMENT_STALE_NOTE`，沿用 note 而不是改 phase/coverage：图本身仍是完整、可用的读取）。system prompt 只在「可用的页面上下文」那句里加上论证图（该提示词有字节预算测试，说明留在页面里）。消息记录的摘要（`ArgumentContextSummary`）带选中论证的短标题 `selectedTitle`，界面显示短标题而不是 id。
  - **去重与观察**：选中变化、图的重取都经 Shell 的 `revision` 计数重发（`PUT /views/:id`），服务端只在每次模型请求前看一次当前版本，版本与已观察的不同才写一条 page-observation。整张图随任务的消息**或随一条 observation** 发出后（`argumentKey(workId, rev)` 记在 run 的 held 集合里；只有 `ready` 页登记，空图没有可列的内容），后续 observation 用 partial 形态列出图并带选中论证（同样取最小的满足上限的级别，且不长于它替代的整页，否则仍发整页）；`rev` 变了才再整图发一次，随后又是列出的形态，所以任务中途才打开论证图、或 rev 变化后，连续点选也不会产生整图洪流。observation 在写入历史之前用 `CopilotObservationSchema` 校验（`copilot-observation.ts` 的 `recordableObservation`）：校验不过的论证图页面不原样写入（写入后读回失败会让整个会话不可读），降级为一个 `phase: "error"`、不带图的合法页面并记一条不含内容的日志，连这样也不合法则不写这条 observation，下一次模型请求再试。
  - 视图打开期间 Library 页自己的动作（过滤、选中文献、探索入口等）一律 `unavailable`，system prompt 说明这时页面是论证图。打开、选中、退出论证图的 Copilot 视图动作与论证图读写工具属于票 09，这里没有。
- **出处跳转**：有目标且目标 `doc_id` 仍在该 Work 的 `doc_ids` 里才是可点按钮，否则只显示文字，不报错、不校验目标是否存在。点击经 `Workspace.openDoc(doc_id, anchor)`：共享 IR 的 Doc 用结构 id，PDF Doc 用 Reader 已有的 `page-<n>` 锚点；因此在单窗格布局下阅读窗格替换当前窗格（视图随之卸载），有多个窗格时用已有的 Doc 窗格。当前 URL 是 `#argument/…` 时打开 Doc 写**新**历史（`pushDocUrl`，其他情况仍是 replace），浏览器后退回到该图（popstate 回到 `#argument/…`，没有 Library 页就先建一个）；也可用 Reader 顶部入口。
- **没有的东西**：没有触发 Copilot 的按钮。新建、清空、编辑、删除、连边见下一节「编辑」。
- **窄窗格**（用户 2026-10-12 的决定，不是原型内容；规则是 `argument/layout.ts` 的纯函数，与文献库 `library/layout.ts` 同一思路并复用其 `MIN_GRAPH_COLUMN`）：大纲 300、面板 392 在任何宽度下都是原型宽度，不再收窄。度量的宽度是视图自己的宽度（`useElementWidth`，即窗格宽，1440 窗口单窗格 1378、1024 窗口 962、1440 双窗格各约 686）。① 面板打开且大纲与面板并排后画布会少于 `OUTLINE_FOLD_CANVAS`（480，即窗格 < 1172）时，大纲自动折叠成 34 px 的轨道（`lib-rail`，`expand-argument-outline`，图标/文案/键盘与文献库列表的折叠控件同一模式；大纲头部的 `collapse-argument-outline` 可手动折叠）。480 不是用户给的数：文献库只在画布 < 240 才折，但那样 1024 窗口（962）会留下 270 px 画布、适应缩放 30%，比旧的收窄做法还差；折叠后有 536 px。要改只改这一个常量。② 用户手动展开后，本次面板打开期间尊重这个选择（此时画布不足则走③，不再自动折叠）；关闭面板或宽度档变化后恢复自动；用户手动折叠的任何时候都不自动恢复。关闭面板后被自动折叠的大纲自动回来。大纲各行的展开状态由视图持有，折叠再展开不丢。③ 折叠后（或用户展开后）画布仍不足 `MIN_GRAPH_COLUMN`（240）时，面板（`data-placement="overlay"`）盖在画布右侧：绝对定位、不占画布宽度、仍有关闭按钮，Esc 关闭（审计清单开着时第一个 Esc 先关清单）。画布收到 `coverRight`（面板宽，窗格更窄时取窗格宽）：适应窗口与「选中的论证保持可见」只按未被盖住的部分算，缩放栏左移到面板之外（`--cover-r`）。④ 画布的覆盖层在窄列里保持完整：画布标题最窄 180、图例最宽随画布收窄（行内换行）且让出缩放栏，缩放栏不压图例。判定阈值：窗格 ≥ 1172 并排；666–1171 大纲折叠、面板并排；< 666 面板浮层（用户展开大纲时 < 932）。


## 编辑（票 05；`contracts/src/argument-edit.ts`、`web/src/argument/`）

用户不借助 agent，在视图里从空图整理出完整的论证图。批准的界面是原型变体 C（[spec](../.scratch/argument-graph/spec.md)「已批准的界面」），页面功能如下；Copilot 的论证图工具（票 09）将调用同一批纯操作与同一条提交路径，页面与工具不得各写一套。

- **提交路径只有一条**。纯操作在 contracts：`createArgument`、`updateArgument`、`deleteArgument`（返回 `removed`）、`restoreArgument`、`addEdge`、`removeEdge`、`clearArgumentGraph`，输入图与参数，输出新图或拒绝原因（`not_found` / `self_loop` / `duplicate_edge` / `edge_not_found` / `invalid`）。每个结果都过 `ArgumentGraphSchema`，所以「操作拒绝」与「服务端 400」是同一套规则；`checkArgumentGraphForWrite` 把 schema 失败翻成可读的 `ArgumentEditIssue`（短标题为空或超长、字段超长、出处文字为空、出处/论证/边超限、id 重复）。纯操作不碰 `rev`。web 侧 `argument/commit.ts` 的 `commitArgumentEdit(workId, base, edit)` 对调用方读到的图执行操作，再以 `base.rev` 做整图 `PUT`（`api/argument-graph.ts` 的 `putArgumentGraph`，结果 `ok / conflict / invalid / not-found / corrupt / error`）。`useArgumentWrites` 把写入排成串行队列：每次写入作用于页面持有的最新图，服务端对上一次写入的回答立即被采用（`useArgumentGraph.adopt`，不等广播），所以连续两次编辑不会各拿一个过期的 `rev`。**「判断」必须在执行时做**：排队的写入在轮到它时才作用于当时的图，所以任何「这张图还是我看到的那张吗」的检查都写进传给提交路径的 edit 闭包里（`commit.ts` 的 `STALE`：返回它就不写、结果是 `conflict`），不得在入队前用 `latest` 判断：表单保存检查这个论证是否仍与表单开始时一致，清空检查论证数与边数是否仍是对话框写明的那两个。页面显示的永远是见过的最高 `rev`：`adopt`（自己写入的回答、重新载入）不取消在途的读取，也不会把页面拉回更低的 `rev`；一次在某次 `adopt` 之前就已开始、返回时比所显示的更旧的读取被忽略，而在最近一次 `adopt` 之后才开始的读取是服务端当前的话、照单全收（人手恢复了旧文件）。「重新载入」排在写入队列里，不会越过在途的写入。
- **冲突（409）不覆盖**。立即生效的写入（连边、移除边、删除、清空、撤销）遇到 409 时，页面重取最新图并说明「这次改动没有写入」，请用户再试一次。论证被删除、保存会重新建出它时，冲突说明还会告诉用户「原来的边不会回来」。表单保存遇到 409，或表单开始后这个论证已在别处被改（与开始时的存档不同）或被删除，则**表单草稿原样保留**，面板底部显示冲突说明，保存停用，直到用户点「重新载入」（读取最新图，把它当作新的起点；论证已被删则之后保存会重新建出它）。别处改了**别的**论证则不算冲突：保存基于最新图。编辑中收到外部更新从不替换草稿，被别处删除的论证在草稿未存时也留在面板里。
- **删除不确认，可撤销**（用户 2026-10-12 的决定，见票 05）。删除经同一条路径写入，随后给 8 秒的「撤销」提示；撤销以**删除之后那张图及其 `rev`** 为基础把论证连同它的边放回原来的位置，所以期间图被别处（或自己后来的写入，此时提示已被收起）改过，写入得到 409，页面如实说「图在此期间被改动过，无法撤销」并重新载入，不覆盖任何东西。清空整张图才弹确认对话框（写明论证数与边数、不能撤销，默认焦点在取消，失败时对话框保持打开并说明）。
- **新建**：标题栏与空图状态的「新建论证」打开面板的编辑态并聚焦短标题；论证不在图里直到第一次保存（id 是 `a` 加 5 位随机小写 base36，如 `a7k3q2`：`nextArgumentId(graph, random?)`，随机源可注入，与图中现有 id 不撞（重抽有上限，随机源恒定且该 id 已占用时改为在末尾加计数，不会死循环）；不再取最小未用的 `a<n>`，否则删掉末尾论证后新论证会复用它的 id，冲突检测与撤销按 id 认论证会认错），Cancel 即丢弃，保存之前不能连边（连边控件停用）。保存空短标题不可能（按钮停用）。
- **连边**：面板里各 Toulmin 元素的「添加来自其他论证的依据」与「被用于」。选择器默认只列比当前论证低一层（「被用于」方向为高一层）的论证，层取当前画布布局的分层（`argument/layers.ts` 复用 `layeredLayout`，选择器与画面不会不一致）；「显示全部论证」勾选后低一层排在最前一组；低一层为空时自动显示全部。已有同角色边的论证不出现在对应选择器里；「被用于」的角色下拉里，该对已有的角色不可选，四个角色都有时论证不再出现。空的可选元素（Backing、Rebuttal）阅读态隐藏，因此给它们连边要先进入编辑态。画布拖拽连边：松手后在落点弹出角色选择（`RoleChooser`，非模态，Esc、「取消」或点外部关闭；Esc 在捕获阶段被它独占，只关这一层，窄窗格浮层形态下不会同时关面板；Esc、「取消」或选定后焦点回到画布上的源论证节点，点外部则不抢焦点；「取消」撑满整行），松手在自己身上被拒并提示，同角色已存在的选项禁用；不受按层过滤影响。选择器的计数提示按方向说「低一层 N 个」/「高一层 N 个」（`pickCountBelow` / `pickCountAbove`）。同一目标以多个角色被用时，`argument-link` 与 `remove-argument-link` 的 `data-ui-key` 是 `<目标 id>:<角色>`，区分是哪条边。表单控件跟随密度令牌（`--control-h`、`--fs-sm`），所以 comfy 下选择器与「添加」同高对齐；种类分段控件是单个 Tab 停靠点，方向键/Home/End 切换，Native / End 的说明是控件下方的可见文字（`aria-describedby`），不只在 `title` 里。移除边：面板里每条关系的 × 按钮。
- **出处**：每条出处是显示文字加可选跳转目标。目标先选该 Work 的一个 Doc；共享 IR 的 Doc（LaTeX/文本）再从**该 Doc 现有的结构**里选章节、图、表或带编号的公式（`api/doc-structure.ts` 读 `/api/paper/:id/ir`，没有额外计算或存储），PDF Doc 填页码（上限为页数）。选了位置而文字为空时自动填 `Section 3.2`、`Figure 4`、`Table 2`、`Equation 7`、`Page 5`（`autoSourceText`，不用 `§`）；保存时文字仍为空也会补上。只选了 Doc 没选位置的出处存为纯文字。结构读不出来时仍可只写显示文字。不在该 Work 里的旧目标 Doc 也保留并标出。Doc 下拉里每个 Doc 带格式标记，格式与「主」标记在前、完整 id 在最后（`LaTeX · 主 · <doc id>`；格式读自 Doc 的 description），下拉与每个选项都有完整内容的 tooltip；Doc 下拉与位置控件各占一整行，面板宽 392 时不再截断标记。
- **未保存草稿与离开保护**：唯一的未保存状态是面板的草稿（新建的论证，或表单被改过）。离开它的每条路径都先问，**问的是应用自己的确认对话框**（`argument-leave-dialog`，`ui/` 的 Dialog，样式同清空等既有确认框；标题「放弃未保存的修改？」，正文写明将丢弃哪个论证的修改，默认焦点在「继续编辑」，「放弃修改」是 danger primary），不用 `window.confirm`：切换论证、关闭面板、返回文献、再点「新建论证」（放弃后表单重置为空白新建）、点清空、删除，以及下面的窗格与导航路径。待决导航：工作区离开守卫可以**晚一点回答**（`workspace.tsx`：守卫返回 `boolean | Promise<boolean>`；`askWorkspaceLeave(view, paneId, origin)` 依次询问、首个拒绝即止（`origin` 是 `user`（默认）或 `agent`，见下「Copilot 发起的离开」）；`whenWorkspaceMayLeave(proceed, view, paneId)` 在回答为是时才执行原动作；同步的 `confirmWorkspaceLeave` 把晚回答当作拒绝）。窗格管理器的 `confirmLeave(view, paneId)` 同样可返回 Promise：裁决前切换/关闭不发生（调用返回 false），回答是之后再做、且只在该窗格仍在时做。**守卫只在真的要离开或卸载论证图视图时发言**：带 `view: "library"` 的守卫登记时带上自己的窗格号，只回应切换或关闭**这个** Library 窗格、浏览器后退/前进离开图、或把这页换成另一个 Work 的图；换 Doc、在另一个 Doc 窗格切 Doc、Copilot 确认删 Doc、关闭另一个 Library 窗格都不问（不带 `view` 的守卫仍是 Doc/Reader/文本编辑器那些，行为不变，它们继续用 `window.confirm`）。Shell 的 `openDoc` 在没有 Doc 窗格、要把当前 Library 窗格换成 Reader 时先问（即使目标就是当前 Doc）；由浏览器后退触发的 `openDoc` 已问过，经 `{ libraryAsked }` 跳过，所以一次导航只问一次。Reader 顶部入口到另一个 Work 的图：`LibraryView.openArgument` 在显示另一个 Work 前问，取消则不写历史条目；由 Shell 的后退/前进触发的请求带 `confirmed`，视图不再问第二次。**浏览器后退/前进的历史行为**：问谁取决于**哪个窗格开着图**——每个 Library 窗格自己登记它正显示的 Work（`ArgumentTarget.workId()`，没有模块级单值），Shell 用 `argumentBus.affected(目标 Work 或 null)` 找出总线会作用的那个窗格（与 `argumentBus.request/exit` 同一条选择规则）；它显示的图会被换掉或关掉才问，问的是**那个窗格**的守卫。因此两个 Library 窗格都开过图、其中一个已用返回按钮回到文献库时，另一个窗格带着草稿的图在后退时照样会问。popstate 已把 URL 移走时，Shell 立即 `pushState` 把图的 URL 推回去（浏览器的前进条目因此被丢弃，不留多余的后退条目）；回答「放弃」后调 `history.back()` 回到用户选的那条，**并只放行这一次**：放行值（`allowed`）记着那条 URL，由到达该 URL 的导航取走（真实浏览器对一次 hash 变化的遍历先后触发 `popstate` 与 `hashchange`，第二个事件不再问，所以取走后还留 100 ms），2 秒后、以及再次从界面进入图（Reader 入口）时一律作废；从界面进入图用 `pushState`，浏览器不触发任何导航事件，旧版「到下一次导航才清」会让之后同一 URL 的后退被放行而丢草稿。**对话框待决时用户又改 hash/又导航**：不再弹第二个对话框，也不死循环；这次导航只是把「放弃」要去的目标更新为最后一次请求的 URL（`history.back()` 总是落在用户最后请求的那条上），图的 URL 再被推回去，所以每多一次这样的手改，历史多 2 条（浏览器自己的一条加推回的一条）；回答「放弃」后到达最后请求的目标，回答「继续编辑」则全部取消、留在图上。后退被拦后「前进」方向（图 → 别处 → 后退回图 → 再前进）取消时历史末尾会多出一条同图 URL 的条目。**文件不可读时的草稿**：见下一条。关闭标签页或刷新走 `beforeunload`（只能是浏览器原生提示）。未改动的新论证不算草稿。撤销成功不切走选中：有别的论证的草稿时撤销照做，选中留在正在编辑的论证。**Copilot 发起的离开**：守卫收到发起者（`LeaveOrigin`：`user` / `agent`）。Copilot 的视图动作（`switch_view`、`close_pane`、`open_doc`、`open_task_doc`，以及页面动作需要把窗格切到某页）以 `agent` 询问；带草稿的论证图页对 `agent` **直接拒绝**，动作结果是 `leave_blocked`（server 给模型的文案是「视图没有变化，请用户先保存或放弃」），**不弹对话框、不留待决导航**；用户自己的点击、后退、窗格操作仍以 `user` 询问并弹对话框。Doc/Reader/文本编辑器的守卫不区分发起者（仍是同步的 `window.confirm`，行为不变）。**文件变得不可读时草稿保留**：编辑中图文件被外部写坏（corrupt）、Work 被删（404）或重读失败，经 WS 刷新后，页面主区是对应的错误态，但**有未保存草稿时面板与草稿留着**（用最后一次读到的图渲染，写入类控件停用），页脚显示「论证图文件当前不可读 / 文献已不存在 / 暂时读不到论证图，无法保存」（`argument-save-unavailable`）并停用保存；文件恢复可读后回到可保存状态，该论证在此期间被改过则走既有冲突流程（保存停用、重新载入）。没有草稿时仍是错误态页面。**Ctrl/Cmd+Z 撤销删除**只在键盘焦点位于本论证图视图内（本窗格）时生效；删除后若焦点落到页面外，视图根元素取得焦点，所以删除后直接按仍然有效。页面上下文（Copilot）不标记草稿：`ArgumentPage` 是 strict 且已写进持久化的 Copilot 历史（reader/writer/text 的页面上下文都带草稿标记，论证图没有），留给票 09 决定是否放宽 contracts。
- **通知**：删除后的撤销、写入失败、自环提示等都在画布列底部居中显示（`.ag-notices` 在 `argument-main` 内，样式与层级取 `.plan-undo` / `.ann-toast` 的 toast 约定，`aria-live="polite"`；位置随画布图例的高度抬升，不遮挡图例、缩放栏与大纲；沿用 toast 的底部居中约定，所以 8 秒的删除撤销提示可能短暂遮住画布最底层节点的标签（已知，不改位置）；左右各留 76px 给缩放栏）。每条通知及它的按钮带区分实例的 `data-ui-key`。撤销可用键盘：Tab 到通知上的「撤销」，或在不在文本框/对话框里时按 Ctrl/Cmd+Z。「无法撤销」这类原先常驻的通知 15 秒后自行消失，也可关闭。
