# 操作目录与 CLI 派生规则

[ADR 0015](adr/0015-one-operation-catalog-for-copilot-and-cli.md) 的实现专题（release-0.2 票 01 起）。数据保护条文在 [contracts](contracts.md)「操作目录与外部 agent」；本文只写代码形状与派生规则，这两处是它们各自的权威。

## 代码形状

目录是 `packages/contracts/src/operation-catalog.ts` 里的 `OPERATION_CATALOG` 数组。每个条目由 `defineOperation`（`operation-def.ts`）建立，字段：

| 字段 | 含义 |
|---|---|
| `domain` | Copilot 工具名，也是 CLI 组名（`library`） |
| `name` | Copilot 动作名，snake_case |
| `id` | `<domain>.<name>`，类型层面是字面量 |
| `summary` | 一句话，CLI `--help` 的说明 |
| `effect` | `read` 或 `write` |
| `confirm` | `none`；`card`（要 Copilot 同类确认卡；票 04 起生效）；`conditional`（只有部分调用要卡，由处理器自己判断：`library.attach_arxiv` 替换既有 Doc 正文时，票 06；`argument.replace` / `clear` 作用于有论证的论证图时，票 08） |
| `navigates` | 是否是「让工作台打开某处」的导航操作（票 05） |
| `params` | 不含 `action` 的 strict zod 对象 |
| `result` | 结果的 zod 形状，含 `{ ok: false, status, detail }` 这类属于答案的失败 |

**选择：在现有 `*-ops.ts` 的动作 schema 上加元数据，不另建一份参数注册表。** 条目的 `params` 就是已有动作 schema 去掉 `action`（`LibraryReadOperationSchema.omit({ action: true })`），参数仍只在 `*-ops.ts` 里写一次，其注释（对应页面哪个控件）原样保留；条目只补 schema 没有的东西。另建注册表会再抄一遍参数，两处必然漂移。带 `superRefine` 的动作 schema（如 `import_works`）不能 `omit`，那时给条目写显式的 params schema，并在 `*-ops.ts` 里让动作 schema 复用它，仍保持一处定义。条目放在 `<domain>-catalog.ts`，由 `operation-catalog.ts` 汇总。

执行在 server：`packages/server/src/operation-catalog.ts` 的 `OPERATION_HANDLERS` 以条目 id 为键，每个处理器就是业务代码本身（`readLibrary`、`applyLibraryOperation`）；给目录加条目而不加处理器是类型错误。`runCatalogOperation(runtime, id, params)` 是 Copilot 工具与 CLI 共用的执行入口。

## 加一个操作

1. 在 `*-ops.ts` 有（或新写）动作 schema；在 `<domain>-catalog.ts` 写条目与结果 schema，列入 `OPERATION_CATALOG`。
2. 在 `OPERATION_HANDLERS` 加处理器。
3. Copilot 工具里该动作的分发改为 `parseCatalogCall` 取参数、`runCatalogOperation` 执行（`copilot-library-tool.ts` 的 `library.read`、`library.set_main_doc` 是范例）；工具说明文字仍是手写的，工具 schema 的字节不变。
4. CLI 无需改代码：`registerOperationCommands`（`packages/cli/src/operations.ts`）遍历目录注册。

界面动作（`filter_library` 等）不进目录。

## 派生规则

- **命令**：`argelanderspace <domain> <name 的下划线换成连字符>`，如 `library set-main-doc`。领域组若已存在（`library` 有既有的 `build`）则就地增加子命令，既有命令不动。
- **参数到选项**：每个扁平参数一个选项，camelCase 变 kebab-case（`refId` → `--ref-id`）。类型：字符串、整数、枚举（`<a|b>`）取值；布尔是不带值的开关。可为 `null` 的参数（如 `expectedMainDocId`）取值 `null`（字面）表示 JSON null。选项一律不在命令行层面标必填，缺参数由目录的 schema 校验并报告；帮助里标 `(required)`。
- **`--json <file|->`**：整个参数对象从文件或标准输入读入，不能与参数选项同用；对象里不写 `action`。嵌套或数组参数（标注的 `target`、PDF 的 `rectangle`、`parts`，论证图的 `argument`、`patch`、`graph`、`ids`）也是一个选项，值写 JSON 文本（`--target '{"type":"document"}'`，`operationOptions` 里 `kind: "json"`，票 07 起）；整个对象用 `--json` 更省事。
- **`--data-dir`**：与既有命令一致。
- **输出**：stdout 一份 JSON（两格缩进），就是该操作的结果对象，与 Copilot 工具返回的同形。**退出码**：

  | 码 | 含义 |
  |---|---|
  | 0 | 结果为 `ok`/`noop`（或读取成功） |
  | 1 | 操作答了 `ok: false`（`not_found`、`conflict`、`rejected`、`error`、`workbench_required` 等）或意外失败（只在 stderr 写 `error: …`） |
  | 2 | 参数无效，输出 `{ ok: false, status: "unsupported", detail }`，什么都没执行 |
  | 3 | 用户在确认卡上拒绝：stdout `{ ok: false, status: "denied", detail }`，什么都没做 |
  | 4 | 等待确认卡时工作台退出或不再应答：stderr `error: interrupted; …`，stdout 无输出。卡片随工作台消失；若恰在此刻批准，操作可能已执行，先读取对象核对 |
  | 130 | 命令在等待确认卡时被 Ctrl-C（或 SIGTERM）中断，卡片已撤回，stderr 写 `error: interrupted; …` |

  3、4、130 只出现在 `confirm: "card"` 与 `"conditional"` 的操作上。
- **路径选择**：命令先在参数校验（退出码 2，不执行也不联系工作台）通过后，按 `--data-dir` 解析出 dataDir，查该目录的实例记录（下节）。有活的工作台就交给它，没有就在本进程执行。两条路径的 stdout、stderr、退出码同形（测试逐字节比对）。只读操作也走工作台，读到的是它当前的状态。
- **本进程路径**：用与 server 同形的 `LibraryOpDeps`（自己的库锁，无通知，读 Library 时图缓存过期则在内存里重建而不写盘；`createLocalOperationRuntime`）。

