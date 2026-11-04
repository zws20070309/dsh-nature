# nature-skills 全套 Skill 消化文档

> 供「论文写作 agent 预设 + DSH 插件」构建使用。
> 依据：上游仓库 <https://github.com/Yuan1z0825/nature-skills> 的 `skills/nature-*` 目录（已逐个核对文件清单）。
> 共 23 个可触发 skill + 1 个内部共享包 `nature-shared`（与该仓库 README 的技能索引同口径）。本文所有结论均来自对各 SKILL.md 及其 references/scripts/assets 的实读，未读部分不写。

---

## a. 全景分类

| 类别 | Skill | 一句话定位 |
|---|---|---|
| **写作类（4）** | `nature-writing` | 从作者证据起草/重构 Nature 风格手稿章节与首次投稿材料 |
| | `nature-polishing` | 只动语言的润色/翻译/精简 + LaTeX 排版修复，不改事实与论证 |
| | `nature-proposal-writer`（触发名 researchwrite） | proposal-first 状态机：先建证据/论证/契约，再写开题报告与申请书 |
| | `nature-social-science` | 社科选题论证工作台：兴趣→问题→证据→新颖性攻击→可行性 |
| **文献类（9）** | `nature-academic-search` | 多源检索/引文核对/MeSH 策略/严格他引审计（自带 MCP server） |
| | `nature-citation` | 严格限定 Nature/CNS 期刊域的"分段补引用"检索与 RIS/ENW/Zotero 导出 |
| | `nature-ref-verifier` | 参考文献逐字段多源交叉验证（🔴🟡🟢分级 + Zotero 修正指令） |
| | `nature-downloader` | 合法获取全文：OA / 出版商 API / CNKI / 机构浏览器四路由 |
| | `nature-literature-pipeline` | cron 驱动的每日文献发现管线：检索→六维评分→精读→推送→归档 |
| | `nature-reader` | 生成带 source-map 锚点的中英对照全文 Markdown reader |
| | `nature-paper-xray` | 单篇论文"白板级"深读：还原作者真实路径与证据边界 |
| | `nature-paper-card` | 固定 16 节、带页码锚点与审计脚本的论文精读卡 |
| | `nature-paper-trans` | 英文 PDF 逐页生图翻译为保版式的中文图片型 PDF |
| **数据与实验类（3）** | `nature-data` | Data/Code Availability 声明、仓储方案与 FAIR 审计 |
| | `nature-statistics` | 统计报告审查/改写：实验单位、n、不确定性、图注统计 |
| | `nature-experiment-log` | 图片/语音/文字→带 YAML frontmatter 的标准实验日志（Obsidian 可选） |
| **绘图类（1）** | `nature-figure` | Python/R 投稿级绘图 + 多面板对齐门 + PDF 碰撞审计 + AI 示意图路由 |
| **转换与交付类（4）** | `nature-paper2word` | Markdown→期刊/学位论文规范 Word（OMML 公式、三线表、CSL 引文） |
| | `nature-paper2ppt` | 论文→中文文献汇报 PPTX（9 步流程 + PPTX 质量审计） |
| | `nature-image2ppt` | 幻灯片图片/扫描 PDF→对象级可编辑 PPTX（页级状态机重建） |
| | `nature-paper-to-patent` | 论文→中国发明专利草稿/技术交底书（证据锚定 + DOCX 打包） |
| **审稿与回应类（2）** | `nature-reviewer` | 模拟 3 份互盲审稿报告 + 1 份综合，含法证一致性审计 |
| | `nature-response` | 返修邮件解析→逐点回复/cover letter/标红稿/LaTeX 返修包一致性 |
| **内部共享（1）** | `nature-shared` | 禁止独立调用的共享参考库：写作公理、语料规则、期刊格式、一致性扫描 |

---

## b. 逐 Skill 卡片

> 通用架构说明（多数 skill 共用，下文卡片不再重复）：采用 **static/dynamic 分层 + manifest.yaml 按轴路由**。`always_load` 是每次必读的 stance/workflow/output 层；`axes` 是运行时检测的维度（paper_type/section/language/journal/backend/source_format 等），每个轴值映射到 `static/fragments/` 下一个片段文件；`references/` 是按需加载的深参考。执行时先报一行"检测到的轴值"供用户廉价纠错。以下卡片只写各 skill 特有的内容。

### 1. nature-writing（v1.5.0，README 标 Draft）

- **用途**：从作者提供的证据起草或重构手稿章节、论证与首次投稿材料；不做语言级润色（→ polishing）、不做返修信（→ response）。
- **触发**：论文写作、章节起草、论证重构、正文压缩、首次投稿材料（cover letter/title page/highlights/declarations/reviewer suggestions）。
- **轴**：`task`（manuscript / submission-package）、`paper_type`（research/methods/hypothesis/algorithmic/review）、`section`（8 节，可多选）、`language`（en / zh-to-en）、`journal`（nature / nature-family / nat-comms / nat-mach-intell / generic）——见 `nature-writing/manifest.yaml`。
- **核心流程**（SKILL.md Routing protocol 5 步）：① 读 manifest + always_load（4 个 shared 文件 + 本地 stance/workflow/output-format）→ ② 检测轴值并报给用户 → ③ 只加载命中的片段（明确禁止全量读 static/）→ ④ 按"stance→paper_type→section→task→journal→language"优先级起草；Results/正文压缩必须先读 `../nature-shared/core/main-text-discipline.md`；Nature 系目标按节加载 `nature-introduction/abstract/results-discussion`，Discussion 另加 `discussion-argument-language.md` → ⑤ 按需进 references/（示例库、paper-review 自审、submission-package 等）。
- **依赖**：nature-shared（硬依赖）；无强制脚本/MCP；证据缺失写占位符并列 `Assumptions or missing inputs:`。
- **输出**：草稿正文；`task=submission-package` 时产出投稿材料矩阵与 readiness audit。
- **衔接**：下游 polishing/response/figure/reviewer；与 shared journal-formats 对接封面级格式要求；投稿前自审交 `references/paper-review.md` 或升格给 nature-reviewer。

### 2. nature-polishing

- **用途**：对既有学术散文做润色/中译英/精简/LaTeX 排版修复，保持事实、术语与证据边界不变。
- **触发**：润色、学术翻译、正文精简、排版（"Float too large" stranded heading 等布局问题）。
- **轴**：paper_type/section/language/journal（无 task 轴）。
- **核心流程**：① manifest + always_load（含 `core/failure-modes.md`）→ ② 检测轴 → ③ 加载片段 → ④ 按"paper type→section job→段落逻辑→claim/evidence/boundary→句子"顺序修；结构性问题不能靠编造内容解决时必须 flag → ⑤ 按需 references（phrasebank、nat-comms 2025 语料等）。
- **特殊分支**：**排版请求跳过全部散文轴**，直接读自包含的 `references/latex-layout.md`（render→contact-sheet→读日志，浮体 glue、`[H]`/`\clearpage`/`placeins`、"宽图在源头重新生成更高"规则），前后必须编译并目检。全文一致性审计走 `../nature-shared/core/consistency-sweep.md`。
- **依赖**：nature-shared；无强制脚本。
- **输出**：修订文本；全文审计时的漂移清单。
- **衔接**：接受 writing 的草稿；向 response 输送修订后的手稿文本；与 writing 共享同一套 shared always_load 文件（见 nature-writing manifest 与 polishing manifest 对比）。

