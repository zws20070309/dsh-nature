/**
 * 宿主半：**nature-skills 增量更新中心**。
 *
 * 职责只有一件事：盯住 GitHub 上 Yuan1z0825/nature-skills 的 main 分支，把 skills/
 * 下发生变化的 skill **增量**同步到本地技能目录（默认 ~/.agents/skills，DSH 的
 * user-agents 发现根，rank 500），并把状态暴露给浏览器半（工作台红点 + 设置页）。
 * Agent 预设的提示词在 cordis.patch.yml / preset 那一层，本文件对 agent 作用域**零侵入**。
 *
 * 实现契约（照抄 dsh-overclock-mode/index.js 的成熟模式）：
 *   1. 状态文件 `$DSH_HOME/dsh-nature-state.json`，启动时 `readFileSync` 同步读，
 *      写盘走串行链上的同目录 tmp + rename —— 读者永远看不到半个文件。
 *   2. 浏览器 RPC 走 typert 协议：实例上的 `typertRemote` 字段 + 原型上的
 *      `@deepseek-ai/dsh-typert-protocol/remote-methods` 标记。Gateway 的 SRC 兜底
 *      从**函数源码**解析参数名（dsh-api-gateway/lib/index.js:1241 与 :1715），
 *      所以下面的 Remote 方法一律不用默认值/解构/剩余参数 —— 名字就是线上字段。
 *   3. 只 import `node:` 内置模块：插件经 profile 的 link 挂载时 Node 按 realpath
 *      解析，从仓库目录出发到不了 `profile/node_modules/@deepseek-ai/`，静态
 *      import 别的包会让 fiber 建不起来（overclock-mode 头注为证）。
 *
 * 网络层约定：
 *   - 全部走 GitHub REST 匿名接口，**必须带 User-Agent**（GitHub 对无 UA 请求直接
 *     403）；唯一不走 api.github.com 的是 raw 文件下载，且允许 config.mirror 整体
 *     替换 raw 前缀（镜像站），api.github.com 的树/commit 元数据始终走官方 —— 那是信任根。
 *   - 每个请求 10s AbortController 超时，失败重试 2 次共 3 次。重试是硬要求：
 *     本机实测 GitHub 间歇性断连，单次失败不代表仓库不可达。
 *   - 每个下载文件先用 git blob sha（内容寻址）校验再落盘：mirror 是第三方通道，
 *     树里的 sha 是唯一可信的完整性锚点，算法与 tools/baseline.cjs 读到的 sha 同源
 *     （sha1("blob <字节数>\\0" + 内容)）。
 *
 * @module @zws/dsh-nature
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** typert 协议里读 Remote 标记的稳定属性名（跨安装副本共享同一字符串）。 */
const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'
/** Cordis 服务键，同时也是 Remote 命名空间名（浏览器侧为 `remote.dshNature`）。 */
const SERVICE_KEY = 'dshNature'
/** 状态文件名，位于 harness home 下。 */
const STATE_FILE = 'dsh-nature-state.json'
const STATE_VERSION = 1
/** 上游仓库：REST 全匿名，User-Agent 是 GitHub API 的硬要求。 */
const REPO = 'Yuan1z0825/nature-skills'
/**
 * 全套 24 个技能的**目录名**，是"完整性检测"的单一事实源。
 * 与 client.js 的 CATALOG 同源（test/catalog-sync.test.mjs 逐项校验）——
 * 两处任何一边增删都要同步，否则检测结论会与目录展示不一致。
 * 注意：目录名 ≠ 触发名（nature-proposal-writer 的 frontmatter 是 researchwrite）。
 */
export const NATURE_SKILLS = [
  'nature-writing',
  'nature-polishing',
  'nature-proposal-writer',
  'nature-social-science',
  'nature-academic-search',
  'nature-citation',
  'nature-ref-verifier',
  'nature-downloader',
  'nature-literature-pipeline',
  'nature-reader',
  'nature-paper-xray',
  'nature-paper-card',
  'nature-paper-trans',
  'nature-data',
  'nature-statistics',
  'nature-experiment-log',
  'nature-figure',
  'nature-paper2word',
  'nature-paper2ppt',
  'nature-image2ppt',
  'nature-paper-to-patent',
  'nature-reviewer',
  'nature-response',
  'nature-shared',
]
const COMMITS_URL = 'https://api.github.com/repos/' + REPO + '/commits/main'
const TREES_URL = 'https://api.github.com/repos/' + REPO + '/git/trees/'
const RAW_ORIGIN = 'https://raw.githubusercontent.com'
const USER_AGENT = 'dsh-nature-plugin (+https://github.com/' + REPO + ')'
/** trees 响应里 skills/ 子树路径的前缀，清单键 = 去掉它之后的 `<skill>/<relpath>`。 */
const SKILLS_PREFIX = 'skills/'
/** 单请求超时与重试：10s × (1+2)。重试是硬要求 —— 本机实测 GitHub 间歇断连。 */
const FETCH_TIMEOUT_MS = 10_000
const FETCH_RETRIES = 4
const RETRY_DELAY_MS = 500
/**
 * 并发下载上限。整套 24 个技能约 800 个文件，**逐个串行**在真实网络上要跑十几分钟
 * （实测 8 分钟只完成 1 个技能 / 12 个文件），用户会以为插件卡死。
 * 6 路并发是折中：对 raw.githubusercontent.com / 镜像都不至于触发限流
 * （匿名无 token，单 IP 并发过多会被 403），又能把总耗时压到分钟级。
 * 每个文件仍是「独立下载 → git blob sha 校验 → tmp+rename 原子写」，
 * 并发只改变编排顺序，不放松任何校验。
 */
const DOWNLOAD_CONCURRENCY = 6
/** 启动 60s 后首查：避开 harness 启动期的网络/磁盘尖峰，不跟会话初始化抢路。 */
const FIRST_CHECK_DELAY_MS = 60_000
/** setInterval 的延迟上限：超过 2^31-1 ms 会回绕成小数值，反而变成高频空转。 */
const MAX_TIMER_MS = 2 ** 31 - 1
const DEFAULT_INTERVAL_HOURS = 6

