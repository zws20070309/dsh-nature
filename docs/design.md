# dsh-nature 设计定稿

> 依据：DSH v0.2.1-rc.5 asar 源码解剖（临时/dsh-preset-internals.md、临时/dsh-ui-internals.md）、PTC 与生态调研（临时/ptc-ecosystem-research.md）、nature-skills 全套消化（docs/nature-skills-digest.md）、本机三个在用插件源码实读。所有结论可溯源，禁止无依据改动。

## 0. 一句话

一个仓库两件套：**「Nature 论文写作」agent 预设**（PTC 底子 + nature skills 专化）+ **DSH 插件**（左侧工作台 + 设置页入口 + nature-skills 增量更新中心，红点提醒）。

## 1. 交付物清单（仓库根）

```
dsh-nature/
├── package.json            # @zws/dsh-nature 插件清单（生态规范四件套）
├── cordis.patch.yml        # insert 两行：插件行 + preset-nature 预设行
├── icon.svg                # 插件图标
├── lib/index.js            # host 半：更新引擎 + typert Remote 服务
├── lib/client.js           # 浏览器半：工作台面板 + 设置页 + 红点图标
├── locale/zh.json          # 中文文案
├── locale/en.json          # 英文文案
├── preset/persona.md       # 预设人格文本（文档化，actual 值内联在 patch）
├── tools/install.ps1       # 一键安装：symlink + profile 登记 + 基线清单
├── tools/uninstall.ps1     # 卸载
├── tools/baseline.cjs      # 从本地 git clone 生成 skills 基线清单（离线）
├── test/*.mjs              # node --test 单测
├── docs/design.md          # 本文件
├── docs/nature-skills-digest.md
└── README.md               # 生态规范格式（徽标/What it does/Install/Security/Known limitations/版本对照）
```

## 2. Agent 预设 `nature`（关键设计）

**底子**：`@ai/dsh-web-app/presets/ptc.patch.yml:1-135` 整段（PTC = standard 工具集 + `tool-presentation { mode: ptc }` 折叠为 run_code + TS SDK 注入）。

**魔改仅两处，其余逐行照抄 ptc**：
1. `persona.prefix` → 论文写作人格（见 §2.1）；**不用 `complete: true`**（会独占提示词、静默丢掉 plan-mode/goal/skill 段——preset-internals 报告 §3.4 的踩坑实录）；不写 `includeRuntimeContext: false`（保留时间上下文）。
2. `workflow-ptc` / `tool-workflow` 保持 ptc 的 `disabled: true`（与 PTC 运行方式一致，这是官方 ptc 预设的既定事实）。

**不写的行及依据**：
- MCP 行：host 层 `mcp__arxiv__*` 对所有预设默认可见（ui-internals §7）。
- skill 行：`skill-filesystem` + `tool-skill` 已在 ptc 组成里；`~/.agents/skills` 是官方发现路径 user-agents root（rank 500，ui-internals §5）→ 24 个 nature skills 自动可用，零配置。

**注册方式**：插件 cordis.patch.yml 顶层 `insert` 两行（preset 行 + 插件行）。官方 README 明文背书："A new preset ... is a bundle patch: an insert of a @deepseek-ai/dsh-agent-preset row"（preset-internals §4.3）。预设 order: 7（本机已有 5/6）。预设子行解析经 loader bare-module 兜底，与 ptc 同名行同机制。

**config**: `{ id: nature, name: 'Nature 论文写作', description: '<digest §e 一句话>', order: 7, plugins: [...] }`

### 2.1 persona 文本要点（preset/persona.md，中英混合可读）

- 身份：Nature 级学术写作与研究 agent（写/改/审/译/绘/投）。
- 工作流互锁边界（来自各 SKILL.md，digest §e）：writing 起草不润色；polishing 只动语言不动事实；reviewer 只出报告不写 rebuttal；response 不做模拟审稿；figure 后端独占（Python/R 先问一次记住偏好）；所有 skill 的 `AUTHOR_INPUT_NEEDED` 约定——缺证据标注不编造。
- PTC 行为补充：工具经 `run_code` 内 `await tools.<name>(...)` 调用（官方 SDK 段会给出声明，persona 不重复 SDK 规则，只补论文场景用法：批量文献处理用 Promise.all 只读并行、写文件串行）。
- arxiv MCP 工具（`mcp__arxiv__*`）作为文献检索/下载/引文导出的首选通道。

## 3. 插件设计

### 3.1 host 半（lib/index.js）——更新引擎 + Remote 服务

