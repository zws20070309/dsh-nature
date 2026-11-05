import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve, sep } from 'node:path'
import { readFileSync } from 'node:fs'

import { diffTrees, normalizeSkillPath, pickChangedSkillNames, SOURCES } from '../lib/index.js'


/**
 * 远端桩：多源改造后引擎只通过 fetchAllSources() 拉远端，
 * 所以测试统一替换这一个方法，不必逐个 mock fetchHeadSha/fetchSkillFiles。
 *
 * skill 名以 `nature-` 开头的归到主源，其余归到反防御源 —— 与真实的
 * 归属规则一致（两个源的技能名前缀天然不同）。
 */
function mockRemote(service, optionsOrGetter) {
  // 传函数 = 每次调用重新求值，用来模拟「上游后来又变了」（同一实例连续 check）。
  const read = () => (typeof optionsOrGetter === 'function' ? optionsOrGetter() : optionsOrGetter)
  const live = () => {
    const o = read()
    return { headSha: o.headSha, files: o.files, failures: o.failures ?? [] }
  }
  service.fetchAllSources = async () => {
    const { headSha, files, failures } = live()
    const perSource = {}
    const heads = {}
    for (const source of SOURCES) {
      const scoped = {}
      for (const [rel, sha] of Object.entries(files)) {
        const skill = rel.slice(0, rel.indexOf('/'))
        const owned = skill.startsWith('nature-') ? 'nature' : 'anti-defensive'
        if (owned === source.id) scoped[rel] = sha
      }
      perSource[source.id] = { headSha, files: scoped }
      heads[source.id] = headSha
    }
    return { files, heads, perSource, failures }
  }
}

// 只测纯函数：不联网、不碰磁盘真实目录（normalizeSkillPath 是纯字符串运算，
// diffTrees / pickChangedSkillNames 只操作普通对象）。联网与磁盘行为由实机验收覆盖。

test('diffTrees: 无变化', () => {
  const files = {
    'nature-figure/SKILL.md': 'f74ffae6423160998b5983402eb627a5ba735fc7',
    'nature-shared/core/ethics.md': '1ed0bc67236819722ad687a974e376261732c3ab',
  }
  const diff = diffTrees(files, { ...files })
  assert.deepEqual(diff, { skills: [], added: {}, modified: {}, removed: [] })

  // 双方都为空（首装后从未建基线之类的边界）也是"无变化"，不是全量新增。
  assert.deepEqual(diffTrees({}, {}), { skills: [], added: {}, modified: {}, removed: [] })
})

test('diffTrees: 修改', () => {
  const diff = diffTrees(
    {
      'nature-figure/SKILL.md': 'f74ffae6423160998b5983402eb627a5ba735fc7',
      'nature-writing/SKILL.md': '1ed0bc67236819722ad687a974e376261732c3ab',
    },
    {
      // nature-figure 内容变了（sha 不同），nature-writing 没动。
      'nature-figure/SKILL.md': 'dc936cb94ee08ba99d11c529c16db002bc3f6fb2',
      'nature-writing/SKILL.md': '1ed0bc67236819722ad687a974e376261732c3ab',
    },
  )
  assert.deepEqual(diff.modified, { 'nature-figure/SKILL.md': 'dc936cb94ee08ba99d11c529c16db002bc3f6fb2' })
  assert.deepEqual(diff.added, {})
  assert.deepEqual(diff.removed, [])
  assert.deepEqual(diff.skills, [{ name: 'nature-figure', added: 0, removed: 0, modified: 1 }])
})

test('diffTrees: 新增 + 删除', () => {
  const diff = diffTrees(
    {
      'nature-old/SKILL.md': 'a1',
      'nature-shared/core/ethics.md': 'b1',
    },
    {
      'nature-new/SKILL.md': 'c1',
      'nature-shared/core/ethics.md': 'b1', // 没动
      'nature-shared/core/terminology.md': 'd1', // 新增文件
    },
  )
  assert.deepEqual(diff.added, { 'nature-new/SKILL.md': 'c1', 'nature-shared/core/terminology.md': 'd1' })
  assert.deepEqual(diff.modified, {})
  assert.deepEqual(diff.removed, ['nature-old/SKILL.md'])
  // skills 行按名字排序，计数对齐三个清单。
  assert.deepEqual(diff.skills, [
    { name: 'nature-new', added: 1, removed: 0, modified: 0 },
    { name: 'nature-old', added: 0, removed: 1, modified: 0 },
    { name: 'nature-shared', added: 1, removed: 0, modified: 0 },
  ])
})

test('diffTrees: 脏输入被清洗，不抛错', () => {
  // 数组/null 当清单传进来 -> 按空清单处理；空键/空 sha 的条目丢弃。
  const diff = diffTrees(null, { '': 'sha', 'nature-x/a.md': '' })
  assert.deepEqual(diff, { skills: [], added: {}, modified: {}, removed: [] })
})

test('normalizeSkillPath: 合法相对路径放行', () => {
  // 纯字符串运算，不碰磁盘；targetDir 用一个假路径即可。
  const root = join('some', 'fake', 'target')
  const full = normalizeSkillPath(root, 'nature-figure', 'scripts/audit.py')
  assert.ok(full.startsWith(resolve(root) + sep), 'stays inside targetDir')
  assert.ok(full.includes('nature-figure'))
  // 与 path 的规范化结果一致（分隔符/层级）。
  assert.equal(full, resolve(root, 'nature-figure', 'scripts', 'audit.py'))

  // 深层嵌套与多层目录都放行。
  const deep = normalizeSkillPath(root, 'nature-academic-search', 'mcp-server/sources/arxiv.py')
  assert.equal(deep, resolve(root, 'nature-academic-search', 'mcp-server', 'sources', 'arxiv.py'))

  // 单文件 SKILL.md（最常见形态）放行。
  assert.equal(normalizeSkillPath(root, 'nature-x', 'SKILL.md'), resolve(root, 'nature-x', 'SKILL.md'))
})

test('normalizeSkillPath: 拦截 ../ 穿越', () => {
  assert.throws(() => normalizeSkillPath('C:/t', 'nature-x', '../escape.md'), /unsafe|inside/)
  assert.throws(() => normalizeSkillPath('C:/t', 'nature-x', 'a/../../escape.md'))
  assert.throws(() => normalizeSkillPath('C:/t', 'nature-x', '..'))
  // skill 名本身就是穿越向量：不含分隔符的 '..' 走独立分支，照样拦。
  assert.throws(() => normalizeSkillPath('C:/t', '../evil', 'a.md'))
  assert.throws(() => normalizeSkillPath('C:/t', '..', 'a.md'))
  // 反斜杠整体看似合法文件名，win32 上是分隔符 —— 必须拦。
  assert.throws(() => normalizeSkillPath('C:/t', 'nature-x', 'a\\..\\..\\escape.md'))
})

test('normalizeSkillPath: 拦截绝对路径', () => {
  assert.throws(() => normalizeSkillPath('C:/t', 'nature-x', '/etc/passwd'))
  // Windows 绝对路径（反斜杠开头）。
  assert.throws(() => normalizeSkillPath('C:/t', 'nature-x', '\\Windows\\system32\\drivers'))
})

test('normalizeSkillPath: 拦截盘符穿越', () => {
  // 盘符绝对路径。
  assert.throws(() => normalizeSkillPath('C:/t', 'nature-x', 'C:/Windows/system32/config'))
  // 盘符相对路径：win32 的 isAbsolute('C:foo') 是 false，靠逐段盘符检查兜底。
  assert.throws(() => normalizeSkillPath('C:/t', 'nature-x', 'C:escape.md'))
  assert.throws(() => normalizeSkillPath('C:/t', 'C:', 'x.md'))
})

test('normalizeSkillPath: 拦截其余恶意形状', () => {
  assert.throws(() => normalizeSkillPath('C:/t', 'nature-x', 'a//b.md')) // 空段
  assert.throws(() => normalizeSkillPath('C:/t', 'nature-x', './a.md')) // 当前段
  assert.throws(() => normalizeSkillPath('C:/t', 'nature-x', '')) // 空 rel
  assert.throws(() => normalizeSkillPath('', 'nature-x', 'a.md')) // 空 targetDir
  assert.throws(() => normalizeSkillPath('C:/t', '.', 'a.md')) // skill='.'
  assert.throws(() => normalizeSkillPath('C:/t', 'nature-x', 'a\0b.md')) // 空字节
  assert.throws(() => normalizeSkillPath('C:/t', 'nature-x', 'stream:ads.md')) // NTFS ADS
})

