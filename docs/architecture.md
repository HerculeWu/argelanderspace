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

**Mail 写信与发送**（Mail 票 07，ADR 0008 / 规格 Q16；contracts `mail-compose.ts`，infra `mail/outgoing.ts`〔`composeMail`＝nodemailer MailComposer；`MailOutgoing`：`saveDraft`/`deleteDraft`/`appendSent`/`sendSmtp`，imapflow/nodemailer 仍只在 infra 邮件文件内〕，server `mail-compose.ts`/`mail-send.ts`/`mail-outbox.ts`/`mail-compose-routes.ts`，web `src/mail/MailCompose.tsx`/`ComposeWindow.tsx`）：只发纯文本正文（富文本不在第一版）。**草稿**存在服务器 Drafts 文件夹（APPEND，标志 `\Draft \Seen`），身份是 Message-ID（客户端生成 `<uuid@账户域名>`，之后每次保存、最终发送都用它）；保存＝先 APPEND 新副本，再只删除同 Message-ID 的**更旧**副本（uid 更小者），所以两次竞争保存最坏留下两份、绝不会零份。Drafts/Sent 文件夹先按 special-use（`\Drafts`/`\Sent`），再按常见名称查找，找不到 Drafts 则拒绝（`drafts_unavailable`，不发送）。回复/全部回复/转发/编辑草稿的初始内容由服务器按原信源生成（`POST init`）：回复收件人＝Reply-To，否则 From（原信是自己发的则取原收件人）；全部回复再加原 To/Cc，去重并去掉自己；`In-Reply-To`＝原 Message-ID，`References`＝原 References＋原 Message-ID；主题加一次 `Re:`/`Fwd:`（同族前缀不叠加）；回复引用 `> ` 逐行，光标在引用之上；转发带“转发的邮件”头与非内联附件（暂存为待发附件）；只有 HTML 的原信用去标签文本引用。**附件**先上传到暂存区 `<globalCache>/mail/_staged/<attId>.bin|.json`（可丢弃缓存，不挂在某个账户目录下，因为写信时可以更换发件账户而附件要跟着草稿走；缺失在发送/保存时报 `attachment_missing`，用户重新添加；发送成功/放弃草稿时删除，其余 7 天后清扫；编辑 Drafts 里的草稿或转发时，原信的非内联附件被暂存到这里），单个 ≤ 40 MiB、整封 ≤ 50 MiB、≤ 50 个；界面按编码后约 4/3 估算大小，超过服务商文档上限（Gmail 25 MB、iCloud 20 MB，未在本票联网复核；波恩与自定义未知）时显示警告但不阻止，真正的拒绝由服务器给出（`message_too_large`，草稿保留）。

**发送与 8 秒撤销**（`POST /api/mail/compose/accounts/:id/send`，body `{sendId, draft}`，202）。服务器按下列顺序执行，这个顺序就是“无重复发送、不丢信”的论证：①对该 Message-ID 取独占 claim：先过进程内守卫（`账户+Message-ID` 集合，缓存目录被删时仍有效），再在缓存里 O_EXCL 创建 `outbox/claim-<hash>.json`；已有 claim 的持有者进程不存在、或属主 pid 相同而 boot id 不同（pid 复用）、或超过 10 分钟，视为陈旧并替换；**无法解析的 claim 若 mtime 在 5 秒内按“对方正在创建”视为 live**，更旧的当垃圾。已被占用回 409 `already_pending`；同一 `sendId` 再次提交（双击、重试，含并发）合并为同一次发送；②把**最终版**邮件存进 Drafts（失败则不进入窗口，什么都没发；进入前后两次确认账户仍存在，已删除的账户不会被重建缓存目录）；③严格写标记 `outbox/<sendId>.json`（状态、属主 pid 与进程 boot id、截止时间；写不下去也不进入窗口）并启动**内存里**的计时器（`unref`）；④窗口内 `POST …/sends/:sendId/undo` 清计时器、释放 claim、标记 `cancelled`，草稿原样在 Drafts；⑤到点：属主进程**严格写入** `sending` 标记（写不下去就不发，标 `failed/storage`），做**一次** SMTP 事务（SMTP 永不自动重试），成功后先记 `sent`，再按账户 preset 决定是否 APPEND 到 Sent（`MAIL_SERVER_SAVES_SENT`：Gmail 为 true〔其 SMTP 自动保存，不重复〕，其余默认 false，iCloud/波恩未经实测）并删除 Drafts 副本；清理完成前对外仍报 `sending`；Sent 副本存不下时保留 Drafts 副本并如实告知。收件人被部分拒绝时邮件已发给其余人，计数告知；全部被拒为 `recipient_rejected`。失败（definite）时草稿仍在 Drafts，界面把原文放回写信窗并给出原因。

