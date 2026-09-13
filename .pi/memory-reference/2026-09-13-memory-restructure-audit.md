# 2026-09-13 记忆重构：去向、冲突与验收

状态：已完成（2026-09-13，文档检查与保真核对通过；未提交/未推送）。这是一次性整理审计，不是新的现行规则副本，按需读取。制度权威在 [inbox 协议](../inbox/README.md)，当前交接在 [本次 session](../inbox/2026-09-13-mem-31b251a-memory-restructure.md)。

## 授权与保护范围

用户先要求看方案、不动手；经三轮 Q1–Q19 全按推荐，最终“确认，可以直接开始实施”。授权仅记忆文档重构；不动代码或用户数据、不修改 `.pi/settings.json`、不 commit/push、不选择下一阶段、不新增自动化系统。

起点工作区已有：15 份 `.kimi-code/memory/` 删除，`.pi/` 未跟踪，`AGENTS.md` 已修改（中文与读取路径）。本次沿用用户迁移，不恢复旧目录、不清理其他未跟踪内容。旧 AGENTS 中文要求保留；路径统一及协议更替由本次明确授权。

## 原文保全证据

基线提交：`31b251ab61204609147b92f70994a4ffd31b761e`。

2026-09-13T22:52:34+02:00，逐个 `git show <ref>:.kimi-code/memory/<name>` 与工作区 `.pi/memory/<name>` 比较，**15/15 字节完全相同**。原文合计 **213,255 UTF-8 字节**（208.26 KiB）；原 AGENTS 4,267 字节。前期方案估算“约234 KB”不准确，以实测为准。

下表 SHA-256 针对完整原文字节。原文已在持久 Git，可删除本地旧副本，不需要额外历史复制或擅自提交。历史目录仅用于 git show，不是当前记忆入口。

| 原文件名（基线目录 `.kimi-code/memory/`） | SHA-256 |
|---|---|
| 2026-09-01-development-log.md | b09d4a4fe481ead7814a0310678ffbc16ea50519f7a69ef44dbee49599e1c37a |
| 2026-09-01-known-issues.md | 1c2830a34c0e476a1a2ded4aeffa51ff665cccaccb22030cd3d585ca029d1ea3 |
| 2026-09-01-pitfalls.md | 447b8c3de4b6e00a0a3e33b6d01863086382c0560e95c59d3ad25d3c2eea3362 |
| 2026-09-01-product-and-architecture.md | c983154b532d1389afaacd88789f022577824c5275630559683638e820c2b90b |
| 2026-09-01-stage3x-roadmap.md | ae552ff942f9b9050f4e0f63798d04b4ba7dbd4516edaed8c4e89c2b7d03075e |
| 2026-09-02-stage4-roadmap.md | 95b0264699c1626ef4187269d6d953430e6b8b77f3e7ebf9b1eca06f11762b5b |
| 2026-09-04-stage5-ms1.md | 329b300b9d8d708aca2a098a573d509e7fcdd845431d7ac274891fe25ae20aa0 |
| 2026-09-04-stage5-ms2.md | 948e26baea1ddcbb1b272dc368ec20b46451f18b93cdc756ad3e26d005a26dce |
| 2026-09-04-stage5-roadmap.md | d701cd690d9691d7541ea20428e68d21d0e091cf2ce3279cf07aaff72ce6002a |
| 2026-09-08-stage5-ms3a.md | a0b430498397a5d81d2ac37a981828b85eb8b62a8c00119ec22ebbdbdacf6983 |
| 2026-09-08-stage5-ms3b.md | c5445f3c34b4189d70529b823e8205deebfc726d97e21000e03bdb8cb0ae81ef |
| 2026-09-09-stage6-roadmap.md | 1e69bfca256e2df41a0dfa744d85b5349c900393739ac8ec0b8d55a76149e361 |
| 2026-09-09-stage7-roadmap.md | c79a8e1218905894d57df153810f468e96d24e61b14a88205f23f3abf8787ce1 |
| 2026-09-10-stage7-ms2b-migration.md | 4f727e77076a57630bcf1391c109cde949bdf6d6492f326d3b595c4cae00b6cc |
| 2026-09-10-stage8-roadmap.md | a22cabf2b534b944de22798de6e8928ab75f575b01b3b026b279cdba091648d0 |

