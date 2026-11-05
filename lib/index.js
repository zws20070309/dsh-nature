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
/**
 * 上游技能源清单。**多源**：每个源是一个 GitHub 仓库，技能都在它的 `skills/` 子树下。
 *
 * 为什么必须是数组而不是单个仓库：本插件现在管两套技能 ——
 *   1. Yuan1z0825/nature-skills：Nature 论文写作全套（原有用例，保持不变）；
 *   2. Adkid-Zephyr/anti-defensive-writing-Skill：反防御性写作（用户点名要的）。
 * 两套技能装进**同一个** targetDir，被同一套检测/安装/更新/红点引擎管理，
 * 用户不需要为第二套技能再装一个插件。
 *
 * 字段约定：
 *   id           稳定标识，会写进状态文件与 manifest，**不许改**（改了等于全部重装）；
 *   repo         GitHub 的 owner/name；
 *   skillsPrefix 该仓库里技能目录的前缀。两个源目前都是 skills/，仍然显式写出来 ——
 *                将来某个仓库把技能放在别处时，改数据而不是改代码；
 *   label        给人看的源名（面板/错误信息里用）。
 */
export const SOURCES = [
  {
    id: 'nature',
    repo: 'Yuan1z0825/nature-skills',
    skillsPrefix: 'skills/',
    label: 'nature-skills',
  },
  {
    id: 'anti-defensive',
    repo: 'Adkid-Zephyr/anti-defensive-writing-Skill',
    skillsPrefix: 'skills/',
    label: 'anti-defensive-writing',
  },
]

/** 主源：UI 的「远端版本」默认显示它，保持单源时代的状态字段语义不变。 */
const PRIMARY_SOURCE = SOURCES[0].id

/** id → 源定义；未知 id 返回 undefined（状态文件被改坏时不猜、不炸）。 */
function sourceById(id) {
  return SOURCES.find((source) => source.id === id)
}
/**
 * 内置技能清单：**离线兜底**，不是权威来源。
 *
 * 权威清单永远是**远端树** —— fetchSkillFiles() 从 GitHub trees API 读到的
 * skills/ 下真实存在的目录。上游从 24 变 25、26 甚至改名/删除时，插件必须
 * 自动跟上，不能靠改代码。（2026-11-04 之前这里是唯一来源，上游新增技能
 * 插件完全无感 —— 用户装了全套也发现不了新技能。）
 *
 * 这份清单只在两种情况下用到：
 *   1. 首次运行、还没有任何远端快照（没有网络/还没检查过）时，给面板一个
 *      可展示的初始状态，而不是空白；
 *   2. 远端快照存在但为空（异常情况）时兜底，避免把「技能全没了」当成结论。
 *
 * 换句话说：**它能少、能旧，但不能成为天花板。**新增技能一律从远端来。
 *
 * 注意：目录名 ≠ 触发名（nature-proposal-writer 的 frontmatter 是 researchwrite）。
 */
/**
 * 每个源的内置技能清单（**离线兜底**，不是权威来源）。
 *
 * 权威清单永远是**远端树** —— fetchSkillFiles() 从 GitHub trees API 读到的
 * skills/ 下真实存在的目录。上游从 24 变 25、26 甚至改名/删除时，插件必须
 * 自动跟上，不能靠改代码。
 *
 * 这份清单只在两种情况下用到：
 *   1. 首次运行、还没有任何远端快照（没有网络/还没检查过）时，给面板一个
 *      可展示的初始状态，而不是空白；
 *   2. 远端快照存在但为空（异常情况）时兜底，避免把「技能全没了」当成结论。
 *
 * 换句话说：**它能少、能旧，但不能成为天花板。**新增技能一律从远端来。
 *
 * 注意：目录名 ≠ 触发名（nature-proposal-writer 的 frontmatter 是 researchwrite）。
 */
const BUILTIN_SKILLS = {
  nature: [
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
  ],
  'anti-defensive': [
    'anti-defensive-writing',
    'anti-defensive-writing-en',
  ],
}

/** 内置的全量兜底清单：两个源合并、排序（与远端 roster 的排序口径一致）。 */
export const NATURE_SKILLS = Object.values(BUILTIN_SKILLS).flat().sort()

/** 单个源的内置清单；未知源返回空数组（不猜）。 */
function builtinSkillsOf(sourceId) {
  const list = BUILTIN_SKILLS[sourceId]
  return Array.isArray(list) ? [...list] : []
}
const API_ORIGIN = 'https://api.github.com'
const RAW_ORIGIN = 'https://raw.githubusercontent.com'
/**
 * raw 下载的镜像兜底（按顺序试）。
 *
 * 本机实测 2026-11-05：raw.githubusercontent.com 对两个上游仓库都 ECONNRESET，
 * 而 ghproxy.net 同路径 200。没有镜像兜底时"网络一抖 = 26 个技能全装不上"，
 * 用户只会看到 fetch failed（真实端到端跑出来的结果）。
 * 镜像只做**传输**：内容仍由 git blob sha 逐文件校验，被篡改/返回错误页都过不了。
 */
