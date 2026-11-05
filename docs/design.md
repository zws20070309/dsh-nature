# dsh-nature 设计定稿

> 依据：DSH v0.2.1-rc.5 的 asar 源码解剖（预设系统与插件 UI/服务契约）、PTC 与生态调研、nature-skills 全套消化（见 docs/nature-skills-digest.md）、若干在用的第三方插件源码实读。所有结论可溯源，禁止无依据改动。

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
- 红点同步（v1.1.1）：`statusView()` 每拿到一次真实宿主状态就向模块级 `dotHub` 广播结论，
  侧栏图标 / 插件详情徽标 / 插件管理器状态卡共同订阅。**不接受「红点是几份各自轮询的副本」**：
  那样在工作台点完「全部更新」后，工作台自己变了脸、侧栏蓝点却要等 10 分钟才灭
  （2026-11-04 22:12 用户实测截图，宿主 `updateAvailable` 已是 false，蓝点仍亮）。
  `statusView(null)` 表示宿主未就绪而非「没有更新」，不参与广播 —— 否则任何面板首屏的
  未知态都会把已亮的红点误灭。回归测试见 `test/reddot.test.mjs`（迷你 React 真渲染）。
- i18n：`locale/{zh,en}.json` + `ctx.locale.register(NS, dict)` + `ctx.locale.bind(NS)`；样式内联 `<style>` 注入 + 仅用 `--dsw-*`/`--dsw-alias-*` 主题 token（亮暗双主题兼容）。
- 徽标克制原则（providers-hub 教训）：失败静默降级 + 状态行明示，不弹窗轰炸。

### 3.3 安装链（tools/）

1. `install.ps1`：在 `$DSH_HOME/plugins/` 下建 `dsh-nature` symlink → 本仓库；profile `package.json` 增 `"@zws/dsh-nature": "link:..."`；`dsh.profile.bundles` 追加 `@zws/dsh-nature`（均先备份）；调用 `baseline.cjs`。
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

## 8. 多源架构（v1.2.0）

插件管两套技能，装进**同一个** targetDir，由同一套检测/安装/更新引擎管理：

| 源 id | 仓库 | 技能 |
|---|---|---|
| `nature` | Yuan1z0825/nature-skills | 24 个 nature-* |
| `anti-defensive` | Adkid-Zephyr/anti-defensive-writing-Skill | anti-defensive-writing / -en |

状态文件新增 `sources: { [id]: { headSha, manifest } }`，每个源有自己的基线；
顶层 `headSha` 镜像主源（保持单源时代的字段语义），顶层 `manifest.files` 是各源的**并集**
（`needsBaseline` 判的是它非空，只镜像主源会让「只装了反防御技能」的用户永久卡在 baseline-missing）。
`sourceOf: { [id]: string[] }` 是持久化的技能归属表；内存里的 `this.sourceOf` 是它的索引。

## 9. 1.3.0 修复记录（逐条：现象 / 根因 / 修法 / 验证）

> 背景：1.2.0 的 90 个测试全绿，但它们几乎全是**单轮**用例（调一次 install 或一次 check）。
> 下面每一条都活在**多轮之间**，因此全部逃过了当时那套测试。
> 修法都配了 `test/lifecycle.test.mjs` 的回归用例，并做过反向验证（还原修复 → 测试变红）。

### 9.1 P0 源不可达时更新会删掉该源的本地技能

**现象**：反防御源 ECONNRESET，用户点一次「更新」，`anti-defensive-writing` 整个目录被删除。
**根因**：两个独立缺陷叠加。
1. `learnRoster` 的防线是「**全局**远端树为空才不动 roster」；只要另一个源活着，全局树就非空，
   于是 roster 被改写成只含健康源，失败源的技能从归属表里消失。
2. `diffAllSources` 没有「这个源本轮没拉到」的概念，拿空集去 diff，该源每个文件都被判成
   「远端已删除」，`syncSkill` 照做。
**修法**：`fetchAllSources` 产出 `health: { [id]: 'ok' | 'empty' | 'unreachable' }`；
`sourceActionable(health, id)` 只有 `ok` 才为真。不健康的源：不重算归属（保留已知）、
不参与 diff、不参与基线推进、`install` 里如实记一条 failure 而不是「跳过」。
「空树」独立成 `empty` 态并**当成异常**：真出现「上游把 skills/ 清空」的概率远低于
「API 抖动 / prefix 改名 / 代理返回截断 JSON」，而这个判断决定要不要删用户的目录。
**验证**：`P0-1 源 unreachable / empty` 两条 + 反向断言「上游**真的**删技能时仍然删」。