## 运行中的工作台（票 02）

ADR 0015 的「单写入者」实现。`serve` 与桌面宿主（二者都经 `startServer`，且只在打开了项目时；无项目的欢迎态不登记）。

**实例记录**：`<dataDir>/workbench.json`，权限 0600，内容 `{ v: 1, pid, port, token, startedAt }`。放在 dataDir 内而不是全局缓存目录，因为「同一 dataDir」就是单写入者的单位，`--data-dir` 指到哪里记录就在哪里，不需要在全局目录里再按路径做键；代价是 dataDir 若被纳入版本控制，崩溃遗留的记录可能被提交，但其令牌在进程退出后不对应任何监听者，无法使用。`token` 是每次运行随机的 32 字节十六进制，是路由的唯一凭据，不写日志、不输出（请求日志只记路由模式）。记录先写临时文件再硬链接到位（已存在则失败），所以读者看不到半个文件，两个同时启动也只有一个成功。正常退出（`close()` 的第一步）撤销，只删令牌仍是自己的记录。

**陈旧记录**：记录只有在 pid 存在且令牌握手成功（`GET /api/operations/handshake` 带令牌，回答 `{ok:true,pid}` 且 pid 一致）时才算「活」。pid 不在、端口无人监听、端口回应但不认这个令牌或 pid 不符、文件损坏，都是陈旧，视为没有工作台并清掉（只在记录仍是被判定的那份时才删，不误删新启动的记录）。第三种情形「无响应」：pid 存在但握手超时（3 秒，忙而非死）——不删、不绕过：CLI 报错退出 1（`the workbench … is running but did not answer`），第二个 `serve` 也拒绝启动，因为绕过会让两个写入者同时存在。

**同 dataDir 两个 `serve`**：第二个拒绝启动，抛 `WorkbenchConflictError`（`another ArgelanderSpace workbench is already running for this data directory (pid …, port …)`），已被它打开的监听随即关闭，第一个的记录不受影响。陈旧记录不阻止启动。登记因其他原因失败（目录不可写等）时 server 继续运行，终端写一行警告，此后 CLI 在本进程执行（等同没有本机制），不静默。

**HTTP 协议**（`operation-routes.ts`；仅在 server 带运行令牌时挂载）：

| | |
|---|---|
| 凭据 | `Authorization: Bearer <token>`，常量时间比较；对端地址能判断时必须是回环。无令牌、错令牌一律 `401 {ok:false,status:"unauthorized"}`，什么都不执行 |
| `GET /api/operations/handshake` | `200 {ok:true,pid}` |
| `POST /api/operations/run` | 请求体 `{ id, params, client? }`（`client`：`{pid, commandLine}`，CLI 如实填，目前仅接收） |
| 200 | 操作自己的结果对象，原样（含 `ok:false` 的答案；CLI 据此退出 0 或 1） |
| 400 | `{ok:false,status:"unsupported",detail}`：请求体坏、id 不在目录、参数不合 schema（未执行；CLI 退出 2）。参数校验用 `parseOperationParams`，与 CLI 本地校验同一函数，detail 相同 |
| 500 | `{ok:false,status:"error",detail}`：处理器抛出（操作可能执行过，也可能没有；CLI 写 stderr `error: …`，退出 1） |

server 端用自己的运行时（`createApp` 里 Copilot 工具共用的那份 `LibraryOpDeps`：同一把库锁，`onChanged` 广播 `library.changed`），所以经 CLI 的写入与 Copilot 写入触发相同的 WS 更新。连接中途断开时 CLI 报 `the workbench … stopped answering; the operation may or may not have run`，退出 1。

**给后续票的预留**（协议不需改动）：
- 票 04（确认卡）：已实现，见下节「确认卡」。
- 票 05（导航）：已实现，见下节「导航」。

## 确认卡（票 04）

`confirm: "card"` 的操作（现有 `library.delete_doc`）经 CLI 发起时，卡片出现在运行中的工作台里；这是 ADR 0015「确认」与契约「操作目录与外部 agent」的实现，界面依据已批准的原型 `.scratch/release-0.2/prototype/03-cli-confirmation/` 方案 A（用户 2026-10-28 审阅）。

**流程。** CLI 选路后，需要确认的操作在没有活工作台时直接答 `{ ok: false, status: "workbench_required" }`（退出 1），不在本进程执行、不启动工作台。有工作台时 `POST /api/operations/run` 在同一请求上挂起：server 先读删除对话框会显示的事实（与 Copilot 共用 `prepareDocDelete`，Doc 不存在、忙、孤儿等照旧直接拒绝、不出卡），再把卡放进**外部请求队列**（`external-requests.ts`，不属于任何 Copilot 会话），等人决定，CLI 不设超时。批准后再核对一次（`recheckDocDelete`，Works、标注数或摘要变了答 `expired`），然后跑与 Copilot 相同的全局物理删除（`applyDocDelete`：输出与标注含归档一并删、从所有 Work 摘除、剩余首个 Doc 递补为主、`library.changed`）。

**五种结局。** 批准：执行并返回结果（退出 0；执行失败按操作结果退出 1）。拒绝：`denied`，退出 3。CLI 被 Ctrl-C 或连接断开：请求的 `signal` 中止，卡片变为 `withdrawn`，不再能批准（server 对已撤回的卡拒绝决定，409），首张撤回卡留到用户点「关闭」，排队中的撤回卡 4 秒后自行消失；已批准的请求不被撤回（点击即提交）。工作台在等待中退出：连接断开，CLI 退出 4；卡片不跨重启恢复。工作台未运行：`workbench_required`，退出 1。退出码全表见上文「输出」。