### 3. nature-proposal-writer / researchwrite（Beta）

- **用途**：研究计划/开题报告/申请书的起草、修订与 QA 审查；proposal-first 而非"帮我写论文"。
- **触发**：researchwrite、proposal、开题报告、研究方案、科研写作 QA。
- **核心流程**：① 模式分派 compose/revise/hybrid（模糊时推断默认）→ ② 建立项目结构 `<outputs>/researchwrite/<slug>/`：00_scope→01_research_canon→02_evidence_table→03_argument_map→04_section_contracts→05_style_guide + state.json → ③ 各模式加载对应 references（compose-mode 9 步 / revise-mode 9 步）→ ④ Gate 顺序：证据→论证→契约→段落→专家（professor 按失败模式动态召唤）→ anti-slop → 语言 → ⑤ 导出 `.md`+.docx（`scripts/build_proposal_docx.py`）。
- **QA 模式**：4 层 Gate——Gate2 professor 内容审查 → Gate1 avoid-ai-writing detect-only（仅英文）→ Gate3 auto-validation（claim 有引用/方法可复现/编号连续）→ Gate4 八维评分阈值（paper/proposal 7.0、internal 5.0、quick 无）；低于阈值按低分维度回退，≤3 轮。**Gate2 必须在 Gate1 前**。
- **依赖**：professor/avoid-ai-writing 等 skill（引用但非硬依赖）、python-docx 导出脚本。
- **输出**：foundation 文件、草稿、qa_logs、exports。
- **衔接**：开题→写作的选题素材可来自 nature-social-science；文献证据来自 nature-academic-search。

### 4. nature-social-science（Draft）

- **用途**：社科选题论证工作台：把兴趣变成可辩护的研究问题，做文献版图、新颖性审计、可行性评估与表述纪律自检。
- **触发**：找题目/research question/文献综述/开题/过度断言检查。
- **核心流程**（8 步，每步有 PASS/REVISE/STOP(+PARK) Gate）：1 搜索空间→2 领域版图→3 未决问题卡(3-7)→4 证据地图+claim ceiling→5 候选 RQ(6-12 张)→6 Novelty Audit+Reviewer-2 攻击→7 博士可行性→8 最终短名单(≤3 Topic Cards)。入口 Mode A(只有兴趣)/B(宽泛主题)/C(已有暂定 RQ，走 audit route)。
- **关键约束**：四条铁律（未知写"未知"、主动找反证、保留证据层级、每步更新 Current Research State）；五套状态系统禁止合成一个分数；十二条"不要混为一谈"判断表；提示词唯一权威版是 `references/05-prompt-library.md`。
- **依赖**：纯文本工作台，无脚本/MCP；9 个 references 按步骤加载。
- **输出**：worksheets 表格、Topic Cards、Current Research State。
- **衔接**：上游可选 nature-academic-search 查文献；产出 RQ 交 nature-proposal-writer 或 nature-writing 展开；与 nature-reviewer 的"审稿人攻击"互为轻/重两档。

### 5. nature-academic-search（Beta，v2.0.0）

- **用途**：跨源文献检索、引文核对、MeSH 策略、引文文件管理、严格他引审计与高影响力引用者画像。
- **触发**：search papers / 查文献 / verify DOI / 严格他引 / 引用我的人有没有大牛。
- **轴**：单一 `workflow` 轴 6 值：multi-source-search / citation-verification / mesh-strategy / citation-file-mgmt / reference-mgmt / strict-other-citation-impact-audit（可多选）。**离线引文文件转换无需联网/API 设置**（SKILL.md 开头特例）。
- **核心流程**：① manifest + always_load（`static/core/tools.md` MCP 工具清单 + `routing-and-ops.md` T1→T2→T3 源路由/环境/错误处理）→ ② 映射 workflow → ③ 读对应 `references/workflows/wf1..wf6.md` → ④ 执行：T1→T2→T3 降级链、去重、失败续跑其余工具、脚本连败两次改为用 MCP 元数据手工生成 → ⑤ 按需进共享模块（dedup/citation-parser/ris-bibtex）与脚本。
- **依赖**：**自带 MCP server** `mcp-server/academic_search_server.py`（FastMCP，sources: CrossRef/PubMed/arXiv/Scopus/ScienceDirect；`config/mcp-snippet.json` 用 `uv run` 启动，依赖 mcp/requests/toml/lxml/pybliometrics/defusedxml）；无 MCP 时脚本兜底 `scripts/academic_search.py`（OpenAlex/stdlib）、`scripts/format-converter.py`、`scripts/preflight.py`。
- **输出**：检索结果、`.nbib/.ris/.bib`、引文验证报告、引用指标表、citer 画像。
- **衔接**：为 writing/citation/paper-card 的外部核查供数；与 nature-citation 分工（本 skill 不限期刊域，citation 限 Nature/CNS）；与 literature-pipeline 互补（一次性 vs 每日自动化）。

### 6. nature-citation（Beta）

- **用途**：为手稿论点检索**严格限定 Nature/CNS 家族**的支撑文献，做 claim→source 映射并导出文献管理器文件。
- **触发**：Nature 系引用、CNS 支撑文献、分段补引用（明确"不限域检索走 academic-search"）。
- **核心流程**（七步，`static/core/workflow.md`）：分段→解析 claim→检索→保守评估支撑度→校验完整结构化作者元数据（DOI 缺 given name 时按 PMID 重取或对出版商核验，禁止姓氏-only AU）→导出单一 reference-manager 文件→按需生成 review 附件。>10 段走 `references/script-usage.md` 批处理策略。
- **依赖**：`scripts/nature_citation.py`（默认写 `.ris`；硬编码 Crossref API + PubMed E-utilities，无第三方依赖要求即纯 urllib + defusedxml）；运行时参数 `--scope`（Nature系列/CNS/CNS及子刊/flagship-only）；中文用户读 `static/core/chinese-mode.md`（中文说明+英文检索式）。
- **红线**：标题相关≠支撑；未读摘要/出版商页不得引用；不编造书目字段。
- **输出**：`.ris`（可 ENW/Zotero RDF）、review 工件。
- **衔接**：产出的 BibTeX 供 nature-paper2word 的 `bibliography:` 消费（见 paper2word SKILL.md §8 表）；文献发现上游是 academic-search/literature-pipeline。

### 7. nature-ref-verifier（Stable）