恢复方法见 [history](../memory/history.md)。不要把本次新 inbox 也视作已在这个提交中；它仍未提交，尽管 D1 已写入正式协议，也必须留原文。

## 去向表（按有意义的小节，不逐句机械编号）

简称对应实际文件：

- **架构**：[product-and-architecture](../memory/product-and-architecture.md)
- **契约**：[contracts-and-decisions](../memory/contracts-and-decisions.md)
- **问题**：[known-issues](../memory/known-issues.md)
- **工程**：[engineering](../memory/engineering.md)
- **历史**：[history](../memory/history.md)；“仅历史”表示原文在上述 Git 基线，不复制全量副本。
- **TeX / 标注 / 计划专题**：[tex-pipeline](tex-pipeline.md) / [annotations](annotations.md) / [plans](plans.md)

| 旧文件及内容组 | 处理与新位置 |
|---|---|
| development-log：Stage1/2重构与agent接入；Stage3存储/IR/UI | 结果压入历史；仍有效的CLI/存储/产品语义合并架构和契约；测试数、逐commit流水仅历史 |
| development-log：Stage3.1隔离、zip身份、旧编号；Stage4定位/CRUD/smoke | zip/独立应用入架构与契约；旧自产号被Stage5替代；计划交互与否决理由入计划专题；过程仅历史 |
| development-log：Stage5定义/迁移/图转换、Stage6/7收尾 | 双通道与图路线入架构/TeX；打包与迁移教训入工程；备份已删除、旧“待验收”作废；阶段结果入历史 |
| development-log：Stage8及下一步 | 已关闭入索引/历史；安全契约入契约/标注专题；未决入问题；不再复述“8项” |
| known-issues：外部服务、keys、旧OCR死代码、旧pandoc机制 | 有日期的观测入工程；OCR恢复方向I025；MinerU缓存字面名/构造即key等已迁出main的细录仅历史；subequations机制随pandoc删关闭 |
| known-issues：attachPdf隐患、cite_key/UA/planner旧READY | attach身份机制入架构/契约；已关闭结果入历史，旧实现细节仅历史；出版商可达性保带日期观测 |
| known-issues：Stage8共11条混合存照 | I001/I002/I008/I009/I014/I015/I020；selbar-y测试局限入工程；canonical位置及OCR字段投影入架构/标注专题；跨进程I013 |
| known-issues：Stage7遗留与Stage6已修 | I003–I007/I016及TeX作者边界；正文diff归因入工程；已修四项进历史/架构，不再划线清单 |
| known-issues：接受行为、task.due、TOC/hyperlink-only、1800s上传 | 当前语义入契约/计划；TOC关闭；xref拆成I003/I017/I027；旧MinerU1800s不套到新latex编译，只留历史 |
| pitfalls：环境/测试/biome、打包、py兼容/cache/mtime | 活跃规则入工程；旧pandoc/mupdf/HTML bs4实现仅历史，保“别前置astro bin”等有效教训 |
| pitfalls：dvisvgm验证失败 | 工程保真实fixture/Chrome真值与反直觉结论，TeX保现行转换路径；无须保每图32k path流水 |
| product-and-architecture：产品/摄入/存储/UI/agent/模块/质量 | 作为架构主骨架，合并后来的Stage7/8决定；安全移契约、工具细节移工程；旧DOI报错、ADS恒活、缺多doc说明被修订 |
| stage3x-roadmap：Q1–Q18、milestone、取证A–E | 当前zip/身份/attach/OCR封存入架构/契约；webui独立应用保理由；pandoc版本/旧模块删除清单/测试连锁仅历史；旧执行授权过期 |
| stage3x-roadmap：推后项 | re-upload与DOI已完成；pandoc发布说明随退役关闭；Stage4已完成；原Stage5写作已删除不顺延；webui目标保留I024 |
| stage4-roadmap：模型/REST/UI/否决项、smoke修订 | 当前详情入计划专题，关键用户取舍入契约；task due必填、无QuickAdd、拖拽最终反馈采用新决定 |
| stage4-roadmap：审查/取证/未来4.1 | I010/I011/I018/I021/I028与工程；40MB探针/浏览器逐轮/临时笔误文件仅历史；未来CLI直写非冻结契约；patchRef类型缺note旧观察保为I029待核对，不升级成新阶段任务 |
| stage5-ms1：mathnum实证/审查、编译执行、资产/fixtures | 反直觉机制、tag*/CurrentFile/事件缺口/超时/受限shell/预扫描与aux brace剥离入TeX；sty打包入工程；旧golden stub当时不能编译的过渡状态仅历史 |
| stage5-ms2：source/macros/fuse/编号/cite/xref/golden与修复 | 现行机制入TeX；原生segments/存储入架构；caption/center/comment内容缺失教训保专题；详细两文人工对账仅历史，保编译bbl真值与golden分层原则 |
| stage5-roadmap：Q1–Q13、原型、全部MS/迁移/smoke | 现行架构/契约/TeX/工程；dvisvgm原决定由smoke改判覆盖；I004/I022/I026；prototype pagedView细节、旧手术清单与逐MS未commit状态仅历史 |
| stage5-ms3a：CLI/acquire/upload/server/seed重接、空格bug | 最终接线入架构，source/meta兼容语义保留；comment空格进TeX；原DocIr回退已被MS4b删除；旧ref p7→p6与逐字段对账仅历史 |
| stage5-ms3b：删除/保留至MS4、banner/stale dist、验证 | 最终删旧schema/桥入架构；banner=ws、清dist、包名filter进工程；过渡保留清单、测试数仅历史 |
| stage6-roadmap：①–④定稿、MS/smoke、取证A/B | UI最终状态架构；停稳机制/真实浏览器/IME等工程；作者三族/revtex/ensuremath TeX；作者而非ref富化与冻结契约保留；旧scrollend/定时器决策明确被最终方案覆盖 |
| stage6-roadmap：作者残余、直通图、后续阶段 | Stage7修掉者归历史；剩余I005；图jpg/gif/webp已支持；Stage7/8已关闭，不顺延成当前待办 |
| stage7-roadmap：Q1–Q10、MS1–MS5 | DOI stub/主位/cite_key/offline/UA等最终结果架构与历史；due契约；作者与xref实证TeX；新问题入I003–I007/I012/I016/I027 |
| stage7-roadmap：审查非阻断 | 主位三边界、SICI、JPEG尺寸、TOC截断token、flag提示等按用户影响分到问题/工程/TeX；纯修复过程及旧测试数仅历史 |
| stage7-ms2b-migration：4成功/5失败、parity/offline/回滚 | 五篇逐原因I004，重要正文diff和迁移验证方法工程；ADS“待决定”被f320c6b明确覆盖；旧备份恢复命令不再作为现行可执行指南 |
| stage8-roadmap：产品定位、硬约束、§1–§8 | 契约保三态原规则及异常分支、权限、全局删除/三态UI、不可变；标注专题保完整target/snapshot/投影/CLI/DOM/REST细节；agent未来能力I023 |
| stage8-roadmap：MS1–MS6实现、审查、smoke | 采用实现位置修订canonical在contracts、asset守卫已补、pin泄漏已修、文本409不换类型、列表点击不开popover；测试局限工程，其余I001/I002/I008/I009/I013–I015/I020；截图/测试计数/逐commit过程仅历史 |
| stage8-roadmap：推后/orphan | I014/I019/I023及契约；不自动访问/清理orphan，不把未来输入写既成事实；跨进程锁不做 |