**页面一侧。** `GET /api/external-requests`（队列）、`POST /api/external-requests/:id/decision`（`{decision: "approve"|"deny"}`；批准的应答等操作完成后带回结果）、`POST …/dismiss`（关闭撤回卡）；队列变化用 WS 帧 `external-requests.changed`（无载荷，页面重读）。只有最早一张卡可决定（其余 409 `not_first`）。决定与关闭要求带 `Origin`（浏览器页面必带），无 Origin 的请求（curl、脚本）403；这不防同账户下伪造头的进程，只防持令牌的 agent 顺手自批。web 在 `src/external-requests/`：卡片内容就是 Copilot 同一 action 的卡（`copilot/confirmations` 的 `CONFIRMATION_KINDS`），批准前问同一套页面守卫（`ConfirmationGuards`，如打开中 Doc 的离开守卫）；批准成功后由决定的那个页面做 Shell 的三态更新（`docDeleted`）。窗口标题加 `(n)` 前缀，等待中有请求时 `beforeunload` 提示。**未实现**：桌面应用的 OS 通知与任务栏角标（页面里没有 Tauri 入口，需要新的宿主桥接，另议）。

**给后续确认卡操作（06/07/08）。** 目录条目写 `confirm: "card"`；处理器里仿 `runDeleteDocOperation`：先做无写入的预读与拒绝，再 `runtime.confirm.ask({ card, client, signal })`（`card` 是 Copilot 该 action 的卡字段，不含 id），按 `answer`（`withdrawn`/`denied`/`approved`）返回，批准后核对并执行，最后 `settle(result)`；Copilot 一侧继续用自己的会话卡，预读/核对函数抽成共用以保持措辞一份。web 一侧该 action 若已有卡种则自动可显示；队列和折叠栏里的一行摘要在 `summaryOf`（`ExternalRequests.tsx`）按 action 补，撤回与结果文案按需补 `externalRequests.*`。

## 导航（票 05）

`navigates: true` 的操作是「让运行中的工作台打开某处」，只有「打开」：Doc（可带锚点）、Work、Work 的论证图。切面板、翻页、缩放等界面动作仍只在 Copilot 工具里。它们不写任何数据（`effect: read`），但**只有运行中的工作台能执行**：没有工作台时命令答 `{ ok: false, status: "workbench_required" }`（退出 1），不在本进程做事，也**不会启动工作台**（Q23）。

**CLI 命名：选用 `argelanderspace open …`，不用派生名。** 条目的可选字段 `cli: { group, name }` 覆盖 `<domain> <name>` 的派生（只影响 CLI；Copilot 一侧不变）。三个动词分属 Copilot 的三个工具（`workspace`、`library`、`argument`），派生出来是 `workspace open-doc`、`library open-work`、`argument open`，对人和 agent 都不如一组 `open` 好找；票据明文允许。

| 命令 | 条目 id | 参数 | Copilot 对应 |
|---|---|---|---|
| `open doc` | `workspace.open_doc` | `--doc-id`，`--anchor`（可选，仅 CLI） | `workspace` 工具的 `open_doc`；定位用 `reader` 的 `navigate` |
| `open work` | `library.open_work` | `--ref-id` | 无同名动作；Copilot 用界面动作 `select_work`（不进目录） |
| `open argument-graph` | `argument.open` | `--work-id` | `argument` 工具的 `open` |

`workspace.open_doc` 与 `argument.open` 的参数来自 Copilot 原有 schema（`WorkspaceOpenDocSchema`、`ArgumentOpenGraphSchema`），两个工具分发改用 `parseCatalogCall` 取参数，向浏览器要的仍是各自原来的 view action，工具 schema 与说明字节不变。`anchor` 是目录条目唯一的 CLI 专有参数，Copilot 的 `open_doc` 没有（带了会被拒）。`open work` 在 Copilot 一侧没有新增动作（会改工具 schema 与窗口常量）。

**窗口与「最近活动」。** 窗口 = 一个页面（浏览器标签页或桌面应用的 webview）的一条 `/ws`。页面自己生成窗口 id，经 WS 上报（`contracts/src/workbench-windows.ts`）：`window.active`（获得焦点、变为可见、连接时可见、被使用——点击或按键，最多每秒一次）与 `window.hidden`（不可见）；每次（重）连接都重报，因为服务端随 socket 忘掉窗口。server（`workbench-windows.ts`）只记上报的先后（计数器，不是时钟）：
1. 已报过 id 且不是 hidden 的窗口里，最后一次 `window.active` 最晚的那个；
2. 全部 hidden 时，hidden 前最后活动的那个；
3. 没有任何窗口报过 id（没人打开工作台）：`{ ok: false, status: "no_window" }`。
失焦不是上报：用户点到别处但窗口仍可见（另一块屏幕）不改变排序。不会聚焦、弹出或新开任何窗口，页面在后台时用户未必看到跳转。

**流程。** CLI 与确认操作一样 `POST /api/operations/run`；server 处理器先对 Work 类目标查 Library（`readLibrary`），没有这个 Work 直接答 `not_found`，不惊动窗口；然后向选中的那个窗口发 `workbench.navigate` 帧（`{windowId, navId, target}`，只发给这一个 socket），页面经 Shell 与 Copilot 同一套动作执行（`open_doc` → Shell 的 `openDocAction`；带锚点再用 Reader 的 `navigate`；`select_work`；`open_argument_graph`），把**真实结果**用 `window.navigated` 报回，等待 15 秒。Doc 不存在、锚点不存在由页面自己的答案决定。未保存的草稿以 `agent` 来源询问规则处理：被保留即 `leave_blocked`，不弹询问。

**结果**（`NavigationResultSchema`，退出码 0 仅 `ok`）：

| status | 含义 |
|---|---|
| `ok` | 窗口报告已显示 |
| `not_found` | 没有这个 Doc 或 Work；或 Doc 已打开但没有该锚点（detail 说明，Doc 留在无定位处） |
| `not_displayed` | 窗口没能显示：有未保存工作被保留、当时的页面无法执行（如论证图打开时 `open work`）、15 秒未确认、窗口中途关闭 |
| `no_window` | 工作台在运行，但没有任何窗口 |
| `workbench_required` | 没有运行中的工作台（本进程路径与处理器自己都这样答，同一字节） |
| `unsupported` | 参数无效（路由 400，CLI 退出 2，未执行） |

