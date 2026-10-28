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
- **输出**：stdout 一份 JSON（两格缩进），就是该操作的结果对象，与 Copilot 工具返回的同形。**退出码**：

  | 码 | 含义 |
  |---|---|
  | 0 | 结果为 `ok`/`noop`（或读取成功） |
  | 1 | 操作答了 `ok: false`（`not_found`、`conflict`、`rejected`、`error`、`workbench_required` 等）或意外失败（只在 stderr 写 `error: …`） |
  | 2 | 参数无效，输出 `{ ok: false, status: "unsupported", detail }`，什么都没执行 |
  | 3 | 用户在确认卡上拒绝：stdout `{ ok: false, status: "denied", detail }`，什么都没做 |
  | 4 | 等待确认卡时工作台退出或不再应答：stderr `error: interrupted; …`，stdout 无输出。卡片随工作台消失；若恰在此刻批准，操作可能已执行，先读取对象核对 |
  | 130 | 命令在等待确认卡时被 Ctrl-C（或 SIGTERM）中断，卡片已撤回，stderr 写 `error: interrupted; …` |

  3、4、130 只出现在 `confirm: "card"` 的操作上。
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
- 票 05（导航）：导航操作同样 `POST`，由路由处理器把它发给最近活动的窗口；工作台未运行时 CLI 拒绝。

## 确认卡（票 04）

`confirm: "card"` 的操作（现有 `library.delete_doc`）经 CLI 发起时，卡片出现在运行中的工作台里；这是 ADR 0015「确认」与契约「操作目录与外部 agent」的实现，界面依据已批准的原型 `.scratch/release-0.2/prototype/03-cli-confirmation/` 方案 A（用户 2026-10-28 审阅）。

**流程。** CLI 选路后，需要确认的操作在没有活工作台时直接答 `{ ok: false, status: "workbench_required" }`（退出 1），不在本进程执行、不启动工作台。有工作台时 `POST /api/operations/run` 在同一请求上挂起：server 先读删除对话框会显示的事实（与 Copilot 共用 `prepareDocDelete`，Doc 不存在、忙、孤儿等照旧直接拒绝、不出卡），再把卡放进**外部请求队列**（`external-requests.ts`，不属于任何 Copilot 会话），等人决定，CLI 不设超时。批准后再核对一次（`recheckDocDelete`，Works、标注数或摘要变了答 `expired`），然后跑与 Copilot 相同的全局物理删除（`applyDocDelete`：输出与标注含归档一并删、从所有 Work 摘除、剩余首个 Doc 递补为主、`library.changed`）。

**五种结局。** 批准：执行并返回结果（退出 0；执行失败按操作结果退出 1）。拒绝：`denied`，退出 3。CLI 被 Ctrl-C 或连接断开：请求的 `signal` 中止，卡片变为 `withdrawn`，不再能批准（server 对已撤回的卡拒绝决定，409），首张撤回卡留到用户点「关闭」，排队中的撤回卡 4 秒后自行消失；已批准的请求不被撤回（点击即提交）。工作台在等待中退出：连接断开，CLI 退出 4；卡片不跨重启恢复。工作台未运行：`workbench_required`，退出 1。退出码全表见上文「输出」。

**页面一侧。** `GET /api/external-requests`（队列）、`POST /api/external-requests/:id/decision`（`{decision: "approve"|"deny"}`；批准的应答等操作完成后带回结果）、`POST …/dismiss`（关闭撤回卡）；队列变化用 WS 帧 `external-requests.changed`（无载荷，页面重读）。只有最早一张卡可决定（其余 409 `not_first`）。决定与关闭要求带 `Origin`（浏览器页面必带），无 Origin 的请求（curl、脚本）403；这不防同账户下伪造头的进程，只防持令牌的 agent 顺手自批。web 在 `src/external-requests/`：卡片内容就是 Copilot 同一 action 的卡（`copilot/confirmations` 的 `CONFIRMATION_KINDS`），批准前问同一套页面守卫（`ConfirmationGuards`，如打开中 Doc 的离开守卫）；批准成功后由决定的那个页面做 Shell 的三态更新（`docDeleted`）。窗口标题加 `(n)` 前缀，等待中有请求时 `beforeunload` 提示。**未实现**：桌面应用的 OS 通知与任务栏角标（页面里没有 Tauri 入口，需要新的宿主桥接，另议）。

**给后续确认卡操作（06/07/08）。** 目录条目写 `confirm: "card"`；处理器里仿 `runDeleteDocOperation`：先做无写入的预读与拒绝，再 `runtime.confirm.ask({ card, client, signal })`（`card` 是 Copilot 该 action 的卡字段，不含 id），按 `answer`（`withdrawn`/`denied`/`approved`）返回，批准后核对并执行，最后 `settle(result)`；Copilot 一侧继续用自己的会话卡，预读/核对函数抽成共用以保持措辞一份。web 一侧该 action 若已有卡种则自动可显示；队列和折叠栏里的一行摘要在 `summaryOf`（`ExternalRequests.tsx`）按 action 补，撤回与结果文案按需补 `externalRequests.*`。

## 现有目录条目

| id | effect | confirm | 说明 |
|---|---|---|---|
| `library.read` | read | none | 页面自己的列表/搜索/详情数据 |
| `library.set_main_doc` | write | none | Files 标签的「设为主 Doc」，带 `expectedMainDocId` 做冲突检查 |
| `library.delete_doc` | write | card | Files 标签的「删除文档」：全局物理删除，经确认卡（票 04） |