- **用途**：参考文献逐条多源交叉验证，字段级对比作者/标题/年份/卷期/页码，输出分级报告与修正补丁。
- **触发**：verify references / 校验文献 / check references / 文献验证 / ref check。
- **核心流程**（5 步）：① 解析输入（整篇 `[N]` 列表 / 单条 / .bib）→ ② **Step 2.0 最先做最便宜的 Crossref DOI 可解析性检查**（404=错号；200 但字段不匹配=DOI 张冠李戴——实测 35 条中 7/9 错误属此类）→ 并行查 Crossref/IEEE Xplore/WebSearch/CNKI-万方/Zotero → ③ 字段级对比矩阵（🔴 Critical 7 项 / 🟡 Warning 6 项 / 🟢 Info 3 项，全部附真实案例）→ ④ 置信度四级（Verified/Check suggested/Needs fix/Unverifiable）→ ⑤ 输出 Markdown 摘要 / BibTeX Patch / Zotero 修正指令。
- **批量策略**：>20 条拆 10-15 条/组给并行子代理（35 条实测 3 个子代理一轮完成）。
- **Zotero 写入实测限制**：本地 HTTP API(23119) 只读（写 501）；批量写首选 pyzotero Web 模式（需 userID+API key）；无 key 用 `/connector/saveItems` 只能新增；直改 zotero.sqlite 仅最后手段。
- **依赖**：可选降级链 pyzotero[cli] / zotero-cli / zotero-mcp / kimi-datasource / kimi-webbridge / WebSearch。
- **输出**：验证报告 + 修正文件。
- **衔接**：投稿前终检；接审稿人指出引用错误的定位；与 nature-citation 的"导出后校验"互补；为 paper2word 投稿包提供 `.bib` 质检。

### 8. nature-downloader（Beta）

- **用途**：合法获取学术全文/PDF/SI：OA、出版商 API、CNKI、机构浏览器（Web Access）四路由。
- **触发**：download papers / 图书馆下载文献 / CARSI / WoS / PDF 下载。
- **硬门**：**SI 确认门**——跑脚本必须带 `--si` 或 `--no-si` 之一，否则返回 `si_confirmation_required` 不建目录（SKILL.md 顶部强制）。
- **核心流程**：① 规范化 DOI/题名、识别语言与出版商 → ② 中文文献一律 CNKI（复用用户 Chrome 登录态，优先配置 `discovery.cnki_url`）→ ③ 英文 Elsevier/Springer/IEEE 且有 Key：API 优先（成功记 `oa_status: not_checked_api_first`，不补 OA 判定），失败自动查合法 OA（PMC/Unpaywall/arXiv），两者皆败才请求确认走 Web Access → ④ 其他出版商：先 OA 后 Web Access → ⑤ 机构路由需要用户本人已登录的 Chrome + CDP（`chrome://inspect/#remote-debugging`；web-access-main `check-deps.mjs` 代理 127.0.0.1:3456）→ ⑥ `scripts/batch_download.mjs` 批处理，写 `<project>/manifest.json`（route/OA 证据/MIME/SHA-256/typed failures），PDF→`PDFs/`、CAJ→`CNKI/`、SI→`SupportingInformation/`。
- **配置**：`python3 scripts/configure_school.py infer|url|show|health`（默认 `~/.config/lit-dl/school.json`，**不含学校预设**，必须从用户真实资源 URL 推断）；`scripts/configure_credentials.py set|validate|delete elsevier|springer_nature(三服务分离)|ieee`（密钥 `--stdin`，0600，禁止让用户往聊天里贴 API key；用户主动给了则视为授权保存该 key）。
- **边界**：不绕付费墙/DRM/2FA；验证码先自动尝试（≤2 次）再交接用户；不读不导出 cookie/密码；30+ 状态码语义（`carsi_waiting_user`、`verification_auto_failed` 等都不是终态失败）。
- **依赖**：Node.js 22+、Python 3（pdfplumber/pypdf/PyYAML/jsonschema）、用户已登录 Chrome、CDP 代理。
- **输出**：PDF/HTML/CAJ/SI 文件 + manifest.json。
- **衔接**：为 reader/xray/card/trans 提供全文输入；上游配合 academic-search 的检索结果。

### 9. nature-literature-pipeline（Stable）

- **用途**：cron 驱动的每日文献发现管线：多源检索→六维评分粗筛→精读→格式化推送→归档。
- **触发**：literature pipeline / 每日文献 / 文献推送 / daily literature push。
- **核心流程**：① SEARCH 30 候选（arXiv/OpenAlex/Crossref/Semantic Scholar，自动降级）→ ② COARSE FILTER 30→5（六维加权：Topic 35 + Methodology 20 + Journal 15 + Network 10 + Applied 10 + Archival 10；每维封顶、总分重算不信任子代理算术；Topic<10 一票否决）→ ③ FINE READ top5（标注全文/仅摘要/仅元数据三级来源）→ ④ DELIVER Feishu/Telegram 模板（🏅排名|⭐分|💡一句话|🔬方法|📊关键结果|🧭点评）→ ⑤ ARCHIVE（DOI/arXiv/OpenAlex 三重去重→分级→写笔记→更新索引）。
- **安全设计**：三层架构（engine 评分/分类/笔记模板 vs application cron/推送/归档）；每日管线只写 `raw/`，改 wiki 需用户批准；配置项 keywords/权重/分级/推送目标/归档路径全部可调（`templates/literature-push-template.md`）。
- **依赖**：cron（Hermes 本地 cron，机器须开机）、各搜索源 API、消息平台（可选 feishu）。
- **输出**：每日推送消息、文献笔记、去重索引。
- **衔接**：发现的好文交 nature-citation 入稿、交 reader/xray 精读；与 academic-search 互补关系已在其 SKILL.md "Related Skills" 声明。

### 10. nature-reader（Beta，v2.1.1）

- **用途**：生成带 source-map 锚点的中英对照全文 Markdown reader（图文表公式对齐）；也服务来源锚定的单点问答与节选翻译。
- **触发**：全文翻译、中英对照、论文精读、对论文的 source-linked 提问。
- **轴**：`source_format` 5 值：pdf-text / scanned-pdf / html / doi-arxiv / pasted-text（一个源可映射多值，先解析再读产物片段）。
- **核心流程**：① 先分流"建 reader / 答问题 / 译节选"——问答只读 `references/grounding-rules.md` 且复用已有 source-map ID，不重建 → ② manifest + always_load（原则/六步流程/输出契约 + shared terminology-ledger）→ ③ 检测 source_format → ④ 加载对应片段（提取文本/图表）→ ⑤ 建 `paper.md` + `source_map.json` + `translation_notes.md`，边译边建术语账本 → ⑥ 交付前跑 output-contract 的预响应校验清单。
- **依赖**：nature-shared（terminology-ledger）；PDF/OCR 能力按环境；无强制脚本。
- **输出**：paper.md（双语对照+图位+公式）、source_map.json（稳定块 ID）、translation_notes.md。
- **衔接**：**其 source-map 是 nature-paper-card 的首选输入**（paper-card SKILL.md 明示"prefer an existing nature-reader artifact"）；图提取规则可与 figure 的 asset-adaptation 呼应。

### 11. nature-paper-xray（Beta）