CLI 不对导航操作设 Ctrl-C 撤回；命令被中断时连接断开，server 的请求 `signal` 中止，等待结束，不影响已显示的页面。

## 现有目录条目

| id | effect | confirm | 说明 |
|---|---|---|---|
| `library.read` | read | none | 页面自己的列表/搜索/详情数据 |
| `library.set_main_doc` | write | none | Files 标签的「设为主 Doc」，带 `expectedMainDocId` 做冲突检查 |
| `library.delete_doc` | write | card | Files 标签的「删除文档」：全局物理删除，经确认卡（票 04） |
| `workspace.open_doc` | read | none | 导航：`open doc`（见「导航」） |
| `library.open_work` | read | none | 导航：`open work` |
| `argument.open` | read | none | 导航：`open argument-graph` |
| `discovery.search_ads` | read | none | 只读 ADS 搜索（票 09），见下节 |
| `discovery.explore` | read | none | 探索页对一个 seed 的请求，以数据返回（票 09），见下节 |
| `library.import_works` | write | none | 导入菜单的三种对话框（票 06），见「Library 领域」 |
| `library.attach_local_pdf` | write | none | 本机 PDF 挂为已有 Work 的 Doc（票 06） |
| `library.list_ads_libraries` | read | none | 读用户自己的 ADS libraries 列表（票 06） |
| `library.read_ads_library` | read | none | 读一个 ADS library 的一窗 bibcode（票 06） |
| `library.acquire_arxiv_pdf` | write | none | 「从 arXiv 获取 PDF」（票 06） |
| `library.attach_arxiv` | write | conditional | 「从 arXiv 获取 LaTeX 源码」；替换既有 arXiv Doc 正文时要确认卡（票 06） |
| `library.read_jobs` | read | none | 获取任务状态行（票 06） |
| `argument.read` / `create` / `update` / `delete` / `undo_delete` / `add_edge` / `remove_edge` | read / write | none | 论证图的业务操作（票 08），见下节 |
| `argument.replace` / `clear` | write | conditional | 整图替换与清空：论证图有论证时经确认卡（票 08） |
| `reader.read` / `read_image` / `read_svg_image` / `read_page_image` | read | none | 阅读：Doc 全文、插图、页图（票 07），见「阅读与标注」 |
| `text.read_source` | read | none | 文本 Doc 的 Markdown 源（票 07） |
| `reader.create_annotation` / `update_annotation` / `delete_annotation` | write | none | LaTeX/文本 Doc 的标注增改删，CLI 在 `annotation create|update|delete`（票 07） |
| `reader.create_pdf_annotation` / `update_pdf_annotation` / `delete_pdf_annotation` | write | none | PDF 工作台标注增改删，CLI 在 `annotation create-pdf|update-pdf|delete-pdf`（票 07） |

## 探索领域与 ADS 只读搜索（票 09）

条目在 `packages/contracts/src/discovery-catalog.ts`，处理器在 `packages/server/src/discovery-actions.ts`（`searchAds`、`exploreSeed`），都是只读、不入库、不拿库锁、不广播。

**进目录的与不进的**：进的是业务操作——`search_ads`、`explore`。不进的：界面动作（`filter_discovery`、`search_discovery`、`set_discovery_display`、`select_candidate`、`set_discovery_tab`、`step_exploration`、`exit_exploration`、`discovery_graph_control` 等）与绑定视图的观测 `read_discovery`——它们只改变或报告某个浏览器标签正显示的东西，CLI 没有对应的「标签」。`save_candidate` 也留在 Copilot：它的前提是「候选必须是该标签打开的探索里的节点」，是页面绑定的规则；入库本身的目录路径是 Library 域的 `import_works`（票 06，bibcode 模式），那里才有本进程路径所需的导入流水线（`createLocalOperationRuntime` 目前没有 `importWorks`）。「保存候选不批量」的规则不变。

**Copilot 与目录的对应**：探索动作原本就在 Copilot 的 `library` 工具里，没有 `discovery` 工具，所以目录领域 `discovery` 对应 CLI 组 `discovery`，而 Copilot 侧 `search_ads` 是 `library` 工具的一个动作（`copilot-library-tool.ts` 用 `parseCatalogCall("discovery", …)` 取参数、`runCatalogOperation` 执行，只接受 `discovery.search_ads`）。`explore` 在 Copilot 侧没有同名动作：Copilot 的 `explore_work`/`explore_candidate` 是让用户标签里的页面去探索（界面动作），不返回图给模型，与目录的数据形态不同。

**`search_ads`**：参数 `query`（1–500 字符，ADS 查询串原样传给 ADS）、`limit`（1–50，默认 10）、`fields`（逗号分隔，取自 `title,author,year,pub,citation_count,doi,arxiv_id,abstract`，默认前六个；`bibcode` 总在）。结果 `{ok:true,status:"ok",query,numFound,returned,records:[…]}`；每条最多列 10 位作者并带真实 `authorCount`，摘要超 1500 字符截断并标 `abstractTruncated`。客户端 `AdsSearchClient`（`packages/infra/src/sources/ads-search.ts`）**只有一个 GET**（测试读源码断言），不写缓存、不写文件；token 每次由组合层从凭据库现读（`realAdsSearch`），只进 Authorization 头，不在结果、错误、日志里。失败是答案不是异常，原因可区分：`no_token`（不发请求）、`unauthorized`（401）、`rate_limited`（429，带 `retryAfter`）、`bad_query`（400，ADS 解析不了查询）、`timeout`、`unreachable`（网络失败或其他 HTTP 状态）、`invalid_response`；调用方取消（Copilot 的 Stop）为 `status:"interrupted"`；宿主没有搜索源为 `unsupported`/`unavailable`。不受 Discovery 的 ADS 开关约束（产品里没有只关 ADS 读取的开关，与 ADS libraries 同）。

