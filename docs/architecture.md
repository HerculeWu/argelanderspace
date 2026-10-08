# 产品与架构

ArgelanderSpace（npm `argelanderspace`，MIT，© Wenjie Wu）是单用户科研工作台。用户通过 webui 独立操作、亲自阅读，也通过 CLI + skills 与 agent 协作。领域语言见 [CONTEXT](../CONTEXT.md)，不可擅改的边界见 [contracts](contracts.md)。

本页记录当前能力和结构，不列待实现任务。产品事实来自 Stage 15 关闭后的记录；阶段结果见 [history](history.md)，新工作由用户决定。

## 能力入口

- **文献库与正文**：arXiv LaTeX / 本地源码摄入，条目内 LaTeX zip 挂载；现支持 Work 内不可变本地 PDF 上传、阅读、原件下载、设主与删除。Web 添加时的 arXiv 获取仍只处理 LaTeX 源码。身份、存储规则及获取场景见 [library](library.md)。
- **文献发现**：从详情页进入 ADS related/useful 临时探索；库图只含已存 Work。边义、失败语义、缓存与用户状态分离见 [discovery](discovery.md)。
- **阅读器**：LaTeX Reader 用共享 IR/标注及共同 epoch；本地 PDF 使用固定 EmbedPDF 2.15.1、同次 hash 校验的原始 bytes 和独立用户 sidecar，PDF 内嵌标注只读。PDF 基础分页/缩放/下载已接入，PDF 工作台标注编辑、搜索/目录和进度保存不属于此边界。LaTeX 规则见 [annotations](annotations.md)，PDF 数据保护见 [contracts](contracts.md)。
- **计划页**：默认 landing，plans→tasks 的列表/看板/时间线/今日聚焦，webui 可独立 CRUD。详细模型和否决项见 [plans](plans.md)。
- **Writer**：独立稿件、八型 cell、CodeMirror、显式 Render/Shift+Enter、共享编译→IR 预览及源码 zip；不展示 PDF。工作流见 [writer](writer.md)，文件协议沿用 [writer-data-model](writer-data-model.md)。
- **web i18n**：zh-CN/en，默认中文、不探测浏览器，Tweaks 即时切换，偏好存 localStorage。server detail/job.error 和用户数据不纳入翻译；CLI 不变。
- **尚未完整的写路径**：文献 note tab 当前只读；持久 note/label 主要通过 CLI，右键色点 overlay 仅会话级。这是能力缺口，不推翻独立应用定位。
- **不在 main**：OCR/出版商 HTML 摄入封存于 `ocr-features` 快照分支。现行 PDF 是不可变原文件阅读，不是 OCR/LaTeX 转换能力。

## 数据与配置

默认项目级 `./literatures`，只按 cwd 相对解析，不向上查找。优先级：

`--data-dir` > `ARGELANDERSPACE_DATA_DIR` > config.toml `data_dir` > `./literatures`。

配置通常在 `~/.config/argelanderspace/config.toml`，支持 XDG_CONFIG_HOME；env 优先，未知键忽略，已知键类型错只报键名、不回显值。隐藏 `auto_ingest_arxiv` 默认 true，语义见 library。

**全局数据**（[ADR 0007](adr/0007-global-data-scope.md)，2026-10-06 决定；目录解析已在 infra 实现，Mail 账户已使用）：属于用户本人、跨项目共享的数据（首个使用者是 Mail 账户）不放 dataDir。全局数据与可丢弃的全局缓存分开，按 `env-paths`（name `argelanderspace`、无 suffix）取各 OS 标准目录：Linux `$XDG_DATA_HOME`/`$XDG_CACHE_HOME`（默认 `~/.local/share`、`~/.cache`），macOS `~/Library/Application Support`、`~/Library/Caches`，Windows `%LOCALAPPDATA%\argelanderspace\Data`、`…\Cache`。覆盖优先级 `ARGELANDERSPACE_GLOBAL_DIR` > config 键 `global_dir` > OS 默认；全局缓存对称：`ARGELANDERSPACE_GLOBAL_CACHE_DIR` > `global_cache_dir` > OS 默认，两者互不影响（改数据目录不移动缓存）。空白 env 视为未设，相对路径一律拒绝（ConfigError，只报来源名；按探测到的平台判断绝对路径，避免随 cwd 分裂全局目录）；`global_dir`/`global_cache_dir` 类型错只报键名。`resolveGlobalDirs` 不访问文件系统（未传 config 时读 config.toml）；OS 默认目录由 env-paths 在 import 时固定 homedir，测试隔离须在导入前把 `HOME`/`XDG_*` 指向 tmp；目录由 `ensureGlobalDirs` 按需创建，权限 0700（infra `global-dirs.ts`）。既有 config.toml 位置不变，项目数据不迁移。