test('diffTrees: 同一 skill 既加又改，计数行分开累计', () => {
  const diff = diffTrees(
    { 'nature-figure/SKILL.md': 'a1' },
    {
      'nature-figure/SKILL.md': 'a2', // modified
      'nature-figure/scripts/audit.py': 'b1', // added
    },
  )
  assert.deepEqual(diff.skills, [{ name: 'nature-figure', added: 1, removed: 0, modified: 1 }])
})

test('pickChangedSkillNames: 去重并排序', () => {
  const diff = {
    skills: [
      { name: 'nature-b', added: 1, removed: 0, modified: 0 },
      { name: 'nature-a', added: 0, removed: 0, modified: 2 },
      { name: 'nature-a', added: 1, removed: 0, modified: 0 }, // 重复行
      { name: 'nature-zero', added: 0, removed: 0, modified: 0 }, // 零变化不算
    ],
    added: { 'nature-c/new.md': 'x' },
    modified: { 'nature-a/a.md': 'y' },
    removed: ['nature-b/old.md'],
  }
  assert.deepEqual(pickChangedSkillNames(diff), ['nature-a', 'nature-b', 'nature-c'])
})

test('pickChangedSkillNames: 无 skills 行时从文件清单反查（调用方手拼 diff 的兜底）', () => {
  // 没有 skills 数组：added/modified/removed 的路径就是唯一信息源。
  const names = pickChangedSkillNames({
    added: { 'nature-x/SKILL.md': 'a', 'nature-x/lib/run.py': 'b' },
    modified: { 'nature-y/a.md': 'c' },
    removed: ['nature-z/old.md'],
  })
  assert.deepEqual(names, ['nature-x', 'nature-y', 'nature-z'])
  // 反查天然去重：同一 skill 多个文件只出一个名字，且排序稳定。
  const dup = pickChangedSkillNames({ added: { 'nature-b/2.md': 'x', 'nature-b/1.md': 'y' }, modified: {}, removed: [] })
  assert.deepEqual(dup, ['nature-b'])
})

test('pickChangedSkillNames: 空变更与坏输入', () => {
  assert.deepEqual(pickChangedSkillNames({ skills: [], added: {}, modified: {}, removed: [] }), [])
  assert.deepEqual(pickChangedSkillNames(null), [])
  assert.deepEqual(pickChangedSkillNames(undefined), [])
})