**`explore`**：参数 `bibcode`（与探索页路由同一个校验 `badDiscoveryBibcode`，现已搬到 `discovery-actions.ts`），结果 `{ok:true,status:"ok",graph}`（`DiscoveryGraph`，含库内成员态）或同形的失败（另有 `not_found`＝ADS 没有该 seed）。与页面共用 `discoverLiterature` 与同一个 ADS discovery 客户端，所以会写该客户端自己的 24 小时 provider 响应缓存（`library/cache/ads-discovery`，派生数据，见 [discovery](discovery.md)）；`search_ads` 没有缓存。

**两条路径**：工作台运行时由它执行（`createApp` 里 `LibraryOpDeps` 的 `adsSearch`/`discoverySource`，即页面路由和 Copilot 共用的工厂，server 的 `makeAdsSearch` 默认 `realAdsSearch`）；未运行时 CLI 用 `createLocalOperationRuntime` 在本进程里用同样的 `realAdsSearch`/`realDiscoverySource`（它接受可选的 `AdapterWiring` 供测试注入 `adsToken` 与 `fetchImpl`；CLI 不传，token 从凭据库读）。两条路径的答案同形。测试：infra `ads-search.test.ts`，server `discovery-operations.test.ts`（本进程、工作台路由、Copilot 工具三条入口；断言只有 GET、token 只在头里、数据夹逐字节不变、每类错误），cli `discovery-operations.test.ts`（命令派生、参数错误退出 2、经工作台的退出码与输出；本进程路径不在 CLI 子进程里测，因为子进程会读测试机器真实的凭据库）。

**窗口常量**：Copilot 的 `library` 工具多了动作 `search_ads`、参数 `fields`、说明一段与基础提示词一句，系统指令加工具 schema 的占用从 81053 增至 81949 字节（+896 B，×4/7＝+512 token），按 project-intake 02 的方法同步了 `copilot-batching.test.ts` 的 `WINDOW_BIG_DOC` 与 PDF 多窗口、`copilot-pdf`、`copilot`、`copilot-text-host` 的窗口、`copilot-argument-read-window` 的 GAP_WINDOW（45000→45512）、`copilot-transcription` 的上限。


## Library 领域（票 06）

条目在 `packages/contracts/src/library-catalog.ts`，参数来自 `library-ops.ts` 的动作 schema；处理器是 `library-actions.ts` 的业务函数本身（`applyLibraryImport`、`applyAttachLocalPdf`、`listAdsLibraries`、`readAdsLibrary`、`applyAcquireArxivPdf`、`applyAttachArxiv`、`readJobs`），Copilot 的 `library` 工具跑同一批函数，所以两个入口的答案、措辞与逐条报告一份。

**进目录的与不进的**：`library-ops.ts` 除界面动作外都进了（`read`、`set_main_doc`、`delete_doc` 早已在）。不进的：`filter_library`、`select_work`、`set_detail_tab`、`set_sidebar`、`set_graph_labels`、`graph_control`、`set_temp_label`（界面动作）、`read_discovery` 与 `save_candidate`（见「探索领域」，CLI 保存候选走 `import_works` 的 bibcode 模式，「保存候选不批量」不变）。

**`import_works`**：`--mode identifier|bibcode|bib --text <文本> [--batch]`。bibcode 模式的文本可含多个 bibcode（空白、逗号、分号分隔），每次至多 200 个，更多答 `rejected` 且什么都不写；`--batch` 是迁入形态（单个 bibcode 也给逐条报告、合并时逐条拒绝、不排自动 arXiv PDF 任务）。含 `superRefine`（`batch` 与 `bib` 不并用、bibcode 非空等），所以条目的 `params` 是显式的 `LibraryImportWorksParamsSchema`，动作 schema `LibraryImportWorksSchema` 与它用同一组字段和同一个检查函数，仍是一处定义。合并既有 Works 的记录仍被拒（`rejected`），写入仍是窄写，逐条 `results`/`entries` 不变。

**`attach_local_pdf`**：`--ref-id --path`（绝对路径，不在 CLI 里按当前目录补全：相对路径答 `path_not_absolute`）。读文件一次、只读，之后是 Files 标签上传自己的服务端路径（PDFium 可信解析、内存余量、页数上限、同 Work 同字节复用、DocMutationRegistry）。Copilot 里该动作受设置 `copilot_file_tools` 约束（关闭则拒绝），那是 Copilot 的权限，在 `copilot-library-tool.ts` 的调用点检查；CLI 与路由上的目录操作**不查**该设置，由调用 CLI 的人（或其 agent 宿主）自己负责读哪个文件，契约「本地 PDF Doc」其余规则照旧。

**`list_ads_libraries` / `read_ads_library`**：只读，token 每次由组合层从凭据库现读，错误区分（`no_token`、`unauthorized`、`rate_limited`……）与文本照契约「ADS libraries」；`read_ads_library` 每次一窗，至多 200 条，`--offset` 翻页。本进程路径用 `realAdsLibraries`。

**`acquire_arxiv_pdf` / `attach_arxiv` / `attach_local_pdf` 与长任务**：它们提交一个任务到 JobRunner（串行队列）并等它结束，答案里有 `job`（`pending` 表示调用在任务结束前就返回了，任务仍在跑，终点用 `read_jobs` 看，不要重复提交）。

