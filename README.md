<div align="center">

# dsh-nature

![version](https://img.shields.io/badge/version-1.0.0-2563eb?style=flat-square)
![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.1--rc.5-1a7f37?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-6b7280?style=flat-square)

**English** | [简体中文](#简体中文)

A Nature-grade academic writing suite for DeepSeek Harness: one repo, two pieces — a `nature` agent preset (PTC base + 24 nature-skills) and a DSH plugin (workbench, settings page, incremental nature-skills update center with red-dot badges).

**简体中文**

[English](#dsh-nature) | **简体中文**

一套 Nature 级论文写作套件：一个仓库两件套——`nature` agent 预设（PTC 底子 + 24 个 nature-skills 技能）+ DSH 插件（工作台、设置页、nature-skills 增量更新中心，红点提醒）。

</div>

---

## What it does / 它做什么

| 件 | 内容 |
|---|---|
| **Agent 预设 `nature`** | 整段复刻官方 `ptc` 预设（standard 工具集 + `run_code` PTC 形态），仅替换 persona 为论文写作人格；24 个 [nature-skills](https://github.com/Yuan1z0825/nature-skills) 技能经 `~/.agents/skills` 官方发现路径自动可用，零额外配置 |
| **DSH 插件** | ① 侧栏工作台：状态头（插件/基线/远端版本、上次检查）、更新中心（检查 / 全部更新 / 勾选部分更新）、24 技能目录（六类分组）；② 设置页：自动检查开关、检查间隔、目标目录、镜像源，显式保存；③ 红点三处官方座位：侧栏图标 6px 圆点、页面头部横幅、插件管理器详情页 Tag |
| **增量更新中心** | 只更新远端**有变化**的子 skill：与本地基线清单（git blob sha）做树差分，未变化的目录一个字节都不动 |

## Install / 安装

### 一键（推荐）

前置：Windows + PowerShell 7（`pwsh`）、本仓库与 nature-skills 各一份本地克隆、DSH 0.2.1-rc.5。

1. `git clone https://github.com/zws20070309/dsh-nature.git`
2. `git clone https://github.com/Yuan1z0825/nature-skills.git`
3. 在 `dsh-nature` 目录运行 `tools/install.ps1`（按脚本头部参数说明传入两个克隆路径）：建立 profile 插件目录 symlink → 登记 `package.json` 依赖与 `dsh.profile.bundles` → 调用 `tools/baseline.cjs` 从克隆生成技能基线清单 → 重启 DSH 生效。

### 手动

1. 在 profile 的 `package.json` 增加依赖：`"@zws/dsh-nature": "link:<本仓库绝对路径>"`（先备份）。
2. 在 profile 的 `cordis.patch.yml` 顶层 `dsh.profile.bundles` 数组追加 `"@zws/dsh-nature"`。
3. `node tools/baseline.cjs <nature-skills 克隆路径>`（离线生成基线；不跑这步插件会提示「未建立基线」并拒绝全量覆盖）。
4. 重启 DSH：设置 → 插件里应出现 dsh-nature；预设选择器里出现「Nature 论文写作」。

## Usage / 使用

- **预设选择**：新会话在预设选择器选「Nature 论文写作」——写作/润色/审稿/回应/绘图/数据声明的互锁边界已写进 persona，工具经 `run_code` 以 PTC 形态呈现。
- **工作台**：侧栏「Nature 写作」图标 → 状态头 + 更新中心 + 技能目录；底部按钮直达技能目录与 GitHub 仓库。
- **设置页**：设置 → Nature 写作。改动**只落内存**，点「保存设置」才写配置（生态惯例）；「立即检查 / 更新全部」就地执行。
- **更新语义**：远端 main 有新提交 → 与基线按 blob sha 差分 → 只有变化的子 skill 被下载覆写/删除，其余目录零改动；可勾选只更新其中一部分。
- **红点**：侧栏图标右上角 6px 品牌色圆点（10 分钟轮询）；设置页与工作台头部横幅；插件管理器详情页「有更新」Tag。
- **镜像源（重要）**：`raw.githubusercontent.com` 在部分网络不可达（2026-11-04 实测 `Connection was reset`），而检查用的 `api.github.com` 通常可达——表现为「检查正常、更新超时」。此时在设置页把镜像源设为前缀替换型代理（实测可用：`https://ghproxy.net/https://raw.githubusercontent.com`、`https://gh-proxy.com/https://raw.githubusercontent.com`），下载经镜像进行，**blob sha 内容校验不受镜像影响**（校验和来自 GitHub trees API，镜像只是传输通道）。留空则直连 raw。

## Security model / 安全模型

- **写盘范围**：只写 `设置页配置的目标目录` 下 `skills/` 内的相对路径 + `$DSH_HOME/dsh-nature-state.json` 状态文件；路径穿越（`../`、盘符、绝对路径）一律拒绝；文件写入走临时文件 + rename 原子替换。
- **凭据**：无任何凭据、无遥测；GitHub API 全程只读（`commits/main`、`git/trees`、`raw.githubusercontent.com`），10 秒超时 + 2 次重试；镜像源仅替换 raw 下载前缀。
- **预设边界**：预设 persona 不用 `complete`，不吞 plan-mode/goal/skill 段；插件对其他预设的会话零侵入（不加提示词、不裁工具）。

## Known limitations / 已知限制

- **设置导航行没有红点**：DSH 设置页 nav 行不渲染第三方徽标（官方事实），红点放在三处官方座位——侧栏图标、页面头部横幅、插件管理器详情页 Tag。
- **插件自身升级走官方 plugin market**：本插件的更新检测只针对 nature-skills 内容，不自建自升级。
- **首次使用必须先建基线**：未跑 `tools/baseline.cjs` 前只会提示引导，不会把远端当全量去覆盖本地。
- **定时检查依赖 DSH 进程存活**：`intervalHours` 的定时器跑在宿主侧，DSH 关闭时不检查。
- **技能名以 SKILL.md 的 frontmatter 为准，不是目录名**：DSH 的技能发现读 frontmatter `name`（`dsh-skill-filesystem` 的 `discoverRoot`）。上游 `nature-proposal-writer` 目录登记的触发名是 `researchwrite`，工作台目录里两者都标出，persona 也按触发名写。

## 版本对照

| DSH | 插件 | 说明 |
|---|---|---|
| 0.2.1-rc.5 | 1.0.0 | 开发与验收基线（本机实测版本） |
| 0.2.1-rc.5 | 1.0.1 | 挂载首拍 status() 挂起时有限重试（实机验收修复） |
| 0.2.1-rc.5 | 1.0.2 | 动作类 RPC 超时重试 + 阶段恢复；raw 被墙时配置镜像源即可完成更新（实机全流程演练通过） |
| 0.2.1-rc.5 | 1.0.3 | 主面板可滚动（此前一屏之外的内容不可达）；更新后不再把页面显示成「未建立基线」；目录标出真实触发名；启动分段兜底 |

装错版本会被 DSH 在启动时整体拒绝，表现为「装了但完全没有入口」。

## License

MIT