### 9.2 P0 补装缺失技能会永久吞掉未安装的更新

**现象**：上游改了 nature-writing；用户某个技能目录损坏，点「自动补全」；之后再点更新，
`updated=[]`，磁盘还是旧内容，而且「检查」说「与远端一致」。
**根因**：`runInstall` 无条件对每个源 `commitSource(source, head, remoteFiles)`，
而 `baselineFor` 拿「已装技能 ∩ **远端** sha」造基线 —— 本轮根本没下载、远端却已经变了的技能
被记成「已是最新」。
**修法**：`commitSource(sourceId, headSha, allFiles, written)` 新增 `written: Map<path, sha>` 参数，
基线只记**本轮真的写进磁盘**的路径；本轮没碰的技能保留旧条目。`runInstall` / `runUpdate` /
`syncSkill` 都逐文件收集 `written`（`commitWrittenSources` 统一落盘）。
**连带**：`runCheck` 原来用「headSha 相等 → 没有变化」短路，而基线现在会**先于内容**前进
（补装一个技能后源 head 已前进、其它技能基线还停在旧 sha）→ 短路把残留的待更新藏起来，
界面上的「全部更新」按钮变成禁用，那次更新在 UI 上再也够不到。改为始终按真实 diff 判定
（树已在内存里，不额外发请求）。
**验证**：`P0-2` 用例覆盖完整链路（补装 → 仍报有更新 → 更新到 v2）。

### 9.3 P1 单个文件失败同样被基线吞掉

**现象**：`scripts/audit.py` 下载失败（`ok=false, failures=1`），网络恢复后 `changedSkills=[]`，
那个文件永远补不回来。
**根因**：同 9.2 —— 基线记的是「远端该有什么」而不是「磁盘真有什么」。
**修法**：同 9.2（`written` 只含成功的文件）。
**验证**：`P1-3` + **基线不变量**用例（基线条目必须在磁盘上找得到对应文件，install/check/update 三处都查）。

### 9.4 P1 `baseline-missing` 被当成「技能没装全」

**现象**：只装 1/3 个技能时 `lastCheckStatus='baseline-missing'`，而 `manifest.files` 有 1 条，
界面引导用户去跑 `tools/baseline.cjs`。
**根因**：`runInstall` 里 `complete === false ? 'baseline-missing' : 'upToDate'`，
把两条正交的轴（有没有基线 / 装没装全）混成一条。这正是 §6 之外 `runCheck` 已修过、
但 `runInstall` 里原样活着的同一个病。
**修法**：有基线就是 `upToDate`；缺技能由 `installation.complete/missing` 单独承载。
**验证**：`P1-4`。

### 9.5 P1 重启后 roster / 归属表丢失

**现象**：上游新增第 27 个技能、用户还没装；重启 DSH 后 `roster` 掉回内置 26 个，
`rosterAdded` 变空，安装态从「26/27 部分安装」跳成「26/26 全套就绪」，那个技能从目录里消失。
**根因**：`persist()` 每次都在写 `roster` / `rosterAdded` / `rosterRemoved`，`status()` 每次都在返回它们，
但 `load()` 一个字都不读 —— 写而不读等于白写。`installationOf(parsed.installation)` 还用了
**内置清单**当过滤器，把磁盘上第 27 个已装技能丢掉。内存里的 `sourceOf` 同样不持久化，
`status()` 只好退回内置兜底清单，源行报一个与磁盘无关的假数字。
**修法**：`load()` 恢复 `roster` / `rosterUpdatedAt` / `rosterAdded` / `rosterRemoved` / `sourceOf` / `remoteHeads`；
安装快照改用**恢复后的** roster 过滤；`status()` 的源行改为「归属未知就返回空数组 + `skillsKnown:false`」，
不再退回内置清单。
**验证**：`P1-5` 两条（重启后 roster/新增提示/计数；重启后归属不退回内置清单）。

### 9.6 P1「远端版本」永远显示基线 sha