**凭据存储**（Mail 票 02，ADR 0008；infra `credential-store.ts`，Mail 账户服务已调用）：窄接口 `get/set/delete(accountId)`，后端 `@napi-rs/keyring`（MIT，service `argelanderspace.mail`，原生模块惰性加载，失败按“不可用”处理；Linux 上 Entry 显式固定 `{linux:{store:"secret-service"}}`，否则绑定会静默回退到内核 keyutils（仅内存、重启即失），固定后无 Secret Service 时构造抛错即“不可用”；app 包将其列为运行时依赖，因原生 `.node` 不可内联）且可注入。钥匙串任何失败都返回 `keychain-unavailable`，不自动降级；仅当调用方传 `{ fileFallbackConsent: true }`（严格 `true`，表示用户已在 UI 同意）才写全局数据目录下 `credentials.json`（0600，tmp+rename 原子替换，AES-256-GCM 轻度加密，密钥由文件内盐与本机用户名/主机名派生，只防误看，不防同用户读取），结果带 `keychainProtected:false` 供 UI 持续标示。读取时钥匙串优先、其次文件；钥匙串可用后再 `set` 会迁入钥匙串并移除文件副本。钥匙串写成功后若旧文件副本无法移除，结果带 `staleFileCopy:true`；钥匙串不可用但文件副本已删时 `delete` 返回 `{status:"deleted", keychainUnavailable:true}`（钥匙串里可能仍有副本，未检查）；文件重写失败为 `file-write-failed`。失败结果只含状态码（`invalid-input`/`file-unreadable`/`file-write-failed`），不含异常消息或密码；唯一含密码的是成功 `get` 的返回值，调用方不得日志/广播/回显。跨进程：文件读-改-写同刻并发写不同账户可能丢一次写（后写者胜），按 ADR 0007 的要求在此明示并同步写入 contracts，可接受（用户重输一个密码）。账户 id 在文件中以 Map 保存，`__proto__` 等同普通键。

**Mail 账户**（Mail 票 04，ADR 0007/0008；infra `mail/account-store.ts`、`mail/protocol.ts`，server `mail-accounts.ts`/`mail-routes.ts`，contracts `mail.ts`；账户添加/重输密码/移除的最小 Web UI 随票 05 在 Mail 页内，设置编辑等另票）：账户列表是全局数据 `<globalDir>/mail/accounts.json`（`{version, rev, accounts}`，不含密码；每个账户有 id `acc-<12 hex>`、显示名、地址、preset、IMAP/SMTP 主机端口加密方式 `tls|starttls`〔不接受明文〕、两个登录名、`credentialRef`（＝id，凭据存储键）、`credentialProtection`（`keychain|file`，`file` 即未受钥匙串保护，UI 持续标示））。每次修改在 proper-lockfile 跨进程锁（`accounts.lock`）内读—比对 `rev`—写（tmp+rename，0600，rev+1）；rev 不符抛冲突、一字节不写，REST 回 409 `rev_mismatch` 带当前 rev；文件损坏/校验失败为 500 且不覆盖。预设（Gmail/iCloud/波恩/自定义，主机端口见 contracts `MAIL_PRESETS`）只补全省略字段，显式字段优先；iCloud IMAP 登录名取地址 @ 前部分、SMTP 取完整地址。协议库 imapflow 2.2.7（MIT）与 nodemailer 10.0.15（MIT-0）只在 infra `protocol.ts` 内引用，窄接口 `MailProtocol.verifyImapLogin/verifySmtpLogin` 只返回失败码（`auth_failed`/`host_not_found`/`connection_refused`/`timeout`/`tls_failed`/`starttls_unsupported`/`protocol_error`/`unknown`），库的错误文本与服务器应答一律丢弃；要求 STARTTLS 而服务器不支持时失败，绝不退回明文登录；证书默认严格校验。REST（`/api/mail`，同 provider 的 CSRF 守卫，`no-store`）：`GET /presets`、`GET /accounts`、`POST /accounts/test`（只测不存；`accountId` 且无密码时用已存密码）、`POST /accounts`（先分别测 IMAP 与 SMTP，任一失败 422 `connection_failed` 带两协议各自结果且不保存；钥匙串不可用且无 `fileFallbackConsent` 为 422 `keychain_unavailable`；同地址重复 409 `duplicate_address`）、`PUT /accounts/:id`（body 带 `rev`；连接参数或密码变更才重测，仅改显示名不连接；密码在 rev 校验通过后才写入凭据存储）、`DELETE /accounts/:id?rev=`（锁内先删凭据，再删账户记录，再删 `<globalCache>/mail/<id>`；绝不连接远端，不触碰远端邮件；凭据无法确认已删除〔钥匙串不可达/凭据存储出错〕时拒绝删除并保留账户，可重试；缓存删除失败只带 `cache_not_removed` 警告）；`POST /accounts/test` 用已存密码时，主机端口加密方式与登录名必须与已存账户一致，否则 400，避免已存密码被送往任意主机。错误体只含固定文案与字段名，不含密码、用户名、主机应答或 zod 消息。并发范围见 [contracts](contracts.md)：账户配置是跨进程安全的（上述锁+rev），缓存不加锁。