- **工作台运行时**：任务排进工作台自己的队列（与页面、Copilot 共用，同一把库锁与 DocMutationRegistry），命令等待至多 `CLI_JOB_WAIT_MS`（240 秒，`app.ts`；低于 Node 全局 fetch 的 5 分钟响应头超时，再长请求会被丢），超时答 `pending`，任务由工作台继续；命令中途被中断也只是停止等待，不取消任务。
- **工作台未运行时（「无工作台的长任务」）**：任务在**本进程**的 JobRunner 里跑（`createLocalOperationRuntime` 按需建 `createAcquisition`：自己的库锁、DocMutationRegistry、`recover: false` 的 JobRunner），命令**一直等到任务结束**才退出，不设上限，因为退出后没有任何东西会继续这个任务；Ctrl-C 终止进程，任务记录停在 `running`/`queued`，下次工作台启动时被标为 `interrupted`，与既有语义一致。这条路径上的 `import_works` **不排**导入菜单在单个 identifier/bibcode 导入后会排的自动 arXiv PDF 任务（同样因为排了也没人跑），要 PDF 就显式 `acquire-arxiv-pdf`；经工作台时仍按设置 `auto_ingest_arxiv` 排，结果字节形状相同。`recover: false`：本进程不改写 jobs 目录里别人的未完成记录，也不在没有写入时建目录。
- **`read_jobs` 在本进程**：直接读 `<dataDir>/jobs/*.json`（运行器每次状态变化都落盘），只读，不建目录、不把任何记录改成 `interrupted`；另一个进程里还在跑的任务按它最后写下的样子显示。

**`attach_arxiv` 与确认卡**：只有「刷新既有 arXiv Doc」（`describeSource` 为 `refresh`）会替换正文并可能丢标注，只有这种调用要卡（`confirm: "conditional"`）；新建 Doc、给只有 PDF 的 Work 追加 LaTeX Doc、以及 `no_arxiv`/`skip`/`not_found` 等拒绝都不需要，在两条路径都直接执行。需要卡时：处理器先做无写入的预读（`prepareArxivRefresh`，Doc 忙、不存在等直接拒绝、不出卡，措辞与 Copilot 共用），把 Copilot 同一种卡 `refresh_arxiv_source` 放进外部请求队列（卡上有 Work 标题、将被替换的 Doc、标注数；web 的 `summaryOf` 与结果文案有对应分支，`externalRequests.*Refresh`）。批准后核对一次（Doc、标注数与版本、Work 的 Doc 列表都与卡所示一致，否则 `expired`、不提交），再提交任务。因为任务可能要几分钟，批准那次页面决定请求在**任务提交后立即**得到 `{ok:true,status:"submitted",jobId}`（页面据此显示「已开始替换」），命令自己的答案仍是任务结束时的 `AcquireOutcome`。拒绝 `denied`（退出码 3）、命令被中断时撤回（130）、工作台退出（4）同 `delete_doc`。**工作台未运行**且这次调用需要卡：处理器答 `{ok:false,status:"workbench_required"}`（退出 1），什么都不改、不提交任务；不需要卡的调用无工作台也照常运行。CLI 对 `conditional` 操作也装 SIGINT/SIGTERM 处理（因为它可能在等卡）。

**窗口常量**：Copilot 的 `library` 工具 schema 与说明文字没有改动（动作、参数、说明字节不变），窗口常量不需同步；`copilot-library-tool.ts` 只是改用 `parseCatalogCall` 取参数，写入类动作的会话内等待、journal 与 `operationId` 去重仍留在该文件。

**测试**：server `library-operations.test.ts`（每个操作的本进程路径与工作台路由、`attach_arxiv` 的批准/拒绝/撤回/过期/无工作台）、cli `library-operations.test.ts`（真实 `bin.js`：帮助、退出码 2、本进程路径含真实 PDFium 与等任务结束、经工作台的 ADS libraries/本地 PDF/确认卡 0·3·130）、contracts `operation-catalog.test.ts`、web `external-requests.test.tsx`。本进程的 ADS libraries 路径不在 CLI 子进程里测（会读测试机器的真实凭据库），由 server 测试以注入 token 与桩覆盖；`acquire-arxiv-pdf` 的网络部分同理。

## 论证图领域（票 08）

条目在 `packages/contracts/src/argument-catalog.ts`，参数就是 `argument-copilot.ts` 里各写动作的 schema 去掉 `action`（该文件把原来内联在 discriminated union 里的八个写动作各自命名，union 由它们组成，Copilot 的工具 schema 字节不变），处理器在 `packages/server/src/argument-operations.ts`。

**进目录的与不进的**：进的是 Copilot `argument` 工具的业务动作——`read`、`create`、`update`、`delete`、`undo_delete`、`add_edge`、`remove_edge`、`replace`、`clear`；打开论证图是 05 的 `argument.open`（`open argument-graph`）。不进的：`select`、`exit`（只改变某个浏览器标签正显示的东西，CLI 没有对应的「标签」）和 `guide`（方法全文是 Copilot 一侧的，措辞针对 Copilot 的 `reader` 工具；外部 agent 的方法在 skill 里，由票 12 处理）。

**CLI 命名：挂在 `argument` 组下，不另取组名。** 组里已有冻结的 `argument get` / `argument put`（[contracts](contracts.md)「CLI 论证图命令冻结契约」）；`registerOperationCommands` 遇到已存在的组就地增加子命令，不动已有的两个，所以它们的 `--help`、参数与行为不受影响（测试把两者的 `--help` 全文钉死，其行为仍由 `argument.test.ts` 的 golden 钉住）。新子命令名 `read create update delete undo-delete add-edge remove-edge replace clear` 与 `get`/`put` 不冲突。取舍：另取组名（如 `argument-graph`）可以避免 `argument` 组里 `get` 与 `read` 并存带来的困惑，但会让「操作目录一个领域一个组」的名字对应（ADR 0015）出现例外，Copilot 的工具名也是 `argument`；这里选择保持对应，并在两处帮助里点明分工：`get`/`put` 是以文件整进整出的冻结命令（读出的 JSON 可直接给 `put`），目录命令是同 Copilot 一样的按条编辑，输出是操作结果而不是图本身。

**嵌套参数。** `create` 的 `argument`、`update` 的 `patch`、`replace` 的 `graph`、`read` 的 `ids` 是对象或数组，是值为 JSON 文本的选项（`--argument '{...}'`；与 07 的标注 `--target` 同一套机制）。整个参数对象（含 `workId`、`expectedRev`）也可写在一个 JSON 里：`argelanderspace argument create --json params.json` 或 `... --json -`（`--json` 不能与参数选项同用）。