- `export const name` / `inject`（最小）/ `apply(ctx, config)`：`ctx.provide('dshNature', service)`。
- `NatureService`（学 overclock-mode/index.js 的成熟模式）：
  - 状态文件 `$DSH_HOME/dsh-nature-state.json`（显式 config.dshHome > DSH_HOME > ~/.dsh），**readFileSync 启动同步读 + writeChain 原子写**（tmp + rename）。
  - 状态：`{ version: 1, headSha, lastCheckedAt, lastCheckStatus, updateAvailable, changedSkills: [{name, added, removed, modified}], manifest: { headSha, files: { "<skill>/<relpath>": blobSha } }, config: { autoCheck, intervalHours, targetDir, mirror } }`
  - **Remote RPC（typert 协议，overclock 契约）**：方法 `status()` / `check()` / `update(skillNames?)` / `setConfig(patch)` / `openSkillsDir()`；`typertRemote = { service, serviceKey: 'dshNature', namespace: 'dshNature' }` + `Object.defineProperty(proto, '@deepseek-ai/dsh-typert-protocol/remote-methods', ...)`；方法参数禁默认值/解构/剩余参数（网关从函数源码解析参数名）。
  - `check()`：GET `api.github.com/repos/Yuan1z0825/nature-skills/commits/main`（UA 头、10s 超时、2 次重试——本机实测 GitHub 间歇性断连必须重试）→ headSha 与 manifest.headSha 比较；不同则 GET `git/trees/<sha>?recursive=1` 过滤 `skills/` 前缀，按 blob sha 与本地 manifest 差异 → changedSkills + updateAvailable=true。本地无 manifest（首装未跑基线）→ 状态报「需要先建立基线」引导跑 baseline，不擅自全量覆盖。
  - `update(skillNames?)`：先连通性预检；对每个 changed skill：trees API 取该 skill 子树 blobs → 逐文件 GET `raw.githubusercontent.com/.../<sha>/skills/<name>/<path>`（重试 2 次；mirror 配置可替换 raw 前缀）→ 写 `targetDir/<skill>/<path>`（路径规范化 + 只许 `skills/` 内相对路径，防穿越；tmp+rename 原子写）；删除远端已移除文件；全部完成后写新 manifest + headSha。只更新变化的子 skill（用户核心要求），未变化的目录一个字节都不碰。实现注记：本条「逐 skill 子树请求」已改为**单次** `git/trees/<sha>?recursive=1` 拉整棵树再按 skill 前缀过滤（fetchSkillFiles）——效果等价且请求数恒定（每次 check/update 各 2 次 API），磁盘侧仍是未变化目录一字节不碰。
  - 定时器：`intervalHours`（默认 6，0=关）+ 启动 60s 后首查；setInterval，config 变更时重置。
- **不加提示词段**（预设 persona 已覆盖；插件对 agent 作用域零侵入——这是"插件只服务预设、不影响其他预设"的实现方式）。

### 3.2 client 半（lib/client.js）——三个 UI 面 + 红点

单语句 `window.__ModuleLoader__.load({ id, factory })`、顶层零绑定、`require('react')`、无构建步骤（overclock/copy-session-id 双先例）。

| UI 面 | 槽位 | 内容 |
|---|---|---|
| 侧栏入口+工作台 | `sidebar.panellist`（id: dsh-nature, order 45）+ `main`（key: dsh-nature） | 状态头（版本/上次检查/红点）、更新中心（检查/一键更新/逐 skill 变更清单）、技能目录（24 skills 按 lifecycle 分组）、设置入口按钮；**图标组件自带红点**（updateAvailable 时画 6px 品牌色圆点，学 DesktopUpdateBadge 的 CSS） |
| 设置页并列入口 | `settings.section`（id: dsh-nature, order 80） | 自动检查开关、间隔、目标目录、镜像源、**保存按钮（改动只落内存点保存才生效**——whale 范式）、立即检查/更新、版本状态行、页头红点横幅（导航行无徽标座位是官方事实，红点放页面内容头部） |
| 插件管理器详情页 | `plugins.detail.badge` + `plugins.bundle.config`（key=包名） | 红点 Tag（官方座位）+ 精简状态卡跳设置 |