**Mail 收信与阅读**（Mail 票 05，ADR 0008；contracts `mail-read.ts`，infra `mail/protocol.ts`〔`MailMailbox`：`listFolders`/`listHeaders`/`openMessage`，imapflow 仍只在此文件〕与 `mail/parse.ts`〔postal-mime 4.0.4，MIT-0〕，server `mail-read.ts`/`mail-cache.ts`/`mail-routes.ts`，web `src/mail/`）：远端邮箱是唯一权威，每次读取先连 IMAP（每次调用一条短连接，每账户最多 2 条并发），邮件缓存只是可丢弃副本。REST（`/api/mail/accounts/:id/…`）：`GET folders`（路径、角色〔specialUse，INBOX 为 inbox〕、未读/总数）、`GET messages?folder=&before=&limit=`（信头，uid 降序，`nextBefore` 游标分页；EXAMINE 只读，不改标志）、`POST messages/open`（`{folder,uid,uidValidity?,unread}`：用 BODY.PEEK 取完整源，`unread:true` 时显式 STORE `\Seen`，服务器拒绝则邮件照常返回 `seen:false`；`unread:false` 且缓存有正文时不连接服务器）、`GET attachment?folder=&uid=&part=&inline=1`（统一 `application/octet-stream`＋`attachment`＋`nosniff`＋`CSP: sandbox`；只有 `inline=1` 且为 png/jpeg/gif/webp/bmp/avif 才按图片内联，供 `cid:` 引用）。UIDVALIDITY 与请求不符回 409 `message_changed`；单封源超过 40 MiB 回 413 `too_large`；失败码＝探测失败码＋`folder_not_found`/`message_not_found`/`credential_missing` 等，错误体只含固定文案。缓存 `<globalCache>/mail/<id>/`：`folders.json`、`f-<sha256(folder)前24位>/headers.json`（合并各页，最多 1000 封）与 `<uidValidity>/<uid>.json|.eml`（解析后的邮件与原始源，0600/0700）；任何缺失、截断、schema 不符、不可写都按未命中重新拉取，不报用户数据错误；只有服务器不可达（非认证/非协议答复）时才把缓存作为 `stale` 返回，认证失败永不被缓存掩盖；`.eml` 损坏导致附件缺失时回源。Web：HTML 邮件由 DOMPurify（HTML profile，无 SVG/MathML；去掉 script/form/frame/object/meta/link/base 与全部事件属性）清洗，远程图片/CSS `url()` 默认移除，逐封“加载远程内容”才放行 http(s) 图片；`cid:` 图片由页面（顶层）取附件字节后以 `data:` URI 内嵌（沙箱 iframe 是不透明源，访问不了应用服务；仅 png/jpeg/gif/webp/bmp、单张≤5 MiB，未取到时显示占位，附件列表仍可下载，内联图也在列表中）；远程样式表、字体、`srcset`、相对路径图片、`@import` 永不放行（也不算“远程内容”，提示条只针对 http(s) 图片与 CSS `url()`）；链接一律 `target=_blank rel=noopener`；放入 `sandbox="allow-popups allow-popups-to-escape-sandbox"`（无脚本/表单/同源/顶层导航）的 `srcdoc` iframe，内置 CSP `default-src 'none'; img-src data: <origin>[ https: http:]; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`。纯文本只作文本节点渲染。