**执行与两条路径。** `OperationRuntime` 新增可选的 `argument: ArgumentOpDeps`（`dataDir`、论证图锁、Work 查询、变更通知、撤销记忆）。工作台里就是 Copilot 工具、页面 PUT 共用的那一份（`app.ts` 的 `argumentOps`：同一把锁、同一个 `argument-graph.changed` 广播、同一个撤销记忆）；`createLocalOperationRuntime` 为本进程路径造自己的（自己的锁、无通知）。读与逐条编辑 = 工具的纯编辑（`argument-edit.ts`）＋页面 PUT 的写入函数（`writeArgumentGraph`：锁内 rev 检查与「Work 仍在库」检查），措辞（冲突带 `latest`、被拒的编辑、Work 不存在、图文件读不了）与 Copilot 共用 `copilot-argument-tool.ts` 导出的构件，同一句话只写一处；读没有「窗口还剩多少」可依，按固定上限分批，`note` 说明如何续读。写入要 `expectedRev`，与存储不符答 `conflict` 并带最新图，不写。

`undo_delete` 的记忆在工作台进程里（与 Copilot 同一份）：经运行中的工作台，`delete` 之后的 `undo-delete` 可用；本进程路径每条命令一个新进程，没有记忆，`undo-delete` 答 `not_found`（措辞与 Copilot 重启后同）。

**确认：`conditional`。** 论证图没有论证时 `replace` 直接写、`clear` 答 `noop`（与页面和 Copilot 同）。有论证时先校验提议的新图（不合法的在出卡前就以 `invalid` 返回，不打扰用户），再放一张 `replace_argument_graph` 卡（Copilot 的同一种卡，`mode` 为 `replace`/`clear`，写明文献标题、现有与新图的论证数和边数，绑定图的 rev 与内容摘要），批准后核对图仍是卡片所示，否则 `expired`，零写入。拒绝为 `denied`（退出码 3），CLI 离开为 `interrupted`/130，工作台没运行为 `workbench_required`（退出 1，零写入；处理器自己答，所以 CLI 对 `conditional` 不像对 `card` 那样一律先拒绝——空图的 `replace` 在无工作台时本进程照常执行）。`conditional` 的 CLI 命令与 `card` 一样在 Ctrl-C 时撤回卡片。覆盖有论证的图只能经确认卡，没有 `--replace` 之类的参数可代替（[contracts](contracts.md)「操作目录与外部 agent」）；冻结的 `argument put --replace` 是另一条老路径，照旧。

工作台一侧，卡片内容用 Copilot 的 `replace_argument_graph` 卡，`ExternalRequests.tsx` 的 `summaryOf`（队列与折叠栏的一行）与结果文案（`externalRequests.*Argument`）按 action 补，批准成功后不做 Shell 的 Doc 三态更新（页面按 `argument-graph.changed` 自行刷新）。

## 阅读与标注（票 07）

条目在 `packages/contracts/src/reader-catalog.ts`（领域 `reader`，即 Copilot 的 `reader` 工具）与 `text-catalog.ts`（`text.read_source`）；执行在 `packages/server/src/reader-operations.ts`，数据接缝 `ReaderOpDeps` 由 `reader-ops-deps.ts` 的 `createReaderOps` 建出（从 `app.ts` 里原来的内联块搬出，行为不变）。

**CLI 组。** 读取留在 `reader`：`reader read`、`reader read-image`、`reader read-svg-image`、`reader read-page-image`；`text read-source`。标注写入放进新组 **`annotation`**（条目的 `cli` 覆盖，Copilot 一侧仍是 `reader` 工具的原动作名）：`annotation create|update|delete`（LaTeX/文本 Doc）、`annotation create-pdf|update-pdf|delete-pdf`（PDF 工作台标注）。冻结的 `annot` 不动，仍是真只读的列表；`annotation` 是另一个组，二者在 `--help` 里并列。顶层既有的 `read`、`show`、`ref` 等不变。

**进目录的与不进的。** 进：整份阅读（LaTeX/文本的 reading 或 PDF 各页文字）、插图、SVG 渲染、PDF 页图、文本源，以及上面六个标注写入。不进：Reader 的界面动作（`navigate`、`jump_back`、`set_panel`、`set_right_tab`、`retry_sync`、`set_text_view`，PDF 的翻页、缩放、搜索、`open_annotation`、`download_original`）；`undo_pdf_annotation`/`redo_pdf_annotation`（撤销栈属于一次 Copilot 会话，且只在服务重启前存在，CLI 无对应概念）；文本 Doc 的 `create`、`save_source`、`add_pdf_image`、`validate`、`generate`（写源文或发布正文，不属于本票，留给后续）。

**参数。** 就是 `reader-ops.ts`、`pdf-annotation-ops.ts`、`text-ops.ts` 里动作 schema 去掉 `action`。PDF 的 create 与 update 带 `superRefine`/`refine`，不能 `omit`，所以那里写了 `PdfCreateAnnotationParamsSchema`、`PdfUpdateAnnotationParamsSchema`，动作 schema 与它共用同一个 shape 与同一个校验函数，规则只写一处。

**写入走哪条路径。** 标注写入（`runReaderWrite`、`runPdfWrite`）只调 `ReaderOpDeps.write` / `pdf.write`，那就是 server 的标注访问路径（`annotations-access.ts` 的 `commit`、`pdf-access.ts` 的 `writeAnnotation`），三态指纹规则、「无法计算是系统错误不当作 mismatch」、归档只发生在这条路径上，都在那里，这里一行没有重写。工作台运行时用工作台自己的那一份（与页面 PUT、Copilot 共用同一把 `annotationLock`）；未运行时 `createLocalOperationRuntime` 用**同一份模块**在本进程建一套（自己的锁、`DocMutationRegistry` 为空、不通知）。所以：
- 读（`reader read`）走 `peek`：只读，不归档，旧内容的标注只是不列出，一个字节不动；
- 写在读到的 epoch 已不是当前时：指纹成功但不同 → 访问路径照旧归档旧批次并建空 current，本次写入答 `conflict`（`reason: document_changed`，带 `archivedOlder` 与条数），写入的内容不落盘；指纹无法计算、IR 或 current 损坏、资产丢失 → 答 `error`，退出 1，不归档、不重写；Doc 不存在 → `not_found`；归档写不进去 → 原 current 保持原样；
- 跨进程同一 Doc 并发写仍不支持（I013 的边界不变）；同一 dataDir 有工作台时 CLI 交给它，没有时才在本进程做，两条路径逐字节同形（测试比对）。