/** 与官方 install 同一套 home 解析顺序：显式 config > DSH_HOME > ~/.dsh。 */
function resolveDshHome(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * 技能目录默认值。nature-skills 的安装位置与 DSH 的 user-agents skill 根一致
 * （dsh-home-paths：DSH_AGENTS_HOME > ~/.agents；dsh-skill-filesystem rank 500），
 * 更新引擎写这里，24 个技能即被所有预设零配置发现。
 */
function defaultTargetDir() {
  const fromEnv = process.env.DSH_AGENTS_HOME
  const agentsHome = typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : join(homedir(), '.agents')
  return join(agentsHome, 'skills')
}

function defaultConfig() {
  return {
    autoCheck: true,
    intervalHours: DEFAULT_INTERVAL_HOURS,
    targetDir: defaultTargetDir(),
    mirror: '',
  }
}

function defaultState() {
  return {
    version: STATE_VERSION,
    headSha: null,
    lastCheckedAt: null,
    lastCheckStatus: 'never',
    lastError: null,
    updateAvailable: false,
    changedSkills: [],
    manifest: { headSha: null, files: {} },
    /** 本地安装快照（磁盘真相）：{ installed, missing, complete }。 */
    installation: { installed: [], missing: [...NATURE_SKILLS], complete: false },
    config: defaultConfig(),
  }
}

function isPlainObject(value) {
  return value !== null && typeof value !== 'undefined' && typeof value === 'object' && !Array.isArray(value)
}

/** 清单键形状清洗：非 `<skill>/<rel>` -> sha 的字符串对一律丢弃，坏文件不能带坏状态。 */
function fileMapOf(value) {
  const out = {}
  if (!isPlainObject(value)) return out
  for (const [path, sha] of Object.entries(value)) {
    if (typeof path === 'string' && path.length > 0 && path.includes('/') && typeof sha === 'string' && sha.length > 0) {
      out[path] = sha
    }
  }
  return out
}

/**
 * 安装快照的形状清洗 + 派生字段归一：只认 NATURE_SKILLS 里的名字，坏数据不能带坏结论。
 *
 * installedCount/total/empty/partial 在宿主侧也算一份：浏览器半会自己派生（它不能
 * 信任宿主的形状），但任何直接读 status() 的消费者（测试、脚本、将来的别的面板）
 * 拿到 undefined 就会渲染出 "{have}/{total}" 这种空值 —— 单点派生，两处都能用。
 */
function installationOf(value) {
  const known = new Set(NATURE_SKILLS)
  const pick = (list) => (Array.isArray(list) ? list.filter((name) => typeof name === 'string' && known.has(name)) : [])
  const installed = isPlainObject(value) ? [...new Set(pick(value.installed))].sort() : []
  const missing = NATURE_SKILLS.filter((name) => !installed.includes(name))
  const complete = isPlainObject(value) && typeof value.complete === 'boolean'
    ? value.complete && missing.length === 0
    : missing.length === 0 && installed.length > 0
  return {
    installed,
    missing,
    complete,
    total: NATURE_SKILLS.length,
    installedCount: installed.length,
    empty: installed.length === 0,
    partial: installed.length > 0 && !complete,
  }
}

function changedSkillsOf(value) {
  if (!Array.isArray(value)) return []
  const rows = []
  for (const row of value) {
    if (!isPlainObject(row) || typeof row.name !== 'string' || row.name.length === 0) continue
    rows.push({
      name: row.name,
      added: typeof row.added === 'number' && Number.isFinite(row.added) ? row.added : 0,
      removed: typeof row.removed === 'number' && Number.isFinite(row.removed) ? row.removed : 0,
      modified: typeof row.modified === 'number' && Number.isFinite(row.modified) ? row.modified : 0,
    })
  }
  return rows
}

/** 首装未跑 baseline 的判定：没有可用清单就绝不把 targetDir 当"远端全量"去覆盖。 */
function needsBaseline(manifest) {
  if (!isPlainObject(manifest)) return true
  if (typeof manifest.headSha !== 'string' || manifest.headSha.length === 0) return true
  if (!isPlainObject(manifest.files) || Object.keys(manifest.files).length === 0) return true
  return false
}

function message(error) {
  return error && typeof error.message === 'string' && error.message.length > 0 ? error.message : String(error)
}

function now() {
  return new Date().toISOString()
}

/**
 * git blob sha = sha1("blob <字节数>\\0" + 内容)。树里存的正是这个值，
 * 所以它既能当 diff 指纹（diffTrees），也能当下载内容的完整性校验和。
 */
function gitBlobSha(content) {
  const hash = createHash('sha1')
  hash.update('blob ' + content.length + '\0')
  hash.update(content)
  return hash.digest('hex')
}

function delay(ms) {
  return new Promise((resolveTick) => setTimeout(resolveTick, ms))
}

/**
 * 带超时与重试的 fetch。重试范围只含"间歇性失败"：网络层抛错（含超时）与
 * 408/429/5xx；404/403 这类 4xx 是真答案，重试救不回来，立即失败。
 */
async function fetchWithRetry(url, responseType) {
  const attempts = 1 + FETCH_RETRIES
  const headers =
    responseType === 'json'
      ? { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' }
      : { 'User-Agent': USER_AGENT }
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    // 指数退避（500 → 1000 → 2000ms）：镜像站在高并发下会回 503，
    // 线性退避（500/1000）不足以让它缓过来 —— 实测 814 文件并发下载时
    // 偶发 503，退避拉长后同一批能过。
    if (attempt > 0) await delay(RETRY_DELAY_MS * 2 ** (attempt - 1))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let outcome
    try {
      const response = await fetch(url, { headers, signal: controller.signal })
      outcome = response.ok
        ? { value: responseType === 'json' ? await response.json() : Buffer.from(await response.arrayBuffer()) }
        : { status: response.status, statusText: response.statusText }
    } catch (error) {
      // response.json() 抛 SyntaxError = HTTP 层已通但响应体不是 JSON（代理/劫持
      // 常见 200+HTML）。重试救不回来，白等三轮还把错误伪装成网络问题 —— 直接
      // 失败，错误信息里带上 URL 才看得出来源。
      if (error instanceof SyntaxError) {
        throw new Error('invalid JSON from ' + url + ' (' + error.message + ')')
      }
      outcome = { network: error }
    } finally {
      clearTimeout(timer)
    }
    if ('value' in outcome) return outcome.value
    if (outcome.network !== undefined) {
      // 断连/超时正是"间歇性失败"的本体：换一次连接再试。
      lastError =
        outcome.network.name === 'AbortError'
          ? new Error('timeout after ' + FETCH_TIMEOUT_MS + 'ms: ' + url)
          : outcome.network
      continue
    }
    const httpError = new Error('HTTP ' + outcome.status + ' ' + outcome.statusText + ' for ' + url)
    if (outcome.status === 408 || outcome.status === 429 || outcome.status >= 500) {
      lastError = httpError
      continue
    }
    throw httpError
  }
  throw lastError
}

/**
 * 有界并发映射：最多 limit 个任务同时在飞，结果按输入顺序返回。
 *
 * 为什么自己写而不是引库：本插件只允许 node: 内置模块（见文件头 import 约定）；
 * 而且这里需要的语义很窄——全部跑完、按序回结果、单个失败不外抛（由任务自己收集）。
 *
 * @param items 输入数组。
 * @param limit 并发上限。
 * @param worker 每个元素的异步处理函数（内部自己 try/catch）。
 */
async function mapPool(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = []
  const width = Math.max(1, Math.min(limit, items.length))
  for (let slot = 0; slot < width; slot++) {
    runners.push((async () => {
      while (true) {
        const index = cursor++
        if (index >= items.length) return
        results[index] = await worker(items[index], index)
      }
    })())
  }
  await Promise.all(runners)
  return results
}

/** 同目录 tmp + rename 的原子写；rename 在同一卷上原子，崩溃也只会留下完整文件。 */
async function atomicWrite(target, data) {
  const temp = target + '.' + process.pid.toString(36) + '-' + Date.now().toString(36) + '.tmp'
  await writeFile(temp, data)
  try {
    await rename(temp, target)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

/**
 * 用 PowerShell 的 Start-Process 打开资源管理器，而不是直接 spawn explorer.exe：
 * explorer 即使成功也返回码 1，等退出码会把成功当失败；Start-Process 立即返回，
 * 退出码是 PowerShell 自己的 0。pwsh（PowerShell 7）优先，退回系统自带 powershell.exe。
 */
function openInExplorer(rawDir, warn) {
  // explorer 对正斜杠路径的处理随版本漂移，先归一成反斜杠。
  const dir = rawDir.replace(/\//g, '\\')
  const script = "Start-Process -FilePath explorer.exe -ArgumentList '" + dir.replace(/'/g, "''") + "'"
  const args = ['-NoProfile', '-NonInteractive', '-Command', script]
  const options = { detached: true, stdio: 'ignore', windowsHide: true }
  const attempt = (command, fallback) => {
    let child
    try {
      child = spawn(command, args, options)
    } catch (error) {
      fallback(error)
      return
    }
    // 'spawn' 事件 = 进程真的起来了，此后的 error 与"打不开目录"无关。
    child.once('spawn', () => child.removeListener('error', fallback))
    child.once('error', fallback)
    child.unref()
  }
  attempt('pwsh', () => attempt('powershell.exe', (error) => warn(error)))
}

/**
 * 清理删空了的父目录直到 skill 根为止：rmdir 只能删空目录，非空目录抛
 * ENOTEMPTY —— 正好当"上面还有活文件"的判定用，删空一层才继续向上。
 */
async function pruneEmptyDirs(dir, stopAt) {
  let cursor = dir
  while (cursor === stopAt || (cursor.startsWith(stopAt + sep) && cursor.length > stopAt.length)) {
    try {
      await rmdir(cursor)
    } catch {
      return
    }
    cursor = dirname(cursor)
  }
}

/** `<skill>/<rel>` -> `<skill>`；不合形状的键返回 null（不入变更统计）。 */
function skillNameOf(path) {
  const index = path.indexOf('/')
  return index > 0 ? path.slice(0, index) : null
}

/**
 * 本地已安装技能的扫描结果。
 *
 * 为什么要"扫目录"而不是只看自己写过的 state：用户可能用 git clone、
 * 手工拷贝、别的工具装过一部分技能。插件的完整性结论必须反映**磁盘真相**，
 * 否则"检测到部分技能"会误报成"全无"。
 *
 * @typedef {{ installed: string[], missing: string[], complete: boolean }} Installation
 */

/**
 * 扫描目标目录下真实存在的 nature-* 技能。
 *
 * 判定"已安装"的严格口径：**目录存在且里面有 SKILL.md 或 skill.md**。
 * 只看目录存在会把半路中断的下载（空目录/半截文件）算成已装，用户看到
 * "已完成"却发现技能调不起来。SKILL.md 是 DSH 技能发现的硬前提
 * （dsh-skill-filesystem 的 discoverRoot 会跳过没有 SKILL.md 的目录）。
 *
 * @param targetDir 技能根目录（不是 skill 自身目录）。
 * @returns 已安装与缺失的目录名清单。
 */
export async function scanInstallation(targetDir) {
  const installed = []
  const missing = []
  for (const name of NATURE_SKILLS) {
    let ok = false
    try {
      // 目录本身要在；不存在时 readdir 会抛 ENOENT，落到 ok=false。
      const entries = await readdir(join(resolve(targetDir), name), { withFileTypes: true })
      ok = entries.some((entry) => entry.isFile() && /^skill\.md$/i.test(entry.name))
    } catch {
      ok = false
    }
    if (ok) installed.push(name)
    else missing.push(name)
  }
  // 统一经 installationOf 出形状：扫描结果与状态快照必须是同一套字段，
  // 否则「刚扫完」和「从状态读」会给出两种结构（installedCount 一处有一处无）。
  return installationOf({ installed })
}

/**
 * 基线清单 vs 远端树的 diff。两侧键都是 `<skill>/<rel>`（相对 skills/ 根），
 * 值都是 git blob sha —— 内容寻址意味着"sha 不同 = 内容真的变了"，没有 mtime 误报。
 *
 * @param manifestFiles 本地基线：{ '<skill>/<rel>': blobSha }
 * @param remoteFiles   远端树：同形状
 * @returns {{ skills: {name,added,removed,modified}[], added: Object<string,string>, modified: Object<string,string>, removed: string[] }}
 */
export function diffTrees(manifestFiles, remoteFiles) {
  const local = fileMapOf(manifestFiles)
  const remote = fileMapOf(remoteFiles)
  const added = {}
  const modified = {}
  const removed = []
  for (const [path, sha] of Object.entries(remote)) {
    const before = local[path]
    if (before === undefined) added[path] = sha
    else if (before !== sha) modified[path] = sha
  }
  for (const path of Object.keys(local)) {
    if (remote[path] === undefined) removed.push(path)
  }
  removed.sort()
  // 汇总到 skill 粒度：UI 显示"哪个 skill 动了几处"，更新引擎按 skill 定位子树。
  const counts = new Map()
  const touch = (name) => {
    let row = counts.get(name)
    if (row === undefined) {
      row = { name, added: 0, removed: 0, modified: 0 }
      counts.set(name, row)
    }
    return row
  }
  for (const path of Object.keys(added)) {
    const name = skillNameOf(path)
    if (name !== null) touch(name).added += 1
  }
  for (const path of removed) {
    const name = skillNameOf(path)
    if (name !== null) touch(name).removed += 1
  }
  for (const path of Object.keys(modified)) {
    const name = skillNameOf(path)
    if (name !== null) touch(name).modified += 1
  }
  const skills = [...counts.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { skills, added, modified, removed }
}

/**
 * 从 diff 里取出真正有变化的 skill 名：排序、去重。除 skills 行之外还从文件清单
 * 反查一遍 —— 调用方手拼 diff（缺 skills 行）时也不漏，且天然去重。
 */
export function pickChangedSkillNames(diff) {
  const names = new Set()
  const fromFiles = (path) => {
    const name = skillNameOf(path)
    if (name !== null) names.add(name)
  }
  if (isPlainObject(diff)) {
    if (Array.isArray(diff.skills)) {
      for (const row of diff.skills) {
        if (isPlainObject(row) && typeof row.name === 'string' && row.added + row.removed + row.modified > 0) {
          names.add(row.name)
        }
      }
    }
    if (isPlainObject(diff.added)) for (const path of Object.keys(diff.added)) fromFiles(path)
    if (isPlainObject(diff.modified)) for (const path of Object.keys(diff.modified)) fromFiles(path)
    if (Array.isArray(diff.removed)) for (const path of diff.removed) fromFiles(path)
  }
  return [...names].sort()
}

/**
 * 把 `<skill>/<rel>` 落到 targetDir 下的绝对路径，负责**全部防穿越**：
 * skill 必须是单段目录名；rel 逐段白名单（拒绝 `..`、`.`、空段、反斜杠、盘符、
 * 冒号/空字节），最后再确认 resolve 结果没翻出 skill 目录 —— 逐段检查是关键，
 * 像 `a\..\..\x` 整体看不是 `..`，在 win32 上却照样能逃逸。
 * 纯字符串运算，不碰磁盘。
 */
export function normalizeSkillPath(targetDir, skill, rel) {
  if (typeof targetDir !== 'string' || targetDir.trim().length === 0) {
    throw new Error('dsh-nature: `targetDir` must be a non-empty string')
  }
  if (
    typeof skill !== 'string' ||
    skill.length === 0 ||
    skill === '.' ||
    skill === '..' ||
    skill.includes('/') ||
    skill.includes('\\') ||
    skill.includes(':') ||
    skill.includes('\0') ||
    isAbsolute(skill)
  ) {
    throw new Error('dsh-nature: `skill` must be a plain directory name, got ' + JSON.stringify(skill))
  }
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new Error('dsh-nature: `rel` must be a non-empty relative path')
  }
  if (rel.includes('\0') || isAbsolute(rel)) {
    throw new Error('dsh-nature: `rel` must stay inside the skill directory, got ' + JSON.stringify(rel))
  }
  for (const part of rel.split('/')) {
    if (part.length === 0 || part === '.' || part === '..' || part.includes('\\') || part.includes(':')) {
      throw new Error('dsh-nature: unsafe path segment ' + JSON.stringify(part) + ' in `rel`')
    }
    if (/^[A-Za-z]:/.test(part)) {
      // 盘符相对路径（'C:foo'）在 win32 的 isAbsolute 里是 false，必须单独拦。
      throw new Error('dsh-nature: drive-letter path is not allowed, got ' + JSON.stringify(rel))
    }
  }
  const root = resolve(targetDir)
  const skillRoot = resolve(root, skill)
  const full = resolve(root, skill, ...rel.split('/'))
  // 双保险：白名单理论上已封死出口，再确认解析结果没出 skill 目录
  // （比"仍在 targetDir 内"更严 —— skillRoot 本身就在 targetDir 内）。
  if (full !== skillRoot && !full.startsWith(skillRoot + sep)) {
    throw new Error('dsh-nature: resolved path escapes the skill directory: ' + JSON.stringify(full))
  }
  return full
}

/** Remote 入参校验：未传/null = 全部 changed；传了就必须是非空字符串数组。 */
function requireSkillNames(skillNames) {
  if (skillNames === undefined || skillNames === null) return undefined
  if (!Array.isArray(skillNames)) throw new Error('dsh-nature: `skillNames` must be an array of skill names')
  const names = []
  for (const name of skillNames) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('dsh-nature: every entry of `skillNames` must be a non-empty string')
    }
    names.push(name.trim())
  }
  return [...new Set(names)]
}

/**
 * Nature 服务：状态文件 + 更新引擎 + 浏览器侧 `remote.dshNature`。
 */
class NatureService {
  /**
   * @param ctx 所属 Cordis 上下文。
   * @param config 本行配置（dshHome 可覆盖状态文件位置）。
   */
  constructor(ctx, config) {
    this.ctx = ctx
    const explicitHome = config === undefined || config === null ? undefined : config.dshHome
    this.file = join(resolveDshHome(explicitHome), STATE_FILE)
    /** 写盘串行链：两次连点不会互相覆盖。 */
    this.writeChain = Promise.resolve()
    /** check/update 互斥链：一键更新连点两次、定时检查撞上手动更新，都排成队。 */
    this.busy = Promise.resolve()
    /** Gateway 的 SRC 兜底靠这个绑定把服务认成 Remote 命名空间（形状同 overclock）。 */
    this.typertRemote = { service: this, serviceKey: SERVICE_KEY, namespace: SERVICE_KEY }
    this.bootTimer = null
    this.intervalTimer = null
    this.state = defaultState()
    this.load()
  }

  /**
   * 启动时同步读一次状态。
   *
   * 为什么必须同步：status() 是 Remote 方法随时可能被调，构造完成即对外可见；
   * 异步读会留一段"文件还没读到 → 界面显示空状态"的窗口。这里只读一个
   * 几百 KB 的 JSON，代价可以忽略。坏文件按字段清洗，绝不抛错拖垮 fiber。
   */
  load() {
    let raw
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.warn('load', error)
      return
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.warn('load', error)
      return
    }
    if (!isPlainObject(parsed)) return
    if (parsed.version !== undefined && parsed.version !== STATE_VERSION) return
    if (isPlainObject(parsed.config)) {
      const merged = { ...this.state.config }
      if (typeof parsed.config.autoCheck === 'boolean') merged.autoCheck = parsed.config.autoCheck
      if (
        typeof parsed.config.intervalHours === 'number' &&
        Number.isFinite(parsed.config.intervalHours) &&
        parsed.config.intervalHours >= 0
      ) {
        merged.intervalHours = parsed.config.intervalHours
      }
      if (typeof parsed.config.targetDir === 'string' && parsed.config.targetDir.trim().length > 0) {
        merged.targetDir = parsed.config.targetDir.trim()
      }
      if (typeof parsed.config.mirror === 'string') merged.mirror = parsed.config.mirror.trim()
      this.state.config = merged
    }
    if (isPlainObject(parsed.manifest)) {
      const headSha = typeof parsed.manifest.headSha === 'string' ? parsed.manifest.headSha : null
      const files = fileMapOf(parsed.manifest.files)
      if (headSha !== null || Object.keys(files).length > 0) {
        this.state.manifest = { headSha, files }
        this.state.headSha = headSha
      }
    }
    if (typeof parsed.lastCheckedAt === 'string') this.state.lastCheckedAt = parsed.lastCheckedAt
    if (typeof parsed.lastCheckStatus === 'string') this.state.lastCheckStatus = parsed.lastCheckStatus
    if (typeof parsed.lastError === 'string') this.state.lastError = parsed.lastError
    if (typeof parsed.updateAvailable === 'boolean') this.state.updateAvailable = parsed.updateAvailable
    if (Array.isArray(parsed.changedSkills)) this.state.changedSkills = changedSkillsOf(parsed.changedSkills)
    if (isPlainObject(parsed.installation)) this.state.installation = installationOf(parsed.installation)
  }

  warn(scope, error) {
    try {
      if (this.ctx.logger?.warn) this.ctx.logger.warn('[dsh-nature] ' + scope + ': ' + message(error))
    } catch {
      /* 日志通道坏了不该影响功能 */
    }
  }

  /** 全量状态快照（深拷贝）：浏览器侧就读它，改它影响不到引擎内部。 */
  status() {
    const state = this.state
    return {
      version: state.version,
      headSha: state.headSha,
      lastCheckedAt: state.lastCheckedAt,
      lastCheckStatus: state.lastCheckStatus,
      lastError: state.lastError,
      updateAvailable: state.updateAvailable,
      changedSkills: state.changedSkills.map((row) => ({ ...row })),
      manifest: { headSha: state.manifest.headSha, files: { ...state.manifest.files } },
      // 安装快照必须原样给到浏览器半：工作台/设置页靠它渲染"未安装/部分/完整"三态。
      installation: installationOf(state.installation),
      config: { ...state.config },
    }
  }

  /**
   * 远端检查。出错时把原因写进状态返回（不抛），之前的结论字段原样保留。
   *
   * 同时刷新本地安装快照（磁盘扫描，不联网）——检测是"本地真相 + 远端版本"
   * 两件事，任何一次检查都该给出一致结论。
   */
  check() {
    return this
      .runExclusive(() => this.refreshInstallation().then(() => this.runCheck()))
      .then(() => this.status())
  }

  /** 只扫本地、不联网：给面板一个立刻可用的安装结论（挂载首屏用）。 */
  inspect() {
    return this.refreshInstallation().then(() => this.status())
  }

  /**
   * 重扫本地安装快照并落盘。
   *
   * 扫描失败（权限/盘符失效）不抛：退回"全缺"结论并记 lastError 语境，
   * 面板会显示"检测失败"而不是假装"已装好"。
   */
  async refreshInstallation() {
    try {
      this.state.installation = await scanInstallation(this.state.config.targetDir)
    } catch (error) {
      this.warn('scanInstallation', error)
      this.state.installation = { installed: [], missing: [...NATURE_SKILLS], complete: false }
    }
    try {
      await this.persist()
    } catch (error) {
      this.warn('inspect.persist', error)
    }
    return this.state.installation
  }

  /**
   * 增量更新。skillNames 未传 = 全部 changed；传了 = 只同步点名的那些。
   *
   * 返回值必须是**刷新后的完整状态对象**，与 status()/check()/setConfig() 同形 ——
   * 浏览器半三个面板拿到动作结果就直接 statusView(unwrap(remote)) 覆盖本地状态
   * （client.js 的 UpdateCenter / SettingsPanel）。runUpdate 内部出于「哪些成功、
   * 哪些被跳过、哪些文件失败」的需要返回的是另一套形状，**不能直接透出**：
   * 那样 statusView 会把一个没有 manifest/config 的对象归一化成
   * 「未建立基线 + 目标目录为空」并整页渲染，一次更新就把设置页显示成坏状态。
   * 明细挂在 outcome 上原样带出（statusView 只读它认识的字段，多加无副作用）。
   */
  update(skillNames) {
    return this
      .runExclusive(() => this.runUpdate(skillNames))
      .then((outcome) => ({ ...this.status(), outcome }))
  }

  /** 改配置（autoCheck/intervalHours/targetDir/mirror），落盘后重排定时器。 */
  async setConfig(patch) {
    if (!isPlainObject(patch)) throw new Error('dsh-nature: `patch` must be an object')
    const previous = this.state.config
    const next = { ...previous }
    if (patch.autoCheck !== undefined) {
      if (typeof patch.autoCheck !== 'boolean') throw new Error('dsh-nature: `autoCheck` must be a boolean')
      next.autoCheck = patch.autoCheck
    }
    if (patch.intervalHours !== undefined) {
      if (typeof patch.intervalHours !== 'number' || !Number.isFinite(patch.intervalHours) || patch.intervalHours < 0) {
        throw new Error('dsh-nature: `intervalHours` must be a finite number >= 0 (0 turns auto check off)')
      }
      next.intervalHours = patch.intervalHours
    }
    if (patch.targetDir !== undefined) {
      if (typeof patch.targetDir !== 'string' || patch.targetDir.trim().length === 0) {
        throw new Error('dsh-nature: `targetDir` must be a non-empty string')
      }
      next.targetDir = patch.targetDir.trim()
    }
    if (patch.mirror !== undefined) {
      if (patch.mirror !== null && typeof patch.mirror !== 'string') {
        throw new Error('dsh-nature: `mirror` must be a string or null')
      }
      next.mirror = patch.mirror === null ? '' : patch.mirror.trim()
    }
    this.state.config = next
    try {
      await this.persist()
    } catch (error) {
      this.state.config = previous // 落盘失败回滚内存，避免"看起来改了其实没有"。
      throw error
    }
    this.scheduleAutoChecks()
    return this.status()
  }

  /**
   * 安装/补全全套 nature-skills。
   *
   * 一个方法覆盖需求里的两种场景，因为它们在引擎层是同一件事：
   *   - 一个技能都没有 → 全量安装 24 个；
   *   - 只有一部分（比如只有 nature-figure）→ **只补缺的那些**，
   *     已有的照常按远端最新版刷新（用户明确要求"更新已有的部分的技能"）。
   *
   * 与 update() 的关键差异：update() 以 manifest 基线做增量（只动变化项），
   * **首装没有基线时它会拒绝动手**。install() 是"首次建立可用状态"的入口，
   * 没有基线也要能跑 —— 所以它不依赖 manifest，直接以远端树为准落盘，
   * 完成后把 manifest 快进到该 commit，之后的 update() 才有基线可用。
   *
   * @param skillNames 可选：点名要装/补哪些（面板的"自动补全"传 missing）。
   *                   省略 = 全套 24 个都确保到最新。
   */
  install(skillNames) {
    return this
      .runExclusive(() => this.runInstall(skillNames))
      .then((outcome) => ({ ...this.status(), outcome }))
  }

  /** 在资源管理器里打开技能目录；目录不存在就先建（它本来就是引擎的工作目标）。 */
  async openSkillsDir() {
    const dir = this.state.config.targetDir
    await mkdir(dir, { recursive: true })
    openInExplorer(dir, (error) => this.warn('openSkillsDir', error))
    return this.status()
  }

  // ── 引擎内部（都在 runExclusive 里跑） ──────────────────────────────────────

  async runCheck() {
    try {
      const headSha = await this.fetchHeadSha()
      if (needsBaseline(this.state.manifest)) {
        // 首装未跑基线：状态里明说，引导用户跑 baseline.cjs，**不擅自全量覆盖**。
        this.state.lastCheckStatus = 'baseline-missing'
        this.state.lastCheckedAt = now()
        this.state.lastError = null
        this.state.updateAvailable = false
        this.state.changedSkills = []
        await this.persist()
        return this.status()
      }
      if (headSha === this.state.manifest.headSha) {
        this.state.lastCheckStatus = 'upToDate'
        this.state.lastCheckedAt = now()
        this.state.lastError = null
        this.state.updateAvailable = false
        this.state.changedSkills = []
        await this.persist()
        return this.status()
      }
      const remoteFiles = await this.fetchSkillFiles(headSha)
      const diff = diffTrees(this.state.manifest.files, remoteFiles)
      this.state.lastCheckedAt = now()
      this.state.lastError = null
      if (diff.skills.length === 0) {
        // headSha 动了但 skills/ 内容零差异：清单直接快进到新 commit。
        // 不快进的话，之后每次检查都会因 headSha 不等而重拉整棵树。
        this.state.manifest = { headSha, files: this.baselineFor(remoteFiles) }
        this.state.headSha = headSha
        this.state.lastCheckStatus = 'upToDate'
        this.state.updateAvailable = false
        this.state.changedSkills = []
      } else {
        this.state.lastCheckStatus = 'updateAvailable'
        this.state.updateAvailable = true
        this.state.changedSkills = diff.skills
      }
      await this.persist()
    } catch (error) {
      // 出错保留 updateAvailable/changedSkills：那是最后一次成功检查的结论。
      this.state.lastCheckStatus = 'error'
      this.state.lastCheckedAt = now()
      this.state.lastError = message(error)
      try {
        await this.persist()
      } catch (persistError) {
        this.warn('check.persist', persistError)
      }
    }
    return this.status()
  }

  /**
   * 安装/补全引擎。
   *
   * 流程：拉远端头 → 拉整棵树 → 对每个目标 skill 逐文件下载（blob sha 校验）
   * → 落盘 → 把 manifest 快进到该 commit。
   *
   * 与 runUpdate 的取舍差异（有意为之）：
   *   - runUpdate 全部成功才写 manifest（部分成功保留旧值，让 diff 继续如实）；
   *   - runInstall 只要**没有整 skill 失败**就写 manifest —— 这是首装路径，
   *     不写基线的话用户会永远停在"未建立基线"，每次检查都白拉一遍整棵树。
   *     单文件失败记录在 failures 里如实上报，不静默。
   */
  async runInstall(skillNames) {
    const requested = requireSkillNames(skillNames)
    const targetsWanted = requested === undefined ? [...NATURE_SKILLS] : requested.filter((name) => NATURE_SKILLS.includes(name))
    const failures = []
    const installed = []
    const skipped = []

    try {
      const headSha = await this.fetchHeadSha()
      const remoteFiles = await this.fetchSkillFiles(headSha)

      // skill 之间互不依赖：整批并发跑，单个 skill 内部再按 DOWNLOAD_CONCURRENCY 并发。
      // 总并发因此是 CONCURRENCY² —— 太高会被 raw 匿名限流，所以外层限 2。
      await mapPool(targetsWanted, 2, async (name) => {
        const prefix = name + '/'
        const files = Object.keys(remoteFiles).filter((rel) => rel.startsWith(prefix))
        if (files.length === 0) {
          // 远端树里没有这个 skill：不是本地问题，如实记为跳过。
          skipped.push(name)
          return
        }
        // 与 syncSkill 同一套并发编排：814 个文件串行要十几分钟，用户会以为卡死。
        let skillFailures = 0
        await mapPool(files, DOWNLOAD_CONCURRENCY, async (rel) => {
          try {
            const body = await this.downloadBlob(headSha, rel, remoteFiles[rel])
            const target = normalizeSkillPath(this.state.config.targetDir, name, rel.slice(prefix.length))
            await mkdir(dirname(target), { recursive: true })
            await atomicWrite(target, body)
          } catch (error) {
            skillFailures += 1
            failures.push({ skill: name, file: rel, message: message(error) })
          }
        })
        // 单文件失败不算整 skill 失败：只要 SKILL.md 落了盘，这个技能就能被发现。
        const hasEntry = files.some((rel) => rel === prefix + 'SKILL.md')
        if (skillFailures === 0 || hasEntry) installed.push(name)
      })

      // 失败是"网络/磁盘"级别才算安装失败；部分文件失败仍把基线快进（见函数头）。
      const fatal = failures.length > 0 && installed.length === 0

      // 安装完立刻重扫，让返回状态里的 installation 反映刚写下的磁盘真相。
      this.state.installation = await scanInstallation(this.state.config.targetDir)

      if (fatal) {
        this.state.lastCheckStatus = 'error'
        this.state.lastError = failures.length + ' file(s) failed to install'
        this.state.lastCheckedAt = now()
        try {
          await this.persist()
        } catch (error) {
          this.warn('install.persist', error)
        }
        return {
          ok: false,
          reason: 'network',
          headSha: null,
          installed: [],
          skipped,
          failures: failures.slice(0, 20),
        }
      }

      // 基线只能记真正落盘的 skill。
      //
      // 这里曾经直接写整棵远端树（remoteFiles），后果是只装 1 个 skill 也会把
      // 另外 23 个记进基线 —— 之后 update() 的 diff 认为那 23 个"已是最新"，
      // 它们永远装不上（实测：install([nature-figure]) 后 manifest 有 3 条，
      // update() 报 changedSkills=[] / updateAvailable=false）。
      //
      // 正确口径：以本次扫描到的 installation.installed 为白名单，只保留
      // "<已装 skill>/" 前缀的文件。没装的 skill 不进基线，下次 update() 的
      // diff 自然把它们报成新增。
      this.state.manifest = { headSha, files: this.baselineFor(remoteFiles) }
      this.state.headSha = headSha
      this.state.lastCheckedAt = now()
      this.state.lastError = null

      // 基线反映"已装的那部分"与远端的差异；还有没装的 skill 也一并报出来。
      const diff = diffTrees(this.state.manifest.files, remoteFiles)
      const stillMissing = this.state.installation.complete === false
      this.state.lastCheckStatus = stillMissing ? 'baseline-missing' : 'upToDate'
      this.state.updateAvailable = diff.skills.length > 0
      this.state.changedSkills = diff.skills
      try {
        await this.persist()
      } catch (error) {
        this.warn('install.persist', error)
      }
      return {
        ok: failures.length === 0,
        reason: failures.length > 0 ? 'partial' : null,
        headSha,
        installed,
        skipped,
        failures: failures.slice(0, 20),
      }
    } catch (error) {
      const text = message(error)
      this.state.lastCheckStatus = 'error'
      this.state.lastCheckedAt = now()
      this.state.lastError = text
      try {
        await this.persist()
      } catch (persistError) {
        this.warn('install.persist', persistError)
      }
      return { ok: false, reason: 'network', error: text, headSha: null, installed: [], skipped, failures: [] }
    }
  }

  async runUpdate(skillNames) {
    const requested = requireSkillNames(skillNames)
    if (needsBaseline(this.state.manifest)) {
      // 与 check() 同一立场：没有基线就不动手。
      this.state.lastCheckStatus = 'baseline-missing'
      this.state.lastCheckedAt = now()
      try {
        await this.persist()
      } catch (error) {
        this.warn('update.persist', error)
      }
      return { ok: false, reason: 'baseline-missing', headSha: null, updated: [], skipped: [], removed: [], failures: [] }
    }
    try {
      // 连通性预检（同 check 第一步）+ 拉新鲜树：更新永远以"此刻"的远端为准，
      // 不信任上次 check 留下的 changedSkills —— 那可能是几小时前的快照。
      const headSha = await this.fetchHeadSha()
      const remoteFiles = await this.fetchSkillFiles(headSha)
      const diff = diffTrees(this.state.manifest.files, remoteFiles)
      this.state.lastCheckedAt = now()
      const changedNames = pickChangedSkillNames(diff)
      let targets
      let skipped = []
      if (requested === undefined) {
        targets = changedNames
      } else {
        targets = []
        skipped = []
        for (const name of requested) {
          if (changedNames.includes(name)) targets.push(name)
          else skipped.push(name)
        }
      }
      const failures = []
      const updated = []
      const removed = []
      for (const name of targets) {
        const outcome = await this.syncSkill(name, headSha, remoteFiles, diff.removed)
        removed.push(...outcome.removed)
        if (outcome.failures.length === 0) updated.push(name)
        else failures.push(...outcome.failures)
      }
      // 更新改的是磁盘：必须在判定状态**之前**重扫，否则下面几个分支用的还是
      // 更新前的 installation，会把"刚补上的技能"当成没装（updateAvailable 判错）。
      this.state.installation = await scanInstallation(this.state.config.targetDir)

      if (failures.length === 0 && updated.length > 0 && updated.length === diff.skills.length) {
        // 全部成功才写新 manifest 与 headSha。部分成功不写：已落盘的文件无害，
        // 下次更新原样覆盖；清单保持旧值，diff 才能继续如实反映剩余变更。
        this.state.manifest = { headSha, files: this.baselineFor(remoteFiles) }
        this.state.headSha = headSha
        this.state.lastCheckStatus = 'upToDate'
        this.state.lastError = null
        this.state.updateAvailable = false
        this.state.changedSkills = []
      } else if (failures.length === 0 && updated.length === 0 && diff.skills.length === 0) {
        // 空差异（skills/ 内容与本地清单完全一致，如上游 revert 后 headSha 仍不同）：
        // 与 runCheck 的快进分支同一套处理 —— 清单快进到新 commit，过期红点/错误一起
        // 清掉。不接这个分支的话，两个状态分支都不命中，旧结论原样 persist，红点不灭。
        this.state.manifest = { headSha, files: this.baselineFor(remoteFiles) }
        this.state.headSha = headSha
        this.state.lastCheckStatus = 'upToDate'
        this.state.lastError = null
        this.state.updateAvailable = false
        this.state.changedSkills = []
      } else if (diff.skills.length > 0) {
        this.state.lastCheckStatus = 'updateAvailable'
        this.state.lastError = failures.length > 0 ? failures.length + ' file(s) failed to update' : null
        this.state.updateAvailable = true
        this.state.changedSkills = diff.skills
      }
      try {
        await this.persist()
      } catch (error) {
        this.warn('update.persist', error)
      }
      return {
        ok: failures.length === 0,
        reason: failures.length > 0 ? 'partial' : null,
        headSha,
        updated,
        skipped,
        removed,
        failures,
      }
    } catch (error) {
      const text = message(error)
      this.state.lastCheckStatus = 'error'
      this.state.lastCheckedAt = now()
      this.state.lastError = text
      try {
        await this.persist()
      } catch (persistError) {
        this.warn('update.persist', persistError)
      }
      return { ok: false, reason: 'network', error: text, headSha: null, updated: [], skipped: [], removed: [], failures: [] }
    }
  }

  /**
   * 按"磁盘上真实装了的 skill"裁剪远端树，作为新的基线清单。
   *
   * 基线是**本地状态的真相**，不是远端的样子。直接把整棵树写进去，会让
   * "远端有但本地没装"的 skill 被记成已同步 —— 之后 diff 认为它们已是最新，
   * 用户永远装不上（install 与 update 两处都踩过，2026-11-04 实测确认）。
   *
   * @param remoteFiles 远端树（<skill>/<rel> -> blob sha）
   * @returns 只含已装 skill 前缀的子集
   */
  baselineFor(remoteFiles) {
    const installed = isPlainObject(this.state.installation) && Array.isArray(this.state.installation.installed)
      ? this.state.installation.installed
      : []
    if (installed.length === 0) return {}
    const prefixes = installed.map((name) => name + '/')
    const out = {}
    for (const [rel, sha] of Object.entries(remoteFiles)) {
      if (prefixes.some((prefix) => rel.startsWith(prefix))) out[rel] = sha
    }
    return out
  }

  /**
   * 把一个 skill 同步到磁盘：远端有的写下去，远端没有的删掉。
   * 单文件失败只记清单不中断 —— 剩余文件照常同步，失败如实上报。
   */
  async syncSkill(name, headSha, remoteFiles, removedPaths) {
    const failures = []
    const removed = []
    const prefix = name + '/'
    const wanted = Object.keys(remoteFiles).filter((rel) => rel.startsWith(prefix))
    // 并发下载（见 DOWNLOAD_CONCURRENCY 注释）：每个文件独立校验 + 原子写，
    // 并发只改编排顺序。异常在单个任务里收集，绝不外抛中断整批。
    await mapPool(wanted, DOWNLOAD_CONCURRENCY, async (rel) => {
      try {
        const body = await this.downloadBlob(headSha, rel, remoteFiles[rel])
        // 防穿越统一入口：rel 里的任何花样都在 normalizeSkillPath 里抛错。
        const target = normalizeSkillPath(this.state.config.targetDir, name, rel.slice(prefix.length))
        await mkdir(dirname(target), { recursive: true })
        await atomicWrite(target, body)
      } catch (error) {
        failures.push({ skill: name, file: rel, message: message(error) })
      }
    })
    for (const path of removedPaths) {
      if (!path.startsWith(prefix)) continue
      try {
        const target = normalizeSkillPath(this.state.config.targetDir, name, path.slice(prefix.length))
        await rm(target, { force: true })
        removed.push(path)
        const skillRoot = resolve(this.state.config.targetDir, name)
        await pruneEmptyDirs(dirname(target), skillRoot)
      } catch (error) {
        failures.push({ skill: name, file: path, message: message(error) })
      }
    }
    return { failures, removed }
  }

  async fetchHeadSha() {
    const commit = await fetchWithRetry(COMMITS_URL, 'json')
    const sha = isPlainObject(commit) ? commit.sha : undefined
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error('commits/main returned no usable sha')
    }
    return sha
  }

  /** 拉整棵树并过滤出 skills/ 下的 blob：键 `<skill>/<rel>` -> blob sha。 */
  async fetchSkillFiles(headSha) {
    const tree = await fetchWithRetry(TREES_URL + headSha + '?recursive=1', 'json')
    if (!isPlainObject(tree) || !Array.isArray(tree.tree)) {
      throw new Error('trees response has no tree array')
    }
    if (tree.truncated === true) {
      // 截断树是残缺快照，diff 会漏文件，宁可失败也不给出错误的"已更新"。
      throw new Error('tree response truncated; refusing to diff an incomplete snapshot')
    }
    const files = {}
    for (const entry of tree.tree) {
      if (!isPlainObject(entry) || entry.type !== 'blob') continue
      const path = entry.path
      if (typeof path !== 'string' || !path.startsWith(SKILLS_PREFIX)) continue
      const rel = path.slice(SKILLS_PREFIX.length)
      // 只认 skills/<skill>/<file>；skill 段缺失（顶层散文件）不属于本插件的管理对象。
      const slash = rel.indexOf('/')
      if (slash <= 0 || slash === rel.length - 1) continue
      if (typeof entry.sha !== 'string' || entry.sha.length === 0) continue
      files[rel] = entry.sha
    }
    return files
  }

  /** 下载单个文件并按 blob sha 校验。mirror 只替换 raw 前缀，api.github.com 不动。 */
  async downloadBlob(headSha, rel, blobSha) {
    const base = this.rawBase()
    const encoded = rel.split('/').map(encodeURIComponent).join('/')
    const url = base + '/' + REPO + '/' + headSha + '/skills/' + encoded
    const body = await fetchWithRetry(url, 'raw')
    const actual = gitBlobSha(body)
    if (actual !== blobSha) {
      throw new Error('blob sha mismatch: expected ' + blobSha + ', got ' + actual)
    }
    return body
  }

  rawBase() {
    const mirror = this.state.config.mirror
    if (typeof mirror === 'string' && mirror.trim().length > 0) {
      return mirror.trim().replace(/\/+$/, '')
    }
    return RAW_ORIGIN
  }

  // ── 定时器 ──────────────────────────────────────────────────────────────────

  /**
   * 自动检查调度：autoCheck 开且 intervalHours > 0 才排（0 = 关，含首查）。
   * 句柄都存起来，setConfig 与 fiber dispose 时统一清。unref 让测试进程能退出，
   * 对常驻的 harness 没有影响。
   */
  scheduleAutoChecks() {
    this.clearTimers()
    const { autoCheck, intervalHours } = this.state.config
    if (autoCheck !== true || !(intervalHours > 0)) return
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null
      this.check().catch((error) => this.warn('auto-check', error))
    }, FIRST_CHECK_DELAY_MS)
    this.bootTimer.unref?.()
    const intervalMs = Math.min(Math.round(intervalHours * 3600 * 1000), MAX_TIMER_MS)
    this.intervalTimer = setInterval(() => {
      this.check().catch((error) => this.warn('auto-check', error))
    }, intervalMs)
    this.intervalTimer.unref?.()
  }

  clearTimers() {
    if (this.bootTimer !== null) {
      clearTimeout(this.bootTimer)
      this.bootTimer = null
    }
    if (this.intervalTimer !== null) {
      clearInterval(this.intervalTimer)
      this.intervalTimer = null
    }
  }

  // ── 状态落盘 ────────────────────────────────────────────────────────────────

  /** 串行链上的原子写；快照在真正执行时再取，避免并发下写回旧值。 */
  persist() {
    const run = async () => {
      await mkdir(dirname(this.file), { recursive: true })
      await atomicWrite(this.file, JSON.stringify(this.state, null, 2) + '\n')
    }
    const next = this.writeChain.then(run, run)
    this.writeChain = next.then(() => undefined, () => undefined)
    return next
  }

  /** check/update 互斥：前一个失败不拖垮后一个，返回值/异常都如实传给调用方。 */
  runExclusive(task) {
    const run = this.busy.then(task, task)
    this.busy = run.then(() => undefined, () => undefined)
    return run
  }
}