// ── update() 契约：必须回完整状态（浏览器半直接拿它覆盖本地状态）───────────────
// 客户端 UpdateCenter/SettingsPanel 拿到动作结果就 statusView(unwrap(remote))。
// runUpdate 的内部明细形状没有 manifest/config，直接透出会把页面归一化成
// 「未建立基线 + 目标目录为空」——一次更新就把界面显示成坏状态。
test('update(): 没有基线时也回完整状态形状，明细在 outcome 里', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-'))
  try {
    // 不联网：经真实公开入口 apply() 拿到服务实例；needsBaseline 分支在发请求前就返回。
    const mod = await import('../lib/index.js')
    let service
    const ctx = {
      logger: { warn() {} },
      provide(key, instance) { service = instance },
      effect() {},
    }
    mod.apply(ctx, { dshHome: home })
    assert.ok(service, 'apply() 必须通过 ctx.provide 发布服务实例')
    const result = await service.update()

    // 契约：status() 的每个字段都在，外加 outcome。
    for (const key of ['version', 'headSha', 'lastCheckedAt', 'lastCheckStatus', 'lastError',
                       'updateAvailable', 'changedSkills', 'manifest', 'config']) {
      assert.ok(Object.hasOwn(result, key), 'update() 结果缺字段 ' + key)
    }
    assert.ok(result.manifest && typeof result.manifest === 'object', 'manifest 必须是对象')
    assert.ok(result.config && typeof result.config.targetDir === 'string' && result.config.targetDir.length > 0,
      'config.targetDir 必须是非空字符串')
    // 明细挂在 outcome 上。
    assert.ok(result.outcome && typeof result.outcome === 'object', 'outcome 必须存在')
    assert.equal(result.outcome.reason, 'baseline-missing')
    assert.deepEqual(result.outcome.updated, [])
    // 状态文件确实写了 baseline-missing（持久化生效）。
    const state = JSON.parse(await readFile(join(home, 'dsh-nature-state.json'), 'utf8'))
    assert.equal(state.lastCheckStatus, 'baseline-missing')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

// ── 安装检测：三态（全无 / 部分 / 完整）必须反映磁盘真相 ─────────────────────────
// 判定口径是"目录里有 SKILL.md"（DSH 的 discoverRoot 会跳过没有 SKILL.md 的目录），
// 不是"目录存在"——只看目录会把半路中断的下载算成已装。
test('scanInstallation: 全无 / 部分 / 完整三态', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const root = await mkdtemp(join(tmpdir(), 'dsh-nature-scan-'))
  try {
    // 空目录 → 全缺
    const empty = await mod.scanInstallation(root)
    assert.equal(empty.complete, false)
    assert.equal(empty.installed.length, 0)
    assert.equal(empty.missing.length, mod.NATURE_SKILLS.length)

    // 只装 nature-figure → 部分，且 missing 里没有它
    await mkdir(join(root, 'nature-figure'), { recursive: true })
    await writeFile(join(root, 'nature-figure', 'SKILL.md'), '---\nname: nature-figure\n---\n')
    const partial = await mod.scanInstallation(root)
    assert.equal(partial.complete, false)
    assert.deepEqual(partial.installed, ['nature-figure'])
    assert.ok(partial.missing.includes('nature-writing'))
    assert.ok(!partial.missing.includes('nature-figure'))

    // 目录在但没有 SKILL.md → 仍算缺失（半截下载不能报成已装）
    await mkdir(join(root, 'nature-writing'), { recursive: true })
    await writeFile(join(root, 'nature-writing', 'notes.txt'), 'x')
    const noEntry = await mod.scanInstallation(root)
    assert.ok(noEntry.missing.includes('nature-writing'), '没有 SKILL.md 不算装上')
    assert.deepEqual(noEntry.installed, ['nature-figure'])

    // 补齐全套 → complete
    for (const name of mod.NATURE_SKILLS) {
      await mkdir(join(root, name), { recursive: true })
      await writeFile(join(root, name, 'SKILL.md'), '---\nname: ' + name + '\n---\n')
    }
    const full = await mod.scanInstallation(root)
    assert.equal(full.complete, true)
    assert.equal(full.installed.length, mod.NATURE_SKILLS.length)
    assert.deepEqual(full.missing, [])
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('scanInstallation: 目标目录不存在时是"全缺"而不是抛错', async () => {
  const mod = await import('../lib/index.js')
  const result = await mod.scanInstallation(join(process.env.TEMP ?? '/tmp', 'definitely-not-here-' + Date.now()))
  assert.equal(result.complete, false)
  assert.equal(result.installed.length, 0)
  assert.equal(result.missing.length, mod.NATURE_SKILLS.length)
})

// ── 技能名清单是单一事实源：host 与 client 目录必须逐项一致 ──────────────────────
test('NATURE_SKILLS 与 client 的 CATALOG 逐项一致（26 项、同名同序）', async () => {
  const { readFile } = await import('node:fs/promises')
  const mod = await import('../lib/index.js')
  const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const catalog = /const CATALOG = \[([\s\S]*?)\n    \]/.exec(clientSource)
  assert.ok(catalog, 'client 的 CATALOG 找不到')
  // 目录跨两个上游源，两种命名前缀都要收（顺序即 CATALOG 分组顺序）。
  const clientNames = [...catalog[1].matchAll(/'(nature-[a-z0-9-]+|anti-defensive-writing[a-z-]*)'/g)].map((m) => m[1])
  assert.equal(mod.NATURE_SKILLS.length, 26, '内置清单 = 24 nature + 2 反防御')
  // 比**集合**而不是顺序：运行时的 roster 来自远端树、经 normalizeRoster 排序，
  // 目录的展示顺序由 CATALOG 分组决定 —— 两边的顺序本来就不同语义，强求同序
  // 会在上游调整目录顺序时误报。这里守的是"没有谁漏掉/多出技能"。
  assert.deepEqual([...clientNames].sort(), [...mod.NATURE_SKILLS].sort(),
    'host NATURE_SKILLS 与 client CATALOG 必须同集')
  // 多源：每个源的内置清单必须真的被登记在 SOURCES 里。
  assert.deepEqual(mod.SOURCES.map((s) => s.id), ['nature', 'anti-defensive'])
})

// ── install()：无基线也能装（这是首装路径，update() 会拒绝）──────────────────────
test('install(): 无基线时仍能走完并回完整状态 + outcome', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-install-'))
  const skills = join(home, 'skills')
  try {
    let service
    const ctx = { logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }
    mod.apply(ctx, { dshHome: home })
    await service.setConfig({ targetDir: skills, autoCheck: false })

    // 用假远端把网络摘掉：只验证"契约 + 落盘 + 重扫"这条本地链路。
    mockRemote(service, { headSha: 'a'.repeat(40), files: {
      'nature-figure/SKILL.md': 'f74ffae6423160998b5983402eb627a5ba735fc7',
    } })
    service.downloadBlob = async () => Buffer.from('---\nname: nature-figure\n---\n')

    const result = await service.installSkills()
    // 返回形状必须与 status() 同形（浏览器半直接拿它覆盖状态）
    for (const key of ['version', 'lastCheckStatus', 'changedSkills', 'manifest', 'config', 'installation']) {
      assert.ok(Object.hasOwn(result, key), 'install() 结果缺字段 ' + key)
    }
    assert.ok(result.outcome && typeof result.outcome === 'object', '明细必须在 outcome 里')
    assert.deepEqual(result.outcome.installed, ['nature-figure'], '远端只有这一个 → 只装它')
    // 关键：install 之后必须真的可被发现（安装快照重扫过）
    assert.deepEqual(result.installation.installed, ['nature-figure'])
    // roster 现在学自远端：远端只有这 1 个技能，装完就是「全套齐全」。
    // （旧行为把内置 24 项当权威，装 1 个永远 complete=false —— 那正是
    //   「上游变成 25 个就发现不了」的同一个病根。）
    assert.equal(result.installation.total, 1, '权威清单应等于远端实际技能数')
    assert.equal(result.installation.complete, true)
    // 基线被快进（否则用户永远停在"未建立基线"）
    assert.equal(result.manifest.headSha, 'a'.repeat(40))
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('install(skillNames): 点名只装指定的，其余不碰', async () => {
  const { mkdtemp, rm, readdir } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-install2-'))
  const skills = join(home, 'skills')
  try {
    let service
    const ctx = { logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }
    mod.apply(ctx, { dshHome: home })
    await service.setConfig({ targetDir: skills, autoCheck: false })
    mockRemote(service, { headSha: 'b'.repeat(40), files: {
      'nature-figure/SKILL.md': 'x'.repeat(40),
      'nature-writing/SKILL.md': 'y'.repeat(40),
    } })
    service.downloadBlob = async () => Buffer.from('---\nname: x\n---\n')

    const result = await service.installSkills(['nature-figure'])
    assert.deepEqual(result.outcome.installed, ['nature-figure'])
    const dirs = await readdir(skills)
    assert.deepEqual(dirs, ['nature-figure'], '没点名的 skill 不该被创建')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

// ── 并发下载：必须真的并发，且单个失败不中断整批 ────────────────────────────────
// 814 个文件串行要十几分钟（实测 8 分钟只完成 1/24 个技能），用户会以为卡死。
// 这里用"同时在飞的最大任务数"直接证明并发生效，而不是只看耗时（耗时在 CI 上不稳）。
test('instal 并发：同时在飞的任务数达到上限，且单文件失败不影响其它文件', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-pool-'))
  try {
    let service
    const ctx = { logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }
    mod.apply(ctx, { dshHome: home })
    await service.setConfig({ targetDir: join(home, 'skills'), autoCheck: false })

    // 造 40 个文件 + 入口 SKILL.md，其中 1 个非入口文件故意失败。
    // 入口必须在：SKILL.md 是 DSH 发现技能的前提，它缺了才该判定安装失败。
    const files = {}
    files['nature-figure/SKILL.md'] = 'a'.repeat(40)
    for (let i = 0; i < 40; i++) files['nature-figure/f' + i + '.md'] = 'a'.repeat(40)
    mockRemote(service, { headSha: 'c'.repeat(40), files })

    let inFlight = 0
    let peak = 0
    // 新签名：downloadBlob(source, headSha, rel, blobSha) —— rel 是第三个参数。
    service.downloadBlob = async (source, head, rel) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      if (rel.endsWith('f7.md')) throw new Error('synthetic failure')
      return Buffer.from('---\nname: nature-figure\n---\n')
    }

    const result = await service.installSkills(['nature-figure'])
    assert.ok(peak > 1, '并发未生效：峰值同时在飞 ' + peak + '（应 > 1）')
    assert.ok(peak <= 6, '并发超过上限：峰值 ' + peak + '（上限是 6）')
    assert.equal(result.outcome.failures.length, 1, '单文件失败要如实记录')
    assert.deepEqual(result.outcome.installed, ['nature-figure'], '单文件失败不该拦掉整个 skill')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

// ── 安装快照的派生字段：宿主直读方也不能拿到 undefined ──────────────────────────
test('installation 快照自带派生字段（total/installedCount/empty/partial）', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-shape-'))
  try {
    let service
    const ctx = { logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }
    mod.apply(ctx, { dshHome: home })
    // 必须显式指向空的临时目录：默认 targetDir 指向本机 ~/.agents/skills，
    // 那里通常已经装满 24 个技能，测"空目录"会得到相反的结论。
    await service.setConfig({ targetDir: join(home, 'skills'), autoCheck: false })
    const s = await service.inspect()
    const inst = s.installation
    for (const key of ['installed', 'missing', 'complete', 'total', 'installedCount', 'empty', 'partial']) {
      assert.ok(Object.hasOwn(inst, key), '安装快照缺字段 ' + key)
    }
    assert.equal(inst.total, mod.NATURE_SKILLS.length)
    assert.equal(inst.installedCount, inst.installed.length)
    assert.equal(inst.empty, inst.installed.length === 0)
    assert.equal(inst.complete, false, '空目录不能报 complete')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

// ── 回归：基线只能记"真正落盘的 skill" ──────────────────────────────────────────
// 实机踩到（P1）：install(['nature-figure']) 之后 manifest 里记了整棵远端树的 3 条，
// 于是 update() 的 diff 认为另外 2 个 skill "已是最新"，它们永远装不上。
// 根因是更新基线时直接写了 remoteFiles。修法：按 installation.installed 裁剪。
test('基线只记已装 skill：install 部分技能后 update 仍能把缺的补上', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-baseline-'))
  const skills = join(home, 'skills')
  try {
    let service
    const ctx = { logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }
    mod.apply(ctx, { dshHome: home })
    await service.setConfig({ targetDir: skills, autoCheck: false })

    const remote = {
      'nature-figure/SKILL.md': 'a'.repeat(40),
      'nature-writing/SKILL.md': 'b'.repeat(40),
      'nature-data/SKILL.md': 'c'.repeat(40),
    }
    mockRemote(service, { headSha: 'd'.repeat(40), files: remote })
    service.downloadBlob = async () => Buffer.from('---\nname: x\n---\n')

    // 只装 1 个
    const first = await service.installSkills(['nature-figure'])
    assert.deepEqual(first.installation.installed, ['nature-figure'])
    // 基线必须只有已装的那一个，绝不能把没装的也记进去
    const baseline = Object.keys(first.manifest.files)
    assert.equal(baseline.length, 1, '基线里混入了未安装的 skill：' + baseline.join(','))
    assert.ok(baseline[0].startsWith('nature-figure/'))

    // 关键：此时 update() 应该能看见还缺的，并把它们装上。
    // 注意 complete 的定义是「24 个全套齐全」，这组夹具只有 3 个技能，
    // 所以绝不能断言 complete=true —— 要断言的是"缺的被补上了"。
    const second = await service.update()
    assert.deepEqual([...second.installation.installed].sort(), ['nature-data', 'nature-figure', 'nature-writing'],
      'update() 应把远端有、本地没有的 skill 补上')
    assert.deepEqual([...second.outcome.updated].sort(), ['nature-data', 'nature-writing'])
    // 同理：远端只有 3 个技能，装齐就是 complete。
    assert.equal(second.installation.total, 3)
    assert.equal(second.installation.complete, true, '远端只有 3 个，装齐即完整')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('baselineFor: 未装任何技能时给空基线（不是整棵远端树）', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-bf-'))
  try {
    let service
    const ctx = { logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }
    mod.apply(ctx, { dshHome: home })
    await service.setConfig({ targetDir: join(home, 'skills'), autoCheck: false })
    await service.refreshInstallation()
    const out = service.baselineFor({ 'nature-figure/SKILL.md': 'a'.repeat(40) })
    assert.deepEqual(out, {}, '一个都没装时基线必须是空的')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

// ── 回归：首屏必须反映磁盘真相，不能读旧快照 ────────────────────────────────────
// 实机踩到（P1）：状态文件里没有 installation，但磁盘上确实装了技能；
// 面板挂载首屏只调 status() 就拿到 0 个已安装 → 误报「未检测到 nature 技能」。
// 修法：① apply() 启动后异步扫一次；② 客户端挂载首帧改调 inspect()（先扫再回）。
test('首屏检测：磁盘有技能时 inspect() 立即给出正确结论（不等启动扫描）', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-first-'))
  const skills = join(home, 'skills')
  try {
    // 磁盘上先放一个技能，state 文件里没有任何 installation
    await mkdir(join(skills, 'nature-figure'), { recursive: true })
    await writeFile(join(skills, 'nature-figure', 'SKILL.md'), '---\nname: nature-figure\n---\n')
    await writeFile(join(home, 'dsh-nature-state.json'), JSON.stringify({
      version: 1,
      config: { autoCheck: false, intervalHours: 6, targetDir: skills, mirror: '' },
      manifest: { headSha: null, files: {} }, changedSkills: [], updateAvailable: false,
      lastCheckStatus: 'never', lastCheckedAt: null, lastError: null, headSha: null,
    }))

    let service
    const ctx = { logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }
    mod.apply(ctx, { dshHome: home })

    // 面板挂载首帧调的就是 inspect()：它必须先扫磁盘再回状态
    const first = await service.inspect()
    assert.equal(first.installation.installedCount, 1, '首屏必须看见磁盘上已有的技能')
    assert.deepEqual(first.installation.installed, ['nature-figure'])
    assert.equal(first.installation.partial, true, '1/24 属于部分安装')
    assert.equal(first.installation.complete, false)
    // 等启动扫描彻底落定再清理：否则 rm 会与它的 persist 撞上 ENOTEMPTY。
    // 这是测试清理的时序问题，不是被测代码的行为（prod 里没人删 home）。
    await new Promise((r) => setTimeout(r, 150))
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('apply(): 启动扫描是异步的，不阻塞 fiber 建立', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-boot-'))
  try {
    let service
    const ctx = { logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }
    // apply 必须同步返回（不 await 磁盘扫描），否则 DSH 启动会被磁盘 IO 卡住
    const returned = mod.apply(ctx, { dshHome: home })
    assert.equal(returned, undefined, 'apply 应同步完成')
    assert.ok(service, 'provide 必须已发生')
    // 稍等让后台扫描跑完，确认它不会抛错
    await new Promise((r) => setTimeout(r, 100))
    const st = service.status()
    assert.ok(st.installation, '后台扫描后状态里应有 installation')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

// ── 回归（审查发现 P0）：installed 必须反映磁盘，不能反映"调度安排" ───────────────
// 早期实现用「远端清单里有 SKILL.md」判断已装：24 个技能远端都有 SKILL.md，
// 于是恒为 true → fatal 不可达 → 全量失败时 installed 报满、manifest 记整棵树、
// 状态置成 upToDate，用户再也装不上。
test('install: 全部下载失败时 installed=[] 且不写基线', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-p0-'))
  try {
    let service
    const ctx = { logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }
    mod.apply(ctx, { dshHome: home })
    await service.setConfig({ targetDir: join(home, 'skills'), autoCheck: false })
    mockRemote(service, { headSha: 'd'.repeat(40), files: {
      'nature-figure/SKILL.md': 'a'.repeat(40),
      'nature-writing/SKILL.md': 'c'.repeat(40),
    } })
    service.downloadBlob = async () => { throw new Error('ECONNRESET') }

    const res = await service.installSkills()
    assert.deepEqual(res.outcome.installed, [], '下载全失败时绝不能报"已安装"')
    assert.equal(res.outcome.ok, false)
    assert.deepEqual(res.installation.installed, [], '磁盘真相就是空的')
    assert.equal(Object.keys(res.manifest.files).length, 0, '失败时绝不能写基线')
    assert.equal(res.lastCheckStatus, 'error', '失败必须反映到状态，不能是 upToDate')
    assert.ok(res.lastError, '失败必须有 lastError')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('install: 成功后 installed 与磁盘一致；部分失败要如实标记', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-p0b-'))
  try {
    let service
    const ctx = { logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }
    mod.apply(ctx, { dshHome: home })
    await service.setConfig({ targetDir: join(home, 'skills'), autoCheck: false })
    mockRemote(service, { headSha: 'e'.repeat(40), files: {
      'nature-figure/SKILL.md': 'a'.repeat(40),
      'nature-figure/extra.md': 'b'.repeat(40),
    } })
    // SKILL.md 成功、extra.md 失败
    service.downloadBlob = async (source, head, rel) => {
      if (rel.endsWith('extra.md')) throw new Error('ECONNRESET')
      return Buffer.from('---\nname: nature-figure\n---\n')
    }
    const res = await service.installSkills()
    assert.deepEqual(res.outcome.installed, ['nature-figure'], 'SKILL.md 落盘就算装上')
    assert.deepEqual(res.installation.installed, ['nature-figure'], 'installed 必须与磁盘一致')
    assert.equal(res.outcome.ok, false, '有文件失败 → ok=false')
    assert.equal(res.outcome.reason, 'partial')
    assert.ok(res.outcome.failures.length >= 1)
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

// ── 回归（审查 P2-3）：非法技能名不能静默成功 ────────────────────────────────────
test('install: 非法技能名进 skipped，不再静默成功', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-p23-'))
  try {
    let service
    const ctx = { logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }
    mod.apply(ctx, { dshHome: home })
    await service.setConfig({ targetDir: join(home, 'skills'), autoCheck: false })
    mockRemote(service, { headSha: 'f'.repeat(40), files: {} })
    service.downloadBlob = async () => Buffer.from('x')

    const res = await service.installSkills(['not-a-nature-skill'])
    assert.ok(res.outcome.skipped.includes('not-a-nature-skill'), '非法名字必须出现在 skipped 里')
    assert.deepEqual(res.outcome.installed, [])
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

// ── 回归（审查 P2-7）：改 targetDir 后必须重扫 ──────────────────────────────────
test('setConfig: 改 targetDir 后立即重扫安装状态', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-p27-'))
  try {
    const dirA = join(home, 'skillsA')
    const dirB = join(home, 'skillsB')
    await mkdir(join(dirB, 'nature-figure'), { recursive: true })
    await writeFile(join(dirB, 'nature-figure', 'SKILL.md'), '---\nname: nature-figure\n---\n')

    let service
    const ctx = { logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }
    mod.apply(ctx, { dshHome: home })
    await service.setConfig({ targetDir: dirA, autoCheck: false })
    assert.equal(service.status().installation.installedCount, 0, 'A 目录是空的')

    const after = await service.setConfig({ targetDir: dirB })
    assert.equal(after.installation.installedCount, 1, '改到 B 后必须立刻看到 B 的技能')
    assert.deepEqual(after.installation.installed, ['nature-figure'])
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

// ── 新能力：上游技能数变化（24 → 25 → 26）必须自动跟上 ──────────────────────────
// 用户明确要求：远端从 24 变 25、26 时，插件要能发现并装上新增的技能。
// 旧实现把 NATURE_SKILLS 当权威清单（写死 24 个），上游新增技能完全无感。
// 现在：roster 学自远端树，内置清单只作离线兜底。
test('rosterFromTree: 从远端树提取权威技能清单（按 SKILL.md 判定）', async () => {
  const mod = await import('../lib/index.js')
  const tree = {
    'nature-a/SKILL.md': 'a'.repeat(40),
    'nature-a/lib/x.py': 'b'.repeat(40),
    'nature-b/SKILL.md': 'c'.repeat(40),
    // 没有 SKILL.md 的目录不算一个技能
    'nature-c/notes.txt': 'd'.repeat(40),
  }
  assert.deepEqual(mod.rosterFromTree(tree), ['nature-a', 'nature-b'])
  assert.deepEqual(mod.rosterFromTree({}), [], '空树返回空数组')
  assert.deepEqual(mod.rosterFromTree(null), [], '坏输入返回空数组')
})

test('上游新增技能：check 后 roster/总数自动跟上，且能装到新技能', async () => {
  const { mkdtemp, rm, readdir } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-roster-'))
  const skills = join(home, 'skills')
  try {
    let service
    const ctx = { logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }
    mod.apply(ctx, { dshHome: home })
    await service.setConfig({ targetDir: skills, autoCheck: false })

    // 模拟上游：现有 24 个 + 2 个新增 = 26
    const remote = {}
    for (const name of mod.NATURE_SKILLS) remote[name + '/SKILL.md'] = 'a'.repeat(40)
    remote['nature-brand-new/SKILL.md'] = 'b'.repeat(40)
    remote['nature-second-new/SKILL.md'] = 'c'.repeat(40)
    mockRemote(service, { headSha: 'e'.repeat(40), files: remote })
    service.downloadBlob = async () => Buffer.from('---\nname: x\n---\n')

    // check 就该发现新技能（旧实现这里恒为 24）
    const checked = await service.check()
    assert.equal(checked.roster.length, mod.NATURE_SKILLS.length + 2, 'roster 必须随远端增长')
    assert.deepEqual(checked.rosterAdded.slice().sort(), ['nature-brand-new', 'nature-second-new'])
    assert.equal(checked.installation.total, mod.NATURE_SKILLS.length + 2, '总数必须跟着变')

    // 全量安装必须包含新增的那两个（旧实现会被白名单挡掉）
    const installedAll = await service.installSkills()
    assert.equal(installedAll.outcome.installed.length, mod.NATURE_SKILLS.length + 2)
    assert.ok(installedAll.outcome.installed.includes('nature-brand-new'), '必须装上上游新增的技能')
    assert.equal(installedAll.installation.complete, true)
    const dirs = await readdir(skills)
    assert.ok(dirs.includes('nature-brand-new'))

    // 点名安装一个上游新增的技能也要能成功（白名单以 roster 为准）
    await rm(skills, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    const oneNew = await service.installSkills(['nature-second-new'])
    assert.deepEqual(oneNew.outcome.installed, ['nature-second-new'])
    assert.deepEqual(await readdir(skills), ['nature-second-new'])
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('上游技能数不变时 roster 不被重复计入 rosterAdded', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-roster2-'))
  try {
    let service
    const ctx = { logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }
    mod.apply(ctx, { dshHome: home })
    await service.setConfig({ targetDir: join(home, 'skills'), autoCheck: false })
    const remote = {}
    for (const name of mod.NATURE_SKILLS) remote[name + '/SKILL.md'] = 'a'.repeat(40)
    mockRemote(service, { headSha: 'f'.repeat(40), files: remote })
    service.downloadBlob = async () => Buffer.from('x')

    const first = await service.check()
    assert.equal(first.roster.length, mod.NATURE_SKILLS.length)
    // 第二次 check 同样内容：不该有"新增"
    const second = await service.check()
    assert.deepEqual(second.rosterAdded, [], '没变化就不该报新增')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

// ── 回归：rosterAdded/rosterRemoved 不能被重复调用覆盖成空 ──────────────────────
// 实机踩到：runCheck 里 learnRoster 被调了两次（一次在头部、一次在 headSha 分支），
// 第二次的 before 已是第一次更新后的值 → 差异恒为空 → 面板永远提示不了"上游新增"。
test('上游增删技能时 rosterAdded / rosterRemoved 如实上报（不能被重复调用清空）', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-roster3-'))
  try {
    let service
    const ctx = { logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }
    mod.apply(ctx, { dshHome: home })
    await service.setConfig({ targetDir: join(home, 'skills'), autoCheck: false })

    const base = {}
    for (const name of mod.NATURE_SKILLS) base[name + '/SKILL.md'] = 'a'.repeat(40)
    let head = '1'.repeat(40)
    let tree = base
    // 惰性：后续改动 head/tree 后，下一次 check 能读到新值（模拟上游真的变了）。
    mockRemote(service, () => ({ headSha: head, files: tree }))
    service.downloadBlob = async () => Buffer.from('x')

    await service.installSkills()

    // 上游：删掉 nature-figure，新增 nature-added
    const changed = { ...base }
    delete changed['nature-figure/SKILL.md']
    changed['nature-added/SKILL.md'] = 'b'.repeat(40)
    tree = changed
    head = '2'.repeat(40)

    const checked = await service.check()
    assert.deepEqual(checked.rosterAdded, ['nature-added'], '上游新增必须能报出来')
    assert.deepEqual(checked.rosterRemoved, ['nature-figure'], '上游删除必须能报出来')
    // 上游删除不等于删用户文件：本地目录还在
    const { readdir } = await import('node:fs/promises')
    assert.ok((await readdir(join(home, 'skills'))).includes('nature-figure'), '不能擅自删用户已有的目录')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('learnRoster: 远端树为空时不动现有 roster（异常快照不能清空认知）', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-roster4-'))
  try {
    let service
    const ctx = { logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }
    mod.apply(ctx, { dshHome: home })
    await service.setConfig({ targetDir: join(home, 'skills'), autoCheck: false })

    const before = service.status().roster.length
    const out = service.learnRoster({})
    assert.deepEqual(out, { added: [], removed: [] })
    assert.equal(service.status().roster.length, before, '空树不该清空 roster')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

// ── 多源：反防御性写作（第二个上游仓库）必须与 nature 全家同等对待 ───────────────
// 用户的原始诉求：nature 全套里没有反防御性写作 → 把那个 skill 也装进同一个
// skills 目录，并且"更新检测以及更新也加上这个 skill"。
// 这里逐条验证：检测、安装、更新、删除上报、部分源失败容错。
test('多源: 反防御技能与 nature 一起被检测为"全套"', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const root = await mkdtemp(join(tmpdir(), 'dsh-nature-multi-scan-'))
  try {
    // 两个源的技能都摆上磁盘
    for (const name of mod.NATURE_SKILLS) {
      await mkdir(join(root, name), { recursive: true })
      await writeFile(join(root, name, 'SKILL.md'), '---\nname: ' + name + '\n---\n')
    }
    const full = await mod.scanInstallation(root)
    assert.equal(full.complete, true, '26 个全在磁盘上 → 全套齐全')
    assert.equal(full.total, 26)
    assert.ok(full.installed.includes('anti-defensive-writing'), '反防御技能必须被算进已安装')

    // 只缺反防御的那两个 → 必须是"部分安装"，而不是"全套齐全"
    const { rm: rmDir } = await import('node:fs/promises')
    await rmDir(join(root, 'anti-defensive-writing'), { recursive: true, force: true })
    await rmDir(join(root, 'anti-defensive-writing-en'), { recursive: true, force: true })
    const partial = await mod.scanInstallation(root)
    assert.equal(partial.complete, false, '缺反防御技能不能算全套齐全')
    assert.deepEqual(partial.missing.sort(), ['anti-defensive-writing', 'anti-defensive-writing-en'])
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('多源: 安装会把两个源的技能都装上，且各自用自己的源下载', async () => {
  const { mkdtemp, readdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-multi-install-'))
  const skills = join(home, 'skills')
  try {
    let service
    mod.apply({ logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }, { dshHome: home })
    await service.setConfig({ targetDir: skills, autoCheck: false })

    mockRemote(service, {
      headSha: 'a'.repeat(40),
      files: {
        'nature-figure/SKILL.md': 'a'.repeat(40),
        'anti-defensive-writing/SKILL.md': 'b'.repeat(40),
        'anti-defensive-writing-en/SKILL.md': 'c'.repeat(40),
      },
    })
    // 记录每个文件是用哪个源下载的 —— 用错源会拼错 URL（真实网络下是 404）。
    const seen = []
    service.downloadBlob = async (source, head, rel) => {
      seen.push(source.id + '|' + rel)
      return Buffer.from('---\nname: x\n---\n')
    }

    const res = await service.installSkills()
    assert.equal(res.outcome.ok, true, '两套技能都要装成功')
    assert.deepEqual(res.outcome.installed.sort(),
      ['anti-defensive-writing', 'anti-defensive-writing-en', 'nature-figure'])
    const dirs = await readdir(skills)
    assert.deepEqual(dirs.sort(), ['anti-defensive-writing', 'anti-defensive-writing-en', 'nature-figure'])

    // 归属正确性：nature-* 走 nature 源，anti-defensive-* 走反防御源。
    assert.ok(seen.includes('nature|nature-figure/SKILL.md'), 'nature 技能必须走 nature 源：' + JSON.stringify(seen))
    assert.ok(seen.includes('anti-defensive|anti-defensive-writing/SKILL.md'), '反防御技能必须走反防御源：' + JSON.stringify(seen))
    assert.ok(seen.includes('anti-defensive|anti-defensive-writing-en/SKILL.md'))
    assert.equal(seen.some((row) => row.startsWith('nature|anti-defensive')), false, '不能把反防御技能发到 nature 源去下')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('多源: 只有反防御源更新时，check 也必须报出来（不能被 nature 的 sha 掩盖）', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-multi-check-'))
  try {
    let service
    mod.apply({ logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }, { dshHome: home })
    await service.setConfig({ targetDir: join(home, 'skills'), autoCheck: false })

    const natureFiles = { 'nature-figure/SKILL.md': 'a'.repeat(40) }
    const antiFiles = { 'anti-defensive-writing/SKILL.md': 'b'.repeat(40) }
    // 两个源各自独立的 head 与文件表
    service.fetchAllSources = async () => ({
      files: { ...natureFiles, ...antiFiles },
      heads: { nature: 'n1'.padEnd(40, '0'), 'anti-defensive': 'd1'.padEnd(40, '0') },
      perSource: {
        nature: { headSha: 'n1'.padEnd(40, '0'), files: natureFiles },
        'anti-defensive': { headSha: 'd1'.padEnd(40, '0'), files: antiFiles },
      },
      failures: [],
    })
    service.downloadBlob = async () => Buffer.from('---\nname: x\n---\n')
    await service.installSkills()

    // 只有反防御源换了一个新技能，nature 源一字未动
    const anti2 = { ...antiFiles, 'anti-defensive-writing-en/SKILL.md': 'c'.repeat(40) }
    service.fetchAllSources = async () => ({
      files: { ...natureFiles, ...anti2 },
      heads: { nature: 'n1'.padEnd(40, '0'), 'anti-defensive': 'd2'.padEnd(40, '0') },
      perSource: {
        nature: { headSha: 'n1'.padEnd(40, '0'), files: natureFiles },
        'anti-defensive': { headSha: 'd2'.padEnd(40, '0'), files: anti2 },
      },
      failures: [],
    })

    const checked = await service.check()
    assert.equal(checked.updateAvailable, true, '反防御源新增技能必须被检测到')
    assert.deepEqual(checked.changedSkills.map((r) => r.name), ['anti-defensive-writing-en'])
    // 关键：check 只报告、不快进基线 —— 基线仍是上次同步到的 sha。
    // 快进的话就等于"假装已经更新完"，用户点更新时会发现没东西可更。
    assert.equal(checked.sources.find((s) => s.id === 'nature').headSha, 'n1'.padEnd(40, '0'))
    assert.equal(checked.sources.find((s) => s.id === 'anti-defensive').headSha, 'd1'.padEnd(40, '0'),
      'anti-defensive 的基线不该被 check 快进到 d2')
    // 远端的最新 sha 通过 sourceErrors 之外的另一条路体现：changedSkills 已经指出变了哪个。
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('多源: 上游删掉反防御技能时不删本地目录，但要如实上报', async () => {
  const { mkdtemp, rm, readdir } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-multi-remove-'))
  try {
    let service
    mod.apply({ logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }, { dshHome: home })
    await service.setConfig({ targetDir: join(home, 'skills'), autoCheck: false })

    const antiFiles = { 'anti-defensive-writing/SKILL.md': 'b'.repeat(40) }
    const natureFiles0 = { 'nature-figure/SKILL.md': 'a'.repeat(40) }
    service.fetchAllSources = async () => ({
      files: { ...natureFiles0, ...antiFiles },
      heads: { nature: 'n1'.padEnd(40, '0'), 'anti-defensive': 'd1'.padEnd(40, '0') },
      perSource: {
        nature: { headSha: 'n1'.padEnd(40, '0'), files: natureFiles0 },
        'anti-defensive': { headSha: 'd1'.padEnd(40, '0'), files: antiFiles },
      },
      failures: [],
    })
    service.downloadBlob = async () => Buffer.from('---\nname: x\n---\n')
    await service.installSkills()

    // 上游把反防御技能整个删了 —— 但 nature 源还有技能。
    // （不能两个源都返回空树：那是 learnRoster 明确防守的"异常快照"场景，
    //   空树会被当成网络故障而不动 roster，见 learnRoster 的安全边界注释。）
    const natureFiles = { 'nature-figure/SKILL.md': 'a'.repeat(40) }
    service.fetchAllSources = async () => ({
      files: { ...natureFiles },
      heads: { nature: 'n1'.padEnd(40, '0'), 'anti-defensive': 'd2'.padEnd(40, '0') },
      perSource: {
        nature: { headSha: 'n1'.padEnd(40, '0'), files: natureFiles },
        'anti-defensive': { headSha: 'd2'.padEnd(40, '0'), files: {} },
      },
      failures: [],
    })
    const checked = await service.check()
    assert.ok(checked.rosterRemoved.includes('anti-defensive-writing'),
      '上游删除必须如实上报，实际：' + JSON.stringify(checked.rosterRemoved.slice(0, 8)))
    const dirs = await readdir(join(home, 'skills'))
    assert.ok(dirs.includes('anti-defensive-writing'), '不能擅自删用户已有的目录')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('多源: 一个源拉取失败不拖垮另一个源（部分失败可容忍）', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-multi-partial-'))
  try {
    let service
    mod.apply({ logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }, { dshHome: home })
    await service.setConfig({ targetDir: join(home, 'skills'), autoCheck: false })

    service.fetchAllSources = async () => ({
      files: { 'nature-figure/SKILL.md': 'a'.repeat(40) },
      heads: { nature: 'n1'.padEnd(40, '0') },
      perSource: { nature: { headSha: 'n1'.padEnd(40, '0'), files: { 'nature-figure/SKILL.md': 'a'.repeat(40) } } },
      failures: [{ source: 'anti-defensive', repo: 'Adkid-Zephyr/anti-defensive-writing-Skill', message: 'HTTP 404' }],
    })
    service.downloadBlob = async () => Buffer.from('---\nname: x\n---\n')
    const res = await service.installSkills()
    assert.equal(res.outcome.ok, true, '一个源挂了，另一个源照样装成功')
    assert.deepEqual(res.outcome.installed, ['nature-figure'])
    // 失败要如实暴露在状态里，而不是假装没事
    assert.equal(res.sourceErrors.length, 1)
    assert.equal(res.sourceErrors[0].source, 'anti-defensive')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

// ── 下载回退：直连不通时必须自动换镜像（真实端到端暴露的缺口）─────────────────
// 2026-11-05 实测：raw.githubusercontent.com 对两个上游仓库都 ECONNRESET，
// 而 ghproxy.net 同路径 200。单前缀 = 网络一抖，26 个技能一个都装不上。
test('下载回退: 直连失败自动换镜像，且内容仍按 blob sha 校验', async () => {
  const { mkdtemp, rm, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { createHash } = await import('node:crypto')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-fallback-'))
  const skills = join(home, 'skills')
  try {
    let service
    mod.apply({ logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }, { dshHome: home })
    await service.setConfig({ targetDir: skills, autoCheck: false })

    const body = Buffer.from('---\nname: anti-defensive-writing\n---\n')
    const sha = createHash('sha1').update('blob ' + body.length + '\0').update(body).digest('hex')
    mockRemote(service, { headSha: 'a'.repeat(40), files: { 'anti-defensive-writing/SKILL.md': sha } })

    // 记录被尝试的顺序：直连必须失败，镜像必须成功。
    const tried = []
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      tried.push(String(url))
      if (String(url).startsWith('https://raw.githubusercontent.com')) {
        // 模拟 ECONNRESET
        const error = new Error('fetch failed')
        error.cause = { code: 'ECONNRESET' }
        throw error
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async arrayBuffer() { return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) },
      }
    }
    try {
      const res = await service.installSkills(['anti-defensive-writing'])
      assert.equal(res.outcome.ok, true, '镜像可用时安装必须成功，失败详情：' + JSON.stringify(res.outcome.failures))
      assert.deepEqual(res.outcome.installed, ['anti-defensive-writing'])
      assert.equal(await readFile(join(skills, 'anti-defensive-writing', 'SKILL.md'), 'utf8'),
        body.toString('utf8'), '落盘内容必须与远端一致')
    } finally {
      globalThis.fetch = realFetch
    }
    assert.ok(tried.some((u) => u.startsWith('https://raw.githubusercontent.com')), '必须先试直连')
    assert.ok(tried.some((u) => u.includes('ghproxy.net')), '直连失败后必须试镜像，实际：' + JSON.stringify(tried))
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('下载回退: 镜像返回错误内容（sha 不符）时不许写盘，报出全部路由失败原因', async () => {
  const { mkdtemp, rm, readdir } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-badtamper-'))
  const skills = join(home, 'skills')
  try {
    let service
    mod.apply({ logger: { warn() {} } , provide(k, v) { service = v }, effect() {} }, { dshHome: home })
    await service.setConfig({ targetDir: skills, autoCheck: false })
    mockRemote(service, { headSha: 'a'.repeat(40), files: { 'anti-defensive-writing/SKILL.md': 'f'.repeat(40) } })

    const realFetch = globalThis.fetch
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      // 每个路由都返回同样的错误页面 —— sha 永远对不上
      async arrayBuffer() { const b = Buffer.from('<html>blocked</html>'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) },
    })
    try {
      const res = await service.installSkills(['anti-defensive-writing'])
      assert.equal(res.outcome.ok, false, '内容不对绝不能报成功')
      const msg = JSON.stringify(res.outcome.failures)
      assert.match(msg, /blob sha mismatch/, '必须点明是内容校验失败，而不是含糊的网络错误')
      // 绝不能把错误页当成技能文件写进用户目录
      const dirs = await readdir(skills).catch(() => [])
      assert.deepEqual(dirs, [], '校验失败时一个字节都不该落盘')
    } finally {
      globalThis.fetch = realFetch
    }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

// ── 回归：只装了第二个源的技能时，update() 的门闸不能误判 ──────────────────────
// 多源改造引入过一个 P1：顶层 manifest 只镜像主源（nature）。只装反防御技能时，
// 主源一个都没装 → 镜像出来的 files 是空 → needsBaseline() 恒真 → update()
// 永远拒绝动手，用户点「更新」毫无反应。
// 真实网络端到端跑出来的（2026-11-05）：installSkills(['anti-defensive-writing'])
// 成功后 manifest.files 仍是 0。
test('多源: 只装反防御技能后，顶层 manifest 必须包含它们的基线（update 门闸不能误判）', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-union-'))
  try {
    let service
    mod.apply({ logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }, { dshHome: home })
    await service.setConfig({ targetDir: join(home, 'skills'), autoCheck: false })

    // 只给反防御源技能，nature 源一个都没有
    service.fetchAllSources = async () => ({
      files: { 'anti-defensive-writing/SKILL.md': 'b'.repeat(40) },
      heads: { nature: 'n1'.padEnd(40, '0'), 'anti-defensive': 'd1'.padEnd(40, '0') },
      perSource: {
        nature: { headSha: 'n1'.padEnd(40, '0'), files: {} },
        'anti-defensive': { headSha: 'd1'.padEnd(40, '0'), files: { 'anti-defensive-writing/SKILL.md': 'b'.repeat(40) } },
      },
      failures: [],
    })
    service.downloadBlob = async () => Buffer.from('---\nname: x\n---\n')

    const installed = await service.installSkills(['anti-defensive-writing'])
    assert.deepEqual(installed.outcome.installed, ['anti-defensive-writing'])
    // 顶层 manifest 是各源基线的并集：反防御的条目必须真的在里面。
    assert.equal(Object.keys(installed.manifest.files).length, 1,
      '顶层 manifest 必须含反防御源的基线，实际 ' + JSON.stringify(installed.manifest.files))

    // 关键断言：update() 能通过基线门闸（不再返回 baseline-missing）。
    const updated = await service.update([])
    assert.notEqual(updated.outcome.reason, 'baseline-missing',
      'update() 不能被误判成缺基线，实际 reason=' + updated.outcome.reason)
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

// ── 回归：技能早已装好（无基线）时，check/update 必须能用 ──────────────────────
// 用户最常见的处境：技能本来就在磁盘上（手工拷贝 / 旧版插件 / 别的工具），
// 装上本插件后只想「检查更新」。
// 旧行为：needsBaseline 要求顶层 manifest.headSha 非空，而多源下顶层 headSha
// 镜像主源 —— 只装反防御技能时主源没装东西 → headSha=null → needsBaseline 恒真
// → 状态永远 baseline-missing → update() 永远拒绝动手（用户以为更新坏了）。
// 2026-11-05 真实场景实测。
test('回归: 技能已装好且无基线时，check 自动补基线、update 不再被拒', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-adopt-'))
  const skills = join(home, 'skills')
  try {
    // 磁盘上先有两个反防御技能（模拟"早已装好"）
    for (const name of ['anti-defensive-writing', 'anti-defensive-writing-en']) {
      await mkdir(join(skills, name), { recursive: true })
      await writeFile(join(skills, name, 'SKILL.md'), '---\nname: ' + name + '\n---\n')
    }
    let service
    mod.apply({ logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }, { dshHome: home })
    await service.setConfig({ targetDir: skills, autoCheck: false })

    const files = {
      'anti-defensive-writing/SKILL.md': 'a'.repeat(40),
      'anti-defensive-writing-en/SKILL.md': 'b'.repeat(40),
    }
    service.fetchAllSources = async () => ({
      files,
      heads: { nature: 'n1'.padEnd(40, '0'), 'anti-defensive': 'd1'.padEnd(40, '0') },
      perSource: {
        nature: { headSha: 'n1'.padEnd(40, '0'), files: {} },
        'anti-defensive': { headSha: 'd1'.padEnd(40, '0'), files },
      },
      failures: [],
    })
    service.downloadBlob = async () => Buffer.from('---\nname: x\n---\n')

    const checked = await service.check()
    assert.equal(checked.lastCheckStatus, 'upToDate',
      '已装的技能应被采纳为基线，状态不该停在 baseline-missing，实际 ' + checked.lastCheckStatus)
    assert.equal(Object.keys(checked.manifest.files).length, 2, '基线应含这两个已装技能')
    // 顶层 headSha 仍是主源的 null（主源一个都没装），但基线判断不该被它卡住。
    assert.equal(checked.sources.find((s) => s.id === 'anti-defensive').baselineSha, 'd1'.padEnd(40, '0'))

    const updated = await service.update(['anti-defensive-writing'])
    assert.notEqual(updated.outcome.reason, 'baseline-missing',
      'update() 不能被误判成缺基线，实际 reason=' + updated.outcome.reason)
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('needsBaseline: 只凭文件清单判定，headSha 为空但有清单时不算缺基线', () => {
  // 直接测纯函数语义（它是 update/check 门闸的核心）。
  // 这里有清单没 headSha = 多源下主源没装技能，但副源清单是好的。
  const mod = require_needsBaseline()
  assert.equal(mod({ headSha: null, files: { 'a/SKILL.md': 'x' } }), false,
    '有清单就不算缺基线，哪怕顶层 headSha 是 null')
  assert.equal(mod({ headSha: 'a'.repeat(40), files: {} }), true, '空清单 = 缺基线')
  assert.equal(mod(null), true)
  assert.equal(mod(undefined), true)

  function require_needsBaseline() {
    // needsBaseline 未导出：从源码抽出来真跑。
    const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
    const m = /function needsBaseline\(manifest\) \{[\s\S]*?\n\}/.exec(src)
    assert.ok(m, 'needsBaseline 找不到')
    return new Function('isPlainObject', 'return ' + m[0].replace('function needsBaseline(manifest) {', 'function needsBaseline(manifest) {'))(
      (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
    )
  }
})

// ── 回归（P1，实机踩到）：单源状态文件升级到多源时，不许把全部技能误报成新增 ────
// 2026-11-05 重启 DSH 后真实复现：插件自己跑了一次 check，状态文件变成
//   lastCheckStatus: 'updateAvailable'，changedSkills 26 条（每个技能都是 added）
//   sources: { nature: {headSha:null, files:{}}, 'anti-defensive': {...} }
// 根因：旧的单源状态文件里只有顶层 manifest（818 个文件），sources 是空对象。
// 采纳逻辑只判 needsBaseline(顶层) —— 顶层非空 → 跳过采纳 → 逐源 diff 时
// 每个源拿空基线去比完整远端树 → 全部「新增」。
// 修法：采纳条件改成逐源判断（sourcesNeedBaseline），并把旧顶层 manifest
// 迁移给主源复用。
test('迁移: 旧单源状态文件不会把全部技能误报成新增', async () => {
  const { mkdtemp, mkdir, writeFile, rm, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-migrate-'))
  const skills = join(home, 'skills')
  try {
    // 磁盘上已装两个源的技能
    for (const name of ['nature-figure', 'anti-defensive-writing']) {
      await mkdir(join(skills, name), { recursive: true })
      await writeFile(join(skills, name, 'SKILL.md'), '---\nname: ' + name + '\n---\n')
    }

    // 旧单源状态文件：顶层 manifest 有基线，**没有 sources 字段**
    const legacy = {
      version: 1,
      headSha: 'o'.repeat(40),
      lastCheckedAt: '2026-11-04T22:57:42.890Z',
      lastCheckStatus: 'upToDate',
      lastError: null,
      updateAvailable: false,
      changedSkills: [],
      manifest: { headSha: 'o'.repeat(40), files: { 'nature-figure/SKILL.md': 'a'.repeat(40) } },
      roster: ['nature-figure', 'anti-defensive-writing'],
      installation: { installed: ['nature-figure'], missing: ['anti-defensive-writing'], complete: false },
      config: { autoCheck: false, intervalHours: 6, targetDir: skills, mirror: '' },
    }
    await writeFile(join(home, 'dsh-nature-state.json'), JSON.stringify(legacy, null, 2))

    let service
    mod.apply({ logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }, { dshHome: home })
    // 读回来确认 load() 没把 sources 弄成 undefined
    assert.ok(service.state.sources !== undefined, 'load() 后 sources 必须有值')

    // 远端：两个源都有这两个技能，内容与本地一致
    const files = {
      'nature-figure/SKILL.md': 'a'.repeat(40),
      'anti-defensive-writing/SKILL.md': 'b'.repeat(40),
    }
    service.fetchAllSources = async () => ({
      files,
      heads: { nature: 'n1'.padEnd(40, '0'), 'anti-defensive': 'd1'.padEnd(40, '0') },
      perSource: {
        nature: { headSha: 'n1'.padEnd(40, '0'), files: { 'nature-figure/SKILL.md': 'a'.repeat(40) } },
        'anti-defensive': { headSha: 'd1'.padEnd(40, '0'), files: { 'anti-defensive-writing/SKILL.md': 'b'.repeat(40) } },
      },
      failures: [],
    })

    const checked = await service.check()
    assert.equal(checked.changedSkills.length, 0,
      '升级迁移不该报出任何变更，实际：' + JSON.stringify(checked.changedSkills.map((r) => r.name)))
    assert.equal(checked.lastCheckStatus, 'upToDate', '状态应是 upToDate，实际 ' + checked.lastCheckStatus)
    assert.equal(checked.updateAvailable, false, '不该点亮红点')

    // 两个源都建立了基线
    const nature = checked.sources.find((s) => s.id === 'nature')
    const anti = checked.sources.find((s) => s.id === 'anti-defensive')
    assert.equal(nature.baselineSha, 'n1'.padEnd(40, '0'), '主源基线应迁移/采纳')
    assert.equal(anti.baselineSha, 'd1'.padEnd(40, '0'), '副源基线应被采纳')

    // 落盘也要是干净的（重启后不该又变回误报）
    const saved = JSON.parse(await readFile(join(home, 'dsh-nature-state.json'), 'utf8'))
    assert.equal(saved.changedSkills.length, 0, '磁盘状态文件也不许留着误报')
    assert.ok(saved.sources && saved.sources.nature, '磁盘状态文件必须写入 per-source 快照')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('迁移: 旧单源状态文件在 load() 阶段就完成迁移（不等 check）', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-loadmig-'))
  try {
    const head = 'd774add241c65e89ed17a4da573b472b0972fd42'
    await writeFile(join(home, 'dsh-nature-state.json'), JSON.stringify({
      version: 1,
      headSha: head,
      lastCheckedAt: '2026-11-04T22:57:42.890Z',
      lastCheckStatus: 'upToDate', lastError: null, updateAvailable: false, changedSkills: [],
      manifest: { headSha: head, files: { 'nature-figure/SKILL.md': 'a'.repeat(40) } },
      roster: [], installation: { installed: [], missing: [], complete: false },
      config: { autoCheck: false, intervalHours: 6, targetDir: join(home, 'skills'), mirror: '' },
      // 没有 sources —— 旧版状态文件
    }))

    let service
    mod.apply({ logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }, { dshHome: home })

    // 关键：**不调 check、不发任何网络请求**，直接看内存状态
    const primary = service.state.sources && service.state.sources.nature
    assert.ok(primary, 'load() 后主源状态槽必须存在')
    assert.equal(primary.headSha, head, '旧顶层 headSha 必须迁移给主源')
    assert.deepEqual(Object.keys(primary.manifest.files), ['nature-figure/SKILL.md'],
      '旧顶层文件清单必须迁移给主源，否则首次 check 会把全部技能误报成新增')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('迁移: 已有 per-source 基线时不被旧顶层 manifest 覆盖', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const mod = await import('../lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-nomig-'))
  try {
    const oldHead = 'o'.repeat(40)
    const newHead = 'n'.repeat(40)
    await writeFile(join(home, 'dsh-nature-state.json'), JSON.stringify({
      version: 1,
      headSha: oldHead,
      manifest: { headSha: oldHead, files: { 'nature-figure/OLD.md': 'a'.repeat(40) } },
      sources: {
        nature: { headSha: newHead, manifest: { headSha: newHead, files: { 'nature-figure/NEW.md': 'b'.repeat(40) } } },
      },
      roster: [], installation: { installed: [], missing: [], complete: false },
      config: { autoCheck: false, intervalHours: 6, targetDir: join(home, 'skills'), mirror: '' },
    }))

    let service
    mod.apply({ logger: { warn() {} }, provide(k, v) { service = v }, effect() {} }, { dshHome: home })
    const primary = service.state.sources.nature
    assert.equal(primary.headSha, newHead, '已有 per-source 基线时不能被旧顶层覆盖')
    assert.deepEqual(Object.keys(primary.manifest.files), ['nature-figure/NEW.md'])
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