- **用途**：把一篇论文读到能复述作者的真实推理路径：起点与下注、承重设计与装饰、公式配数值微例、证据边界。
- **触发**：精读论文、讲透这篇、作者为什么这么设计、这个公式怎么推、paper x-ray。
- **核心流程**（7 步）：① 全源通读（含附录/脚注/图注/补充材料；正文与附录矛盾记为发现）→ ② 重建研究路径（第一张图通常承载赌注）→ ③ 区分承重/装饰（引消融或明写"论文没做此对照"）→ ④ 数学落地（每个符号给形状含义，关键公式配能算到底的微例，见 `references/deep-reading-protocol.md`）→ ⑤ 证据边界检查（`references/evidence-boundary.md`：基线公平性、测试集调参、泄漏、成本）→ ⑥ 保留 hedges 强度（"may"≠"does"；未报告就写未报告）→ ⑦ 交付 Markdown long-read（章节式摘要是失败模式）。
- **论文类型适配**：algorithmic 重公平比较、methods 重可复现、hypothesis 重因果排除、research 重外推、review 重分歧——类型不明时读 `../nature-shared/core/paper-type-taxonomy.md`。
- **依赖**：仅 2 个 references + shared taxonomy；无脚本/MCP。
- **输出**：结构化 Markdown 长读（默认）；公式 `$...$`/`$$...$$` 不得进代码块。
- **衔接**：明确边界：不打分（→reviewer）、不翻译（→reader）、不检索（→academic-search/citation）、可作 nature-writing 定位章节的输入。

### 12. nature-paper-card（Beta）

- **用途**：单篇论文→固定 16 节、证据约束的精读卡（方法逻辑、实验-结论证据链、边界、可检验研究想法）。
- **触发**：论文精读卡、方法拆解、证据链分析。
- **核心流程**（6 步）：① manifest+always_load → ② **源边界与定位器状态机**：page-grounded（脚本成功验证 PDF 页码）/ structure-grounded（页提取不可靠但结构可靠，禁页码引用）/ source-limited（仅摘要/元数据）；PDF 或 source-map 输入**强制跑捆绑脚本** `scripts/prepare_paper.py INPUT --output WORKDIR/source_bundle.json`（可加 `--render-dir`），禁止现场写 Python/一次性替代脚本 → ③ 分类 paper_type（6 值，主+至多 1 副 lens）→ ④ 先建证据清单+claim-evidence 矩阵再动笔；外部检索仅限 04/15 节与书目核查 → ⑤ 生成固定 01-16 节卡片（缺料写 `Not assessable from supplied material`）→ ⑥ QA：`scripts/audit_paper_card.py --card ... --bundle ... --locator-mode ...`，audit error 是阻断项。
- **依赖**：两个捆绑 Python 脚本（prepare_paper / audit_paper_card）；nature-reader artifact 优先。
- **输出**：paper-card.md + source_bundle.json + audit-report.json。
- **衔接**：reader→card（复用 source map）；外部核查→academic-search；正式审稿→reviewer；成品是 PPT→paper2ppt。

### 13. nature-paper-trans（Beta）

- **用途**：英文论文 PDF 指定页/全文逐页生图翻译为保留源版式的简体中文**图片型 PDF**；只交付中文 PDF。
- **触发**：论文翻译、翻译论文 PDF。
- **核心流程**：① `pages.py prepare --pdf --pages --work-dir`（默认 240 DPI 渲染源页）→ ② 保存通用生图提示词到 `$JOB/generation-prompt.md` → ③ 并发生成：每页 `reserve`→一次 `image_gen`→`record`；**每页整个任务只有 1 次生图机会，失败不返还、不自动重试/择优**；主智能体直接并发，≤10 个未结束请求 → ④ 逐页对照源页检查（正文/图表/公式/上下标/数值单位），记 `pass/issue/unknown` JSON，`review` 绑定原 attempt → ⑤ `assemble --pdf-only` 合并（默认保留源页尺寸方向比例，仅用户明示才 `--a4`）；有 issue/unknown 页须在交付时列明，不自动补生图。
- **异常续跑**：以 `task.json`/`status` 为准；`recoverable_output` 补录 record 不算失败；缺页用 `assemble --allow-partial` 生成标注 partial 的 PDF。
- **依赖**：内置 `image_gen` 工具（唯一生图通道）；Python 3.9+ / PyMuPDF / Pillow（`scripts/pages.py`）；macOS/Linux/WSL2/原生 Windows。
- **输出**：一个中文图片型 PDF（无检查 Markdown/JSON/预览图）。
- **衔接**：与 reader 的区别是"保版式的阅读副本"vs"可检索的对照 reader"；不用于可编辑 Word（→paper2word）。

### 14. nature-data（Draft）

- **用途**：起草/审计 Data/Code Availability 声明、数据访问路线、仓储计划与 FAIR 元数据。
- **触发**：数据可用性声明、数据共享、数据仓库选择、dataset citations。
- **核心流程**（8 步）：识别期刊→盘点全部支撑数据集→每个数据集归入 7 类访问路线之一（公共仓储/受控访问/论文内/复用公共/第三方受限/正当请求/不适用）→先定仓储与标识符策略→起草 dataset-to-location 映射的声明→加正式 dataset 引用→FAIR/元数据审计→返回可粘贴文本+未决字段。单条声明的措辞编辑走轻量路径，不做全研究盘点。
- **红线**：不发明 DOI/accession/仓库名/许可/embargo/伦理批准；"available upon request"无具体限制理由视为弱声明。
- **依赖**：无脚本；Nature 目标读 `references/nature-article-requirements.md`；NMI 目标读 `../nature-shared/journal-formats/nature-machine-intelligence.md`（强制 Data Availability + 其后 References 前 `Code availability` 节）。
- **输出**：可粘贴声明 + FAIR 审计结果（中文用户附中文核对块）。
- **衔接**：writing 的 submission-package 与 response 的返修都会调用它的产物；与 statistics 同属"投稿合规双件套"。

### 15. nature-statistics（Draft）

- **用途**：审查/改写/起草手稿统计报告：实验单位、重复数、不确定性、检验、图注统计；仅当用户给数据并明示时才做新计算。
- **触发**：统计审查、统计方法小节、图注统计、reviewer 统计质疑。
- **核心流程**（9 步）：分类任务→提取设计（分组/处理/时点/随机化/盲法/排除）→**定义 n 与重复**（独立实验单位为默认 n，细胞/视野/技术重复不得充当生物学重复）→claim→analysis 映射→查常见失败模式（`common-failure-modes.md`：嵌套/多重比较/交互/相关回归/离群/小样本/significance-only）→查报告完整性（Nature 目标加 `nature-article-requirements.md`，NMI 加 shared NMI 格式）→图注统计对齐（`figure-statistics.md`）→保守起草→`reviewer-checklist.md` 终检。
- **红线**：不发明 p 值/样本量/软件版本/校正方法；"significant"≠重要/大/因果；缺料标 `AUTHOR_INPUT_NEEDED`。
- **输出**：固定格式报告（scope/Major issues P0-P1-P2/Ready-to-paste 修订/AUTHOR_INPUT_NEEDED/审稿风险注）。
- **衔接**：reviewer 的统计类意见可直接喂给它做回应支持；图注统计与 nature-figure 的 qa-contract 呼应；跨章节数值一致性走 shared consistency-sweep。

### 16. nature-experiment-log（Draft）