## 冲突处理：采用后来的有权决定，不把事实简单按时间抹掉

| 旧说法 | 采用的现行结论与来源 |
|---|---|
| AGENTS读.pi却写.kimi，日常直接增正式记忆 | 2026-09-13 Q1–Q19：全部.pi、session inbox、授权归并、新覆盖旧 |
| 所有memory均当不可变既定事实 | 本次区分决定/事实；保已验证结论，明确新决定可覆盖，证据更新有环境范围 |
| 产品=文献工具/web看板 | 2026-09-02用户定位升级：科研工作台+独立web应用 |
| DOI/URL仅友好报错不建work | Stage7 MS4：可解析DOI建stub；无DOI URL仍报错，非任意URL都可建 |
| ADS在offline仍联网 | Stage7 roadmap最终MS2b+f320c6b：ADS enabled gate，缓存仍可读 |
| 所有display自动编号 | Stage5 Q2：编译印刷真值，无号公式不自产编号 |
| dvisvgm适合通用PDF图转SVG | Stage5 smoke R1：真实字形/位图证伪，改pdftocairo+gs；旧三角测试只在样本范围成立 |
| re-upload仅upload家族/推广待做 | Stage7 A1已落地：所有work可上传，多doc+主位 |
| task.due可选/超plan日期未解决 | Stage4 smoke改必填；Stage7 Q6定为合法+软警告 |
| Stage5=论文写作 | 2026-09-04明确删除不顺延，重定义为IR管线 |
| Stage6修参考文献title/authors | Q8用户澄清是当前论文作者块，富化非其诉求砍掉 |
| 900/400固定校正或scrollend是最终方案 | Stage6 MS4停稳检测覆盖；旧机制取消面问题退役 |
| Stage7完成后下一阶段Stage8；Stage8待smoke | 2026-09-12 Stage8已验收关闭，下一阶段未定 |
| canonical放core、literatures全被忽略 | Stage8 landed明确canonical在contracts、专门补annotations忽略规则，修正草案实现前提 |
| migration日志备份还在/可按旧tar命令还原 | 后来阶段关闭明确备份已删，迁移过程只留历史 |
| 普通golden可更新意味着agent冻结也解除 | 两条不同范围规则同时有效，Stage6–8冻结继续成立，不伪造冲突 |
| 所有5篇失败都因缺cls | 按既有逐篇证据修正摘要：还包括旧类冲突、缺宏、plain TeX；不需要重跑 |
| 旧阶段自行commit永久生效 | 本次Q15明确阶段授权到期；未获得本次commit/push授权 |