- RPC：CONTRIBUTION descriptors（status/check/update/setConfig/openSkillsDir）→ `ctx.remote.$mount(CONTRIBUTION)` → `ctx.get('remote.dshNature')`。
- 状态刷新：面板挂载即 status() + 动作后刷 + 卸载清理的 setInterval(10min) 轮询（图标红点保鲜）。
- i18n：`locale/{zh,en}.json` + `ctx.locale.register(NS, dict)` + `ctx.locale.bind(NS)`；样式内联 `<style>` 注入 + 仅用 `--dsw-*`/`--dsw-alias-*` 主题 token（亮暗双主题兼容）。
- 徽标克制原则（providers-hub 教训）：失败静默降级 + 状态行明示，不弹窗轰炸。

### 3.3 安装链（tools/）

1. `install.ps1`：建 `C:\Users\ZWS\.dsh\plugins\dsh-nature` symlink → 本仓库；profile `package.json` 增 `"@zws/dsh-nature": "link:..."`；`dsh.profile.bundles` 追加 `@zws/dsh-nature`（均先备份）；调用 `baseline.cjs`。
2. `baseline.cjs`：`git -C <clone> ls-tree -r HEAD -- skills/` 生成 `{headSha, files}` 基线写入 state 文件（离线、精准——git blob sha 内容寻址）。
3. 重启 DSH 生效。

## 4. 质量门

- `npm test`（= `node --test test/*.test.mjs`）：manifest diff 纯函数、路径穿越防护、patch YAML 结构校验（preset 行字段/id 唯一/!!js 仅限 disabled）、以及三条 1.0.3 回归（见 §6）。
- 双审查员逐行审（host 对照本设计 + 契约；client 对照 overclock/copy-session-id 先例），问题必须修复复测后才许提交。
- 实机验收（我本人执行）：重启 DSH → 设置页可见并列入口 → 侧栏红点/工作台 → 模拟远端变更 → 增量更新只动变化的 skill → dev 分支验收后合 main。

## 5. 已知取舍

- 设置导航 label 无红点座位（官方 nav 行无 slot）→ 红点改为：侧栏图标 + 设置页头横幅 + 插件管理器 Tag，三处官方座位。
- 插件不自建「插件自身升级」（生态共识走官方 plugin market）——本插件的更新检测只针对 nature-skills 内容。
- workflow 行保持 ptc 原状禁用（与 PTC 一致）；如需工作流引擎可后续在 patch 里改 disabled（一行）。

## 6. 1.0.3 修复记录（实机复现 → 修 → 验）

### 6.1 P1 主面板不可滚动（用户报告）

**现象**：工作台一页看不到全部技能，鼠标中键/滚轮都滚不动。

**根因**：main 槽的父级是 `.mP3x-q_centerCol{flex-direction:column;overflow:hidden}`，高度由
`.mP3x-q_frame{grid-template-rows:minmax(0,1fr) auto;height:100%}` 定死
（`dsh-client-ui-layout/lib/client.js` 的 AppFrame CSS）。插件面板根节点只有
`max-width/margin/padding`，没有 `height` 也没有 `overflow` → 面板随内容无限增高，
超出视口的部分被父级 `overflow:hidden` 裁掉，全页没有任何可滚动祖先。

**实机复现数据**（用官方 layout 真实 CSS 搭 DOM 链，浏览器实测）：
修复前 `page clientHeight=1438px / 视口列高=697px / overflowY=visible / 可滚动=false / 内容被裁剪=true`；
修复后 `可滚动=true / 内容被裁剪=false`，滚轮可直达底部按钮。

**修法**：`.dsh-nature-scroll{box-sizing:border-box;height:100%;min-height:0;overflow-y:auto}`
作唯一滚动容器，内层 `.dsh-nature-page` 只留居中与内边距。与官方面板同范式
（plugin-manager `.page{height:100%;overflow:auto}`、skillhub `[data-surface=page]{max-height:100%;overflow:auto}`）。
设置页**不加**这层：它在官方 `.AnXs9G_options{flex:1;min-height:0;overflow-y:auto}` 里已经会滚，再套一层就是双层滚动。

### 6.2 P1 更新完成后页面被带坏

**现象**：点「更新」后工作台/设置页把它显示成「未建立基线 + 目标目录为空」。

**根因**：`update()` 回的是 `runUpdate` 的内部明细 `{ok,reason,headSha,updated,skipped,removed,failures}`，
而客户端拿到动作结果直接 `statusView(unwrap(remote))` 覆盖本地状态。明细里没有
`manifest`/`config` → 归一化出 `needsBaseline=true`、`targetDir=''`。

**修法**：宿主 `update()` 改为 `{...this.status(), outcome}`，与 status/check/setConfig 同形；
明细挂 `outcome`。客户端顺带把 outcome 用上，更新完显示「已更新 N 个技能」而不是只让红点消失。

