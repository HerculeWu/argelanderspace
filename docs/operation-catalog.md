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
| `confirm` | `none` 或 `card`（要 Copilot 同类确认卡；票 04 起生效） |
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
- **`--json <file|->`**：整个参数对象从文件或标准输入读入，不能与参数选项同用；对象里不写 `action`。嵌套或数组参数没有扁平映射，只能用 `--json`（`operationOptions` 遇到时抛错，由加条目的人处理）。
- **`--data-dir`**：与既有命令一致。
- **输出**：stdout 一份 JSON（两格缩进），就是该操作的结果对象，与 Copilot 工具返回的同形。退出码：0 结果为 `ok`/`noop`（或读取成功）；1 操作答了 `ok: false`（`not_found`、`conflict`、`rejected`、`error` 等）或意外失败（意外失败只在 stderr 写 `error: …`）；2 参数无效，输出 `{ ok: false, status: "unsupported", detail }`，什么都没执行。
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
- 票 04（确认卡）：`confirm: "card"` 的操作在同一个 `POST` 上，响应保持挂起直到卡片被决定，CLI 不设超时。CLI 按 Ctrl-C 中止请求（`runOnWorkbench` 的 `signal`），server 侧 `c.req.raw.signal` 触发即撤回卡片；工作台退出则连接断开，CLI 报告已中断并非零退出。`client.commandLine` 就是卡片来源条要显示的完整命令行。拒绝的固定退出码/错误码由 04 在结果与退出码映射里增加。工作台未运行时 04 在 CLI 侧于选路后拒绝（`findRunningWorkbench` 返回 null）。
- 票 05（导航）：导航操作同样 `POST`，由路由处理器把它发给最近活动的窗口；工作台未运行时 CLI 拒绝。

## 现有目录条目

| id | effect | confirm | 说明 |
|---|---|---|---|
| `library.read` | read | none | 页面自己的列表/搜索/详情数据 |
| `library.set_main_doc` | write | none | Files 标签的「设为主 Doc」，带 `expectedMainDocId` 做冲突检查 |
| `discovery.search_ads` | read | none | 只读 ADS 搜索（票 09），见下节 |
| `discovery.explore` | read | none | 探索页对一个 seed 的请求，以数据返回（票 09），见下节 |

## 探索领域与 ADS 只读搜索（票 09）

条目在 `packages/contracts/src/discovery-catalog.ts`，处理器在 `packages/server/src/discovery-actions.ts`（`searchAds`、`exploreSeed`），都是只读、不入库、不拿库锁、不广播。

**进目录的与不进的**：进的是业务操作——`search_ads`、`explore`。不进的：界面动作（`filter_discovery`、`search_discovery`、`set_discovery_display`、`select_candidate`、`set_discovery_tab`、`step_exploration`、`exit_exploration`、`discovery_graph_control` 等）与绑定视图的观测 `read_discovery`——它们只改变或报告某个浏览器标签正显示的东西，CLI 没有对应的「标签」。`save_candidate` 也留在 Copilot：它的前提是「候选必须是该标签打开的探索里的节点」，是页面绑定的规则；入库本身的目录路径是 Library 域的 `import_works`（票 06，bibcode 模式），那里才有本进程路径所需的导入流水线（`createLocalOperationRuntime` 目前没有 `importWorks`）。「保存候选不批量」的规则不变。

**Copilot 与目录的对应**：探索动作原本就在 Copilot 的 `library` 工具里，没有 `discovery` 工具，所以目录领域 `discovery` 对应 CLI 组 `discovery`，而 Copilot 侧 `search_ads` 是 `library` 工具的一个动作（`copilot-library-tool.ts` 用 `parseCatalogCall("discovery", …)` 取参数、`runCatalogOperation` 执行，只接受 `discovery.search_ads`）。`explore` 在 Copilot 侧没有同名动作：Copilot 的 `explore_work`/`explore_candidate` 是让用户标签里的页面去探索（界面动作），不返回图给模型，与目录的数据形态不同。

**`search_ads`**：参数 `query`（1–500 字符，ADS 查询串原样传给 ADS）、`limit`（1–50，默认 10）、`fields`（逗号分隔，取自 `title,author,year,pub,citation_count,doi,arxiv_id,abstract`，默认前六个；`bibcode` 总在）。结果 `{ok:true,status:"ok",query,numFound,returned,records:[…]}`；每条最多列 10 位作者并带真实 `authorCount`，摘要超 1500 字符截断并标 `abstractTruncated`。客户端 `AdsSearchClient`（`packages/infra/src/sources/ads-search.ts`）**只有一个 GET**（测试读源码断言），不写缓存、不写文件；token 每次由组合层从凭据库现读（`realAdsSearch`），只进 Authorization 头，不在结果、错误、日志里。失败是答案不是异常，原因可区分：`no_token`（不发请求）、`unauthorized`（401）、`rate_limited`（429，带 `retryAfter`）、`bad_query`（400，ADS 解析不了查询）、`timeout`、`unreachable`（网络失败或其他 HTTP 状态）、`invalid_response`；调用方取消（Copilot 的 Stop）为 `status:"interrupted"`；宿主没有搜索源为 `unsupported`/`unavailable`。不受 Discovery 的 ADS 开关约束（产品里没有只关 ADS 读取的开关，与 ADS libraries 同）。

**`explore`**：参数 `bibcode`（与探索页路由同一个校验 `badDiscoveryBibcode`，现已搬到 `discovery-actions.ts`），结果 `{ok:true,status:"ok",graph}`（`DiscoveryGraph`，含库内成员态）或同形的失败（另有 `not_found`＝ADS 没有该 seed）。与页面共用 `discoverLiterature` 与同一个 ADS discovery 客户端，所以会写该客户端自己的 24 小时 provider 响应缓存（`library/cache/ads-discovery`，派生数据，见 [discovery](discovery.md)）；`search_ads` 没有缓存。

**两条路径**：工作台运行时由它执行（`createApp` 里 `LibraryOpDeps` 的 `adsSearch`/`discoverySource`，即页面路由和 Copilot 共用的工厂，server 的 `makeAdsSearch` 默认 `realAdsSearch`）；未运行时 CLI 用 `createLocalOperationRuntime` 在本进程里用同样的 `realAdsSearch`/`realDiscoverySource`（它接受可选的 `AdapterWiring` 供测试注入 `adsToken` 与 `fetchImpl`；CLI 不传，token 从凭据库读）。两条路径的答案同形。测试：infra `ads-search.test.ts`，server `discovery-operations.test.ts`（本进程、工作台路由、Copilot 工具三条入口；断言只有 GET、token 只在头里、数据夹逐字节不变、每类错误），cli `discovery-operations.test.ts`（命令派生、参数错误退出 2、经工作台的退出码与输出；本进程路径不在 CLI 子进程里测，因为子进程会读测试机器真实的凭据库）。

**窗口常量**：Copilot 的 `library` 工具多了动作 `search_ads`、参数 `fields`、说明一段与基础提示词一句，系统指令加工具 schema 的占用从 81053 增至 81949 字节（+896 B，×4/7＝+512 token），按 project-intake 02 的方法同步了 `copilot-batching.test.ts` 的 `WINDOW_BIG_DOC` 与 PDF 多窗口、`copilot-pdf`、`copilot`、`copilot-text-host` 的窗口、`copilot-argument-read-window` 的 GAP_WINDOW（45000→45512）、`copilot-transcription` 的上限。