## 本次 Q1–Q19 覆盖核对

| 题目 | 落地权威/验收点 |
|---|---|
| Q1 保真 | 协议§4，契约保理由/范围，35–50KB软预算 |
| Q2 决策资格 | 协议§3：用户/授权agent/建议/实现偏差区别 |
| Q3 事实更新 | 协议§3、工程外部观测保日期、TeX保环境 |
| Q4 全量inbox启动 | AGENTS启动1–3、索引、协议§1 |
| Q5 修改权限 | AGENTS记忆写入、协议§2/§4 |
| Q6 历史追溯 | 本页hash基线、history恢复、协议原文入Git条件 |
| Q7 目录/单一权威 | 索引职责表、目录结构；所有材料限.pi |
| Q8 写入时点 | 协议§2、真实当前inbox而非伪造旧session |
| Q9 格式 | 协议模板，局部D/F/I/Q编号，带时区记录头 |
| Q10 覆盖记录 | 协议§3、本页冲突表、inbox D1 |
| Q11 归并授权 | 协议§4：无争议可做、歧义问、不含commit/push |
| Q12 部分归并 | 协议§4、本次inbox已归并但未提交故暂保留 |
| Q13 阈值 | 8份/40KB软提醒，阶段交界；不后台、不跳读 |
| Q14 问题分类 | known-issues四类、I001–I029稳定号 |
| Q15 历史授权 | 契约§3/§6，冻结与普通回归分开 |
| Q16 长篇方案 | 协议§5：状态/授权/执行进inbox/关闭归并 |
| Q17 临时/敏感 | 协议§6、工程证据教训，不读实际密钥 |
| Q18 保真验收 | 本页去向、下方清单和恢复演练 |
| Q19 不扩工程 | 只文档，一次性只读检查，无hook/脚本系统 |

## 保真重点核对

- 产品/用户：科研工作台、独立webui、用户亲自读论文、拒绝额外计划状态机/延期历史、ref富化非原诉求、下一阶段待用户。
- 接口：ordinary golden vs agent冻结分开、annot键序/排序/stdout/stderr/真只读、结构id不承诺逐位置稳定、DOI stub限制范围。
- 标注：target不可变、body字节保存、UTF-16与原子范围、三态及全部错误分支、archive字节原样/不覆盖、server访问权威、PUT双校验、系统错误不reset。
- 生命周期：DELETE全库物理摘除、workspace三态、server双向busy、跨进程不支持、orphan不自动访问/清理。
- 未决与边界：五篇逐因、脚注DROP、主位三边界、作者残余、reader旧IR、部分删除、GET双归档、SICI、推后能力。
- 工程：sty随包/createRequire=ws/stale dist、真实图和浏览器真值、测试密封、ADS offline已修、旧备份不承诺存在。

