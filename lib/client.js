window.__ModuleLoader__.load({
  id: '@zws/dsh-nature',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // ── 为什么这个文件长这样（先例：overclock-mode / copy-session-id，均实测踩坑）──
    //   1. 所有 client bundle 会被拼成**一个脚本**执行，顶层 const 撞名会让整个拼合脚本
    //      （含官方 bundle）起不来。所以文件顶层零绑定，注册内联成一条
    //      `window.__ModuleLoader__.load({...})` 语句（因此首行就是这条语句，不能有文件头注释）。
    //   2. 没有构建步骤：require 只解析 react，不 import 任何 dsh 包
    //      （引 dsh 包会把「引不到 / 引错」变成整页起不来的风险）。
    //   3. 每个槽位注册都包 try/catch：register 抛错会连带炸掉整个 apply()，
    //      官方 bundle 跟着死；单个入口坏了只该是「这个入口不出现」。
    //
    // ── 挂载面（槽位契约出处：临时/dsh-ui-internals.md）────────────────────────
    //   sidebar.panellist  kind:list  id=面板 key，图标组件收 ownerProps {size, active}（§3）
    //   main               kind:keyed key 必填且即「sidebar 入口 id」（§3）
    //   settings.section   kind:list  id+order+label，导航行无徽标座位（§1、§4）
    //   plugins.detail.badge        列表槽，渲染在版本/beta/问题 Tag 之后（§4）
    //   plugins.bundle.config       keyed 槽，key=包名（§2）
    //
    // ── 红点的三处官方座位（设计定稿 §3.2 / §5）────────────────────────────────
    //   设置导航行没有徽标座位（ui-internals §4 官方事实），所以红点放在：
    //   ① 侧栏图标右上角 6px 圆点（CSS 仿官方 DesktopUpdateBadge：
    //      position:absolute + top:2px + inset-inline-end:2px + border-radius:50%
    //      + background:var(--dsw-alias-brand-primary-…)，dsh-client-ui-settings-general :94）
    //   ② 页面内容头部的红点横幅（工作台 + 设置页）
    //   ③ 插件管理器详情页的徽标 Tag（官方座位）
    //
    // ── Remote 契约（与宿主半 lib/index.js 实读对齐）────────────────────────────
    //   typert 协议，serviceKey/namespace = 'dshNature'（设计定稿 §3.1，index.js:43,427,865-869）。
    //   五个方法全部 invocation direct；参数名禁止默认值/解构/剩余参数
    //   （网关从函数源码解析参数名，overclock-mode/index.js:259-263 头注为证）。
    //   status()/check()/update()/setConfig() 的返回值统一是**刷新后的完整状态对象**
    //   （index.js:498-511）：
    //     { version, headSha, lastCheckedAt,
    //       lastCheckStatus: 'never'|'baseline-missing'|'upToDate'|'updateAvailable'|'error',
    //       lastError, updateAvailable, changedSkills: [{name,added,removed,modified}],
    //       manifest: { headSha, files }, config: { autoCheck, intervalHours, targetDir, mirror } }
    //   statusView 负责归一化：baselineSha=manifest.headSha、remoteSha=headSha、
    //   needsBaseline 由 lastCheckStatus==='baseline-missing' 或清单头为空推导。
    //   openSkillsDir() 返回值不承载业务，只报成功/失败。
    //
    // ── plugins.bundle.config 的一处降级（偏离设计稿的说明）────────────────────
    //   设计稿写的是「精简状态卡 + 跳设置按钮」。但 DSH 没有任何可编程打开设置页的
    //   官方 API：ui-internals §1/§3 未记载；本机 skillhub（client.js:1248-1261）与
    //   overclock/copy-session-id 都没有跳设置；官方 layout 客户端只有
    //   layout.selectPanel（仅 main 面板，.probe/official-layout-client.js:401-465）。
    //   按铁律「禁止编造 DSH API」，这里改为：状态行 + 「打开技能目录」按钮
    //   （走本插件自己的 openSkillsDir Remote 方法，完全有据）+ 一行设置路径提示。

    const React = require('react')
    const h = React.createElement

    const PACKAGE = '@zws/dsh-nature'
    const NS = 'nature'
    const PANEL_ID = 'dsh-nature'
    /** nature-skills 上游仓库：与宿主半 check() 探测的 api.github.com/repos/Yuan1z0825/nature-skills 同源。 */
    const REPO_URL = 'https://github.com/Yuan1z0825/nature-skills'
    /** 侧栏图标红点的轮询周期。低频足够：红点晚 10 分钟出现没有伤害。 */
    const POLL_MS = 10 * 60 * 1000
    /** sha 展示长度：git 短哈希惯例 7 位，悬停 title 里给全量。 */
    const SHA_DISPLAY = 7
    /**
     * 插件版本。client 半的 require 只解析 react，读不到自己的 package.json
     * （overclock-mode 头注先例），宿主 status() 也不带版本号；
     * 这里内联同一份值，test/client-shape.test.mjs 会对着 package.json 断言同步。
     * status() 将来若返回 pluginVersion，则以宿主为准。
     */
    const PLUGIN_VERSION = '1.0.6'

    // ── 文案 ────────────────────────────────────────────────────────────────────
    // 字典写在 JS 里、apply 时 ctx.locale.register(NS, { zh, en })（官方与 skillhub 同款写法）。
    // locale/zh.json、en.json 与这份字典**逐键同步**（test/client-shape.test.mjs 会比对），
    // JSON 里额外多一个 meta 段供插件管理器展示标题与描述——浏览器半不读 JSON 文件。
    const DICTIONARY = {
      zh: {
        nav: 'Nature 写作',
        'banner.update': 'nature-skills 有可用更新',
        'banner.notInstalled': '未检测到 nature 技能 —— 打开「Nature 写作」工作台可一键安装全套',
        'banner.partialInstalled': '检测到部分 nature 技能（{have}/{total}，缺 {miss} 个）—— 可在工作台自动补全',
        'banner.needsBaseline': '尚未建立技能基线：请先在 nature-skills 克隆目录运行 tools/baseline.cjs，再回到这里点「检查更新」',
        'banner.error': '状态获取失败：{message}',
        'status.pluginVersion': '插件版本',
        'status.baseline': '基线版本',
        'status.remote': '远端版本',
        'status.lastChecked': '上次检查',
        'status.never': '从未',
        'status.neverChecked': '尚未检查',
        'status.noBaseline': '未建立',
        'status.needsBaseline': '未建立基线',
        'status.uptodate': '与远端一致',
        'status.resultError': '失败',
        'updates.title': '更新中心',
        'updates.check': '检查更新',
        'updates.updateAll': '全部更新',
        'updates.updateSelected': '更新所选（{n}）',
        'updates.checking': '检查中…',
        'updates.updating': '更新中…',
        'updates.none': '没有待更新的技能',
        'updates.changedCount': '{n} 个技能有变化',
        'updates.hint': '勾选要更新的技能即可只更新一部分；未选中的目录一个字节都不会改动。',
        'updates.files': '+{added} −{removed} ~{modified}',
        'updates.resultDone': '已更新 {n} 个技能',
        'updates.resultPartial': '已更新 {done} 个技能，{failed} 个文件失败（详见日志）',
        'catalog.title': '技能目录',
        'catalog.count': '共 {n} 项',
        'catalog.hint': '24 个技能随 nature-skills 仓库增量更新；在会话里直接描述任务即可触发对应技能。',
        'catalog.triggerHint': '该技能在 SKILL.md 里登记的触发名是 {trigger}（目录名与触发名不同）',
        'install.title': '技能安装状态',
        'install.unknown': '正在读取安装状态…如果一直停在这里，说明宿主服务未就绪，重启 DSH 即可。',
        'install.diagMountFailed': '远程通道挂载失败：{message}',
        'install.diagNoNamespace': '远程通道已挂载，但命名空间未出现。请把这一行发给作者。',
        'install.progress': '{have}/{total} 已安装',
        'install.complete': '全套 {n} 个 nature 技能已就绪',
        'install.empty': '未检测到 nature 技能',
        'install.emptyHint': '当前目录下没有任何 nature 技能，预设里的写作/文献/统计/绘图链路都无法触发。点下方按钮安装全套。',
        'install.partialShort': '检测到部分 nature 技能：已有 {have}/{total}，还缺 {miss} 个',
        'install.partialHint': '可以只补装缺失的 {n} 个；已安装的技能保持原样。「全部重装」会按远端最新版刷新每一个。',
        'install.installAll': '安装全套 nature 技能',
        'install.fillMissing': '自动补全缺失的 {n} 个',
        'install.refreshAll': '全部重装 / 刷新',
        'install.installing': '安装中…',
        'install.done': '已安装 {n} 个技能',
        'install.failed': '安装失败（{n} 个文件报错），请检查网络或镜像源后重试',
        'install.partialDone': '已安装 {done} 个技能，{failed} 个文件失败（详见日志）',
        'install.openDir': '打开技能目录',
        'install.pathHint': '安装位置：{dir}（DSH 从这里自动发现技能，装完即可在会话里触发）',
        'group.writing': '写作',
        'group.literature': '文献',
        'group.data': '数据与实验',
        'group.figure': '绘图',
        'group.delivery': '转换与交付',
        'group.review': '审稿与回应',
        'group.shared': '内部共享',
        'footer.openDir': '打开技能目录',
        'footer.github': 'GitHub 仓库',
        'settings.autoCheck': '自动检查更新',
        'settings.autoCheckHint': '按固定间隔在宿主侧检查 nature-skills 远端变化',
        'settings.interval': '检查间隔（小时）',
        'settings.intervalHint': '0 表示关闭定时检查，仅手动检查',
        'settings.targetDir': '目标目录',
        'settings.targetDirHint': '技能更新只写入该目录（路径穿越防护仅放行 skills/ 内的相对路径）',
        'settings.mirror': '镜像源前缀',
        'settings.mirrorHint': '替换 raw.githubusercontent.com 下载前缀以加速；留空使用官方源',
        'settings.save': '保存设置',
        'settings.saving': '保存中…',
        'settings.saved': '已保存',
        'settings.dirty': '有未保存的修改（改动仅在点「保存设置」后生效）',
        'settings.checkNow': '立即检查',
        'settings.updateAll': '更新全部',
        'settings.invalidInterval': '检查间隔必须是不小于 0 的数字',
        'settings.invalidTargetDir': '目标目录不能为空',
        'error.load': '状态加载失败：{message}',
        'error.action': '操作失败：{message}',
        'error.remoteTimeout': '远程通道无响应（已自动重试多次）。DSH 的插件事件流可能中断：稍后重试，或重启 DSH 后再试。',
        'error.remoteNotMounted': '宿主服务未就绪，请重启 DSH 后重试',
        'badge.update': '有更新',
        'card.openDir': '打开技能目录',
        'card.settingsHint': '自动检查、目标目录与镜像源在「设置 → Nature 写作」页配置。',
        'skill.nature-writing': '从作者证据起草/重构 Nature 风格手稿章节与首次投稿材料',
        'skill.nature-polishing': '只动语言的润色/翻译/精简 + LaTeX 排版修复，不改事实与论证',
        'skill.nature-proposal-writer': 'proposal-first 状态机：先建证据/论证/契约，再写开题报告与申请书',
        'skill.nature-social-science': '社科选题论证工作台：兴趣→问题→证据→新颖性攻击→可行性',
        'skill.nature-academic-search': '多源检索/引文核对/MeSH 策略/严格他引审计（自带 MCP server）',
        'skill.nature-citation': '严格限定 Nature/CNS 期刊域的「分段补引用」检索与 RIS/ENW/Zotero 导出',
        'skill.nature-ref-verifier': '参考文献逐字段多源交叉验证，输出分级报告与修正补丁',
        'skill.nature-downloader': '合法获取全文：OA / 出版商 API / CNKI / 机构浏览器四路由',
        'skill.nature-literature-pipeline': 'cron 驱动的每日文献发现管线：检索→评分→精读→推送→归档',
        'skill.nature-reader': '生成带 source-map 锚点的中英对照全文 Markdown reader',
        'skill.nature-paper-xray': '单篇论文「白板级」深读：还原作者真实路径与证据边界',
        'skill.nature-paper-card': '固定 16 节、带页码锚点与审计脚本的论文精读卡',
        'skill.nature-paper-trans': '英文 PDF 逐页生图翻译为保版式的中文图片型 PDF',
        'skill.nature-data': 'Data/Code Availability 声明、仓储方案与 FAIR 审计',
        'skill.nature-statistics': '统计报告审查/改写：实验单位、n、不确定性、图注统计',
        'skill.nature-experiment-log': '图片/语音/文字→带 YAML frontmatter 的标准实验日志',
        'skill.nature-figure': 'Python/R 投稿级绘图 + 多面板对齐门 + PDF 碰撞审计',
        'skill.nature-paper2word': 'Markdown→期刊/学位论文规范 Word（OMML 公式、三线表、CSL 引文）',
        'skill.nature-paper2ppt': '论文→中文文献汇报 PPTX（9 步流程 + 质量审计）',
        'skill.nature-image2ppt': '幻灯片图片/扫描 PDF→对象级可编辑 PPTX',
        'skill.nature-paper-to-patent': '论文→中国发明专利草稿/技术交底书（证据锚定 + DOCX 打包）',
        'skill.nature-reviewer': '模拟 3 份互盲审稿报告 + 1 份综合，含法证一致性审计',
        'skill.nature-response': '返修邮件解析→逐点回复/cover letter/标红稿/LaTeX 返修包一致性',
        'skill.nature-shared': '禁止独立调用的共享参考库：写作公理、语料规则、期刊格式、一致性扫描',
      },
      en: {
        nav: 'Nature Writing',
        'banner.update': 'nature-skills has updates available',
        'banner.notInstalled': 'No nature skills detected — open the Nature Writing workbench to install the full set',
        'banner.partialInstalled': 'Partial nature skills detected ({have}/{total}, {miss} missing) — top up from the workbench',
        'banner.needsBaseline': 'No baseline yet: run tools/baseline.cjs inside the nature-skills clone, then click "Check for updates" here',
        'banner.error': 'Failed to load status: {message}',
        'status.pluginVersion': 'Plugin',
        'status.baseline': 'Baseline',
        'status.remote': 'Remote',
        'status.lastChecked': 'Last check',
        'status.never': 'never',
        'status.neverChecked': 'Not checked yet',
        'status.noBaseline': 'not built',
        'status.needsBaseline': 'Baseline not built',
        'status.uptodate': 'Up to date',
        'status.resultError': 'failed',
        'updates.title': 'Update center',
        'updates.check': 'Check for updates',
        'updates.updateAll': 'Update all',
        'updates.updateSelected': 'Update selected ({n})',
        'updates.checking': 'Checking…',
        'updates.updating': 'Updating…',
        'updates.none': 'Nothing to update',
        'updates.changedCount': '{n} skills changed',
        'updates.hint': 'Tick only the skills you want to update; untouched directories are never modified.',
        'updates.files': '+{added} −{removed} ~{modified}',
        'updates.resultDone': 'Updated {n} skills',
        'updates.resultPartial': 'Updated {done} skills, {failed} files failed (see logs)',
        'catalog.title': 'Skill catalog',
        'catalog.count': '{n} skills',
        'catalog.hint': '24 skills shipped with the nature-skills repo; describe the task in a session and the matching skill triggers.',
        'catalog.triggerHint': 'This skill registers the trigger name {trigger} in SKILL.md (directory name differs)',
        'install.title': 'Skill installation',
        'install.unknown': 'Reading installation state… if this never resolves, the host service is not ready — restart DSH.',
        'install.diagMountFailed': 'Remote channel mount failed: {message}',
        'install.diagNoNamespace': 'Remote channel mounted but the namespace never appeared. Please send this line to the author.',
        'install.progress': '{have}/{total} installed',
        'install.complete': 'All {n} nature skills are ready',
        'install.empty': 'No nature skills detected',
        'install.emptyHint': 'None of the nature skills are present, so none of the writing, literature, statistics or figure workflows can trigger. Install the full set below.',
        'install.partialShort': 'Partial nature skills detected: {have}/{total} present, {miss} missing',
        'install.partialHint': 'Install only the {n} missing skills, or refresh every skill to the latest remote version. Existing skills are left untouched by a top-up.',
        'install.installAll': 'Install all nature skills',
        'install.fillMissing': 'Fill in the missing {n}',
        'install.refreshAll': 'Reinstall / refresh all',
        'install.installing': 'Installing…',
        'install.done': 'Installed {n} skills',
        'install.failed': 'Install failed ({n} files errored); check the network or mirror and retry',
        'install.partialDone': 'Installed {done} skills, {failed} files failed (see logs)',
        'install.openDir': 'Open skills directory',
        'install.pathHint': 'Installed into {dir} — DSH discovers skills from there, so they are usable as soon as the run finishes',
        'group.writing': 'Writing',
        'group.literature': 'Literature',
        'group.data': 'Data & experiments',
        'group.figure': 'Figures',
        'group.delivery': 'Conversion & delivery',
        'group.review': 'Review & response',
        'group.shared': 'Internal shared',
        'footer.openDir': 'Open skills directory',
        'footer.github': 'GitHub repository',
        'settings.autoCheck': 'Check for updates automatically',
        'settings.autoCheckHint': 'Poll the nature-skills remote on the host side at a fixed interval',
        'settings.interval': 'Interval (hours)',
        'settings.intervalHint': '0 disables the scheduled check; use "Check now" instead',
        'settings.targetDir': 'Target directory',
        'settings.targetDirHint': 'Skill updates are written only into this directory (path-traversal guard allows relative paths under skills/ only)',
        'settings.mirror': 'Mirror prefix',
        'settings.mirrorHint': 'Replaces the raw.githubusercontent.com download prefix; leave empty for the official source',
        'settings.save': 'Save settings',
        'settings.saving': 'Saving…',
        'settings.saved': 'Saved',
        'settings.dirty': 'Unsaved changes (they apply only after "Save settings")',
        'settings.checkNow': 'Check now',
        'settings.updateAll': 'Update all',
        'settings.invalidInterval': 'Interval must be a number not below 0',
        'settings.invalidTargetDir': 'Target directory must not be empty',
        'error.load': 'Failed to load status: {message}',
        'error.action': 'Action failed: {message}',
        'error.remoteTimeout': 'The remote channel stopped responding (retried automatically). The DSH plugin event stream may be down: retry later, or restart DSH.',
        'error.remoteNotMounted': 'Host service is not ready; restart DSH and retry',
        'badge.update': 'Update',
        'card.openDir': 'Open skills directory',
        'card.settingsHint': 'Auto-check, target directory and mirror are configured on the "Settings → Nature Writing" page.',
        'skill.nature-writing': 'Draft or restructure Nature-style manuscript sections and first-submission materials from author evidence',
        'skill.nature-polishing': 'Language-only polishing, translation and trimming plus LaTeX layout fixes; facts and argumentation untouched',
        'skill.nature-proposal-writer': 'Proposal-first state machine: build evidence, argument and contracts before writing the proposal',
        'skill.nature-social-science': 'Social-science topic workbench: interest, question, evidence, novelty attack, feasibility',
        'skill.nature-academic-search': 'Multi-source search, citation verification, MeSH strategy and strict other-citation audit (bundled MCP server)',
        'skill.nature-citation': 'Nature/CNS-only claim-by-claim citation search with RIS/ENW/Zotero export',
        'skill.nature-ref-verifier': 'Field-level multi-source cross-validation of references with graded reports and fix patches',
        'skill.nature-downloader': 'Legal full-text acquisition: OA, publisher API, CNKI and institutional browser routes',
        'skill.nature-literature-pipeline': 'Cron-driven daily literature pipeline: search, score, read, push, archive',
        'skill.nature-reader': 'Bilingual full-text Markdown reader with source-map anchors',
        'skill.nature-paper-xray': 'Whiteboard-level deep read of one paper: the real reasoning path of the authors and the evidence boundaries',
        'skill.nature-paper-card': 'Fixed 16-section paper reading card with page anchors and audit scripts',
        'skill.nature-paper-trans': 'Page-by-page image translation of an English PDF into a layout-preserving Chinese PDF',
        'skill.nature-data': 'Data/Code Availability statements, repository planning and FAIR audit',
        'skill.nature-statistics': 'Statistical reporting review and rewrite: experimental units, n, uncertainty, caption statistics',
        'skill.nature-experiment-log': 'Images, voice and text filed into standardized experiment logs with YAML frontmatter',
        'skill.nature-figure': 'Publication-grade figures in Python/R with panel alignment and PDF collision audits',
        'skill.nature-paper2word': 'Markdown compiled into journal or thesis Word documents (OMML equations, three-line tables, CSL citations)',
        'skill.nature-paper2ppt': 'Paper to Chinese presentation PPTX with a 9-step flow and quality audit',
        'skill.nature-image2ppt': 'Slide images and scanned PDFs rebuilt as object-level editable PPTX',
        'skill.nature-paper-to-patent': 'Paper to Chinese patent draft or technical disclosure, evidence-anchored',
        'skill.nature-reviewer': 'Three mutually blinded mock reviews plus one synthesis, with a forensic consistency audit',
        'skill.nature-response': 'Decision-letter parsing into point-by-point replies, cover letter, redlined manuscript and LaTeX package',
        'skill.nature-shared': 'Internal shared reference library (never invoked standalone): writing axioms, corpus rules, journal formats',
      },
    }

    /**
     * 目录名 ≠ 触发名的例外表。DSH 的技能名取 **SKILL.md 的 frontmatter name**，
     * 不是目录名（dsh-skill-filesystem/lib/index.js 的 discoverRoot：`name: parsed.name`）。
     * 上游 nature-proposal-writer 目录里的 frontmatter 是 `name: researchwrite`
     * （2026-11-04 实读 ~/.agents/skills/nature-proposal-writer/SKILL.md:2），所以模型
     * 只能按 researchwrite 触发；照目录名写进 persona 会把模型引到一个不存在的技能名上。
     * 目录沿用目录名展示（那是磁盘上的真实目录，也是更新引擎按 `<skill>/` 前缀匹配的
     * 单位），触发名在同一行单独标出。
     */
    const TRIGGER_ALIASES = { 'nature-proposal-writer': 'researchwrite' }

    /**
     * 技能目录：24 个 nature skills 按 docs/nature-skills-digest.md §a 的六类分组，
     * 外加内部共享包。名称是仓库目录名（除 TRIGGER_ALIASES 标注的例外），
     * 一句话定位取自 digest §a 表，逐条放在 DICTIONARY 的 skill.* 键里。
     * 纯静态数据：目录内容不参与更新逻辑。
     */
    const CATALOG = [
      { key: 'group.writing', skills: ['nature-writing', 'nature-polishing', 'nature-proposal-writer', 'nature-social-science'] },
      { key: 'group.literature', skills: ['nature-academic-search', 'nature-citation', 'nature-ref-verifier', 'nature-downloader', 'nature-literature-pipeline', 'nature-reader', 'nature-paper-xray', 'nature-paper-card', 'nature-paper-trans'] },
      { key: 'group.data', skills: ['nature-data', 'nature-statistics', 'nature-experiment-log'] },
      { key: 'group.figure', skills: ['nature-figure'] },
      { key: 'group.delivery', skills: ['nature-paper2word', 'nature-paper2ppt', 'nature-image2ppt', 'nature-paper-to-patent'] },
      { key: 'group.review', skills: ['nature-reviewer', 'nature-response'] },
      { key: 'group.shared', skills: ['nature-shared'] },
    ]

    /** 目录总数单一事实源：catalog.count 的 n 绑定它，目录增删不漂移。 */
    const CATALOG_TOTAL = CATALOG.reduce((sum, group) => sum + group.skills.length, 0)

    /** `{key}` 插值（官方字典同款形状，见 copy-session-id 的 fmt）。 */
    function fmt(text, params) {
      if (typeof text !== 'string') return ''
      if (params === undefined || params === null) return text
      return text.replace(/\{(\w+)\}/g, (match, key) => (params[key] === undefined ? match : String(params[key])))
    }

    /**
     * 取文案：优先框架注入的 `t`（注册时声明了 locale: NS），字典缺键时回退 zh——
     * 官方查找链缺键会原样返回 key，页面不能退化成 "updates.check" 这种字符串。
     */
    function makeText(t) {
      return function text(key, params) {
        let out
        if (typeof t === 'function') {
          try { out = t(key) } catch (error) { out = undefined }
        }
        if (typeof out !== 'string' || out.length === 0 || out === key) out = DICTIONARY.zh[key]
        if (typeof out !== 'string') out = key
        return fmt(out, params)
      }
    }

    // ── Remote 贡献 ─────────────────────────────────────────────────────────────
    /**
     * 严格 codec 占位。浏览器不执行参数 schema，宿主会逐字段校验；
     * 这个对象只用来通过 Client 侧的 strict-input 检查（非 strict 的 codec 会被拒绝挂载）。
     * 写法照抄 overclock-mode/client.js:102-116。
     */

    /**
     * Remote 方法名的**保留字**黑名单。
     *
     * 名字不是随便起的：gateway 的 RemoteNamespaceService 在客户端为每个命名空间
     * 建一个 Service 实例，而服务方法装在这个实例上。只要方法名撞上它的原型成员
     * 或保留字段，$mount 就会在 validateContribution 阶段抛
     *   client api: method "<ns>/<method>" conflicts with its namespace service
     * 整个命名空间挂不上 —— 表现为「宿主服务未就绪」，而宿主其实是好的。
     *
     * 2026-11-04 实机踩到：把安装方法命名成 install，正好撞上服务自己的
     * install()，插件从此完全不可用。方法名一律避开这张表。
     *
     * 出处：dsh-api-gateway/lib/client.browser.js 的 RemoteNamespaceService
     *      原型方法与 REMOTE_NAMESPACE_FIELDS。
     */
    const RESERVED_REMOTE_NAMES = new Set([
      // RemoteNamespaceService.prototype 上的成员
      'assertMethodAvailable', 'constructor', 'empty', 'has',
      'install', 'installDirect', 'installScoped', 'remove',
      // REMOTE_NAMESPACE_FIELDS 保留字段
      'ctx', 'invokeRemote', 'methods', 'name', 'namespace',
    ])

    /** 注册前自查：撞保留名就立刻抛错，比等 $mount 在运行时炸掉整个命名空间好定位。 */
    function assertRemoteMethodName(method) {
      if (RESERVED_REMOTE_NAMES.has(method)) {
        throw new Error(
          'dsh-nature: remote method ' + JSON.stringify(method) + ' collides with the gateway namespace service; ' +
          'rename it (see RESERVED_REMOTE_NAMES) or the whole namespace will fail to mount',
        )
      }
    }

    const codec = (name, parse) => ({
      mode: 'strict',
      typeSymbol: PACKAGE + '#' + name,
      create: () => ({ parse: parse ?? ((value) => value) }),
    })

    /** update(skillNames?) 的可选参数：省略 = 全部变化的技能；给了就必须是非空名字数组。 */
    const skillNamesCodec = codec('SkillNames', (value) => {
      if (value === undefined || value === null) return undefined
      if (!Array.isArray(value)) throw new Error('expected an array of skill names')
      for (const item of value) {
        if (typeof item !== 'string' || item.trim().length === 0) throw new Error('expected non-empty skill names')
      }
      return value
    })

    /** setConfig(patch)：只认设计定稿 §3.1 的四个配置键，类型不对就地拒绝。 */
    const configPatchCodec = codec('ConfigPatch', (value) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a config object')
      const known = ['autoCheck', 'intervalHours', 'targetDir', 'mirror']
      for (const key of Object.keys(value)) {
        if (!known.includes(key)) throw new Error('unknown config key: ' + key)
      }
      if (value.autoCheck !== undefined && typeof value.autoCheck !== 'boolean') throw new Error('autoCheck must be a boolean')
      if (value.intervalHours !== undefined && (typeof value.intervalHours !== 'number' || !Number.isFinite(value.intervalHours) || value.intervalHours < 0)) {
        throw new Error('intervalHours must be a non-negative number')
      }
      if (value.targetDir !== undefined && (typeof value.targetDir !== 'string' || value.targetDir.trim().length === 0)) {
        throw new Error('targetDir must be a non-empty string')
      }
      if (value.mirror !== undefined && typeof value.mirror !== 'string') throw new Error('mirror must be a string')
      return value
    })

    const statusResultCodec = codec('StatusResult')

    const CONTRIBUTION = {
      package: PACKAGE,
      descriptors: [
        {
          id: PACKAGE + '#dshNature/status',
          service: 'dshNature',
          namespace: 'dshNature',
          method: 'status',
          invocation: { kind: 'direct' },
          parameters: [],
          result: statusResultCodec,
        },
        {
          id: PACKAGE + '#dshNature/inspect',
          service: 'dshNature',
          namespace: 'dshNature',
          method: 'inspect',
          invocation: { kind: 'direct' },
          parameters: [],
          result: statusResultCodec,
        },
        {
          id: PACKAGE + '#dshNature/check',
          service: 'dshNature',
          namespace: 'dshNature',
          method: 'check',
          invocation: { kind: 'direct' },
          parameters: [],
          result: statusResultCodec,
        },
        {
          id: PACKAGE + '#dshNature/update',
          service: 'dshNature',
          namespace: 'dshNature',
          method: 'update',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'skillNames', wire: 'skillNames', source: 'json', codec: skillNamesCodec }],
          result: statusResultCodec,
        },
        {
          id: PACKAGE + '#dshNature/installSkills',
          service: 'dshNature',
          namespace: 'dshNature',
          method: 'installSkills',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'skillNames', wire: 'skillNames', source: 'json', codec: skillNamesCodec }],
          result: statusResultCodec,
        },
        {
          id: PACKAGE + '#dshNature/setConfig',
          service: 'dshNature',
          namespace: 'dshNature',
          method: 'setConfig',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'patch', wire: 'patch', source: 'json', codec: configPatchCodec }],
          result: statusResultCodec,
        },
        {
          id: PACKAGE + '#dshNature/openSkillsDir',
          service: 'dshNature',
          namespace: 'dshNature',
          method: 'openSkillsDir',
          invocation: { kind: 'direct' },
          parameters: [],
          result: statusResultCodec,
        },
      ],
    }

    // ── 样式 ────────────────────────────────────────────────────────────────────
    // 只用 --dsw-* / --dsw-alias-* 主题 token，且每个都带字面回退值：亮暗双主题可读，
    // token 缺失也不至于不可用（ptc-ecosystem-research §3.6 的生态共识）。
    // ⚠️ 模板字符串里不能出现反引号——注释也一样。
    // ⚠️ 主按钮的两处例外（官方无「品牌底上的文字色」token，官方 bundle 同场景也写
    //    字面色）：.dsh-nature-btn-primary 的 color:#fff 与 hover 的 color-mix #000。
    //    其余颜色一律走 token / currentColor（warn 圆点随横幅文字色，无自造琥珀值）。
    const CSS = `
/* 滚动容器（只给 main 槽用）。main 槽的父级是 .mP3x-q_centerCol
   {flex-direction:column;overflow:hidden}（dsh-client-ui-layout/lib/client.js AppFrame CSS），
   高度由 .mP3x-q_frame{grid-template-rows:minmax(0,1fr) auto;height:100%} 定死。
   面板自己不声明 height + overflow-y 时只能无限增高，超出部分被父级 overflow:hidden
   裁掉 —— 一屏之外的内容既看不到也滚不到（2026-11-04 实机复现：page clientHeight
   等于内容全高，页面无任何可滚动祖先）。
   官方面板同样自己当滚动容器：plugin-manager 的 .page{height:100%;overflow:auto}、
   skillhub 的 [data-surface=page]{max-height:100%;overflow:auto}。 */
.dsh-nature-scroll{box-sizing:border-box;height:100%;min-height:0;overflow-y:auto;
overscroll-behavior:contain;
--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);
--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
/* 内容列：居中 + 内边距。设置页（settings.section）本身已经在官方
   .AnXs9G_options{flex:1;min-height:0;overflow-y:auto} 里滚动，只复用本类排版。 */
.dsh-nature-page{max-width:760px;margin:0 auto;padding:20px 24px 40px;
color:var(--dsw-alias-label-primary,inherit);font-size:13px;line-height:1.6}
.dsh-nature-banner{display:flex;align-items:flex-start;gap:8px;padding:8px 12px;
border-radius:var(--dsw-radius-sm,8px);margin:0 0 16px;font-size:13px}
.dsh-nature-banner-dot{width:8px;height:8px;border-radius:50%;background:currentColor;flex:none;margin-top:6px}
.dsh-nature-banner[data-tone="update"],.dsh-nature-banner[data-tone="error"]{
background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1242f) 10%,transparent);
color:var(--dsw-alias-state-error-primary,#d1242f)}
.dsh-nature-banner[data-tone="warn"]{
background:color-mix(in srgb,var(--dsw-alias-label-secondary,#6b7280) 12%,transparent);
color:var(--dsw-alias-label-primary,inherit)}
.dsh-nature-card{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.06));
border:1px solid color-mix(in srgb,var(--dsw-alias-label-secondary,#6b7280) 14%,transparent);
border-radius:var(--dsw-radius-md,12px);padding:14px 16px;margin:0 0 16px}
.dsh-nature-card h3{margin:0 0 10px;font-size:13px;font-weight:600;
color:var(--dsw-alias-label-primary,inherit);display:flex;align-items:baseline;gap:8px}
.dsh-nature-card h4{margin:14px 0 2px;font-size:12px;font-weight:600;
color:var(--dsw-alias-label-secondary,#6b7280);display:flex;align-items:baseline;gap:8px}
.dsh-nature-rows{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}
.dsh-nature-rows dt{color:var(--dsw-alias-label-secondary,#6b7280);white-space:nowrap}
.dsh-nature-rows dd{margin:0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.dsh-nature-mono{font-family:ui-monospace,SFMono-Regular,Consolas,Menlo,monospace;font-size:12px}
.dsh-nature-count{color:var(--dsw-alias-label-secondary,#6b7280);font-weight:400;font-size:11px}
.dsh-nature-btnrow{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dsh-nature-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;
border-radius:var(--dsw-radius-sm,8px);border:1px solid color-mix(in srgb,var(--dsw-alias-label-secondary,#6b7280) 24%,transparent);
background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px;cursor:pointer;
transition:background-color .12s,border-color .12s}
.dsh-nature-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.dsh-nature-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-2,#fff),
0 0 0 4px var(--dsw-alias-brand-primary,#2563eb)}
.dsh-nature-btn:disabled{opacity:.5;cursor:default}
.dsh-nature-btn-primary{background:var(--dsw-alias-brand-primary,#2563eb);border-color:transparent;color:#fff}
.dsh-nature-btn-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2563eb) 86%,#000)}
.dsh-nature-list{margin-top:10px}
.dsh-nature-row{display:flex;align-items:flex-start;gap:10px;padding:7px 0;
border-top:1px solid color-mix(in srgb,var(--dsw-alias-label-secondary,#6b7280) 10%,transparent)}
.dsh-nature-list>.dsh-nature-row:first-child{border-top:0}
.dsh-nature-check{accent-color:var(--dsw-alias-brand-primary,#2563eb);width:15px;height:15px;
margin:3px 0 0;flex:none;cursor:pointer}
.dsh-nature-name{font-family:ui-monospace,SFMono-Regular,Consolas,Menlo,monospace;font-size:12.5px}
.dsh-nature-files{margin-left:auto;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;
white-space:nowrap;font-variant-numeric:tabular-nums}
.dsh-nature-skill{display:flex;gap:12px;padding:5px 0;
border-top:1px dashed color-mix(in srgb,var(--dsw-alias-label-secondary,#6b7280) 12%,transparent)}
.dsh-nature-group .dsh-nature-skill:first-of-type{border-top:0}
.dsh-nature-skill .dsh-nature-name{flex:none;width:200px;display:flex;align-items:baseline;gap:6px;
min-width:0;flex-wrap:wrap}
.dsh-nature-trigger{color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px;
font-family:inherit;opacity:.85}
.dsh-nature-desc{color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;min-width:0}
.dsh-nature-misslist{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0}
.dsh-nature-chip{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;
font-size:11px;line-height:17px;font-family:ui-monospace,SFMono-Regular,Consolas,Menlo,monospace;
background:color-mix(in srgb,var(--dsw-alias-label-secondary,#6b7280) 12%,transparent);
color:var(--dsw-alias-label-secondary,#6b7280)}
.dsh-nature-hint{color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;margin:8px 0 0}
.dsh-nature-statusline{color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;margin:10px 0 0;min-height:1em}
.dsh-nature-statusline[data-tone="error"]{color:var(--dsw-alias-state-error-primary,#d1242f)}
.dsh-nature-statusline[data-tone="ok"]{color:var(--dsw-alias-state-success,#1a7f37)}
.dsh-nature-footer{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
.dsh-nature-field{display:grid;grid-template-columns:170px minmax(0,1fr);gap:4px 16px;
align-items:center;padding:6px 0}
.dsh-nature-field>label{color:var(--dsw-alias-label-primary,inherit);cursor:pointer}
.dsh-nature-field-hint{grid-column:2;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;margin:0}
.dsh-nature-input{width:100%;box-sizing:border-box;height:30px;padding:0 10px;
border-radius:var(--dsw-radius-sm,8px);
border:1px solid color-mix(in srgb,var(--dsw-alias-label-secondary,#6b7280) 28%,transparent);
background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px}
.dsh-nature-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#2563eb);
box-shadow:0 0 0 1px var(--dsw-alias-brand-primary,#2563eb)}
@media (max-width:560px){.dsh-nature-field{grid-template-columns:1fr}
.dsh-nature-field-hint{grid-column:1}.dsh-nature-skill .dsh-nature-name{width:auto}}
.dsh-nature-iconbox{position:relative;display:inline-flex;align-items:center;justify-content:center}
.dsh-nature-dot{position:absolute;width:6px;height:6px;border-radius:50%;top:2px;inset-inline-end:2px;
background:var(--dsw-alias-brand-primary,#2563eb)}
.dsh-nature-badge{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;
font-size:11px;line-height:16px;
background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1242f) 12%,transparent);
color:var(--dsw-alias-state-error-primary,#d1242f)}
.dsh-nature-badge::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor}
`

    /** 只插一次样式表；class 名带插件前缀，不会碰官方样式（overclock 同款防重）。 */
    function installStyles() {
      if (typeof document === 'undefined') return
      const tagId = PACKAGE + '/nature.css'
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = PACKAGE
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** Remote 结果统一是 { ok, value } | { ok, error } 判别联合（overclock 同款解包）。 */
    function unwrap(result) {
      if (result !== null && typeof result === 'object') {
        if (result.ok === true) return result.value
        if (result.ok === false) throw new Error(result.error && result.error.message ? result.error.message : 'remote call failed')
      }
      throw new Error('remote returned a non-Result shape')
    }

    /** 把错误转成给状态行看的消息：命名空间未挂载这类环境错要用人话，不甩原始栈。 */
    function toMessage(error) {
      const raw = error && error.message ? error.message : String(error)
      // 这里只做**哨兵标记**，绝不丢掉原始错误：曾经把含 "not mounted" 的错误
      // 一律替换成 remoteNotMounted，导致宿主侧真实原因（方法未注册 / 参数不匹配 /
      // 服务没起来）永远看不到，排查只能靠反复重启（2026-11-04 踩到）。
      if (raw.indexOf('not mounted') !== -1) return 'remoteNotMounted: ' + raw
      if (raw.indexOf('remote timeout') === 0) return 'remoteTimeout: ' + raw
      return raw
    }

    /**
     * toMessage 的 'remoteNotMounted'/'remoteTimeout' 是字典哨兵不是文案：
     * 渲染时必须经 errText 查成对应 t('error.*')，否则页面显示裸 token。
     */
    function errText(t, error) {
      if (error === 'remoteNotMounted') return t('error.remoteNotMounted')
      if (error === 'remoteTimeout') return t('error.remoteTimeout')
      // 带原始信息的哨兵：先给人话，再把 raw cause 括起来，便于排查。
      if (typeof error === 'string' && error.indexOf('remoteNotMounted: ') === 0) {
        return t('error.remoteNotMounted') + ' [' + error.slice('remoteNotMounted: '.length) + ']'
      }
      if (typeof error === 'string' && error.indexOf('remoteTimeout: ') === 0) {
        return t('error.remoteTimeout') + ' [' + error.slice('remoteTimeout: '.length) + ']'
      }
      return error
    }

    /**
     * 带超时与重试的动作类远程调用。DSH 桌面壳的插件事件流
     * （dsh-app://app/plugins/events）实测会间歇性 net::ERR_FAILED
     * （2026-11-04 控制台实录），挂在其上的调用既不 resolve 也不 reject——
     * 所以每个动作调用都必须有超时，超时换拍重发；check/update/setConfig/
     * openSkillsDir 全部幂等（宿主 update 每次以「此刻」远端为准），重发无副作用。
     */
    function remoteCall(api, method, args, opts) {
      const safe = opts ?? {}
      const attempts = typeof safe.attempts === 'number' && safe.attempts > 0 ? safe.attempts : 3
      const timeoutMs = typeof safe.timeoutMs === 'number' && safe.timeoutMs > 0 ? safe.timeoutMs : 12000
      const gapMs = typeof safe.gapMs === 'number' && safe.gapMs > 0 ? safe.gapMs : 2000
      const once = () => new Promise((resolveCall, rejectCall) => {
        const timer = setTimeout(() => rejectCall(new Error('remote timeout: ' + method)), timeoutMs)
        try {
          Promise.resolve(api()[method].apply(null, args ?? []))
            .then(
              (value) => { clearTimeout(timer); resolveCall(value) },
              (error) => { clearTimeout(timer); rejectCall(error) },
            )
        } catch (error) {
          clearTimeout(timer)
          rejectCall(error)
        }
      })
      const attempt = (n) => once().catch((error) => {
        if (n >= attempts) throw error
        return new Promise((resolveTick) => setTimeout(resolveTick, gapMs)).then(() => attempt(n + 1))
      })
      return attempt(1)
    }

    /**
     * 宿主状态对象 → 视图模型。所有字段带形状守卫：宿主半少给一个字段，
     * 面板显示「—」而不是整页崩掉（徽标克制原则：失败静默降级 + 状态行明示）。
     * 宿主真实形状见文件头 Remote 契约段（lib/index.js:498-511）：
     * 基线在 manifest.headSha、远端在 headSha、错误原因在 lastError、
     * lastCheckStatus 取 'never'|'baseline-missing'|'upToDate'|'updateAvailable'|'error'。
     */
    /**
     * 安装快照归一化：宿主给什么都要能渲染。
     * 判定口径与宿主 scanInstallation 一致（有 SKILL.md 才算装上），
     * 这里只做形状守卫与"缺多少"的派生，不重新定义真假。
     *
     * known=false 是**关键**：宿主未就绪（升级后未重启、Remote 未挂载、首拍挂起）
     * 时拿不到 installation。把它渲染成"0/24 已安装"是误报 —— 用户会去重装本来就
     * 装好的技能。未知就显示未知，等状态刷新再出结论。
     */
    function installationView(raw) {
      const total = CATALOG_TOTAL
      if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.installed)) {
        return {
          installed: [], missing: [], total,
          installedCount: 0, complete: false, empty: false, partial: false,
          known: false,
        }
      }
      const s = raw
      const installed = [...new Set(s.installed.filter((n) => typeof n === 'string' && n.length > 0))]
      const missing = Array.isArray(s.missing)
        ? [...new Set(s.missing.filter((n) => typeof n === 'string' && n.length > 0))]
        : []
      // complete 只认宿主给的布尔；拿不到就用 missing 数量兜底，不假定"已装好"。
      const complete = typeof s.complete === 'boolean' ? s.complete : missing.length === 0 && installed.length > 0
      return {
        installed,
        missing,
        total,
        installedCount: installed.length,
        complete,
        empty: installed.length === 0,
        partial: installed.length > 0 && !complete,
        known: true,
      }
    }

    function statusView(raw) {
      const s = raw !== null && typeof raw === 'object' ? raw : {}
      const config = s.config !== null && typeof s.config === 'object' ? s.config : {}
      const changed = Array.isArray(s.changedSkills)
        ? s.changedSkills.filter((row) => row !== null && typeof row === 'object' && typeof row.name === 'string')
        : []
      const baselineSha = typeof s.baselineSha === 'string' && s.baselineSha.length > 0
        ? s.baselineSha
        : (s.manifest !== null && typeof s.manifest === 'object' && typeof s.manifest.headSha === 'string' && s.manifest.headSha.length > 0 ? s.manifest.headSha : null)
      const remoteSha = typeof s.remoteSha === 'string' && s.remoteSha.length > 0
        ? s.remoteSha
        : (typeof s.headSha === 'string' && s.headSha.length > 0 ? s.headSha : null)
      const lastCheckStatus = typeof s.lastCheckStatus === 'string' ? s.lastCheckStatus : null
      const installation = installationView(s.installation)
      // 只有「真的一条基线都没有」才算未建立基线。install() 已经把基线写进 manifest
      // 之后就不该再引导用户去跑 tools/baseline.cjs —— 否则「全套已就绪」和
      // 「未建立基线」会同屏打架（P2-5）。baseline-missing 仍然保留：那是真的没基线。
      const needsBaseline = installation.known
        ? (s.needsBaseline === true || (baselineSha === null && installation.empty))
        : (s.needsBaseline === true || lastCheckStatus === 'baseline-missing' || baselineSha === null)
      return {
        pluginVersion: typeof s.pluginVersion === 'string' && s.pluginVersion.length > 0 ? s.pluginVersion : PLUGIN_VERSION,
        needsBaseline,
        baselineSha,
        remoteSha,
        lastCheckedAt: typeof s.lastCheckedAt === 'string' ? s.lastCheckedAt : null,
        lastCheckStatus,
        lastCheckError: typeof s.lastError === 'string' ? s.lastError : (typeof s.lastCheckError === 'string' ? s.lastCheckError : null),
        updateAvailable: s.updateAvailable === true,
        changedSkills: changed.map((row) => ({
          name: row.name,
          added: typeof row.added === 'number' ? row.added : 0,
          removed: typeof row.removed === 'number' ? row.removed : 0,
          modified: typeof row.modified === 'number' ? row.modified : 0,
        })),
        config: {
          autoCheck: config.autoCheck === true,
          intervalHours: typeof config.intervalHours === 'number' && Number.isFinite(config.intervalHours) ? config.intervalHours : 6,
          targetDir: typeof config.targetDir === 'string' ? config.targetDir : '',
          mirror: typeof config.mirror === 'string' ? config.mirror : '',
        },
        // update()/install() 的明细（updated/skipped/removed/failures/installed）。
        // 宿主返回「完整状态 + outcome」，这里只做形状守卫，读不到就是 null。
        outcome: s.outcome !== null && typeof s.outcome === 'object' ? s.outcome : null,
        // 本地安装快照：三态渲染（未安装 / 部分安装 / 已完整）。
        installation: installationView(s.installation),
      }
    }

    function shortSha(sha) {
      return typeof sha === 'string' && sha.length > SHA_DISPLAY ? sha.slice(0, SHA_DISPLAY) : (sha ?? '')
    }

    function formatWhen(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return ''
      const at = new Date(iso)
      return Number.isNaN(at.getTime()) ? iso : at.toLocaleString()
    }

    /**
     * 红点横幅：updateAvailable > 未建基线 > 检查失败，三者取一；
     * 一切正常就不出横幅（克制：横幅常驻等于没有横幅）。
     */
    function statusBanner(t, status) {
      // 安装态优先：技能都没装齐时，"有更新"是个没有意义的结论。
      // known=false（宿主未就绪）时不宣称安装状态 —— 那是误报。
      const inst = status.installation
      if (!inst.known) return null
      // 操作失败（断网/权限）优先于安装态：用户点了安装却失败时，必须先看到
      // 失败原因，而不是被「未检测到技能」引导去再点一次（P1-1 实测：断网时
      // 横幅永远停在 empty 分支，lastError 永远露不出来）。
      if (status.lastCheckStatus === 'error' && status.lastCheckError) {
        return h('div', { className: 'dsh-nature-banner', 'data-tone': 'error', role: 'status' },
          h('span', { className: 'dsh-nature-banner-dot', 'aria-hidden': 'true' }),
          h('span', null, t('banner.error', { message: status.lastCheckError })),
        )
      }
      if (inst.empty) {
        return h('div', { className: 'dsh-nature-banner', 'data-tone': 'warn', role: 'status' },
          h('span', { className: 'dsh-nature-banner-dot', 'aria-hidden': 'true' }),
          h('span', null, t('banner.notInstalled')),
        )
      }
      if (inst.partial) {
        return h('div', { className: 'dsh-nature-banner', 'data-tone': 'warn', role: 'status' },
          h('span', { className: 'dsh-nature-banner-dot', 'aria-hidden': 'true' }),
          h('span', null, t('banner.partialInstalled', { have: inst.installedCount, total: inst.total, miss: inst.missing.length })),
        )
      }
      if (status.updateAvailable) {
        return h('div', { className: 'dsh-nature-banner', 'data-tone': 'update', role: 'status' },
          h('span', { className: 'dsh-nature-banner-dot', 'aria-hidden': 'true' }),
          h('span', null, t('banner.update') + ' · ' + t('updates.changedCount', { n: status.changedSkills.length })),
        )
      }
      if (status.needsBaseline) {
        return h('div', { className: 'dsh-nature-banner', 'data-tone': 'warn', role: 'status' },
          h('span', { className: 'dsh-nature-banner-dot', 'aria-hidden': 'true' }),
          h('span', null, t('banner.needsBaseline')),
        )
      }
      if (status.lastCheckStatus === 'error') {
        return h('div', { className: 'dsh-nature-banner', 'data-tone': 'error', role: 'status' },
          h('span', { className: 'dsh-nature-banner-dot', 'aria-hidden': 'true' }),
          h('span', null, t('banner.error', { message: status.lastCheckError ?? '' })),
        )
      }
      return null
    }

    /** 状态头四行：插件版本 / 基线版本 / 远端版本 / 上次检查。 */
    function StatusHeader(props) {
      const { t, status } = props
      const baselineCell = status.needsBaseline || status.baselineSha === null
        ? t('status.noBaseline')
        : h('span', { className: 'dsh-nature-mono', title: status.baselineSha }, shortSha(status.baselineSha))
      const remoteCell = status.remoteSha === null
        ? '—'
        : h('span', { className: 'dsh-nature-mono', title: status.remoteSha }, shortSha(status.remoteSha))
      const lastCheckedCell = status.lastCheckedAt === null
        ? t('status.never')
        : formatWhen(status.lastCheckedAt) +
          (status.lastCheckStatus === 'error' ? ' · ' + t('status.resultError') : '')
      return h('dl', { className: 'dsh-nature-rows' },
        h('dt', null, t('status.pluginVersion')), h('dd', null, status.pluginVersion === '' ? '—' : status.pluginVersion),
        h('dt', null, t('status.baseline')), h('dd', null, baselineCell),
        h('dt', null, t('status.remote')), h('dd', null, remoteCell),
        h('dt', null, t('status.lastChecked')), h('dd', null, lastCheckedCell),
      )
    }

    /**
     * 安装状态卡：整套 nature-skills 的**本地完整性**总览。
     *
     * 三态（与宿主的 scanInstallation 同口径：有 SKILL.md 才算装）：
     *   - empty   一个都没有 → 引导"安装全套"
     *   - partial 只有一部分 → 说明缺哪些，引导"自动补全"（顺带刷新已有的）
     *   - complete 全套齐了 → 只显示计数，不出按钮（克制：没有动作就不占位）
     *
     * 这一卡是用户第一次装插件后唯一有意义的入口：没有技能时，
     * "检查更新/更新中心"全都没有操作对象。
     */
    function InstallCard(props) {
      const { t, api, status, onRefresh } = props
      const inst = status.installation
      const [phase, setPhase] = React.useState('')
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')

      const run = (names) => {
        // 幂等：宿主 runInstall 以"此刻远端"为准，重复点击只会重装同一批。
        if (phase !== '') return
        setPhase('install')
        setError('')
        setNotice('')
        // 安装是分钟级操作（814 个文件）：60s×3 必然超时重试，三份安装叠加写同一目录。
        // 单次给足 5 分钟、最多 2 次；runInstall 本身幂等（同 sha 同内容、原子写），
        // 重发只是重跑一遍，不会损坏文件。
        remoteCall(api, 'installSkills', [names], { attempts: 2, timeoutMs: 300000 })
          .then((remote) => {
            const next = statusView(unwrap(remote))
            onRefresh(next)
            const outcome = next.outcome
            if (outcome !== null) {
              const failed = Array.isArray(outcome.failures) ? outcome.failures.length : 0
              // 以宿主的 ok 为准，不看"数了数组长度"：网络层失败时返回的是
              // failures:[] + error，只数长度会显示成绿色「已安装 0 个」。(P1-2)
              if (outcome.ok === false) {
                setError(outcome.error !== undefined && outcome.error !== null
                  ? String(outcome.error)
                  : t('install.failed', { n: failed }))
              } else {
                const done = Array.isArray(outcome.installed) ? outcome.installed.length : 0
                setNotice(failed > 0
                  ? t('install.partialDone', { done, failed })
                  : t('install.done', { n: done }))
              }
            }
          })
          .catch((e) => setError(toMessage(e)))
          .then(() => { setPhase('') })
      }

      const busy = phase !== ''
      // 未知态：宿主还没给状态（升级未重启 / Remote 未挂载）。
      // 不给安装按钮 —— 那时"点安装"会打到未注册的方法上，报错比没按钮更糟。
      if (!inst.known) {
        // 未知态把启动诊断一并显示：这是用户唯一能提供给我的有效线索。
        const diag = bootDiagnostics.mountError !== ''
          ? t('install.diagMountFailed', { message: bootDiagnostics.mountError })
          : t('install.diagNoNamespace')
        return h('section', { className: 'dsh-nature-card' },
          h('h3', null, t('install.title')),
          h('p', { className: 'dsh-nature-statusline' }, t('install.unknown')),
          h('p', { className: 'dsh-nature-hint dsh-nature-mono' }, diag),
        )
      }
      // 三态文案。complete 时不渲染卡片主体（只有一行计数）。
      const tone = inst.complete ? 'ok' : 'warn'
      const headline = inst.complete
        ? t('install.complete', { n: inst.installedCount })
        : inst.empty
          ? t('install.empty')
          : t('install.partialShort', { have: inst.installedCount, total: inst.total, miss: inst.missing.length })

      if (inst.complete) {
        return h('section', { className: 'dsh-nature-card' },
          h('h3', null, t('install.title')),
          h('p', { className: 'dsh-nature-statusline', 'data-tone': 'ok' }, headline),
          notice === '' ? null : h('p', { className: 'dsh-nature-statusline', 'data-tone': 'ok' }, notice),
        )
      }

      return h('section', { className: 'dsh-nature-card', 'data-tone': tone },
        h('h3', null, t('install.title'),
          h('span', { className: 'dsh-nature-count' }, t('install.progress', { have: inst.installedCount, total: inst.total }))),
        h('p', { className: 'dsh-nature-statusline', 'data-tone': tone }, headline),
        h('p', { className: 'dsh-nature-hint' }, inst.empty ? t('install.emptyHint') : t('install.partialHint', { n: inst.missing.length })),
        inst.missing.length > 0 && !inst.empty
          ? h('div', { className: 'dsh-nature-misslist' },
              inst.missing.slice(0, 12).map((name) => h('span', { key: name, className: 'dsh-nature-chip' }, name)),
              inst.missing.length > 12
                ? h('span', { className: 'dsh-nature-chip' }, '+' + (inst.missing.length - 12))
                : null,
            )
          : null,
        h('div', { className: 'dsh-nature-btnrow' },
          h('button', {
            type: 'button',
            className: 'dsh-nature-btn dsh-nature-btn-primary',
            disabled: busy,
            onClick: () => run(inst.empty ? undefined : inst.missing),
          }, phase === 'install'
            ? t('install.installing')
            : (inst.empty ? t('install.installAll') : t('install.fillMissing', { n: inst.missing.length }))),
          // 部分安装时额外给"全部重装/刷新"，用户明确要求"更新已有的部分"。
          inst.empty ? null : h('button', {
            type: 'button',
            className: 'dsh-nature-btn',
            disabled: busy,
            onClick: () => run(undefined),
          }, t('install.refreshAll')),
          h('button', {
            type: 'button', className: 'dsh-nature-btn', disabled: busy,
            onClick: () => {
              setError('')
              remoteCall(api, 'openSkillsDir', []).then(() => {}).catch((e) => setError(toMessage(e)))
            },
          }, t('install.openDir')),
        ),
        h('p', { className: 'dsh-nature-hint' }, t('install.pathHint', { dir: status.config.targetDir })),
        notice === '' ? null : h('p', { className: 'dsh-nature-statusline', 'data-tone': 'ok' }, notice),
        error === '' ? null : h('p', { className: 'dsh-nature-statusline', 'data-tone': 'error' }, t('error.action', { message: errText(t, error) })),
      )
    }

    /**
     * 更新中心：检查 / 全部更新 / 更新所选。
     * 「全部更新」显式传全部变化名单而不是省略参数——「更新哪些」由客户端说清楚，
     * 不依赖网关对缺省参数的处理方式。
     */
    function UpdateCenter(props) {
      const { t, api, status, onRefresh } = props
      const [selected, setSelected] = React.useState({})
      const [phase, setPhase] = React.useState('')
      const [error, setError] = React.useState('')
      /** 操作结果行（非错误）：更新完说清楚动了哪些 skill，否则界面只"红点消失"。 */
      const [notice, setNotice] = React.useState('')
      const changed = status.changedSkills

      const checkedNames = []
      for (const row of changed) {
        if (selected[row.name] === true) checkedNames.push(row.name)
      }

      const run = React.useCallback((kind, names) => {
        // 入口在 phase !== '' 时直接返回，所以同一时刻最多只有一个动作在飞，
        // 收尾可以无条件清 busy——不能用闭包里的 phase 做比对（它永远是调用时的 ''）。
        // remoteCall 自带超时+重试：事件流挂起时按钮最迟 ~40s 后恢复可点，不再死锁。
        if (phase !== '') return
        setPhase(kind)
        setError('')
        setNotice('')
        remoteCall(api, kind === 'check' ? 'check' : 'update', kind === 'check' ? [] : [names])
          .then((remote) => {
            setSelected({})
            const next = statusView(unwrap(remote))
            onRefresh(next)
            if (kind === 'update' && next.outcome !== null) {
              const done = Array.isArray(next.outcome.updated) ? next.outcome.updated.length : 0
              const failed = Array.isArray(next.outcome.failures) ? next.outcome.failures.length : 0
              setNotice(failed > 0
                ? t('updates.resultPartial', { done, failed })
                : t('updates.resultDone', { n: done }))
            }
          })
          .catch((e) => setError(toMessage(e)))
          .then(() => { setPhase('') })
      }, [api, onRefresh, phase])

      const busy = phase !== ''
      const checking = phase === 'check'

      return h('div', null,
        h('div', { className: 'dsh-nature-btnrow' },
          h('button', {
            type: 'button', className: 'dsh-nature-btn', disabled: busy,
            onClick: () => run('check', undefined),
          }, checking ? t('updates.checking') : t('updates.check')),
          h('button', {
            type: 'button', className: 'dsh-nature-btn dsh-nature-btn-primary',
            disabled: busy || changed.length === 0,
            onClick: () => run('update', changed.map((row) => row.name)),
          }, phase === 'update' ? t('updates.updating') : t('updates.updateAll')),
          h('button', {
            type: 'button', className: 'dsh-nature-btn',
            disabled: busy || checkedNames.length === 0,
            onClick: () => run('update', checkedNames),
          }, t('updates.updateSelected', { n: checkedNames.length })),
        ),
        changed.length === 0
          ? h('p', { className: 'dsh-nature-hint' }, t('updates.none'))
          : h('div', { className: 'dsh-nature-list' },
              changed.map((row) => h('label', { key: row.name, className: 'dsh-nature-row' },
                h('input', {
                  type: 'checkbox',
                  className: 'dsh-nature-check',
                  checked: selected[row.name] === true,
                  disabled: busy,
                  onChange: (event) => setSelected((current) => ({ ...current, [row.name]: event.target.checked })),
                }),
                h('span', { className: 'dsh-nature-name' }, row.name),
                h('span', { className: 'dsh-nature-files' }, t('updates.files', row)),
              )),
              h('p', { className: 'dsh-nature-hint' }, t('updates.hint')),
            ),
        notice === '' ? null : h('p', { className: 'dsh-nature-statusline', 'data-tone': 'ok' }, notice),
        error === '' ? null : h('p', { className: 'dsh-nature-statusline', 'data-tone': 'error' }, t('error.action', { message: errText(t, error) })),
      )
    }

    /** 技能目录：24 个 nature skills 静态分组列出（digest §a），不参与任何更新逻辑。 */
    function Catalog(props) {
      const { t } = props
      return h('section', { className: 'dsh-nature-card' },
        h('h3', null, t('catalog.title'), h('span', { className: 'dsh-nature-count' }, t('catalog.count', { n: CATALOG_TOTAL }))),
        h('p', { className: 'dsh-nature-hint' }, t('catalog.hint')),
        CATALOG.map((group) => h('div', { key: group.key, className: 'dsh-nature-group' },
          h('h4', null, t(group.key), h('span', { className: 'dsh-nature-count' }, String(group.skills.length))),
          group.skills.map((name) => {
            const trigger = TRIGGER_ALIASES[name]
            return h('div', { key: name, className: 'dsh-nature-skill' },
              h('span', { className: 'dsh-nature-name' },
                name,
                trigger === undefined
                  ? null
                  : h('span', { className: 'dsh-nature-trigger', title: t('catalog.triggerHint', { trigger }) },
                      '→ ' + trigger),
              ),
              h('span', { className: 'dsh-nature-desc' }, t('skill.' + name)),
            )
          }),
        )),
      )
    }

    /** 侧栏图标：叶片 + 笔尖，单色 currentColor；updateAvailable 时右上角 6px 品牌色圆点。 */
    function leafNibGlyph(size) {
      return h('svg', {
        className: 'dsh-nature-glyph',
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', { key: 'blade', d: 'M8 16C8 9.5 13.4 4 20.5 3.5C21 10.5 15.6 16 8.5 16.5Z' }),
        h('path', { key: 'vein', d: 'M8.7 15.8C11.5 12 15 8.6 19.4 4.9' }),
        h('path', { key: 'nib', d: 'M3.5 20.5 6.5 14.5 9.5 17.5Z' }),
        h('path', { key: 'slit', d: 'M3.5 20.5 6 18' }),
      )
    }

    /**
     * 挂载即取状态的共用钩子。DSH 网关实测会把「面板挂载后的第一拍」远程调用挂起
     * （不 resolve 也不 reject，下一次任意输入事件才冲刷，静置 20s 不自愈；
     * 2026-11-04 实机验收记录），所以 2s 没回音就换一拍重试，最多 5 次，
     * 仍挂起才报 remoteNotMounted。每次尝试递增共享 seq：
     * 迟到的旧结果不许覆盖新结果。apply(next, errToken)：
     * next 为 statusView 对象（成功）或 null（失败）。
     */
    /**
     * @param method 首拍调用的远端方法，默认 'status'。
     *        inspection 类面板传 'inspect'：它会先扫一遍磁盘再回状态，
     *        避免首屏读到"启动扫描还没跑完"的旧快照（0 个已安装 → 误报未安装）。
     *        宿主半若没有这个方法（旧版本），自动退回 status。
     */
    function useStatusWithRetry(api, seqRef, apply, method) {
      const ownSeq = React.useRef(0)
      const seq = seqRef !== undefined && seqRef !== null ? seqRef : ownSeq
      const call = method === undefined ? 'status' : method
      React.useEffect(() => {
        let alive = true
        let timer = null
        const attempt = (n) => {
          const ticket = ++seq.current
          let pending
          try {
            const namespace = api()
            // 方法不存在（宿主是旧版本）就退回 status：宁可读到旧快照，
            // 也不要整块面板因为 "not a function" 直接失败。
            const fn = typeof namespace[call] === 'function' ? namespace[call] : namespace.status
            pending = Promise.resolve(fn.apply(namespace, []))
          } catch (error) {
            pending = Promise.reject(error)
          }
          let settled = false
          const done = (fn) => {
            settled = true
            if (!alive || ticket !== seq.current) return
            fn()
          }
          pending.then(
            (remote) => done(() => apply(statusView(unwrap(remote)), '')),
            (error) => done(() => apply(null, toMessage(error))),
          )
          setTimeout(() => {
            if (settled || !alive) return
            settled = true
            if (n < 5) timer = setTimeout(() => attempt(n + 1), 1200)
            else apply(null, 'remoteNotMounted')
          }, 2000)
        }
        attempt(0)
        return () => {
          alive = false
          if (timer !== null) clearTimeout(timer)
        }
      }, [api])
    }

    /**
     * 侧栏图标组件。ownerProps（契约 ui-internals §3）只有 { size, active }；
     * api 来自注册项的 inject。轮询 10 分钟保红点新鲜，卸载时清理；
     * 轮询失败一律静默——红点晚 10 分钟出现没有伤害，不该在侧栏刷错误。
     */
    function PanelIcon(props) {
      const safe = props ?? {}
      const size = typeof safe.size === 'number' && safe.size > 0 ? safe.size : 20
      const api = safe.api
      const [updateAvailable, setUpdateAvailable] = React.useState(false)

      // 挂载重试（见 useStatusWithRetry）+ 10 分钟轮询：两者都只推一个布尔，
      // 结果同源，迟到互覆盖无害。首拍挂起时重试保证红点尽快就位。
      useStatusWithRetry(api, undefined, (next) => {
        if (next !== null) setUpdateAvailable(next.updateAvailable === true)
        /* err 静默：红点不该在侧栏刷错误 */
      })
      React.useEffect(() => {
        let alive = true
        const read = () => {
          try {
            Promise.resolve(api().status())
              .then((remote) => {
                if (alive) setUpdateAvailable(unwrap(remote).updateAvailable === true)
              })
              .catch(() => {})
          } catch {
            /* 命名空间未挂载等：静默，下个周期再试 */
          }
        }
        const timer = setInterval(read, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [api])

      return h('span', { className: 'dsh-nature-iconbox' },
        leafNibGlyph(size),
        updateAvailable ? h('span', { className: 'dsh-nature-dot' }) : null,
      )
    }

    /** 工作台主面板（main 槽，key=dsh-nature）。挂载即 status()，动作后经 onRefresh 刷新。 */
    function WorkbenchPanel(props) {
      const safe = props ?? {}
      const t = makeText(safe.t)
      const api = safe.api
      const [status, setStatus] = React.useState(() => statusView(null))
      const [loadError, setLoadError] = React.useState('')
      const [dirError, setDirError] = React.useState('')
      const seq = React.useRef(0)

      const refresh = React.useCallback(() => {
        const ticket = ++seq.current
        let pending
        try {
          pending = Promise.resolve(api().status())
        } catch (error) {
          pending = Promise.reject(error)
        }
        return pending
          .then((remote) => {
            if (ticket !== seq.current) return
            setStatus(statusView(unwrap(remote)))
            setLoadError('')
          })
          .catch((error) => {
            if (ticket !== seq.current) return
            setLoadError(toMessage(error))
          })
      }, [api])

      // inspect：先扫磁盘再回状态，首屏不会拿旧快照误报安装状态。
      useStatusWithRetry(api, seq, (next, err) => {
        if (err !== '') {
          setLoadError(err)
          return
        }
        setStatus(next)
        setLoadError('')
      }, 'inspect')

      const openDir = () => {
        setDirError('')
        remoteCall(api, 'openSkillsDir', [])
          .then((remote) => { unwrap(remote) })
          .catch((error) => setDirError(toMessage(error)))
      }

      const openRepo = () => {
        try {
          window.open(REPO_URL, '_blank', 'noopener')
        } catch {
          /* 弹窗被拦截时静默：链接按钮不是关键路径 */
        }
      }

      // 两层：外层 .dsh-nature-scroll 是**唯一**滚动容器（见 CSS 注释），
      // 内层 .dsh-nature-page 只负责居中与内边距。把它们合成一层会让
      // max-width 与滚动条互相干扰（滚动条被推到 max-width 之外）。
      return h('div', { className: 'dsh-nature-scroll', 'data-dsh-nature-scroll': '' },
        h('div', { className: 'dsh-nature-page', 'data-dsh-nature': '' },
          statusBanner(t, status),
          loadError === '' ? null : h('p', { className: 'dsh-nature-statusline', 'data-tone': 'error' }, t('error.load', { message: errText(t, loadError) })),
          h('section', { className: 'dsh-nature-card' },
            h(StatusHeader, { t, status }),
          ),
          // 安装状态在最前：没有技能时检查/更新都没有操作对象。
          h(InstallCard, { t, api, status, onRefresh: (next) => setStatus(next) }),
          h('section', { className: 'dsh-nature-card' },
            h('h3', null, t('updates.title')),
            h(UpdateCenter, { t, api, status, onRefresh: (next) => setStatus(next) }),
          ),
          h(Catalog, { t }),
          h('div', { className: 'dsh-nature-footer' },
            h('button', { type: 'button', className: 'dsh-nature-btn', onClick: openDir }, t('footer.openDir')),
            h('button', { type: 'button', className: 'dsh-nature-btn', onClick: openRepo }, t('footer.github')),
          ),
          dirError === '' ? null : h('p', { className: 'dsh-nature-statusline', 'data-tone': 'error' }, t('error.action', { message: errText(t, dirError) })),
        ),
      )
    }

    /**
     * 设置页（settings.section 槽）。
     * 表单改动只落内存（draft），点「保存设置」才 setConfig——生态范式
     * （ptc-ecosystem-research §3.5 whale 的「取消/恢复默认/保存」约定）。
     * 页面顶部 updateAvailable 时渲染红点横幅：设置导航行无徽标座位是官方事实
     * （ui-internals §4），红点放页面内容头部。
     */
    function SettingsPanel(props) {
      const safe = props ?? {}
      const t = makeText(safe.t)
      const api = safe.api
      const [status, setStatus] = React.useState(() => statusView(null))
      const [loadError, setLoadError] = React.useState('')
      /** draft 的 interval 用字符串承载输入框原值，保存时才解析校验。 */
      const [draft, setDraft] = React.useState(null)
      const savedRef = React.useRef('')
      const seq = React.useRef(0)
      const [phase, setPhase] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [error, setError] = React.useState('')

      const refresh = React.useCallback(() => {
        const ticket = ++seq.current
        let pending
        try {
          pending = Promise.resolve(api().status())
        } catch (e) {
          pending = Promise.reject(e)
        }
        return pending
          .then((remote) => {
            if (ticket !== seq.current) return
            const next = statusView(unwrap(remote))
            setStatus(next)
            setLoadError('')
            // 草稿只在第一次拿到配置时初始化：之后刷新不能盖掉用户正在编辑的内容。
            if (savedRef.current === '') {
              savedRef.current = JSON.stringify(next.config)
              setDraft({
                autoCheck: next.config.autoCheck,
                interval: String(next.config.intervalHours),
                targetDir: next.config.targetDir,
                mirror: next.config.mirror,
              })
            }
          })
          .catch((e) => {
            if (ticket !== seq.current) return
            setLoadError(toMessage(e))
          })
      }, [api])

      useStatusWithRetry(api, seq, (next, err) => {
        if (err !== '') {
          setLoadError(err)
          return
        }
        setStatus(next)
        setLoadError('')
        // 草稿只在第一次拿到配置时初始化：之后刷新不能盖掉用户正在编辑的内容。
        if (savedRef.current === '') {
          savedRef.current = JSON.stringify(next.config)
          setDraft({
            autoCheck: next.config.autoCheck,
            interval: String(next.config.intervalHours),
            targetDir: next.config.targetDir,
            mirror: next.config.mirror,
          })
        }
      }, 'inspect')

      const dirty = draft !== null && savedRef.current !== '' &&
        JSON.stringify({
          autoCheck: draft.autoCheck,
          intervalHours: Number(draft.interval),
          targetDir: draft.targetDir.trim(),
          mirror: draft.mirror.trim(),
        }) !== savedRef.current

      const save = () => {
        if (draft === null || phase !== '') return
        const interval = Number(draft.interval)
        if (!Number.isFinite(interval) || interval < 0) {
          setError(t('settings.invalidInterval'))
          return
        }
        // 宿主对空 targetDir 直接抛错（index.js:538-541），这里先用人话拦住。
        if (draft.targetDir.trim().length === 0) {
          setError(t('settings.invalidTargetDir'))
          return
        }
        setPhase('save')
        setError('')
        setNotice('')
        remoteCall(api, 'setConfig', [{
          autoCheck: draft.autoCheck,
          intervalHours: interval,
          targetDir: draft.targetDir.trim(),
          mirror: draft.mirror.trim(),
        }])
          .then((remote) => {
            const next = statusView(unwrap(remote))
            setStatus(next)
            savedRef.current = JSON.stringify(next.config)
            setDraft({
              autoCheck: next.config.autoCheck,
              interval: String(next.config.intervalHours),
              targetDir: next.config.targetDir,
              mirror: next.config.mirror,
            })
            setNotice(t('settings.saved'))
          })
          .catch((e) => setError(toMessage(e)))
          .then(() => { setPhase('') })
      }

      const checkNow = () => {
        if (phase !== '') return
        setPhase('check')
        setError('')
        setNotice('')
        remoteCall(api, 'check', [])
          .then((remote) => { setStatus(statusView(unwrap(remote))) })
          .catch((e) => setError(toMessage(e)))
          .then(() => { setPhase('') })
      }

      const updateAll = () => {
        if (phase !== '' || status.changedSkills.length === 0) return
        setPhase('update')
        setError('')
        setNotice('')
        remoteCall(api, 'update', [status.changedSkills.map((row) => row.name)])
          .then((remote) => {
            const next = statusView(unwrap(remote))
            setStatus(next)
            if (next.outcome !== null) {
              const done = Array.isArray(next.outcome.updated) ? next.outcome.updated.length : 0
              const failed = Array.isArray(next.outcome.failures) ? next.outcome.failures.length : 0
              setNotice(failed > 0 ? t('updates.resultPartial', { done, failed }) : t('updates.resultDone', { n: done }))
            }
          })
          .catch((e) => setError(toMessage(e)))
          .then(() => { setPhase('') })
      }

      const busy = phase !== ''
      const statusLine =
        status.updateAvailable
          ? t('banner.update') + ' · ' + t('updates.changedCount', { n: status.changedSkills.length })
          : status.needsBaseline
            ? t('status.needsBaseline')
            : status.lastCheckStatus === 'error'
              ? t('banner.error', { message: status.lastCheckError ?? '' })
              : status.lastCheckedAt !== null
                ? t('status.uptodate') + ' · ' + t('status.lastChecked') + ' ' + formatWhen(status.lastCheckedAt)
                : t('status.neverChecked')

      return h('div', { className: 'dsh-nature-page', 'data-dsh-nature-settings': '' },
        statusBanner(t, status),
        loadError === '' ? null : h('p', { className: 'dsh-nature-statusline', 'data-tone': 'error' }, t('error.load', { message: errText(t, loadError) })),
        h('section', { className: 'dsh-nature-card' },
          draft === null ? null : h('div', null,
            h('div', { className: 'dsh-nature-field' },
              h('label', { htmlFor: 'dsh-nature-autocheck' }, t('settings.autoCheck')),
              h('input', {
                id: 'dsh-nature-autocheck',
                type: 'checkbox',
                className: 'dsh-nature-check',
                checked: draft.autoCheck === true,
                onChange: (event) => setDraft((current) => ({ ...current, autoCheck: event.target.checked })),
              }),
              h('p', { className: 'dsh-nature-field-hint' }, t('settings.autoCheckHint')),
            ),
            h('div', { className: 'dsh-nature-field' },
              h('label', { htmlFor: 'dsh-nature-interval' }, t('settings.interval')),
              h('input', {
                id: 'dsh-nature-interval',
                type: 'number',
                className: 'dsh-nature-input',
                min: 0,
                step: 1,
                value: draft.interval,
                onChange: (event) => setDraft((current) => ({ ...current, interval: event.target.value })),
              }),
              h('p', { className: 'dsh-nature-field-hint' }, t('settings.intervalHint')),
            ),
            h('div', { className: 'dsh-nature-field' },
              h('label', { htmlFor: 'dsh-nature-targetdir' }, t('settings.targetDir')),
              h('input', {
                id: 'dsh-nature-targetdir',
                type: 'text',
                className: 'dsh-nature-input dsh-nature-mono',
                value: draft.targetDir,
                spellCheck: false,
                onChange: (event) => setDraft((current) => ({ ...current, targetDir: event.target.value })),
              }),
              h('p', { className: 'dsh-nature-field-hint' }, t('settings.targetDirHint')),
            ),
            h('div', { className: 'dsh-nature-field' },
              h('label', { htmlFor: 'dsh-nature-mirror' }, t('settings.mirror')),
              h('input', {
                id: 'dsh-nature-mirror',
                type: 'text',
                className: 'dsh-nature-input dsh-nature-mono',
                value: draft.mirror,
                spellCheck: false,
                onChange: (event) => setDraft((current) => ({ ...current, mirror: event.target.value })),
              }),
              h('p', { className: 'dsh-nature-field-hint' }, t('settings.mirrorHint')),
            ),
            h('div', { className: 'dsh-nature-btnrow' },
              h('button', {
                type: 'button', className: 'dsh-nature-btn dsh-nature-btn-primary',
                disabled: busy || !dirty, onClick: save,
              }, phase === 'save' ? t('settings.saving') : t('settings.save')),
              h('button', {
                type: 'button', className: 'dsh-nature-btn', disabled: busy, onClick: checkNow,
              }, phase === 'check' ? t('updates.checking') : t('settings.checkNow')),
              h('button', {
                type: 'button', className: 'dsh-nature-btn',
                disabled: busy || status.changedSkills.length === 0, onClick: updateAll,
              }, phase === 'update' ? t('updates.updating') : t('settings.updateAll')),
            ),
            dirty ? h('p', { className: 'dsh-nature-statusline' }, t('settings.dirty')) : null,
            notice === '' ? null : h('p', { className: 'dsh-nature-statusline', 'data-tone': 'ok' }, notice),
            error === '' ? null : h('p', { className: 'dsh-nature-statusline', 'data-tone': 'error' }, t('error.action', { message: errText(t, error) })),
          ),
        ),
        h(InstallCard, { t, api, status, onRefresh: (next) => setStatus(next) }),
        h('section', { className: 'dsh-nature-card' },
          h(StatusHeader, { t, status }),
          h('p', { className: 'dsh-nature-statusline' }, statusLine),
        ),
      )
    }

    /** 插件管理器详情页徽标（plugins.detail.badge）：只在 updateAvailable 时出现。 */
    function DetailBadge(props) {
      const safe = props ?? {}
      const t = makeText(safe.t)
      const api = safe.api
      const [updateAvailable, setUpdateAvailable] = React.useState(false)

      useStatusWithRetry(api, undefined, (next) => {
        if (next !== null) setUpdateAvailable(next.updateAvailable === true)
        /* err 静默：徽标克制原则，失败不占官方座位 */
      })

      if (!updateAvailable) return null
      return h('span', { className: 'dsh-nature-badge', role: 'status' }, t('badge.update'))
    }

    /**
     * 插件管理器详情页的精简状态卡（plugins.bundle.config，key=包名）。
     * 设计稿要求「跳设置按钮」，但 DSH 没有可编程打开设置页的官方 API（见文件头说明），
     * 这里降级为：状态行 + 「打开技能目录」（openSkillsDir，有据可依）+ 设置路径提示。
     */
    function BundleCard(props) {
      const safe = props ?? {}
      const t = makeText(safe.t)
      const api = safe.api
      const [status, setStatus] = React.useState(() => statusView(null))
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      useStatusWithRetry(api, undefined, (next) => {
        if (next !== null) setStatus(next)
        /* err 静默，与原行为一致：状态卡失败显示初始「—」而不是错误 */
      })

      const openDir = () => {
        setBusy(true)
        setError('')
        remoteCall(api, 'openSkillsDir', [])
          .then((remote) => { unwrap(remote) })
          .catch((e) => setError(toMessage(e)))
          .then(() => { setBusy(false) })
      }

      const line =
        status.updateAvailable
          ? t('banner.update') + ' · ' + t('updates.changedCount', { n: status.changedSkills.length })
          : status.needsBaseline
            ? t('status.needsBaseline')
            : status.lastCheckedAt !== null
              ? t('status.uptodate') + ' · ' + t('status.lastChecked') + ' ' + formatWhen(status.lastCheckedAt)
              : t('status.neverChecked')

      return h('div', { className: 'dsh-nature-card', 'data-dsh-nature-card': '' },
        h('p', { className: 'dsh-nature-statusline' }, line),
        error === '' ? null : h('p', { className: 'dsh-nature-statusline', 'data-tone': 'error' }, t('error.action', { message: errText(t, error) })),
        h('div', { className: 'dsh-nature-btnrow' },
          h('button', { type: 'button', className: 'dsh-nature-btn', disabled: busy, onClick: openDir }, t('card.openDir')),
        ),
        h('p', { className: 'dsh-nature-hint' }, t('card.settingsHint')),
      )
    }

    /** 失败必须看得见（控制台），但绝不允许把异常抛回 apply() 外层炸掉官方 bundle。 */
    function warn(scope, error) {
      console.warn('[' + PACKAGE + '] ' + scope + ':', error)
    }

    /** 单个槽位的注册失败只损失那一个入口，不许连带（copy-session-id 的教训）。 */
    function safeSlot(ctx, owner, optionsFactory, label) {
      try {
        ctx.effect(() => ctx.slots.inject(owner, optionsFactory), PACKAGE + ':' + label)
      } catch (error) {
        warn(owner, error)
      }
    }
    /**
     * 启动诊断：$mount 的真实结果。命名空间没挂上时，面板要能说清是哪一步坏的 ——
     * 只报「宿主服务未就绪」等于没说，用户和排查者都无从下手。
     */
    const bootDiagnostics = { mountError: '', mounted: false }


    async function apply(ctx) {
      // 启动分三段各自兜底：样式、文案、Remote 挂载任一失败，都只损失对应能力，
      // 绝不让异常穿出 apply() —— 那会把整个 client bundle（含官方）拖死。
      // Remote 挂载失败时 UI 仍要出现：面板自己会走 useStatusWithRetry 的
      // remoteNotMounted 分支给出可读提示，而不是"插件没入口"。
      try {
        installStyles()
      } catch (error) {
        warn('installStyles', error)
      }

      try {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARY), PACKAGE + ': dictionaries')
      } catch (error) {
        warn('locale.register', error)
      }

      // 记录 $mount 的真实结果：命名空间没挂上时，面板要能说清是哪一步坏的。
      // （以前这里只会冒出「宿主服务未就绪」一句，真实原因被 toMessage 吞掉，
      //   排查只能靠反复重启 —— 2026-08 起就吃过一次，2026-11 又吃一次。）
      bootDiagnostics.mountError = ''
      // 先确认 ctx.remote 本身在不在：这是最容易坏的一步，而且坏了以后
      // $mount 根本不会被调用，之前只会报一句「宿主服务未就绪」。
      if (ctx.remote === undefined || ctx.remote === null || typeof ctx.remote.$mount !== 'function') {
        bootDiagnostics.mountError = 'ctx.remote is unavailable (typeof=' + typeof ctx.remote + ')'
        warn('remote.missing', bootDiagnostics.mountError)
      } else {
        // 挂载前自查方法名：撞上 gateway 的保留名会让**整个命名空间**挂不上，
        // 而错误只在控制台一闪（表现为「宿主服务未就绪」）。宁可这里直接报清楚。
        for (const descriptor of CONTRIBUTION.descriptors) {
          try {
            assertRemoteMethodName(descriptor.method)
          } catch (error) {
            bootDiagnostics.mountError = error.message
            warn('remote.method-name', error)
          }
        }
        try {
          await ctx.remote.$mount(CONTRIBUTION)
          bootDiagnostics.mounted = true
        } catch (error) {
          bootDiagnostics.mountError = 'remote.$mount failed: ' + (error && error.message ? error.message : String(error))
          warn('remote.$mount', error)
        }
      }
      const t = ctx.locale.bind(NS)

      /**
       * Remote 命名空间的惰性解析：注入的是这个工厂而不是值，
       * 面板挂载时才解析，宿主半挂载晚于浏览器半也不怕。
       */
      const namespaceApi = () => {
        const namespace = ctx.get('remote.dshNature')
        if (namespace === undefined || namespace === null) {
          // 把 mount 阶段的真实失败原因带出来：只说「not mounted」等于没说，
          // 用户和排查者都无从下手（toMessage 以前还会把这段吞掉）。
          throw new Error('the dsh-nature Remote namespace is not mounted'
            + (bootDiagnostics.mountError === '' ? '' : ' (' + bootDiagnostics.mountError + ')'))
        }
        return namespace
      }
      const injectApi = () => ({ api: namespaceApi })

      // 侧栏入口：id 必须与 main 槽的 key 一致（LayoutController.selectPanel 按它校验）。
      safeSlot(ctx, 'sidebar.panellist', () =>
        ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          // 45：官方 plugins 面板是 0，本插件排在常规工具面板之后（任务定稿值）。
          order: 45,
          label: () => t('nav'),
          locale: NS,
          registrant: PACKAGE,
          inject: injectApi,
        }, PanelIcon), 'icon')

      // 主面板：keyed 槽，key 即侧栏入口 id（ui-internals §3）。
      safeSlot(ctx, 'main', () =>
        ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          registrant: PACKAGE,
          inject: injectApi,
        }, WorkbenchPanel), 'panel')

      // 设置页并列入口：整页自绘（skillhub 范式，client.js:1248-1254）。
      safeSlot(ctx, 'settings.section', () =>
        ctx.slots.register({
          name: 'settings.section',
          id: PANEL_ID,
          order: 80,
          label: () => t('nav'),
          locale: NS,
          registrant: PACKAGE,
          inject: injectApi,
        }, SettingsPanel), 'settings')

      // 插件管理器：红点 Tag（官方座位）+ 精简状态卡（key=包名）。
      safeSlot(ctx, 'plugins.detail.badge', () =>
        ctx.slots.register({
          name: 'plugins.detail.badge',
          id: PANEL_ID,
          locale: NS,
          registrant: PACKAGE,
          inject: injectApi,
        }, DetailBadge), 'badge')

      safeSlot(ctx, 'plugins.bundle.config', () =>
        ctx.slots.register({
          name: 'plugins.bundle.config',
          key: PACKAGE,
          locale: NS,
          registrant: PACKAGE,
          inject: injectApi,
        }, BundleCard), 'card')
    }

    exports.name = 'dsh-nature-client'
    exports.inject = ['slots', 'locale', 'remote']
    exports.apply = apply
    return module.exports
  },
})