**SMTP 结果的判定按协议阶段，不按错误文本**：infra 用 nodemailer 的协议跟踪只读取一个事实——客户端已发出 `DATA` 命令（或服务器对它回了 `354`）；之所以以命令发出为界，是因为从那一刻起断线就无法与“已接受、应答丢了”区分。该日志不保存、不记录任何其它内容。`DATA` 之前的任何失败（连接、TLS、认证、MAIL/RCPT 被拒或断线）都是确定未发出；`DATA` 之后若没有服务器应答（断线、超时、TLS 错误文本都算）一律为“结果未知”（`outcome_unknown`，状态 `unknown`，草稿保留，不重试）；服务器给出了应答码（552/5xx/4xx）则是确定的失败。测试覆盖 RCPT 后断线（确定）与 DATA 后断线（未知）。

**窗口内 server 退出（Q16）与优雅关停**：邮件在步骤②已在服务器 Drafts，窗口不读标记也不会发送；重启后没有任何东西会据标记补发。标记只用于如实报告：属主已不存在的 `pending` 报告为 `interrupted`（未发出、已在草稿、不自动补发），`sending` 报告为 `unknown`（窗口已过，可能发出也可能没有，请先查“已发送”，同样不补发）。**优雅关停**：`createServer().close()` 的第一件事（同步）是 `disposeMailSendServices()`：清除所有计时器、置关停守卫（到点触发器与新的发送都直接拒绝）、把仍在窗口内的发送标记为 `interrupted` 并释放 claim——因此关停期间有慢请求或 Copilot run 要等，窗口也不会在这段时间里变成发送；已交给 SMTP 的发送不被打断。只有属主进程会发送；另一个 server 进程只能观察（`ownedElsewhere`），撤销/关闭该发送回 409 `owned_elsewhere`，对同一草稿再发送回 `already_pending`。页面刷新后 `GET /api/mail/compose/outbox` 列出仍需用户注意的发送（窗口内、发送中、failed、interrupted、unknown，以及**尚未被页面确认的近期 sent**，所以用户不在页面时成功发出的邮件，回到 Mail 页也能看到结果），界面据此恢复倒计时或显示结果；用户关闭/确认时 `DELETE …/sends/:sendId` 才忘记该标记（普通的已确认 `sent` 一小时后清扫；带有需告知结果的 `sent`——没有 Sent 副本、有被拒收件人、Drafts 里留有副本——与其它问题一样保留到页面确认，最长 30 天）。内存里的完成记录释放邮件字节并在 10 分钟后淘汰。

**窗口内的草稿被冻结**：对正在发送的 Message-ID，`PUT draft`、`discard`、以草稿模式 `init` 都回 409 `already_pending`（检查在草稿锁内，排在它之前的保存先完成），避免“发出旧版并删掉新编辑”；撤销后恢复可编辑。

**为什么标记在全局缓存而不是全局数据，及其代价**（ADR 0007 判断）：进入窗口前最终邮件已在远端 Drafts（远端为权威），所以标记丢了不会丢邮件；它不是用户数据，不需要保全规则，删除账户会连同缓存目录清掉其标记。**代价必须说清：缓存目录被整体删除时，claim 文件随之消失，跨进程互斥失效。** 同一进程内仍有内存守卫；但若此时另一个 server 进程对同一草稿发起发送，两个进程可能各自进入窗口并各发一次（重复发送），重启后的“未发出”提示也会丢（草稿仍在服务器）。这是用户主动删缓存目录且恰好多进程并发发同一草稿时才会遇到的剩余窗口，没有额外加锁。其余已知剩余窗口：①单次 SMTP 事务若长于 claim 的陈旧期（10 分钟），另一进程会把该 claim 当作陈旧而接管，同一草稿因此可能被第二次发送；②三个进程同时判定同一陈旧 claim 并先后删除/创建（仅发生在同刻发送同一草稿且上一属主刚崩溃时）。

**暂存附件**不属于账户目录，因此删除账户**不会**清掉它们；靠 7 天清扫（server 启动时扫一次，暂存新附件时也扫）以及发送成功/放弃草稿时的删除。**前端**：同时可有多条发送各自倒计时与撤销；撤销/SMTP 失败要恢复写信窗时，若用户正在写另一封，不替换它，而是给带“打开”的通知（打开前先把当前稿存到服务器，存不下则保留）；撤销遇 409 先查真实状态再报告；服务器暂时不可达时倒计时归零后显示“正在重新连接，尚不知道是否发出”；离开 Mail 页卸载时先把未存文字 best-effort 存到服务器，失败则记入 sessionStorage，下次进入 Mail 提示；同一份草稿内容的重试复用同一 `sendId`（服务端以磁盘标记也能认出，内存记录过期后同样成立）。写信窗按“有无服务器没有的改动”判定能否关闭：保存后再输入的改动、被取消的延迟保存都算；发送请求进行中窗口被锁定（不可关闭/编辑/换发件人，“打开”恢复入口无效），发送结果只回写发起它的那个写信窗（按窗口 uid），其窗口已不在则以通知＋“打开”恢复；任何新窗口（含回复/转发的初始内容）遇到已打开的写信窗时都只以通知提供。附件大小提示只对有已知服务商上限的预设显示（Gmail 25 MB、iCloud 20 MB）；波恩与自定义无已知上限，不显示大小警告，只有服务器的拒绝才会让发送失败（草稿保留）。离开 Mail 页面不会取消服务器端的发送，也无法再撤销；回到 Mail 页时由 outbox 列表显示结果或中断警告。

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