const FALLBACK_RAW_MIRRORS = [
  'https://ghproxy.net/https://raw.githubusercontent.com',
  'https://gh-proxy.com/https://raw.githubusercontent.com',
]
/** User-Agent 是 GitHub API 的硬要求；仍以主仓为标识（多源共用同一个 UA）。 */
const USER_AGENT = 'dsh-nature-plugin (+https://github.com/' + SOURCES[0].repo + ')'
/** 单源的 commits 地址：取该仓库 main 的最新提交 sha。 */
function commitsUrl(source) {
  return API_ORIGIN + '/repos/' + source.repo + '/commits/main'
}
/** 单源的整棵树地址：递归列出全部 blob，再按 skillsPrefix 过滤。 */
function treesUrl(source, headSha) {
  return API_ORIGIN + '/repos/' + source.repo + '/git/trees/' + headSha + '?recursive=1'
}
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
    /** 远端权威技能清单（从 trees API 学到）：上游增删技能时自动跟上。 */
    roster: [...NATURE_SKILLS],
  /**
   * 每个源各自的远端快照状态。多源改造的核心：一个源断网/改名/空树时，
   * 不能影响另一个源的结论。顶层 headSha/manifest 仍然镜像**主源**，
   * 保持单源时代的字段语义（UI 的「远端版本」直接读它）。
   *
   * 形状：{ [sourceId]: { headSha: string|null, manifest: {headSha, files} } }
   */
  sources: {},
  /** 本次检查里失败的源（不为空时面板要如实显示「某个源拉取失败」）。 */
  sourceErrors: [],
    rosterUpdatedAt: null,
    /** 自上次同步以来上游**新增**的技能（用户还没装）；面板据此提示「上游新增 N 个」。 */
    rosterAdded: [],
    /** 自上次同步以来上游**移除**的技能（本地可能还有，不自动删）。 */
    rosterRemoved: [],
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
function installationOf(value, roster) {
  // roster = 权威技能清单（远端学到的）。缺省退回内置清单 —— 首装、离线、
  // 旧 state 三种情况都不会因此崩掉。
  const names = normalizeRoster(roster)
  const knownNames = new Set(names)
  const pick = (list) => (Array.isArray(list) ? list.filter((name) => typeof name === 'string' && knownNames.has(name)) : [])
  const installed = isPlainObject(value) ? [...new Set(pick(value.installed))].sort() : []
  const missing = names.filter((name) => !installed.includes(name))
  const complete = missing.length === 0 && installed.length > 0
  return {
    installed,
    missing,
    complete,
    total: names.length,
    installedCount: installed.length,
    empty: installed.length === 0,
    partial: installed.length > 0 && !complete,
    // 宿主侧也带 known：直接读 status() 的消费者（测试/脚本/别的面板）与浏览器半
    // 用同一套字段，不必各自推断这份快照算不算已知。
    known: true,
  }
}

/**
 * 技能清单归一化：去重、只留合法形状、排序。
 *
 * 上游可能新增（24→25→26）、改名、甚至删除技能。清单一律以远端为准，
 * 这里只做形状防守 —— 空/坏输入退回内置清单，绝不让「远端返回空」被当成
 * 「技能全没了」而把用户已有的安装判成多余。
 */
function normalizeRoster(roster) {
  const seen = new Set()
  const out = []
  const push = (name) => {
    if (typeof name !== 'string') return
    const trimmed = name.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) return
    seen.add(trimmed)
    out.push(trimmed)
  }
  if (Array.isArray(roster)) for (const name of roster) push(name)
  return out.length > 0 ? out.sort() : [...NATURE_SKILLS]
}

/**
 * 从远端树里提取**权威技能清单**：skills/ 下真实存在的目录名。
 *
 * 这是「上游变成 25 个 / 26 个技能」的唯一入口 —— 插件不再把技能数写死。
 * 判定口径与该 skill 的可用性一致：目录里必须有 SKILL.md（DSH 的
 * discoverRoot 同样要求），只有零散文件不算一个技能。
 *
 * @param remoteFiles fetchSkillFiles() 的结果：`<skill>/<rel>` -> blob sha
 * @returns 排序后的技能目录名数组；远端为空时返回空数组（**不**退回内置清单，
 *          由调用方判断是否要保留旧 roster —— 空树通常意味着异常，不该覆盖已有结论）。
 */