- **用途**：把上传/本地/飞书群的实验图片、语音、文字整理为带 YAML frontmatter 的标准 Markdown 实验日志并归档原始材料。
- **触发**：实验日志、记录实验、experiment log（用户提交实验材料时自动加载）。
- **核心流程**（8 步）：接收材料（上传/本地路径/飞书群）→ vision_analyze + 文本解析提结构 → 缺失模糊字段**问用户不猜** → 确认输出方式与目录，生成实验 ID（`{体系}-{设备}-YYMMDD-{序号}`，设备码 M/T/E/G/F/B）与样品批次 ID（`{体系}-{候选}-B{序号}`）→ 写 `实验日志/{体系}/{类型}/{exp_id}.md` → 原件归档 `raw/experiments/YYYY.MM.DD_描述_EXPID/` → 更新实验索引/异常记录 → 告知文件位置。
- **依赖**：核心流程零外部依赖；可选 Obsidian（3 个模板：experiment-index/anomaly-log/equipment-tracking，配 Dataview）；可选飞书 `feishu-cli-integration`（bot 需 im:message 等权限；`--output` 只收相对路径）。
- **输出**：Markdown 日志 + raw 归档 + 索引/异常/设备追踪三表。
- **衔接**：日志是 writing 的 Experiments 素材源与 statistics 的设计信息源；与 literature-pipeline 同属"日常科研流水线"风格（同一作者 Jiahao8595）。

### 17. nature-figure（Stable，v2.8.0）

- **用途**：创建/修订/审计/导出投稿级科研图（Python 或 R）；含 AI graphical abstract、OpenRouter 生图、手绘 SVG 示意图三条特殊路由。
- **触发**：论文配图、科研绘图、多面板图、投稿级 plot；AI 示意图须用户明示。
- **三条前置路由**（先于 Python/R 门）：① AI graphical abstract → `references/ai-graphical-abstract-workflow.md`（brief/构图/调色/政策门/人类科学审/披露/溯源）；② OpenRouter/GPT Image 2 生图 → `references/openrouter-image-generation.md` + `scripts/generate_openrouter_schematic.py`，产物是草稿不是定量面板；③ 手绘可编辑 SVG 示意图 → `vector-schematic-workflow.md` + `vector-schematic-style-rules.md`，画前确认 brief，交付前跑 `scripts/audit_svg_schematic.py`。
- **绘图流程**：① manifest + always_load（contract + stance）→ ② **backend 阻断门**：显式选择→语言特异输入→本任务既定→保存的偏好（`scripts/nature_figure_backend.py get/set`，存 `~/.config/nature-skills/nature-figure.json`）→都没有才问一次"Python or R? I will remember this as your default."；选定后后端**独占**全部绘制/预览/导出/QA → ③ 只加载所选 backend 片段 → ④ 按 contract（先写核心结论与证据链再写代码）→ multipanel 证据架构 → stance → backend quick-start → asset-adaptation → ⑤ **渲染时 QA 链**：多面板对齐门（`scripts/audit_panel_alignment.py` 的 `require_matplotlib_panel_alignment()` / R 用 `panel_alignment.R`，容差 1.5pt，exit 1=FIX BEFORE DELIVERY、exit 2=NOT AUDITABLE 均阻断）→ `validate_figure.py` 查源码 → `audit_pdf_text.py` 查导出 PDF → `audit_figure_collisions.py`（**每次改动后强制重跑**，PyMuPDF）→ 最终物理尺寸逐面板目检。
- **期刊规则**：Nature 目标读 `references/nature-article-requirements.md`；NMI 目标读 shared NMI 格式（主文 6 项/Extended Data 10 项、300dpi/180mm、图注 <300 词历史建议值）。
- **依赖**：Python: matplotlib/seaborn；R: ggplot2/patchwork/ComplexHeatmap；PyMuPDF>=1.24（requirements.txt）；可选 OpenRouter key。资产：10 张 chart-atlas、figures4papers 第三方示例（THIRD_PARTY_NOTICES）、gallery 5 张、plot_templates.py 模板。
- **输出**：图源码 + PDF/PNG + 对齐 JSON + 碰撞审计 JSON/标记 PDF。
- **衔接**：接受 writing 的结果结构与 statistics 的图注统计；AI 示意图与 paper2ppt/paper-card 的配图可联动；图注规范与 shared NMI/nature 格式文件对齐。

### 18. nature-image2ppt（Beta）

- **用途**：把幻灯片图片/截图/扫描 PDF/图片型 PPTX 重建为**对象级可编辑** PowerPoint（非从笔记新建 deck）。
- **触发**：图片转可编辑 PPT、截图还原 PPT、diagram reconstruction。
- **核心流程**：① `cli.py doctor --json`（失败必须修完再继续）→ ② `prepare <input...> --out-root ... --image-backend builtin-imagegen|openai-compatible-api`（builtin-imagegen 优先：agent 有 `image_gen.imagegen` 时；OCR 优先 Baidu Paddle `PADDLE_OCR_TOKEN`，无则告知 builtin-ink 只测几何不识字）→ ③ `run next` 领页→`build_page_worker_prompt.py` 生成 worker prompt→`run dispatch`（多页派独立 worker，单页 `--local`）→ ④ 页重建：3-5 语义区域分区路由；薄箭头=连接线+箭头头同对象，实心箭头=单个 Arrow AutoShape 内嵌文字；manifest `schema_version: 2`；**公式渲染是硬门**（缺引擎除非用户明示例外并记录 `user_approved_exception`）→ `page build` → `run_image2ppt_qa.py`（首跑写 visual-review 证据模板，补齐 evidence 后 `--visual-review-status reviewed` 复跑）→ `page contact-sheet` → `run record` → ⑤ `run finalize` → `run_final_image2ppt_qa.py`（重放 manifest 箭头、原子性、逐页渲染、speaker note 完整性）。
- **硬约束**：`page_jobs.json` 是唯一页状态源、`pages/page_NNN/manifest.json` 唯一页内容源、`deck_manifest.json` 唯一装配源；禁止第二份 job 文件/重建计划/打包路径；一切写操作锁在各自页目录（路径逃逸=硬失败）；QA 可报失败但不得改生命周期状态。
- **依赖**：Python 3.10+；requirements：pypdfium2/Pillow/numpy/requests/PyYAML/openai/defusedxml；可选 Paddle OCR token、OpenAI 兼容生图 API。
- **输出**：可编辑 .pptx + `final/image2ppt_qa.json`；报告哪些复杂视觉仍是位图占位。
- **衔接**：与 paper2ppt 互补（重建 vs 创作）；还原的学术图可回流 nature-figure 修订。

### 19. nature-paper2ppt（Beta）

- **用途**：从论文/精读笔记生成或改进**中文**学术汇报 PPTX，含源图与 speaker notes。
- **触发**：论文做 PPT、文献汇报、组会 PPT、会议/答辩汇报。
- **核心流程**：① manifest + always_load（principles/toolchain/workflow 9 步/output-and-quality + **shared terminology-ledger**）→ ② 分类 paper_type（discovery/methods/resource/clinical/materials/review，决定叙事弧）→ ③ 加载对应片段 → ④ 读源时同步建术语账本 → ⑤ 真实 `.pptx` 为最终产物（只给大纲不算完成）→ ⑥ 有 pptx 必跑 `scripts/audit_pptx_quality.py`，high-severity 是阻断项，修完重跑并记 `output/qa_report.md`。
- **依赖**：cross-platform Python-first 工具链（core/toolchain.md）；nature-shared。
- **输出**：.pptx + qa_report.md。
- **衔接**：优先消费 reader/card/xray 的笔记与 figure 的成图；改既有 deck 时复用原叙事与资产，改后重跑 audit。