**Mail 管理与服务端搜索**（Mail 票 06，ADR 0008；contracts `mail-manage.ts`，infra `mail/protocol-manage.ts`〔`MailManage`：`setFlag`/`move`/`remove`/`search`，imapflow 仍只在 `mail/` 协议文件内〕，server `mail-manage.ts`/`mail-manage-routes.ts`，web `src/mail/` 的 `MessageActions`/`MailSearch`/`useMailActions`/`useMailSearch`/`search-query`）：所有改动先发给 IMAP 服务器、确认后才应答，缓存随后只镜像服务器的结果。REST（POST，同 CSRF 守卫）：`messages/flag`（`seen|flagged` 加 `value`，应答为服务器实际标志）、`messages/move`（`destination`，应答含邮件在目的文件夹的新 uid/uidValidity，供撤销；无 COPYUID 时为 null、不提供撤销）、`messages/delete`、`messages/search`（POST 以免搜索词进 URL/日志）。删除＝移入 Trash（`\Trash` 特殊用途，缺失时按 Trash/Deleted Items/Deleted Messages/Bin/Papierkorb 名称回退，名称回退与 imapflow 的“按名称猜测”都只认顶层或 INBOX 的直接子级，`Projects/Deleted` 这类嵌套自定义夹不会被当成 Trash；服务器声明的 `\\Trash` 任意层级有效）；Trash 内的邮件再删须带 `permanent:true`（contracts schema 要求同时带 `uidValidity`，否则 400、零请求；uidValidity 过期则 409 `message_changed`）（否则 409 `confirmation_required`、零改动），且仅允许在 Trash 内永久删除（否则 409 `not_in_trash`）；永久删除只用 `UID EXPUNGE`，服务器无 UIDPLUS 时 502 `unsupported`（普通 EXPUNGE 会连带清掉他人已标 `\Deleted` 的邮件）；无 MOVE 扩展时自行 COPY＋`UID EXPUNGE`（要求 UIDPLUS），删除失败则撤回源邮件的 `\\Deleted` 并返回 `partial`（目的地已有副本、原邮件仍在，结果未知）；找不到 Trash 绝不退化为永久删除（`trash_not_found`）；expunge 被拒时撤回 `\Deleted` 标记。imapflow 把 STORE/MOVE/EXPUNGE 的 NO 应答只返回 `false`，因此“服务器拒绝”（`refused`）与“连接中途断开”（`connection_lost`，结果未知，UI 提示刷新核对）由会话是否仍可用区分；发出改动命令之后的任何抛错（含超时、读回失败）一律按 `connection_lost`（结果未知）而非 timeout/unknown；另有 `destination_not_found`。UI 对 `connection_lost`/`unreachable`/`unavailable`（服务应答不可读）的文案是“结果未知”（不说没成功也不说仍在原处）：先回滚乐观显示，再对文件夹列表、源文件夹、目的地（移动的目的文件夹/删除的 Trash）静默重载——无转圈、不把已“加载更多”的分页截回第一页、不让统一收件箱该账户的行消失；搜索中则重跑搜索。重载成功提示“已从服务器重新加载”，重载失败保留回滚后的状态并提示“无法从服务器确认”。`loadSource` 的每次写回都是对当前条目的函数式更新（不用启动时抓取的快照，否则失败的重载会把回滚覆盖回乐观状态）。`partial` 状态已知（目的地有副本、原邮件仍在），单独文案，不算“未知”；`message_not_found` 为“邮件已不在此处”且不放回行。在途移动的行若被重载带回，移动成功时仍会移除。搜索：条件 `text`（发件人/主题/正文任一）、`from`/`subject`/`body`、`since`（含）/`before`（不含，日历日）；服务器端 UID SEARCH（日期用 SENTSINCE/SENTBEFORE，即列表显示的信头 Date，不是到达时间；日期必须是真实日历日，`2026-02-30` 被拒；非 ASCII 词由 imapflow 以字面量＋CHARSET UTF-8 发送；搜索会话的 socket 空闲超时单独为 60 s），结果按 uid 降序分页（`before` 游标，`matches` 为总命中数），EXAMINE 只读；搜索失败的提示用独立文案（“服务器拒绝了这次搜索”“搜索没有完成”），不提“更改”；SEARCH 被拒是错误而不是“空结果”（05 的列表 `SEARCH ALL` 同样：被拒按 `protocol_error` 处理，有缓存则作 stale 返回，缓存不被清剪）；搜索结果不入缓存，没有本地全文索引。缓存一致性（缓存写入失败不会把服务器已完成的改动变成错误应答）：成功改标志后更新缓存信头；移动/删除后删除源文件夹缓存信头与已缓存正文；服务器答 `message_not_found` 时同样清除；列表重新取到最新页时，缓存中落在该页 uid 范围内（首页则整个高于页底的范围）而服务器已无的信头被剔除，避免离线视图复活已被他处移走的邮件。Web：阅读栏动作条（星标、已读/未读、移动菜单、删除；Trash 内为“移回收件箱”＋“永久删除”）与列表搜索框（`from:`/`subject:`/`body:`/`since:YYYY-MM-DD`/`before:` 与自由词；Enter 才搜索，搜索中状态/命中数/失败原因一行显示；换文件夹即清除搜索）。乐观更新：标志、移动、移入 Trash 立即显示，失败则原样回滚（标志、行在列表中的原位置、文件夹未读数、被关闭的阅读栏）并以提示条说明原因；同一封邮件在途时动作按钮禁用；移动/移入 Trash 成功后给 8 秒“撤销”（用返回的新 uid 反向移动）；永久删除不乐观，先确认对话框（默认焦点在取消，写明主题、不可撤销），确认后等服务器删除成功才移除行，失败对话框保留并显示原因。文件夹角色（含 05 的文件夹树）：imapflow 按文件夹名称猜测的特殊用途只在顶层或 INBOX 直接子级有效，`Projects/Deleted` 这类嵌套自定义夹是普通文件夹，服务器声明（RFC 6154）的任意层级有效。

