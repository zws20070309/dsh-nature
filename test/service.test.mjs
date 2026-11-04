import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve, sep } from 'node:path'

import { diffTrees, normalizeSkillPath, pickChangedSkillNames } from '../lib/index.js'

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
test('NATURE_SKILLS 与 client 的 CATALOG 逐项一致（24 项、同名同序）', async () => {
  const { readFile } = await import('node:fs/promises')
  const mod = await import('../lib/index.js')
  const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const catalog = /const CATALOG = \[([\s\S]*?)\n    \]/.exec(clientSource)
  assert.ok(catalog, 'client 的 CATALOG 找不到')
  const clientNames = [...catalog[1].matchAll(/'(nature-[a-z0-9-]+)'/g)].map((m) => m[1])
  assert.equal(mod.NATURE_SKILLS.length, 24)
  assert.deepEqual(clientNames, mod.NATURE_SKILLS, 'host NATURE_SKILLS 与 client CATALOG 必须同集同序')
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
    service.fetchHeadSha = async () => 'a'.repeat(40)
    service.fetchSkillFiles = async () => ({
      'nature-figure/SKILL.md': 'f74ffae6423160998b5983402eb627a5ba735fc7',
    })
    service.downloadBlob = async () => Buffer.from('---\nname: nature-figure\n---\n')

    const result = await service.install()
    // 返回形状必须与 status() 同形（浏览器半直接拿它覆盖状态）
    for (const key of ['version', 'lastCheckStatus', 'changedSkills', 'manifest', 'config', 'installation']) {
      assert.ok(Object.hasOwn(result, key), 'install() 结果缺字段 ' + key)
    }
    assert.ok(result.outcome && typeof result.outcome === 'object', '明细必须在 outcome 里')
    assert.deepEqual(result.outcome.installed, ['nature-figure'], '远端只有这一个 → 只装它')
    // 关键：install 之后必须真的可被发现（安装快照重扫过）
    assert.deepEqual(result.installation.installed, ['nature-figure'])
    assert.equal(result.installation.complete, false)
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
    service.fetchHeadSha = async () => 'b'.repeat(40)
    service.fetchSkillFiles = async () => ({
      'nature-figure/SKILL.md': 'x'.repeat(40),
      'nature-writing/SKILL.md': 'y'.repeat(40),
    })
    service.downloadBlob = async () => Buffer.from('---\nname: x\n---\n')

    const result = await service.install(['nature-figure'])
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
    service.fetchHeadSha = async () => 'c'.repeat(40)
    service.fetchSkillFiles = async () => files

    let inFlight = 0
    let peak = 0
    service.downloadBlob = async (head, rel) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      if (rel.endsWith('f7.md')) throw new Error('synthetic failure')
      return Buffer.from('---\nname: nature-figure\n---\n')
    }

    const result = await service.install(['nature-figure'])
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
    service.fetchHeadSha = async () => 'd'.repeat(40)
    service.fetchSkillFiles = async () => remote
    service.downloadBlob = async () => Buffer.from('---\nname: x\n---\n')

    // 只装 1 个
    const first = await service.install(['nature-figure'])
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
    assert.equal(second.installation.complete, false, '只有 3/24 不可能是 complete')
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
