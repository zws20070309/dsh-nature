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
  - `update(skillNames?)`：先连通性预检；对每个 changed skill：trees API 取该 skill 子树 blobs → 逐文件 GET `raw.githubusercontent.com/.../<sha>/skills/<name>/<path>`（重试 2 次；mirror 配置可替换 raw 前缀）→ 写 `targetDir/<skill>/<path>`（路径规范化 + 只许 `skills/` 内相对路径，防穿越；tmp+rename 原子写）；删除远端已移除文件；全部完成后写新 manifest + headSha。只更新变化的子 skill（用户核心要求），未变化的目录一个字节都不碰。
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

- `node --test test/`：manifest diff 纯函数、路径穿越防护、patch YAML 结构校验（preset 行字段/id 唯一/!!js 仅限 disabled）。
- 双审查员逐行审（host 对照本设计 + 契约；client 对照 overclock/copy-session-id 先例），问题必须修复复测后才许提交。
- 实机验收（我本人执行）：重启 DSH → 设置页可见并列入口 → 侧栏红点/工作台 → 模拟远端变更 → 增量更新只动变化的 skill → dev 分支验收后合 main。

## 5. 已知取舍

- 设置导航 label 无红点座位（官方 nav 行无 slot）→ 红点改为：侧栏图标 + 设置页头横幅 + 插件管理器 Tag，三处官方座位。
- 插件不自建「插件自身升级」（生态共识走官方 plugin market）——本插件的更新检测只针对 nature-skills 内容。
- workflow 行保持 ptc 原状禁用（与 PTC 一致）；如需工作流引擎可后续在 patch 里改 disabled（一行）。