```text
<有效 dataDir>/
├── output/<latex_doc_id>/
│   ├── <latex_doc_id>.json # TexDocIr，version:1，渲染 IR 即存储
│   ├── src/               # 源树
│   ├── build/             # aux/bbl/toc/fls/argelander.jsonl 等编译事实
│   └── assets/            # 直通图或 PDF/EPS 转 SVG
├── output/<pdf_doc_id>/
│   ├── <pdf_doc_id>.json  # 明确 format=pdf 的可信元数据，非 TexDocIr
│   ├── original.pdf       # 不可变原始 bytes
│   ├── annotations.json  # PDF 工作台用户数据（初始空集合）
│   └── reading-position.json # 初始 null 状态；位置保存另票实施
├── output/.latexcache/    # arXiv 源包缓存
├── library/              # library.json、bib、富化与 discovery 缓存、graph.json
├── jobs/                 # 持久 job 与 spool
├── logs/                 # arxiv-fetch.jsonl；错误日志，不是用户文档
├── input/
├── annotations/<doc_id>/
│   ├── current.json      # 独立用户数据，不是 IR
│   └── archive/          # 原批次标注，不对正常 reader/agent 开放
├── manuscripts/<m_id>/   # manuscript.json、原始 assets/、派生 build/
└── templates/            # <id>.json 覆盖与 <id>.deps/ 依赖
<有效 dataDir 的父目录>/status/plans.json
```

`statusDir = resolve(dataDir, "..", "status")`，不是无条件使用 repo/status。plans/annotations/manuscripts 使用 pretty 2 空格、rev 乐观锁和 tmp+rename；PDF 元数据及初始 sidecar 同次绑定文件 SHA-256。PDF Doc owner 仅从 Library 的 Work–Doc 关联得出，build 不通过标题 seed PDF，也不按全局字节去重。不能由上述写法推断所有 schema 都保留未知键，plans 的 I010 仍需相关任务核对。

TexDocIr 直接落盘，含 source/meta 身份、references/bib/refsManifest/citationsByBlock 和原生 text/math/cite/xref segments。旧 Document 桥与双轨 occurrences 已删除。`/api/paper/:id/ir` 只服务 LaTeX IR；`/description` 的格式是显式描述，不能替代正文一致性证明。PDF `GET /pdf/snapshot` 验证 owner、实际原件 hash 和 annotation sidecar；`GET /pdf` 返回受同一固定 hash 校验的原始 Buffer，Web 再校验收到的 bytes 并将那份 buffer 交给 EmbedPDF。PDF hash 已知不同返回 409，不归档/重绑或重写用户数据；损坏 metadata/annotations 返回 500并保留原 bytes。reading-position 独立校验；其损坏/缺失以snapshot中的明确 progress error表示，正文仍可读但不假称位置已恢复，且不写空替代文件。EmbedPDF worker 的 WASM URL 由 Vite 本地资产解析成**绝对同源 URL**后再交给 blob worker（相对 URL 按 blob 基址解析会卡在 loading）；font fallback 关闭。产品错误层以 10 秒 timeout 收束 worker/WASM 异步无响应（它不能抢占同步 CPU/WASM 阻塞，不声称此类情况的硬时限）；部署若加 CSP，至少需允许 `worker-src blob:` 与 `script-src 'wasm-unsafe-eval'`。旧 raw GET `/api/paper/:id` 已删除，不能与同路径的新 DELETE 混淆；旧无 version 文档需要重摄入，不再投影。