/**
 * Gateway 在找不到生成式严格定义时会读这个原型标记（dsh-api-gateway/lib/index.js:1241
 * `remoteMethods(original).find(...)`），参数名则从函数源码里解析（同文件 :1715）。
 * 所以上面的 Remote 方法**不能**用默认值/解构/剩余参数，参数名就是线上字段名。
 */
Object.defineProperty(NatureService.prototype, REMOTE_METHODS, {
  configurable: true,
  value: {
    version: 1,
    methods: [
      { method: 'status', invocation: { kind: 'direct' } },
      { method: 'inspect', invocation: { kind: 'direct' } },
      { method: 'check', invocation: { kind: 'direct' } },
      { method: 'update', invocation: { kind: 'direct' } },
      { method: 'install', invocation: { kind: 'direct' } },
      { method: 'setConfig', invocation: { kind: 'direct' } },
      { method: 'openSkillsDir', invocation: { kind: 'direct' } },
    ],
  },
})

/** Cordis 插件名。 */
export const name = '@zws/dsh-nature'

/**
 * 宿主依赖。**刻意为空**：更新引擎只用全局 fetch 与 node: 内置模块，不需要
 * webServer / settings / storage 任何一个。空数组 = 无依赖，cordis 立刻 apply。
 */
export const inject = []

/**
 * 注册服务与自动检查生命周期。
 * @param ctx 所属 Cordis 上下文。
 * @param config 本行配置（dshHome 可覆盖状态文件位置）。
 */
export function apply(ctx, config) {
  const service = new NatureService(ctx, config)
  ctx.provide(SERVICE_KEY, service)
  // 定时器登记进 cordis 生命周期：fiber dispose 时两个定时器一起清掉。
  ctx.effect(
    () => {
      service.scheduleAutoChecks()
      return () => service.clearTimers()
    },
    'dsh-nature.auto-check',
  )
}
