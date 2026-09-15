# Stage 11 范围草案:Writer 渲染链路大修(citation/xref/编号/编辑器)

- 状态:**草案**(2026-09-15 整理自 Stage 10 用户 smoke 反馈;**无决策效力**,正式范围待立项 grilling)
- 前提:Stage 10 已关闭(smoke 未通过但用户决定关闭);本文件是下阶段 grilling 的输入,不是已批准方案。

## 背景:Stage 10 smoke 发现的四个问题(用户原话整理)

### P1 — citation 工作不好
- 右栏 References 点击**应只插入裸 key**(与 xref 插入行为一致),实际插入 `\cite{key}`。
  - 修订点:Stage 10 R1 Q4 的"插入 `\cite{key}` 完整命令"决定**被用户 smoke 反馈修订**——插入行为应对齐 xref:只给 key,命令由用户自己写(或未来的自动补全/编辑辅助)。
- **`\citep` 渲染不出来**(预览渲染不符合预期)。
- **citation 渲染不随模板走**——用户期望引用渲染与模板语义关联(如 natbib 作者-年 vs 数字编号等风格差异)。

### P2 — xref 工作不好
- 当前渲染:`equation [eq:vc]`(kind + 裸 key 芯片)。
- 期望:渲染出**编号等内容**(如 `equation 1.1` / `(1.1)` 样式),即 xref 应解析到(编译求真的)编号,样式与模板相关。

### P3 — 公式编号一直没有
- 正文预览里渲染的公式**不显示编号**;编号只存在于 outline/crossref 面板。
- 期望:渲染的 display 公式带编号(编译真值;草稿未编译时有合理占位)。

### P4 — 进入 cell 编辑后光标错位
- overlay 高亮方案(textarea 透明字 + 下垫高亮层)在真实使用中出现**光标/文字错位**。
- 这是方案级脆弱性(字体度量漂移/滚动/换行对齐),不是参数问题。

## 用户定性(原话要点)

- "这些问题我觉得是后面有深层次原因。"
- "可能需要**增加一些依赖库**来解决编辑和语法高亮问题,可能已有方案甚至可以一起解决关于**自动补全**方面的问题。"
- "前 3 个表明需要对**整个渲染链路进行大修**。我们下个 stage 专门做这个。"

## 候选方向(草案,待 grilling 取舍)

1. **编辑器组件换代**:用成熟编辑器库(首选候选 CodeMirror 6:IME 安全、光标/滚动正确、扩展体系完整)替换 overlay 高亮,根治 P4;同构扩展顺带做**自动补全**(cite key 来自文献库、label 来自文档目标、LaTeX 命令)。许可证/体积评估是 grilling 题目。
2. **统一渲染链路**:cell 预览从"正则启发式散件"升级为一条以**编译事实 + 文献库 + 模板样式**为输入的渲染管线:
   - citation:解析到文献库条目,按模板引用风格渲染(作者-年/数字),`\citep/\citet/\cite` 等家族语义区分;编译事实(bbl/bib 解析)作为真值兜底。
   - xref:`\eqref/\autoref/\ref` 渲染为编译编号,kind 感知样式(如 `(1.1)`、`equation 1.1`、`Figure 2`),模板可声明风格。
   - 公式编号:display 公式渲染携带编译编号(草稿期占位语义另定)。
   - 模板模型升级:citation/xref 风格进 template schema(本阶段 template 不可覆写序列化的边界随之重审)。
3. **插入行为对齐**:References 插入改裸 key(对齐 xref);自动补全若落地,裸插入+补全组合重新定义"插入"语义。

## 待 grilling 的决策点(初步清单)

- 插入格式:裸 key 是否唯一形式;`\cite/\citep/\citet/\eqref/\autoref` 的输入辅助形态。
- citation 渲染语义:解析源(library.bib / library.json / 编译 bbl)、样式维度、模板字段设计。
- xref 显示格式与编号来源;公式编号在预览的显示位置与草稿期占位。
- 编辑器库选型(CodeMirror 6 vs 其他)与迁移范围(哪些 textarea 保留);依赖引入评估(MIT/体积/维护)。
- 自动补全范围(cite/label/命令)与触发交互。
- 渲染链路改造与既有 reader(tex-pipeline)知识的复用边界;是否影响 Stage 10 已冻结的存储契约(应不影响:manuscript.json/template JSON 保持)。
- 编号编译通道(D14)是否扩展到 bbl/cite 事实。

## 不受影响(Stage 10 已锁定,未被推翻)

- manuscript/template 的 JSON 文件契约与 agent 协作接口;导出 zip 形态;编号编译通道本身;UI 骨架(三栏/列表/modal)。
- 文献库只读引用关系;CLI 冻结面(writer 无 CLI)。