### 20. nature-paper2word（Beta）

- **用途**：把学术 Markdown 稿件编译为期刊/学位论文规范的 `.docx`：声明式排版、OMML 原生公式、三线表、题注、公式交叉引用、分节页码、CSL 参考文献目录（GB/T 7714、APA、Nature、IEEE）。
- **触发**：论文转 Word、学位论文排版、期刊投稿排版、submission docx。
- **关键事实**：**本 skill 只带文档，引擎是 pip 包 `md-to-word-docx`**；会话首次导出前必须 `md-to-word --version` 确认可用；完整词汇表在包内手册（`md-to-word --contract` 打印路径）。
- **核心流程**：① 先定场景（期刊/学校规范→建 requirements 文件；已有规范 `-r` 传入；无规范→内置 preset，中文稿 `zh-academic`、其他 `en-nature`；无 `-r` 时只认手稿旁名为 `format.txt` 的文件）→ ② 把稿件规范到输入契约（`%% 样式` 行、一行一段、`$$...$$ {#eq-name}`、`[@key]` 引用必须配 `bibliography:`、`{{< pagebreak/toc/section >}}` 块标记；不支持的 Markdown 一律阻断并给替换写法）→ ③ 选/建格式要求（`md-to-word init` 起步；`md-to-word-template target.docx -o format.txt` 逆向）→ ④ `md-to-word manuscript.md -o manuscript.docx`（管线：preflight→样式模板→稿件模型→OOXML→数字完整性→逐行审计）→ ⑤ 读双级 gate：Blocking（丢内容/语法原样打印/格式未映射/YAML 里放标题）vs Warning（图超宽被钳、题注远离图、跳级标题）→ ⑥ 交付前核验：exit 0、报告所用 preset 与引文样式、声明仍需在 Word 里人工目检；有目录/分节页码时用 `--pdf`（macOS+Word）展开域。
- **依赖**：`pip install md-to-word-docx`（上游 github.com/ls-open/md-to-word）；`.bib` 必需。
- **输出**：.docx（可选 PDF 校样）；`--json` 供程序读回。
- **边界**：不做封面/合并单元格/多栏/文字绕图/图号表号交叉引用；限度和症状→修复见手册 §6/§8。
- **衔接**：SKILL.md §8 关系表——上游 nature-writing（稿）与 nature-polishing（语言）、nature-citation（参考文献导出 BibTeX）、nature-ref-verifier（投稿前核校）、nature-paper2ppt（同一稿件转 deck）。

### 21. nature-paper-to-patent（Beta）

- **用途**：论文/发明人材料→证据锚定的中国发明专利草稿与技术交底书（权利要求书、说明书、摘要、附图，DOCX 包）。
- **触发**：论文转专利、技术交底书、现有技术对比、权利要求集。
- **轴**：source_format（PDF/扫描 PDF/粘贴文本/混合项目）× task_mode（full draft/claim set/disclosure analysis/technical disclosure/disclosure iteration/paper-patent audit）× invention_type（算法软件/装置系统/工艺材料/混合）。
- **核心流程**：① manifest+always_load，报轴值 → ② 建**稳定源 ID**（P=正文块/E=公式/F=源图/C=代码补充），formal claim 的每个实质性特征必须映射源 ID；支持状态仅 explicit/inherent/needs-confirmation/unsupported 四种，unsupported 不得入 formal claim；缺事实用 `[TO CONFIRM: ...]`；不推断发明人/权属/公开日/现有技术结论 → ③ 过 stage gates（source map→术语账本→清单→证据账本→发明构思）后才写 claim → ④ 先权利要求后说明书/图/实施例/摘要对齐；正式交付物**用中文**；算法发明公式转 OMML 原生 Office Math；主流程图从主权利要求步骤生成且末节点是具体领域输出，一图三用（主图/摘要图/说明书图）→ ⑤ 交付前 `python scripts/validate_patent_draft.py draft.json`（ERROR 必修）→ `python scripts/build_patent_package.py draft.json --output-dir outputs --prefix patent`；技术交底书走 `references/disclosure/` 自检 + `scripts/disclosure/mermaid_render.py`。
- **依赖**：自带 scripts（docx 渲染、math_to_omml、flowchart SVG、CNIPA epub 爬取解析等，`scripts/disclosure/requirements-cnipa.txt`）。
- **输出**：权利要求书/说明书/摘要/摘要附图 DOCX 包；技术交底书 Markdown+DOCX；标注 `incomplete draft` 当质量阈值不达标。
- **免责**：起草辅助工具，非专利性/侵权意见或授权保证。
- **衔接**：上游 reader/xray 提供精读；正文公式可源自 writing 的方法节；与 paper2word 共享"中文正式 DOCX"交付管线但 schema 完全独立。

### 22. nature-reviewer（Draft）

- **用途**：审稿人视角的模拟评审：3 份**互盲** reviewer 报告 + 1 份 post-review 综合。
- **触发**：模拟审稿、投稿前自审、审稿人视角评估（明确不做 rebuttal → response）。
- **核心流程**（10 步）：① 定输入范围与边界 → ② 构建**不可变评审包**（仅手稿事实+已验证锚点+共同标准，不含任何分析结论）→ ③ 先定义 reviewer 数与 emphasis briefs → ④ 每位审稿人在**真正隔离的上下文**运行（无法隔离必须明说，不得把共享上下文冒充互盲）→ ⑤ 各自独立按 5 轴评（originality / scientific importance / interdisciplinary readership / technical soundness / readability for nonspecialists）+ 12 轴技术关切分类法做内部覆盖清单 + 按域加载 domain-specific gates → ⑥ 冻结每份报告（自然重复/分歧是独立性的证据，不得修饰）→ ⑦ **冻结后**独立编辑跑 `references/forensic-consistency-audit.md`（算术/指标界限/聚合层级/图表一致性/散点异常/溯源），审计发现永不回流审稿人上下文 → ⑧ 单独综合 pass：≥2 份独立同关切才算共识 → ⑨ 生成综合（共识阻断项/其他 major/法证发现/Minor 清单/分歧）→ ⑩ QA 九项。
- **输出**：固定结构（Review setup / R1-R3 各含 Overall、 strengths、Major Concerns（每条带 Concern ID R1-M1、Blocking、Axis、claim pointer、evidence pointer、resolution test）/Minor Comments / Cross-review synthesis / Risk-unsupported claims）。
- **红线**：不编造审稿人身份；不发明实验/引用/行号；不凑意见配额；不把核心证据问题降级 Minor；不用 em dash/冒号做惯用连接。
- **依赖**：纯文本；`../nature-shared/core/consistency-sweep.md` 用于稿件自相矛盾检查。
- **输出**：审稿报告包。
- **衔接**：其 Major/Minor 清单是 nature-response 的直接输入；其发现可转 nature-statistics/nature-figure 修复任务。

### 23. nature-response（Beta）