## 恢复演练（只依新启动材料）

| 问题 | 可得到的正确答案及入口 |
|---|---|
| 项目是什么、到哪了？ | 科研工作台；Stage8关闭，下一阶段由用户定。索引/架构 |
| 不能擅自做什么？ | 不改冻结接口、不把指纹错误当替换、不自动迁移/删orphan、不继承旧commit授权。契约 |
| 新旧冲突听谁？ | 同范围有权新决定优先，事实看证据/环境；来源不清问用户。协议§3 |
| 开发结束记哪里？ | 自己的session inbox，关键节点早记，结束收尾，不直接改正式记忆。协议§2 |
| 什么没解决，谁定下一阶段？ | 稳定I清单分四类，不默认排期；用户决定。问题/索引 |
| 改专题先读什么？ | 必读契约+工程，索引指向TeX/标注/计划；专题按任务，inbox全部读 |
| 正文指纹算不出怎么办？ | 不归档/删/重写/广播invalidate；按错误分支返回，保用户数据。契约§4 |
| 新决定已归并但inbox未提交能删吗？ | 不能；保留原文注明已归并，等待原文持久Git与必要授权。协议§4 |
| inbox过阈值可只读索引吗？ | 不可；提醒整理，仍全读，无自动化后台。协议§1/§6 |

这些是文档一致性演练，不冒充新session独立审查或产品功能重测。

## 最终检查与体量

2026-09-13 最终只读检查通过：

- 15份原文重新按基线Git读取，SHA-256全部匹配；本地旧副本在字节/hash双验证后删除。新正式目录恰6文件，专题3文件+本审计，inbox协议+1份真实session。
- **13个Markdown文件、54个本地链接**全部可达；`.pi/`记忆链接没有指向目录外的记忆副本，所有文件UTF-8、末尾换行、无尾空白。
- 契约核对23个关键条款，包括三态全部错误分支、server归档/CLI只读、双校验、全局删除/三态UI/并发、agent冻结；Q1–Q19映射完整，问题I001–I029编号唯一且连续。
- 上方恢复演练逐项对照新启动材料完成；没有把它冒充独立subagent审查或新session自动化测试。
- 旧目录字面只在history、本审计、session起点记录的历史定位中出现；AGENTS无失效读写路径。README/docs/skills的字面引用扫描没有待修的旧记忆链接。
- `git diff --check`通过；未跟踪的新Markdown另做全文件空白/链接检查，不能只靠git diff忽略未跟踪文件。
- 分支main、HEAD仍为原基线；Git index无暂存变更。相对起点，仅替换记忆内容和AGENTS；未触碰代码、用户文献数据、settings，未commit/push。

体量（UTF-8，KB按十进制，报告/inbox收尾会使总量略增）：

| 范围 | 整理前 | 整理后 |
|---|---:|---:|
| 正式必读memory | 213,255 bytes / 15文件 | **46,159 bytes / 6文件，减少78.36%** |
| 启动记忆（正式+协议+本次inbox，不含AGENTS） | 213.3 KB | 约60 KB，减少约72% |
| 全部记忆（另含专题和本审计） | 213.3 KB | 约105 KB；历史详录已在Git而非复制入新目录 |
| AGENTS | 4,267 bytes | 3,778 bytes |

没有重新验证历史实验，没有运行build/test/typecheck/lint全四门：本次纯文档，无代码变更。没有新增脚本工具、插件、hook或后台任务；检查是一次性只读命令。

### 剩余注意事项

- 本次session原文尚未入Git，所以保留inbox，尽管协议决定已归并。后续获得提交/整理授权并确保原文持久后，再清理并更新所有来源链接。
- I029只是未明确关闭的历史观察，不声称当前代码仍有该问题；需要相关任务核对，无需为本次整理重复实验。
- 上述产品问题没有被本次文档整理修复；下一阶段未定。
- 无需用户进一步裁决的记忆冲突遗留；实施没有扩大权限。