export function rosterFromTree(remoteFiles) {
  const names = new Set()
  if (!isPlainObject(remoteFiles)) return []
  for (const rel of Object.keys(remoteFiles)) {
    const slash = rel.indexOf('/')
    if (slash <= 0) continue
    const skill = rel.slice(0, slash)
    const rest = rel.slice(slash + 1)
    // 只有目录里有 SKILL.md（大小写不敏感）才算一个可用技能。
    if (/^skill\.md$/i.test(rest)) names.add(skill)
  }
  return [...names].sort()
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

/**
 * 是否需要先建基线：**只看有没有可用文件清单**，不看 headSha。
 *
 * 为什么不再要求 headSha：多源之后顶层 headSha 镜像主源，而主源可能一个技能
 * 都没装（用户只要反防御技能）→ 顶层 headSha 是 null，但各源自己的清单是好的。
 * 旧定义下 needsBaseline 恒真，状态永远停在 baseline-missing，update() 永远
 * 拒绝动手（2026-11-05 实测：只装反防御技能后 update 返回 baseline-missing）。
 *
 * files 为空才是真的没有基线 —— 那时绝不把 targetDir 当"远端全量"去覆盖。
 */
function needsBaseline(manifest) {
  if (!isPlainObject(manifest)) return true
  if (!isPlainObject(manifest.files)) return true
  if (Object.keys(manifest.files).length === 0) return true
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
export async function scanInstallation(targetDir, roster) {
  const names = normalizeRoster(roster)
  const installed = []
  for (const name of names) {
    try {
      // 目录本身要在；不存在时 readdir 抛 ENOENT —— 那是正常的「没装」。
      const entries = await readdir(join(resolve(targetDir), name), { withFileTypes: true })
      if (entries.some((entry) => entry.isFile() && /^skill\.md$/i.test(entry.name))) installed.push(name)
    } catch (error) {
      // 只有「不存在」能当成「没装」。权限/IO 错误必须冒出去 ——
      // 把它们当「没装」会让面板说「未检测到技能」并引导用户重装，
      // 而重装写到同一个坏目录会再次失败，全程看不到「检测失败」。
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
    }
  }
  // 统一经 installationOf 出形状：扫描结果与状态快照必须是同一套字段。
  return installationOf({ installed }, names)
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
    /**
     * 技能 → 所属源 的归属表：Map<sourceId, Set<skillName>>。
     * 由 learnRoster 维护（它本来就在看每个 skill 来自哪个远端树）。
     * 用途：filesOfSource 按归属筛文件，而不是靠路径前缀猜。
     */
    this.sourceOf = new Map()
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
    // 多源状态：只接受已知源 id 的形状，坏数据丢弃（不猜、不炸）。
    if (isPlainObject(parsed.sources)) {
      const next = {}
      for (const [id, value] of Object.entries(parsed.sources)) {
        if (sourceById(id) === undefined) continue
        if (!isPlainObject(value)) continue
        const headSha = typeof value.headSha === 'string' ? value.headSha : null
        const manifest = isPlainObject(value.manifest)
          ? { headSha: typeof value.manifest.headSha === 'string' ? value.manifest.headSha : null, files: fileMapOf(value.manifest.files) }
          : { headSha: null, files: {} }
        next[id] = { headSha, manifest }
      }
      this.state.sources = next
    }
    if (Array.isArray(parsed.sourceErrors)) {
      this.state.sourceErrors = parsed.sourceErrors.filter((row) => isPlainObject(row) && typeof row.source === 'string')
    }
    // 单源 → 多源迁移（在 **load 阶段**做，不等下一次 check）：
    // 旧状态文件只有顶层 manifest，sources 是空的。如果不在这里迁移，
    // 进程启动后的第一次 check 会拿空基线 diff 完整远端树，把每个技能都报成
    // "新增"，红点亮起（2026-11-05 重启 DSH 后实机踩到，26 条误报）。
    // 把旧顶层 manifest 交给主源复用，剩下的源由 adoptLocalBaseline 在 check 时补齐。
    this.migrateLegacyBaseline()
  }

  /**
   * 把单源时代的顶层 manifest 迁移给主源。
   *
   * 只在「主源还没有基线，而顶层有」时动手；已有 per-source 基线时什么都不做
   * （重复迁移会把用户已更新的基线覆盖回旧值）。
   */
  migrateLegacyBaseline() {
    const scoped = this.sourceState(PRIMARY_SOURCE)
    if (!needsBaseline(scoped.manifest)) return
    if (needsBaseline(this.state.manifest)) return
    scoped.headSha = this.state.manifest.headSha ?? null
    scoped.manifest = { headSha: scoped.headSha, files: { ...this.state.manifest.files } }
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
      // 权威清单也带给浏览器半：目录/计数都按它渲染，不能写死。
      roster: [...state.roster],
      rosterUpdatedAt: state.rosterUpdatedAt,
      rosterAdded: [...state.rosterAdded],
      rosterRemoved: [...state.rosterRemoved],
      // 多源：每个源各自的最新 sha 与上次比对时的基线，面板按源显示。
      sources: SOURCES.map((source) => {
        const scoped = isPlainObject(state.sources) ? state.sources[source.id] : undefined
        return {
          id: source.id,
          repo: source.repo,
          label: source.label,
          headSha: isPlainObject(scoped) && typeof scoped.headSha === 'string' ? scoped.headSha : null,
          baselineSha: isPlainObject(scoped) && isPlainObject(scoped.manifest) && typeof scoped.manifest.headSha === 'string'
            ? scoped.manifest.headSha
            : null,
          skills: [...(this.sourceOf.get(source.id) ?? builtinSkillsOf(source.id))].sort(),
        }
      }),
      // 本次拉取失败的源：面板要如实显示，而不是假装"全套就绪"。
      sourceErrors: Array.isArray(state.sourceErrors) ? state.sourceErrors.map((row) => ({ ...row })) : [],
      installation: installationOf(state.installation, state.roster),
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
    // 必须与 install/check/update 走同一条串行链：refreshInstallation 会写
    // state.installation 并落盘，不加锁就会与安装过程抢同一个字段
    // （扫描在安装写盘中途开始、在安装扫描之后完成 → 把旧快照覆盖回去）。
    return this.runExclusive(() => this.refreshInstallation()).then(() => this.status())
  }

  /**
   * 重扫本地安装快照并落盘。
   *
   * 扫描失败（权限/盘符失效）不抛：退回"全缺"结论并记 lastError 语境，
   * 面板会显示"检测失败"而不是假装"已装好"。
   */
  async refreshInstallation() {
    try {
      this.state.installation = await scanInstallation(this.state.config.targetDir, this.state.roster)
    } catch (error) {
      this.warn('scanInstallation', error)
      this.state.installation = installationOf({ installed: [] }, this.state.roster)
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
    // 换了目标目录就必须重扫：否则安装结论停在旧目录（面板显示旧目录的「全套已
    // 就绪」，实际新目录一个技能都没有）。
    if (next.targetDir !== previous.targetDir) {
      await this.refreshInstallation()
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
  installSkills(skillNames) {
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
      // 先拉**全部源**的远端树 —— 在有无基线、headSha 变没变之前。
      //
      // 这一步以前藏在「headSha 变了」分支里，于是两个场景永远学不到新技能：
      //   - 首装没有基线（下面的 baseline-missing 分支直接 return）；
      //   - 远端没新提交（headSha 相同，直接 return）。
      // 而「上游从 24 变成 25」恰恰可能发生在 headSha 已变但我们上次已经
      // 快进过的情形 —— 只要不重新拉树，就永远发现不了。
      // 代价是每次 check 多几次 trees 请求（本来 headSha 变了也要拉），可接受。
      //
      // 多源下 fetchAllSources 容忍**部分源失败**：
      // 反防御源被墙/改名时，nature 全套的检查结论不该跟着变成 error。
      const snapshot = await this.fetchAllSources()
      // 归属表要用「每个源自己的文件表」学，不能只看合并后的全量表 ——
      // 合并后无法区分同名技能来自哪个源，filesOfSource 就没法筛。
      const perSourceFiles = {}
      for (const [id, entry] of Object.entries(snapshot.perSource)) perSourceFiles[id] = entry.files
      this.learnRoster(snapshot.files, perSourceFiles)
      this.state.sourceErrors = snapshot.failures

      // 本地已有技能但还没有基线：**用磁盘真相自动补一个**，而不是把用户
      // 挡在「未建立基线，请去跑 tools/baseline.cjs」前面。
      //
      // 为什么之前是拒绝：单源时代担心「远端整棵树被写进本地」造成假基线。
      // 现在补的基线来自「已装技能 ∩ 远端树」（baselineFor 按 installed 裁剪），
      // 既不会多记也不会少记；本地文件本来就在那儿，补基线只是承认既有事实，
      // 不写任何技能文件、不覆盖任何内容。
      //
      // 真实场景（2026-11-05 实测）：用户先把技能装好了（手工拷贝 / 旧版插件 /
      // 别的工具），装上本插件后只想「检查更新」—— 若这里仍拒绝，update() 永远
      // 返回 baseline-missing，用户以为「更新功能坏了」。
      // 触发条件必须**逐源**判断，不能只看顶层：
      // 从单源升级到多源时，顶层 manifest 是旧版写的（非空），但 sources 是空的 ——
      // 只看 needsBaseline(顶层) 会跳过采纳，接着每个源都用空基线 diff 完整远端树，
      // 26 个技能全部误报「新增」（2026-11-05 重启后实机踩到）。
      if (this.hasLocalSkills() && this.sourcesNeedBaseline()) {
        this.adoptLocalBaseline(snapshot)
      }

      if (needsBaseline(this.state.manifest)) {
        // 真的什么都没有（本地零技能 + 无基线）：状态里明说，引导用户装全套，
        // **不擅自全量覆盖**。
        this.state.lastCheckStatus = 'baseline-missing'
        this.state.lastCheckedAt = now()
        this.state.lastError = null
        this.state.updateAvailable = false
        this.state.changedSkills = []
        await this.persist()
        return this.status()
      }

      // 逐源比对：每个源用自己的 headSha 与自己的 manifest 片段。
      // 这样「只有反防御源更新了」不会被 nature 源相同的 headSha 掩盖。
      const changedSources = []
      for (const source of SOURCES) {
        const scoped = this.sourceState(source.id)
        const headSha = snapshot.heads[source.id]
        if (headSha === undefined) continue // 这个源本次没拉到，跳过（已记在 sourceErrors）
        if (headSha === scoped.manifest.headSha) continue
        changedSources.push(source.id)
      }

      if (changedSources.length === 0) {
        // 所有源的 headSha 都没变：技能内容层面不会有变化，但 roster 已经在上面的
        // learnRoster 里更新过了（可能补上了之前没学到的条目）。
        //
        // 这里曾经写 `installation.complete === false ? 'baseline-missing' : 'upToDate'`：
        // 把「技能没装全」和「没有基线」混成了一件事。两回事 —— 基线是
        // 「我知道远端长什么样」，装没装全是另一条轴。混在一起会让只装了部分
        // 技能的用户永远停在 baseline-missing：update() 因此永远拒绝动手
        // （真实场景：用户只想要反防御技能，不装 nature 全套）。
        // 走到这里说明基线存在（上面 needsBaseline 已挡掉），所以就是 upToDate。
        this.state.lastCheckStatus = 'upToDate'
        this.state.lastCheckedAt = now()
        this.state.lastError = null
        this.state.updateAvailable = false
        this.state.changedSkills = []
        await this.persist()
        return this.status()
      }

      // 汇总各源的 diff：任一源有技能级变化，就算「有更新」。
      const perSourceDiff = {}
      const allChanged = []
      for (const source of SOURCES) {
        if (!changedSources.includes(source.id)) continue
        const scoped = this.sourceState(source.id)
        const sourceFiles = this.filesOfSource(snapshot.files, source.id)
        const diff = diffTrees(scoped.manifest.files, sourceFiles)
        perSourceDiff[source.id] = diff
        for (const row of diff.skills) allChanged.push(row)
      }

      this.state.lastCheckedAt = now()
      this.state.lastError = null
      if (allChanged.length === 0) {
        // headSha 动了但 skills/ 内容零差异：清单直接快进到新 commit。
        // 不快进的话，之后每次检查都会因 headSha 不等而重拉整棵树。
        for (const source of SOURCES) {
          const headSha = snapshot.heads[source.id]
          if (headSha === undefined) continue
          this.commitSource(source.id, headSha, snapshot.files)
        }
        this.state.lastCheckStatus = 'upToDate'
        this.state.updateAvailable = false
        this.state.changedSkills = []
      } else {
        this.state.lastCheckStatus = 'updateAvailable'
        this.state.updateAvailable = true
        this.state.changedSkills = allChanged.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
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
   * 是否**至少有一个源**还没有基线。
   *
   * 与 needsBaseline(顶层) 的区别是这里逐源看：顶层 manifest 在单源时代是唯一的
   * 基线载体，升级到多源后它还在，但 sources 是空的 —— 只判顶层会漏掉这次迁移。
   */
  sourcesNeedBaseline() {
    for (const source of SOURCES) {
      if (needsBaseline(this.sourceState(source.id).manifest)) return true
    }
    return false
  }
  /** 磁盘上是否已有至少一个已装技能（用来决定要不要自动补基线）。 */
  hasLocalSkills() {
    const installation = this.state.installation
    return isPlainObject(installation) && Array.isArray(installation.installed) && installation.installed.length > 0
  }

  /**
   * 用「已装技能 ∩ 远端树」给每个源补一份基线。
   *
   * 补完的效果：状态从 baseline-missing 变成可比较状态，用户能立刻点「检查更新」/
   * 「更新」。**不写任何技能文件** —— 它只是承认磁盘上既有的事实。
   *
   * 两个关键场景（都是真实踩过的）：
   *
   * 1. 技能早就装好了，插件状态文件是新的 → 各源都还没有基线，全部补上，
   *    否则 update() 永远返回 baseline-missing。
   *
   * 2. **从单源版本升级到多源版本**（2026-11-05 实机踩到）：旧状态文件里只有
   *    顶层 manifest，`sources` 是空对象。只看 needsBaseline(顶层) 的话它是非空的
   *    （旧版写进去的 818 个文件），于是这段被跳过；接着逐源 diff 时每个源都用
   *    空基线 vs 完整远端树 → **26 个技能全部误报成「新增」**，红点亮起，
   *    用户以为有更新，实际什么都没变。
   *    所以这里必须**逐源**判断，不能只看顶层。旧顶层 manifest 作为主源的
   *    迁移来源用（它能复用就别浪费一次网络往返）。
   *
   * 安全边界：只记 installed 里的技能（baselineFor 的口径），所以「远端有但本地
   * 没装」的技能不会被记成已同步 —— 那种假基线会让用户永远装不上缺的技能。
   */
  adoptLocalBaseline(snapshot) {
    if (!isPlainObject(snapshot) || !isPlainObject(snapshot.heads)) return
    let adopted = 0
    for (const source of SOURCES) {
      const headSha = snapshot.heads[source.id]
      if (headSha === undefined) continue // 这个源没拉到，跳过
      const scoped = this.sourceState(source.id)
      if (!needsBaseline(scoped.manifest)) continue // 这个源已有基线，不覆盖
      // 单源 → 多源迁移：旧顶层 manifest 属于主源，直接搬过去，
      // 免得重新按「已装 ∩ 远端」重算（结果等价，但能保住历史基线）。
      if (source.id === PRIMARY_SOURCE && !needsBaseline(this.state.manifest)) {
        scoped.headSha = headSha
        scoped.manifest = { headSha, files: { ...this.state.manifest.files } }
        adopted += 1
        continue
      }
      const files = this.baselineFor(this.filesOfSource(snapshot.files, source.id), source.id)
      if (Object.keys(files).length === 0) continue // 这个源本地一个都没装，无基线可补
      scoped.headSha = headSha
      scoped.manifest = { headSha, files }
      adopted += 1
    }
    if (adopted > 0) {
      this.syncTopLevelManifest()
      this.state.lastError = null
    }
  }
  /**
   * 取某个源的状态槽，没有就建默认值。
   *
   * 为什么要 per-source：多源之后「基线」不再是全局的一个 sha —— 两个仓库各有
   * 各的 main。混用会让一个源的提交号去 diff 另一个源的文件清单，结果永远是
   * 全量新增/全量删除。旧状态文件里没有这个字段，所以读的时候要能自愈。
   */
  sourceState(sourceId) {
    if (!isPlainObject(this.state.sources)) this.state.sources = {}
    let scoped = this.state.sources[sourceId]
    if (!isPlainObject(scoped)) {
      scoped = { headSha: null, manifest: { headSha: null, files: {} } }
      this.state.sources[sourceId] = scoped
    }
    if (!isPlainObject(scoped.manifest)) scoped.manifest = { headSha: null, files: {} }
    if (!isPlainObject(scoped.manifest.files)) scoped.manifest.files = {}
    if (typeof scoped.manifest.headSha !== 'string') scoped.manifest.headSha = null
    if (typeof scoped.headSha !== 'string') scoped.headSha = null
    return scoped
  }

  /**
   * 从全量文件表里筛出属于某个源的那些条目。
   *
   * 判定依据是**技能名归属**，不是路径前缀 —— 两个源的仓库结构不同
   * （都叫 skills/ 但内容不同），归属只能靠 skill 名。
   * 归属表由 roster 学到：learnRoster 记录了每个 skill 来自哪个源。
   */
  filesOfSource(files, sourceId) {
    const out = {}
    const owned = this.sourceOf.get(sourceId)
    if (owned === undefined) return out
    for (const [rel, sha] of Object.entries(files)) {
      const skill = skillNameOf(rel)
      if (skill !== null && owned.has(skill)) out[rel] = sha
    }
    return out
  }

  /** 技能归属于哪个源；归属表里查不到返回 null（调用方如实报错，不猜）。 */
  sourceOfSkill(skillName) {
    for (const source of SOURCES) {
      const owned = this.sourceOf.get(source.id)
      if (owned !== undefined && owned.has(skillName)) return source
    }
    // 归属表还没学到（首装第一次）：按内置清单兜底判断，避免第一次安装就失败。
    for (const source of SOURCES) {
      if (builtinSkillsOf(source.id).includes(skillName)) return source
    }
    return null
  }

  /**
   * 逐源 diff 后汇总。
   *
   * 必须逐源：manifest 是按源存的，远端文件表也应只取该源的条目。
   * 混合会让「反防御源多出一个技能」被 nature 源的基线判成新增、
   * 而 nature 源的那份又被反防御的基线判成删除 —— 两边都报错。
   */
  diffAllSources(remoteFiles) {
    const skills = []
    const added = {}
    const modified = {}
    const removed = []
    for (const source of SOURCES) {
      const scoped = this.sourceState(source.id)
      const sourceFiles = this.filesOfSource(remoteFiles, source.id)
      const diff = diffTrees(scoped.manifest.files, sourceFiles)
      skills.push(...diff.skills)
      Object.assign(added, diff.added)
      Object.assign(modified, diff.modified)
      removed.push(...diff.removed)
    }
    skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    removed.sort()
    return { skills, added, modified, removed }
  }

  /**
   * 把某个源的清单快进到该 commit，并同步顶层镜像字段。
   *
   * 顶层 hotSha/manifest 镜像**主源**：UI 的「基线版本 / 远端版本」读的是那两个
   * 字段，保持单源时代的语义（用户看到的仍是 nature-skills 的提交号）。
   */
  commitSource(sourceId, headSha, allFiles) {
    const scoped = this.sourceState(sourceId)
    scoped.headSha = headSha
    scoped.manifest = { headSha, files: this.baselineFor(this.filesOfSource(allFiles, sourceId), sourceId) }
    this.syncTopLevelManifest()
  }

  /**
   * 顶层 manifest/headSha 是所有源基线的**并集**（headSha 取主源）。
   *
   * 为什么必须是并集而不是"只镜像主源"：needsBaseline() 判的是
   * top-level manifest.files 是否为空。多源第一次只装反防御技能时，主源
   * （nature）一个技能都没装 → 镜像出来的 files 是空 → needsBaseline 恒真
   * → 状态永远停在 baseline-missing，update() 一直拒绝动手。
   * 实测路径：installSkills(['anti-defensive-writing']) 成功后
   * lastCheckStatus 仍是 baseline-missing（2026-11-05 真实网络端到端跑出来的）。
   *
   * headSha 仍镜像主源：UI 的「基线版本 / 远端版本」读它，保持单源时代的语义。
   */
  syncTopLevelManifest() {
    const files = {}
    let primaryHead = null
    for (const source of SOURCES) {
      const scoped = this.sourceState(source.id)
      Object.assign(files, scoped.manifest.files)
      if (source.id === PRIMARY_SOURCE) primaryHead = scoped.headSha
    }
    this.state.manifest = { headSha: primaryHead, files }
    if (primaryHead !== null) this.state.headSha = primaryHead
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
    // 白名单**以远端权威清单为准**，不是内置的 24 项常量 —— 否则上游新增技能
    // （24→25→26）即使远端树里有，也会因为「不在白名单」被拒之门外。
    // 远端清单优先，还没学到时退回内置兜底（首装/离线）。
    /** 调度期「有文件尝试落盘」的 skill；最终装没装以磁盘重扫为准。 */
    const touched = []
    // invalid 在 learnRoster 之后才能算出来，见下面的 targetsWanted 段。
    const skipped = []
    /** 逐文件的失败记录；只用于如实上报，不静默吞。 */
    const failures = []

    try {
      // 拉**全部源**：用户点「安装全套」时要装的是两套技能，不只是 nature。
      // fetchAllSources 容忍部分源失败（见其注释）：某个源挂了，另一个照样装。
      const snapshot = await this.fetchAllSources()
      const remoteFiles = snapshot.files
      this.state.sourceErrors = snapshot.failures

      // 学到远端权威清单：上游新增技能（24→25→26、以及第二套技能）自动跟上。
      const perSourceFiles = {}
      for (const [id, entry] of Object.entries(snapshot.perSource)) perSourceFiles[id] = entry.files
      this.learnRoster(remoteFiles, perSourceFiles)

      // 目标清单必须在 learnRoster **之后**再算 —— 用刚学到的权威 roster。
      // 早算一步就会漏掉上游本次新增的技能（实测：远端 25 个、只装了 24 个）。
      const known = normalizeRoster(this.state.roster)
      // 不在清单里的名字不能静默丢弃：用户点名要装 X，结果 ok:true 什么也没装，
      // 界面显示成功 —— 实测 install(['not-a-nature-skill']) 返回 {ok:true, installed:[]}。
      // 现在把这些名字记进 skipped，让调用方看得见。
      const invalid = requested === undefined ? [] : requested.filter((name) => !known.includes(name))
      const targetsWanted = requested === undefined
        ? [...known]
        : requested.filter((name) => known.includes(name))
      for (const name of invalid) if (!skipped.includes(name)) skipped.push(name)

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
        // 这个 skill 属于哪个源：下载地址与 headSha 都得用**它自己的**源 ——
        // 用错源会拼出 404，或拿到另一个仓库的同路径文件（sha 校验会拦，但白跑）。
        const source = this.sourceOfSkill(name)
        if (source === null) {
          failures.push({ skill: name, file: '', message: 'cannot determine which source owns ' + name })
          return
        }
        // 与 syncSkill 同一套并发编排：814 个文件串行要十几分钟，用户会以为卡死。
        await mapPool(files, DOWNLOAD_CONCURRENCY, async (rel) => {
          try {
            const body = await this.downloadBlob(source, snapshot.heads[source.id], rel, remoteFiles[rel])
            const target = normalizeSkillPath(this.state.config.targetDir, name, rel.slice(prefix.length))
            await mkdir(dirname(target), { recursive: true })
            await atomicWrite(target, body)
          } catch (error) {
            failures.push({ skill: name, file: rel, message: message(error) })
          }
        })
        // 单文件失败不算整 skill 失败 —— 但"算不算装上"必须以**磁盘**为准。
        //
        // 这里曾经用 `files.some(rel => rel === prefix + SKILL.md)` 判断，而
        // files 是**远端**清单：24 个技能远端都有 SKILL.md，于是恒为 true，
        // installed 恒非空 → 下面的 fatal 永远不成立（实测：全量下载失败后
        // installed 报 24 个、磁盘 0 个文件、状态被置成 upToDate，用户再也装不上）。
        // 现在先记下"这个 skill 有文件落盘了"，最终以重扫出的磁盘真相为准。
        touched.push(name)
      })

      // 安装完立刻重扫：**磁盘真相是唯一可信的"装上了没有"**。
      // 返回值里的 installed 与 fatal 判定都从它派生，不再用调度期的推测。
      this.state.installation = await scanInstallation(this.state.config.targetDir, this.state.roster)
      const onDisk = this.state.installation.installed
      const installed = targetsWanted.filter((name) => onDisk.includes(name))
      const untouched = targetsWanted.filter((name) => !onDisk.includes(name) && !skipped.includes(name))

      // 落盘成功数为 0（且确实有失败）才算致命失败：这时绝不能写基线，
      // 否则假基线会让后续 update() 认为一切已同步，用户永远装不上。
      const fatal = failures.length > 0 && installed.length === 0

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
          untouched,
          skipped,
          failures: failures.slice(0, 20),
        }
      }

      // 基线只记真正落盘的 skill（见 baselineFor 注释）。
      // 逐源写：每个源的清单只含**属于它自己的**那些已装技能。
      for (const source of SOURCES) {
        const headSha = snapshot.heads[source.id]
        if (headSha === undefined) continue
        this.commitSource(source.id, headSha, remoteFiles)
      }
      this.state.lastCheckedAt = now()
      this.state.lastError = failures.length > 0 ? failures.length + " file(s) failed to install" : null

      // 基线反映"已装的那部分"与远端的差异；还有没装的 skill 也一并报出来。
      // 逐源比对后再汇总：混用会让一个源的基线去 diff 另一个源的文件表。
      const diff = this.diffAllSources(remoteFiles)
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
        // 主源的 sha：与 status().headSha 语义一致（UI 的「远端版本」读它）。
        headSha: snapshot.heads[PRIMARY_SOURCE] ?? null,
        installed,
        untouched,
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
      return {
        ok: false,
        reason: 'network',
        error: text,
        headSha: null,
        installed: [],
        untouched: [],
        skipped,
        // error 也进 failures：客户端只读 failures.length 判断有没有问题，
        // 返回空数组会让界面显示绿色的「已安装 0 个技能」（P1-2 实测）。
        failures: [{ skill: '', file: '', message: text }],
      }
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
      const snapshot = await this.fetchAllSources()
      const remoteFiles = snapshot.files
      this.state.sourceErrors = snapshot.failures

      // 学到远端权威清单：上游新增技能（24→25→26）自动跟上。
      const perSourceFiles = {}
      for (const [id, entry] of Object.entries(snapshot.perSource)) perSourceFiles[id] = entry.files
      this.learnRoster(remoteFiles, perSourceFiles)
      // 逐源 diff：manifest 是按源存的，混用会把另一个源的文件判成全增/全删。
      const diff = this.diffAllSources(remoteFiles)
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
        // 每个 skill 用它自己所属源的 headSha 下载。
        const source = this.sourceOfSkill(name)
        if (source === null) {
          failures.push({ skill: name, file: '', message: 'cannot determine which source owns ' + name })
          continue
        }
        const outcome = await this.syncSkill(source, name, snapshot.heads[source.id], remoteFiles, diff.removed)
        removed.push(...outcome.removed)
        if (outcome.failures.length === 0) updated.push(name)
        else failures.push(...outcome.failures)
      }
      // 更新改的是磁盘：必须在判定状态**之前**重扫，否则下面几个分支用的还是
      // 更新前的 installation，会把"刚补上的技能"当成没装（updateAvailable 判错）。
      this.state.installation = await scanInstallation(this.state.config.targetDir, this.state.roster)

      if (failures.length === 0 && updated.length > 0 && updated.length === diff.skills.length) {
        // 全部成功才写新 manifest 与 headSha。部分成功不写：已落盘的文件无害，
        // 下次更新原样覆盖；清单保持旧值，diff 才能继续如实反映剩余变更。
        for (const source of SOURCES) {
          const head = snapshot.heads[source.id]
          if (head === undefined) continue
          this.commitSource(source.id, head, remoteFiles)
        }
        this.state.lastCheckStatus = 'upToDate'
        this.state.lastError = null
        this.state.updateAvailable = false
        this.state.changedSkills = []
      } else if (failures.length === 0 && updated.length === 0 && diff.skills.length === 0) {
        // 空差异（skills/ 内容与本地清单完全一致，如上游 revert 后 headSha 仍不同）：
        // 与 runCheck 的快进分支同一套处理 —— 清单快进到新 commit，过期红点/错误一起
        // 清掉。不接这个分支的话，两个状态分支都不命中，旧结论原样 persist，红点不灭。
        for (const source of SOURCES) {
          const head = snapshot.heads[source.id]
          if (head === undefined) continue
          this.commitSource(source.id, head, remoteFiles)
        }
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
        headSha: snapshot.heads[PRIMARY_SOURCE] ?? null,
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
   * 从远端树学习**权威技能清单**，并记录本次新增/移除的技能。
   *
   * 这是「上游从 24 变 25、26」的唯一入口：插件不再假设技能数固定，
   * 而是每次拿到远端树就重算一遍 roster，让检测/安装/目录展示自动跟上。
   *
   * 两条安全边界：
   *   - 远端树为空（异常/截断）时**不动**现有 roster，避免把「技能全没了」
   *     当成结论去清空用户认知；
   *   - 变化只是记录，不自动删本地目录 —— 上游移除某个技能不等于用户要删文件。
   *
   * @param remoteFiles fetchSkillFiles() 的结果
   * @returns { added: string[], removed: string[] } 相对上一个 roster 的差异
   */
  learnRoster(remoteFiles, perSourceFiles) {
    const next = rosterFromTree(remoteFiles)
    if (next.length === 0) return { added: [], removed: [] }
    // 记下每个技能来自哪个源：filesOfSource 靠它筛文件，不靠路径前缀猜。
    if (isPlainObject(perSourceFiles)) {
      for (const source of SOURCES) {
        const scoped = perSourceFiles[source.id]
        if (!isPlainObject(scoped)) continue
        this.sourceOf.set(source.id, new Set(rosterFromTree(scoped)))
      }
    } else {
      // 没给明细（老调用路径）：按内置清单兜底推断归属。
      for (const source of SOURCES) {
        this.sourceOf.set(source.id, new Set(builtinSkillsOf(source.id)))
      }
    }
    const before = new Set(this.state.roster)
    const after = new Set(next)
    const added = next.filter((name) => !before.has(name))
    const removed = [...before].filter((name) => !after.has(name))
    this.state.roster = next
    this.state.rosterUpdatedAt = now()
    // 只把「还没装的」新增技能算进提示：已经装上的（比如上次已补全）不该反复提醒。
    const installedNow = isPlainObject(this.state.installation) && Array.isArray(this.state.installation.installed)
      ? this.state.installation.installed
      : []
    this.state.rosterAdded = added.filter((name) => !installedNow.includes(name))
    this.state.rosterRemoved = removed
    return { added, removed }
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
  baselineFor(remoteFiles, sourceId) {
    const installed = isPlainObject(this.state.installation) && Array.isArray(this.state.installation.installed)
      ? this.state.installation.installed
      : []
    if (installed.length === 0) return {}
    // 传了 sourceId 就只记该源名下的技能：多源下每个源的清单必须自洽，
    // 否则 nature 的清单里混进反防御的文件，diff 会互相判成"新增/删除"。
    const owned = sourceId === undefined ? null : this.sourceOf.get(sourceId)
    const prefixes = installed
      .filter((name) => owned === null || owned === undefined || owned.has(name))
      .map((name) => name + '/')
    if (prefixes.length === 0) return {}
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
  async syncSkill(source, name, headSha, remoteFiles, removedPaths) {
    const failures = []
    const removed = []
    const prefix = name + '/'
    const wanted = Object.keys(remoteFiles).filter((rel) => rel.startsWith(prefix))
    // 并发下载（见 DOWNLOAD_CONCURRENCY 注释）：每个文件独立校验 + 原子写，
    // 并发只改编排顺序。异常在单个任务里收集，绝不外抛中断整批。
    await mapPool(wanted, DOWNLOAD_CONCURRENCY, async (rel) => {
      try {
        const body = await this.downloadBlob(source, headSha, rel, remoteFiles[rel])
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

  /** 取单个源 main 分支的最新提交 sha。 */
  async fetchHeadSha(source) {
    const commit = await fetchWithRetry(commitsUrl(source), 'json')
    const sha = isPlainObject(commit) ? commit.sha : undefined
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error('commits/main of ' + source.repo + ' returned no usable sha')
    }
    return sha
  }

  /**
   * 拉单个源的整棵树并过滤出 skills/ 下的 blob：键 `<skill>/<rel>` -> blob sha。
   * 两个源的 skill 名天然不冲突（nature-* / anti-defensive-*），所以同一张表即可。
   */
  async fetchSkillFiles(source, headSha) {
    const tree = await fetchWithRetry(treesUrl(source, headSha), 'json')
    if (!isPlainObject(tree) || !Array.isArray(tree.tree)) {
      throw new Error('trees response of ' + source.repo + ' has no tree array')
    }
    if (tree.truncated === true) {
      // 截断树是残缺快照，diff 会漏文件，宁可失败也不给出错误的"已更新"。
      throw new Error('tree response of ' + source.repo + ' truncated; refusing to diff an incomplete snapshot')
    }
    const prefix = source.skillsPrefix
    const files = {}
    for (const entry of tree.tree) {
      if (!isPlainObject(entry) || entry.type !== 'blob') continue
      const path = entry.path
      if (typeof path !== 'string' || !path.startsWith(prefix)) continue
      const rel = path.slice(prefix.length)
      // 只认 skills/<skill>/<file>；skill 段缺失（顶层散文件）不属于本插件的管理对象。
      const slash = rel.indexOf('/')
      if (slash <= 0 || slash === rel.length - 1) continue
      if (typeof entry.sha !== 'string' || entry.sha.length === 0) continue
      files[rel] = entry.sha
    }
    return files
  }

  /**
   * 下载单个文件并按 blob sha 校验。
   *
   * 逐前缀回退（见 rawBases 注释）：直连不通就换镜像。**每个候选都做 sha 校验** ——
   * 镜像站可能返回错误页/旧文件，只有内容哈希对得上才算成功，绝不因为"拿到了
   * 200 的字节"就写进用户的技能目录。
   */
  async downloadBlob(source, headSha, rel, blobSha) {
    const encoded = rel.split('/').map(encodeURIComponent).join('/')
    const path = '/' + source.repo + '/' + headSha + '/' + source.skillsPrefix + encoded
    const errors = []
    for (const base of this.rawBases()) {
      try {
        const body = await fetchWithRetry(base + path, 'raw')
        const actual = gitBlobSha(body)
        if (actual === blobSha) return body
        errors.push({ base, message: 'blob sha mismatch: expected ' + blobSha + ', got ' + actual })
      } catch (error) {
        errors.push({ base, message: message(error) })
      }
    }
    // 全部候选都失败：如实报出每一个的原因，用户才看得出是网络还是内容问题。
    throw new Error('all download routes failed for ' + rel + ': ' +
      errors.map((row) => row.base + ' -> ' + row.message).join('; '))
  }

  /**
   * 拉全部源：返回 { files: {`<skill>/<rel>`: sha}, heads: {sourceId: sha}, perSource: {...} }。
   *
   * 容错口径（多源与单源最重要的差别）：**一个源失败不能拖垮另一个源**。
   * 用户可能只关心 nature 全套，反防御源临时 404 不该让整个检查变成 error。
   * 所以这里并发拉取、逐个记录成功/失败：
   *   - 全部失败 → 抛错（这才是真的网络问题）；
   *   - 部分失败 → 返回成功部分 + failures 清单，由调用方决定怎么呈现。
   */
  async fetchAllSources() {
    const files = {}
    const heads = {}
    const perSource = {}
    const failures = []
    await mapPool(SOURCES, 2, async (source) => {
      try {
        const headSha = await this.fetchHeadSha(source)
        const sourceFiles = await this.fetchSkillFiles(source, headSha)
        heads[source.id] = headSha
        perSource[source.id] = { headSha, files: sourceFiles }
        // 合并进全局表：两个源的 skill 名不重叠，直接 Object.assign 即可。
        Object.assign(files, sourceFiles)
      } catch (error) {
        failures.push({ source: source.id, repo: source.repo, message: message(error) })
        this.warn('fetch.' + source.id, error)
      }
    })
    if (failures.length === SOURCES.length) {
      // 一个源都没拉到 = 网络/API 出了问题。抛出第一条真实原因（带 repo 名）。
      throw new Error('all skill sources failed: ' + failures.map((f) => f.repo + ': ' + f.message).join('; '))
    }
    return { files, heads, perSource, failures }
  }

  /**
   * raw 下载的候选前缀，按优先级排。
   *
   * 为什么要"多个"而不是一个：本机实测（2026-11-05）raw.githubusercontent.com
   * 对两个上游仓库都直接 ECONNRESET，而 ghproxy.net 镜像同样路径返回 200。
   * 单前缀意味着**网络可达性一变，整个安装就全盘失败** —— 这正是本次
   * 真实网络端到端跑出来的问题（26 个技能一个都没装上，只有 fetch failed）。
   *
   * 顺序：用户显式配置的 mirror 排最前（那是他的明确选择），然后是直连，
   * 最后是内置镜像兜底。任何一层成功就不再往下试。
   */
  rawBases() {
    const out = []
    const custom = typeof this.state.config.mirror === 'string' ? this.state.config.mirror.trim() : ''
    if (custom.length > 0) out.push(custom.replace(/\/+$/, ''))
    out.push(RAW_ORIGIN)
    for (const mirror of FALLBACK_RAW_MIRRORS) {
      if (!out.includes(mirror)) out.push(mirror)
    }
    return out
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
      { method: 'installSkills', invocation: { kind: 'direct' } },
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

  // 启动即扫一次本地安装（不联网、只 readdir）。
  //
  // 为什么必须在这里扫：status() 是纯读快照的同步方法，面板挂载首屏就调它。
  // 状态文件里的 installation 可能是上次运行留下的旧值（甚至为空），用户装了技能、
  // 或刚在别处装过，首屏就会误报「未检测到 nature 技能」并引导重装 ——
  // 实测：预置技能 + 空 state 时，首屏返回 0 个已安装（而磁盘上确实有）。
  //
  // 放在微任务里跑：不阻塞 fiber 建立（DSH 启动不该等磁盘扫描），失败只记 warn，
  // 绝不让构造/apply 抛错拖垮插件。
  void Promise.resolve()
    .then(() => service.inspect())
    .catch((error) => service.warn('boot.scan', error))
}