- **用途**：起草/审计/修订审稿回复、返修 cover letter、标红稿与 LaTeX 返修包。
- **触发**：审稿意见回复、逐点回复、返修信、rebuttal（首投材料归 writing、模拟审稿归 reviewer）。
- **模式**：draft / audit / revise / triage-only / cover-letter / revision-package / latex-template / appeal-like；**decision type 必答门**（minor/major/R&R/transfer/unknown——从编辑信提取，仍不明才问，禁止从意见数量语气推断）。
- **核心流程**：① manifest + always_load（stance/workflow）→ ② 定模式与 readiness（`references/intake-and-routing.md`）→ ③ 粘贴的是期刊邮件则先解析元数据/决定类型/编辑指示/审稿报告/文件/期限/审稿人可见性 → ④ 编辑指示 `E.1`、审稿意见 `R1.1` 编号；逐条分类 response action 与独立核实状态；建内部/编辑两套 master tracker → ⑤ 为**互盲审稿人各写一份隐私过滤的独立回复**；审稿人漏看稿件已有材料=表述清晰度信号，改呈现而非回怼 → ⑥ 每条声称的修改映射到手稿位置或显式占位；改稿在备份副本上标红；回复信中引用的改后文字用斜体 → ⑦ 缺作者输入标 `AUTHOR_INPUT_NEEDED`；QA；按逐条状态推导包 readiness。
- **硬约束**：回复涉及正文修改时必须加载 `../nature-shared/core/main-text-discipline.md`（信里答全，稿上改动最短）；**绝不发明**实验/引用/行号/图面板/编辑指示；LaTeX 包在每次手稿改动后都要重跑 `scripts/check_package_consistency.py`（信中 verbatim 引用与页码会失效）。
- **依赖**：3 个 LaTeX 模板（cover-letter / response-to-reviewers / revised-manuscript-redline，模板内置隐私规则宏）、`scripts/check_package_consistency.py`（解析 `\RevisedExcerpt` 等宏与 `\input` 树）；qa-checklist 与 package-consistency-audit 互补且终包都适用。
- **输出**：逐点回复信、cover letter、标红稿、一致性报告。
- **衔接**：接 nature-reviewer 的模拟意见可全流程演练；改稿手艺回流 polishing；回复信与稿件的再同步规则由 shared consistency-sweep §6 指定。

---

## c. nature-shared 公共库拆解

**定位**（其 SKILL.md 前言）：内部共享参考包，**禁止作为独立工作流调用**；只按其他 skill 的请求加载具体文件，返回请求方 skill 做任务逻辑与 QA。`core/` 与 `journal-formats/` 是共享定义，不是独立流程。

**文件清单与职责**（16 个内容文件 + `scripts/check_consistency.py`）：

| 文件 | 职责 | 被谁消费 |
|---|---|---|
| `core/reader-workflow.md` | 读者五问序列（Relevance→Novelty→Trust→Reuse→Meaning），起草/润色的总纲领 | **writing、polishing always_load** |
| `core/paper-type-taxonomy.md` | 5 型论文分类法（research/methods/hypothesis/algorithmic/review）+ 检测规则 + 旧词表映射；各 skill 在其上叠 action 层 | **writing、polishing always_load**；paper-xray 按需；paper2ppt/paper-card/response 有各自 6 值变体 |
| `core/ethics.md` | 引用伦理：标注贡献归属、引用实际读过的来源、AI 边界 | **writing、polishing always_load** |
| `core/terminology-ledger.md` | 术语账本：动笔前提取全部复现领域术语为唯一真相源 | **writing、polishing always_load**；reader、paper2ppt 显式消费 |
| `core/main-text-discipline.md` | 正文纪律：证据完整≠正文完整、结果分类定位表、最短充分证据链、防修回膨胀、SI 分流、统计报告纪律 | writing/polishing 的 Results 与压缩任务按需；response 改稿时强制 |
| `core/nature-introduction.md` | NMI 语料提炼的引言规则：收敛漏斗、精确知识缺口、文献造张力、question-first（**明确声明是语料推断非官方政策**） | writing/polishing 的引言任务按需 |
| `core/nature-abstract.md` | 摘要=最短证据链架构：`gap→做什么→主发现→关键支撑→确立什么→为何重要`，主 claim 唯一、数字按需 | writing/polishing 的摘要任务按需 |
| `core/nature-results-discussion.md` | Results claim 递进 + Discussion 综合、同层重复防控 | writing/polishing/figure(多面板与正文论证对齐) 按需 |
| `core/discussion-argument-language.md` | Discussion 四功能、反漏斗、情态强度与证据校准、limitations=claim 边界 | writing/polishing 的 Discussion 任务按需 |
| `core/consistency-sweep.md` | 回溯式一致性审计：12 轴（术语/单位/精度/自指/时态/连字符/拼写/交叉引用）+ 数值自洽 + claims-vs-data + 冗余；配机械扫描脚本 | polishing 全文审计；reviewer（稿件自相矛盾）、statistics（同一统计量两处表述）引用；`scripts/check_consistency.py` 内置自指/标准差变体扫描 + `--term-group` 自定义（272 行，`--json`/`--fail-on-findings`） |
| `core/research-compliance.md` | 受监管研究合规路由（人类/动物/临床/图像完整性/结构化学/分类学），适用性门分类 required/NA/AUTHOR_INPUT_NEEDED，不推断任何批准 | writing 按需（合规触发时） |
| `journal-formats/nature.md` | 旗舰 Nature Article 投稿硬规则（阶段门/结构限额/显示项/行政检查，313 行） | writing/figure/data/statistics 的 nature 目标按需；明确"不得自动套用到子刊" |
| `journal-formats/nature-machine-intelligence.md` | NMI 全套（文章类型/限额/初投稿件/数据代码义务/生产检查，431 行，最详尽） | writing/polishing/figure/data/statistics 的 nat-mach-intell 目标按需 |
| `journal-formats/nat-comms.md` | Nat Commun 格式事实（Article ~5000 词/摘要 150/引文 ~60/显示项 ≤10 等），"事实在 shared、action 在各 skill 片段"分工 | writing/polishing 的 nat-comms 目标按需 |
| `scripts/check_consistency.py` | 一致性机械扫描器（见上） | polishing/reviewer/statistics 的全文审计 |

**依赖关系总结**：nature-writing 与 nature-polishing 是 always_load 级硬依赖（各 4 个 core 文件）；reader/paper2ppt 依赖 terminology-ledger；figure/data/statistics/response/reviewer/xray 按条件依赖 journal-formats、main-text-discipline、consistency-sweep、paper-type-taxonomy。**nature-figure、nature-academic-search 明确不用 prose-oriented shared 层**（各自 manifest 注释）。

---

## d. 论文全生命周期编排链

```
选题 ──→ 文献 ──→ 精读 ──→ 实验记录 ──→ 数据分析 ──→ 初稿 ──→ 图表 ──→ 润色 ──→ 自查 ──→ 模拟审稿 ──→ 审稿回应 ──→ 转换交付
```

**链式强配合（A 的产物是 B 的输入）：**