**现象**：远端已经 bbbbbbb、`check` 报 `updateAvailable=true`，而状态头的「远端版本」显示 aaaaaaa ——
与「基线版本」一模一样，这一行没有任何信息量。
**根因**：`headSha` 只在 `commitSource` 里写（更新成功才前进），而 UI 的「远端版本」读的就是它。
**修法**：新增 `state.remoteHeads: { [id]: sha }`，`check` 一拿到就记（`rememberRemoteHeads`）；
`status()` 暴露 `remoteHeads` 与每源的 `remoteHeadSha`；客户端「远端版本」与源行都优先读它。
`headSha` 保持历史语义 = 基线。
**验证**：`P1-6`。

### 9.7 P2 其余四项

| 项 | 修法 | 验证 |
|---|---|---|
| 只勾选更新一部分后，已更新完的技能仍挂在待更新列表 | `runUpdate` 按 `written` 逐文件推进基线，再用推进后的基线重算剩余差异 | `P2-8` |
| 故意只装子集时红点常亮 | `hasActionableChange` / `hasActionableRows`：只有「基线内的技能变了」或「上游新增」才点亮；缺技能交给 installation | `P2-10` |
| `touched` 数组只 push 从不读（死代码） | 删除，改用磁盘重扫 + `written` | 现有 install 用例 |
| `rosterAdded/rosterRemoved` 宿主算了但界面从不显示 | `InstallCard` 新增「上游新增 N 个技能」区块（复用「自动补全」按钮，不新增动作）；en/zh 各补 3 个键 | `client-shape` 键集断言 |

### 9.8 一处能力缺口（不是 bug）

上游**真的**把某个技能从仓库里删掉时，`sourceOfSkill` 曾经查不到它的归属（`learnRoster` 已按新树
重算归属，那个名字随即消失），于是删除动作被跳过，用户目录里永远留着上游已不存在的东西。
新增「从历史基线反查归属」的兜底：删掉的技能也找得到它属于哪个源。
**验证**：`P0-1 上游**真的**删掉技能时仍然按语义删除`。

### 9.9 零差异快进只推进 head（不再重建基线清单）

`runCheck` 的分支「head 动了但 skills/ 内容零差异」原本会调 `commitSource(整源重建)`，
而 `baselineFor` 依赖**当前安装快照** —— 如果此刻快照是陈旧的（扫描失败、刚换目录），
就会凭空写出一份与磁盘不符的基线。既然这个分支的前提就是「内容没变」，清单就不该变。
改成只推进 `headSha` / `manifest.headSha`（两者必须同步，否则「远端版本」与「基线版本」无端分叉）。
**验证**：`零差异快进：只推进 head…`。

### 9.9 归属表自愈（老状态文件不再报 0 个技能）

`status()` 的源行改成「归属未知就返回空数组 + `skillsKnown:false`」之后，
1.3.0 之前写的状态文件（没有 `sourceOf` 字段）会让源行显示 `0 个技能 / 未知`，
直到用户下一次联网 check 才补上 —— 用户看不到任何错误，只看到一个奇怪的 0。
**修法**：`load()` 末尾调 `adoptBuiltinOwnership()`，用「内置清单」补一份归属（只补缺的，
已学到的不覆盖）。联网 check 之后仍以远端真实树为准，内置清单只是首屏的占位。
**验证**：`归属自愈：老状态文件加载后源行有归属`。

### 9.9 反向验证（防「测试只是跟着实现写」）

| 还原的修复 | 变红的用例 |
|---|---|
| `diffAllSources` 去掉 health 门控 | `P0-1 源 unreachable` |
| `commitSource` 改回整源重建 | `P0-2` / `P1-3` / `P2-8` / 基线不变量（4 条） |
| `load()` 不恢复 roster | `P1-5 重启后 roster…` |

还原后恢复原代码，102 条全部重新转绿。

## 10. 已知取舍（1.3.0 新增）

- **源不可达时不删本地文件**，代价是「上游把技能整仓删空」时需要人工清理。取舍依据：
  误删用户文件不可恢复，多留一个目录随时可删。
- **空树当成异常**：`skills/` 返回零文件时不产生任何删除。同上。
- **红点语义收窄**为「你装的技能变了」。没装的技能由安装状态承载 —— 用户明确表达过
  「我只想要反防御写作」，不该每次检查都被蓝点催。