**与 Copilot 的关系。** 标注写入：Copilot 的 `reader` 工具对 `create_annotation`、`update_annotation`、`delete_annotation`、`create/update/delete_pdf_annotation` 用 `parseCatalogCall` 取参数，执行与措辞来自同一对函数 `runReaderWrite`/`runPdfWrite`（操作记录里的 status/label/rev 也由它们给出），行为与旧版一致（`copilot-reader*` 测试未改全过）。PDF 写入的撤销历史按 `conversationId` 分，目录操作用自己的范围 `operation-catalog`，既不能撤销某个会话的改动，也不会被会话撤销；经 CLI 的写入对会话相当于「别人改了」，会让它的历史按既有规则终止。**读取不是同一套代码**：Copilot 的 `read` 要按模型窗口余量分批、按账本重投递、图片作 image part；CLI 没有窗口，`reader read` 一次给整份（`from`/`version` 仍可取后面的部分），图片作 `data`（base64）放在 JSON 里。两边只共用参数 schema 与读取接缝。工具的 schema 与说明字节没有变，**窗口常量不用动**（系统指令加工具 schema 仍是 81949 B）。

**图片。** `read-image` 只给 PNG/JPEG/WebP（其余原样拒绝，不转换）；`read-svg-image` 先做与 Copilot 相同的安全检查，再用可选的 resvg 渲染，没装则答 `unsupported`；`read-page-image` 用同一份已校验的原件字节和 PDFium。单张上限同 Copilot（`PDF_IMAGE_MAX_BYTES`），超过答 `rejected` 并提示减小 `--long-edge`。CLI 输出可能是几 MB 的 base64，外部 agent 要自己落成文件才能看图。

**测试。** server `reader-operations.test.ts`（本进程、工作台路由与 Copilot 工具三个入口答案和文件逐一相同；三态各分支与系统错误〔IR 不是 JSON、IR 不合 schema、current 损坏、资产丢失、归档写不进〕；读取不写盘；PDF 的增改删与页图；插图；文本源）；cli `annotation-operations.test.ts`（真实 `bin.js`，工作台未运行与运行两条路径各一遍：读、增改删、冻结的 `annot` 在其后仍列出并保持键序、三态、参数错误退出 2、`--json`、PDF）；contracts `operation-catalog.test.ts`（条目、CLI 位置、JSON 选项、PDF 校验仍在）。冻结的 `annot` golden（`agent.test.ts`）未改全过。


## 操作说明（票 12）

六份随包说明（`skills/argelander-*`）和 `skills/README.md` 用操作名写步骤：每步给出 Copilot 的工具动作与外部 agent 的 CLI 命令，一份服务两个入口。Copilot 载入全部六份（`COPILOT_SKILL_NAMES` 白名单已删，`loadBundledSkills` 载入目录里的全部）。Plan、Writer、Mail、文献仓不写说明。没有操作可用的事，说明里明说：Copilot 不能写 note/tags/标记、不能 `ingest` 本机 LaTeX 源（把命令交给用户），外部 agent 不能创建 Plan 与 Task（迁入里只写计划草案，由 Copilot 创建）。说明里仍有几处不经目录的旧命令（`search`、`list`、`read`、`show`、`ref`、`annot`、`pdf-path`、`ingest`、`library build`、`note`、`label`），都是冻结面或没有对应操作的命令。

**防漂移**：`packages/cli/src/skill-commands.ts` 从 Markdown 里提取每条 `argelanderspace …` 命令（围栏代码块逐行、`\` 续行、`#` 注释、`|`/`&&`/`;` 结束，或行内代码）与反引号里的操作名（`library.read_jobs`），`checkSkillCommand` / `checkSkillGuide` 对照 `buildProgram()` 与目录断言：子命令、选项、选项的固定取值、参数个数存在；操作名在目录里；同一行只提一个操作时，不得紧挨着另一个操作的命令。测试是 `packages/cli/tests/skill-commands.test.ts`（进 `-r test`）。提取结果带 `argv` 与行号，票 15 的 e2e 用同一个模块取出命令、填好占位符（`isPlaceholder`）后实际执行。`agent-plugin`（票 14）已落地，测试里不再有 `PLANNED` 登记。

### Agent 插件（票 14）

构建（`packages/app/scripts/copy-assets.mjs` → `agent-plugin-lib.mjs`）产出 `dist/agent-plugin/`：`.claude-plugin/marketplace.json`（marketplace 名 `argelanderspace-local`，一个条目 `argelanderspace`，`source: "./"`，marketplace 根与插件根同一个目录）、`.claude-plugin/plugin.json`（名 `argelanderspace`，版本 = 包版本）、从刚复制好的 `dist/skills` 复制的 `skills/`。不带 MCP、hooks、agents、CLI 本体。`checkAgentPlugin`（`pack-contents.mjs` 的 `checkAgentPluginIn`）在 prepack 与 `smoke-pack.mjs` 中检查文件齐全、版本一致、skills 与随包说明逐字节相同；`pack-contents.mjs` 的必需文件列表含插件文件。`argelanderspace agent-plugin`（`packages/cli/src/agent-plugin.ts`）只读：用 infra `bundledAgentPluginDir(CLI 入口)` 找入口旁的 `dist/agent-plugin`（npm 与桌面包相同，桌面包保留在 `sidecar/app/dist/agent-plugin`），名字取自清单，输出路径与 `/plugin marketplace add`、`/plugin install argelanderspace@argelanderspace-local`。