1. **选题**：`nature-social-science`（8 步论证 + 新颖性攻击）→ 产出 Topic Cards/RQ → `nature-proposal-writer`（开题）或直接进 `nature-writing`。
2. **文献检索→获取**：`nature-academic-search`（检索/核验）→ `nature-downloader`（拿全文 PDF）；日常监测用 `nature-literature-pipeline`（cron 自动推送，人工筛选后回流检索结果）。
3. **文献获取→精读**：downloader 的 PDF → 三档精读：`nature-reader`（双语对照 + source_map.json）→ `nature-paper-card`（**优先复用 reader 的 source-map**，强制 prepare_paper.py + 审计脚本）/ `nature-paper-xray`（单篇深读无工件依赖）；需要"保版式中文阅读副本"用 `nature-paper-trans`（独立管线，不依赖 reader）。
4. **实验记录→写作**：`nature-experiment-log` 的 YAML 日志是 writing 的 Experiments 素材与 statistics 的设计信息源。
5. **写作→引用**：`nature-writing` 起草时标出待补引用 → `nature-citation`（Nature/CNS 域内检索导出 .ris）→ `nature-ref-verifier`（投稿前逐条核验 → BibTeX patch）→ `.bib` 交给 `nature-paper2word` 编译。
6. **写作→图表**：writing 的 Results 证据链决定 figure 顺序（nature-figure SKILL.md 明示"figure order must follow the manuscript argument"时加载 shared nature-results-discussion）；`nature-statistics` 校图注统计。
7. **润色→一致性**：`nature-polishing` 完成语言层 → shared `consistency-sweep.md` + `check_consistency.py` 全文机械扫描（术语/数值/单位/自指）。
8. **自查→投稿**：`nature-data`（声明+FAIR）+ `nature-statistics`（报告完整性）+ writing `references/paper-review.md`（自审）→ `references/submission-package.md` 投稿材料矩阵。
9. **模拟审稿→回应**：`nature-reviewer` 的 Major/Minor 清单（含 R1-M1 编号、blocking 标记）直接喂 `nature-response` 逐条回复；response 中每处改稿回流 polishing 语言检查；交付前 `check_package_consistency.py` 保证信-稿一致。这是本库设计最完整的闭环（reviewer 明确"不写 rebuttal"、response 明确"不做模拟审稿"，边界互锁）。
10. **转换交付**：`nature-paper2word`（投稿/学位 Word）← 同一 Markdown 稿 → `nature-paper2ppt`（组会 deck）；`nature-image2ppt` 独立处理"只有图片的 deck 重建"；成果转化走 `nature-paper-to-patent`（技术交底书/专利草稿，独立 schema）。

**可选支线（不阻塞主线）：**
- `nature-literature-pipeline`：纯日常增益，不投稿不触发。
- `nature-experiment-log`：湿实验课题组专用；干算法团队可跳过。
- `nature-social-science`：社科/人文专用，理工选题可用但非必需。
- `nature-paper-trans` / `nature-image2ppt`：阅读与还原工具，与投稿主线正交。
- `nature-figure` 的 AI 示意图/OpenRouter 路由：需用户明示 + 政策自担，默认不走。
- `nature-shared` 各 journal-formats：只有目标期刊明确时才加载。

---

## e. 预设集成建议

### 核心 10 skill（论文写作 agent 预设最小集）

按"写作主线 + 质量闭环 + 交付"选择，其余按需装：

| # | Skill | 理由 |
|---|---|---|
| 1 | nature-writing | 主写作引擎 |
| 2 | nature-polishing | 语言层唯一入口（与 writing 边界已在双方 description 互锁） |
| 3 | nature-shared | 前两者的 always_load 硬依赖，**必须随装** |
| 4 | nature-reviewer | 投稿前模拟审稿（质量闭环核心） |
| 5 | nature-response | 返修必备，接 reviewer 输出 |
| 6 | nature-statistics | 统计合规双件套之一 |
| 7 | nature-data | 统计合规双件套之二 |
| 8 | nature-academic-search | 唯一多源检索（自带 MCP server） |
| 9 | nature-ref-verifier | 引文质检，投稿前最后防线 |
| 10 | nature-figure | 图表唯一引擎（Python/R 双后端） |

第二梯队（按用户类型加装）：精读三件套 reader/xray/card（读文献型用户）、paper2word + paper2ppt（交付型）、citation + downloader（文献密集型）、social-science + proposal-writer（研究生开题型）、literature-pipeline + experiment-log（课题组日常型）、image2ppt + paper-trans + paper-to-patent（按单次需求触发）。

### MCP 与环境

- **arxiv MCP**：本机已配置（mcp__arxiv 工具集），覆盖 arXiv 检索/下载/引文导出，与 academic-search 的 arxiv source 互补。
- **academic-search MCP server**：`nature-academic-search/mcp-server/academic_search_server.py`，FastMCP + CrossRef/PubMed/arXiv/Scopus/ScienceDirect；启动方式 `config/mcp-snippet.json`（`uv run --with mcp requests toml lxml pybliometrics ...`）；无 MCP 时 `scripts/academic_search.py` 兜底。
- **可选 MCP/工具**：zotero（pyzotero Web 模式——ref-verifier 实测本地 API 只写 501）、kimi-datasource/webbridge（中文文献核验）、feishu-cli（pipeline 推送 + experiment-log 输入）。
- **Python 环境**：基础 Python 3.10+；`pip install md-to-word-docx`（paper2word 唯一外部引擎）；PyMuPDF（figure 审计链 + paper-trans + downloader PDF 验证）；pypdfium2/Pillow/openai（image2ppt）。
- **Node.js 22+**：仅 nature-downloader 需要；其机构路由还需 Chrome CDP（web-access-main check-deps.mjs），预设可不装，用时再配。
- **可选密钥**：`PADDLE_OCR_TOKEN`（image2ppt OCR）、OpenRouter API key（figure AI 示意图）、Elsevier/Springer/IEEE API key（downloader，全部 `--stdin` 配置不进聊天）、Zotero userID+API key（ref-verifier 批量写回）。

### 插件 UI 快捷操作建议

直接映射 skill 触发词，做成一键入口：

| UI 操作 | 挂载 skill | 说明 |
|---|---|---|
| 一键审稿 | nature-reviewer | 输入手稿→3 互盲报告+综合 |
| 一键润色 | nature-polishing | 粘贴文本→轴检测→润色（区分"润色"与"排版"两种入口） |
| 一键返修 | nature-response | 粘贴审稿邮件→逐点回复包 |
| 一键核引用 | nature-ref-verifier | 上传参考文献列表→分级验证报告 |
| 一键转 Word | nature-paper2word | md+可选 format.txt→docx |
| 一键组会 PPT | nature-paper2ppt | 论文/笔记→中文 pptx+QA |
| 一键精读 | nature-reader / paper-xray / paper-card | 三档（对照阅读/深读/结构卡）做成单选 |
| 每日文献推送 | nature-literature-pipeline | 配置关键词+推送目标+归档路径 |
| 配图工作台 | nature-figure | 首次询问 Python/R 并持久化；展示 atlas 模板库 |
| 数据声明助手 | nature-data + nature-statistics | 投稿合规打包 |

预设 system prompt 需写死的边界规则（来自各 SKILL.md 的互锁声明）：writing↔polishing↔response 的任务分流；reviewer 不写 rebuttal、response 不做模拟审稿；figure 的 backend 独占与"先问一次 Python or R"；所有 skill 共同的 `AUTHOR_INPUT_NEEDED` 不编造约定与"检测到轴值先报一行"交互模式。