### 6.3 P2 目录名被当成触发名

DSH 的技能名取 SKILL.md 的 frontmatter `name`（`dsh-skill-filesystem` 的 `discoverRoot`），
不是目录名。上游 `nature-proposal-writer` 的 frontmatter 是 `name: researchwrite`，
原 persona 与目录都写 `nature-proposal-writer` —— 那个名字模型根本触发不了。
修法：目录用 `TRIGGER_ALIASES` 在同行标出真实触发名；persona 改为按 `researchwrite` 引用。

### 6.4 P0 防护：启动分段兜底

`apply()` 里 `installStyles` / `locale.register` / `remote.$mount` 三段各自 try/catch。
此前 `$mount` 抛错会让整个 client bundle 挂掉（与官方 bundle 拼在同一脚本里），
表现为「插件装了但完全没有入口」。现在 `$mount` 失败仍注册五个槽位，面板走
`remoteNotMounted` 分支给可读提示。另有回归测试覆盖该失败路径。


## 7. 1.0.4：安装检测与补全（新增能力）

### 7.1 为什么需要"检测"

原插件只做**增量更新**：它假设技能已经在本地（用户跑过 `tools/baseline.cjs`）。
新用户装完插件打开工作台，看到的是"未建立基线"——没有任何一键入口，
而"检查更新/更新中心"在没有技能时**根本没有操作对象**。这是首装体验的断点。

### 7.2 三态检测（scanInstallation）

判定口径：**目录内有 SKILL.md 才算装上**。
只看目录存在会把半路中断的下载（空目录、半截文件）算成已装，用户看到"已完成"
却发现技能调不起来——DSH 的 `discoverRoot` 同样会跳过没有 SKILL.md 的目录
（`dsh-skill-filesystem/lib/index.js`：`locator = entry.type === 'directory' ? { path: join(entry.path,'SKILL.md') } : ...`）。

返回 `{ installed, missing, complete, total, installedCount, empty, partial }`，
宿主与浏览器半用同一套派生字段（客户端仍会重新派生，因为它不能信任宿主形状）。

### 7.3 install() 与 update() 的分工

| | install(skillNames?) | update(skillNames?) |
|---|---|---|
| 前提 | **不需要基线**（首装路径） | 需要 manifest 基线，无基线直接返回 baseline-missing |
| 语义 | 确保点名的（或全套）技能**到最新** | 只同步**与基线有差异**的技能 |
| 基线 | 按 `installation.installed` 裁剪后写入 | 同左（都是 `baselineFor`） |
| 用途 | 首次安装 / 部分补全 / 全部重装 | 日常增量更新 |

**基线口径（关键，踩过坑）**：基线必须只记**磁盘上真实存在的 skill**。
早期实现直接写整棵远端树（`remoteFiles`），后果是 `install(['nature-figure'])`
之后 manifest 里记了全部 24 个，于是 `update()` 的 diff 认为另外 23 个"已是最新"，
**它们永远装不上**（2026-11-04 实测：manifest 3 条、update 报 changedSkills=[]）。
现在统一走 `baselineFor(remoteFiles)`：以 `installation.installed` 为白名单过滤。

### 7.4 并发下载（性能）

814 个文件逐个串行实测 **8 分钟只完成 1/24 个技能**，用户会以为卡死。
改为 `mapPool` 有界并发：skill 间并发 2、skill 内并发 6，配合指数退避
（500→1000→2000ms）+ 重试 4 次。实测 **92 秒完成 24/24**（814 文件，0 失败）。

并发只改编排顺序，每个文件仍是「下载 → git blob sha 校验 → tmp+rename 原子写」，
不放松任何校验。镜像站在高并发下会回 503，退回线性退避时实测有 8 个文件失败，
退避改成指数后同一批 0 失败。

### 7.5 误报修复（known 标志）

升级插件后宿主未重启（旧代码没有 `inspect` 方法）时，面板显示
「未检测到 nature 技能 / 0 个已安装」，而本机装了 24 个 —— 用户会去重装。
`installationView` 增加 `known` 标志：拿不到宿主状态时显示「正在读取安装状态…」
而不是「0/24」，且此时**不渲染安装按钮**（点了会打到未注册的方法上）。

### 7.6 persona 改为全英文

原人格中英混排。预设注入应与官方 `ptc` 同语言（英文）。改为纯英文后：
3615 字符、0 个中文字符（脚本校验），路由规则/语言策略/铁律全部保留。
中文只保留在技能目录文案与用户可见 UI，不进提示词。