## LaTeX 数据流

隔离 workspace → latexmk（编译事实与插桩事件）＋unified-latex 源码树/有界宏展开 → 融合 IR → 图资产物化 → 直接存储/展示。

印刷编号取编译真值，不从结构 id 猜测；编译失败不做无编译全文降级。PDF/EPS 图片转换采用 pdftocairo/gs，旧 pandoc/mupdf/dvisvgm 路线退役。执行护栏、事实盲区、回退和测试范围见 [tex-pipeline](tex-pipeline.md)。Writer 显式 profile 共享主干但不共享摄入/归档副作用。

## Web 与同步

- `serve` 默认 8000；Hono REST、SPA、images、`/ws`。
- watcher 轮询 library、plans、per-doc current annotations、manuscript JSON 和模板 JSON 指纹；server 自写可再收到 external，前端幂等重取。没有资产目录 watcher。
- JobRunner 串行、持久化；boot 将未完成 job 标 interrupted，不重跑；hello 回放，失败在详情刷新后仍可见；job.done 先于 library.changed。upload、refresh 和 arXiv ingest 生命周期不能与 Discovery 只读请求混淆。
- 文献 label 色板：red重点 / amber待读 / green已精读 / blue方法 / violet灵感；overlay > 持久 label > star 播种。已读标题灰化及“已读”，未读蓝点。
- 阅读中列流式、100ch 上限；顶部可折叠作者块，多引用 per-ref chip；图片尺寸预留与停稳校正。右栏默认引用，可切标注；DOM 不嵌套高亮 span。
- 文献深链接 `/doc/<doc_id>#<anchor>` 使用 sec-N/fig-N/eq-N/tab-N/ref-N 等结构 id，不是印刷编号；标注使用 `#ann-<annotation_id>`。探索链接及历史见 discovery。

## Agent 接入

CLI + 仓库 `skills/argelander-*` 三件套（ingest/query-library/read-paper），无 MCP 是项目选择；本机安装方式不成为跨机器保证。

- search/read/show/ref/note/label/list + 只读 annot，CLI 直读磁盘，不依赖 HTTP。
- 文献问答从项目根走 CLI/skills，不传 `--data-dir`，不读内部 JSON/源码替代文献接口。开发任务不受此源码禁读限制。
- 仓库 CLI：`node packages/app/dist/bin.js`；全局安装后 `argelanderspace`。
- 深链接端口：`ARGELANDERSPACE_PORT` > config `port` > 8000。
- search 空 note 提示只走 stderr，stdout JSONL 保持可 pipe；摄入后每篇询问 note 并给建议稿。输出冻结以 contracts 为准。

## 包职责

pnpm workspace，ESM-only，TypeScript strict + noUncheckedIndexedAccess，Biome，Vitest：

| 包 | 职责 |
|---|---|
| contracts | Zod 数据/REST/WS 契约，canonical annotation text 与 Writer 序列化纯函数，web runtime 可用 |
| core | tex facts/source/fuse/IR 编排；文档展示与引用；library store/seed/graph/build；acquire/upload；plans/annotations/writer store、导出和预览 |
| infra | workspace/compile/instrument/figures/ingest；arXiv 抓取解包；ADS/Crossref/OpenAlex、config、zip、pyjson 缓存兼容；Writer opt-in 编译缓存 |
| server | REST/SPA/images/WS、jobs/watcher、领域锁、DocMutationRegistry、Writer single-flight/drain |
| cli | 命令注册、冻结 agent 输出、磁盘读写 |
| web | 阅读/文献/计划/标注/Writer/探索，共享 IR 展示、ReaderSession、i18n、graph 共享 renderer 与两个 adapter |
| app | npm 单包；tsup bin/web/argelander.sty/许可 notices；createRequire banner 有实际运行作用 |

单用户文件存储，不使用 SQLite。源码结构优先通过 CodeGraph 定位；工具不足再读源码。旧“截至 Stage 8 无 CI”的历史观测不是本次对 CI 的重验证。

来源：迁移基线 `46093915` 的 `.pi/memory/product-and-architecture.md`；本页仅重组已有事实，没有重新测试产品。
