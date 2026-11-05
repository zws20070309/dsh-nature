// 生命周期回归：多轮真实调用链路（check → install → update → 重启）的契约。
//
// 为什么单独一个文件：service.test.mjs 里的用例几乎都是**单轮**的（调一次
// install 或一次 check，断言返回值）。2026-11-05 那轮审查发现的所有 P0 都活在
// **多轮之间**：源挂掉一轮之后点更新删文件、补装一轮之后更新被吞、重启一轮之后
// roster 掉回内置清单 —— 90 个全绿的单轮测试一条都没抓到。
//
// 这里的每个 test 都先在工作区跑红再修到绿，对应 docs/design.md §9 的修复记录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, NATURE_SKILLS } from '../lib/index.js'

const SKILL_HEAD = '---\nname: x\n---\n'

/** 挂一个独立实例（同 home 再挂一次 = 模拟重启 DSH）。 */
async function boot(home) {
  let service
  apply(
    { logger: { warn() {} }, provide(key, value) { service = value }, effect() {} },
    { dshHome: home },
  )
  await service.setConfig({ autoCheck: false })
  return service
}

/**
 * 可编程假远端：能按源下线 / 返空 / 推新提交，并如实产出 health。
 *
 * health 是这一轮多源架构的核心：fetchAllSources 之外没人分得清
 * 「远端真没有这个技能」和「这个源这一轮没拉到」。
 */
function makeRemote() {
  const state = {
    nature: { head: 'n1'.padEnd(40, '0'), files: {}, health: 'ok' },
    'anti-defensive': { head: 'd1'.padEnd(40, '0'), files: {}, health: 'ok' },
  }
  const fetchAll = async () => {
    const files = {}
    const heads = {}
    const perSource = {}
    const failures = []
    const health = {}
    for (const [id, entry] of Object.entries(state)) {
      health[id] = entry.health
      if (entry.health === 'unreachable') {
        failures.push({ source: id, repo: 'repo/' + id, message: 'ECONNRESET' })
        continue
      }
      heads[id] = entry.head
      perSource[id] = { headSha: entry.head, files: entry.files }
      Object.assign(files, entry.files)
      if (entry.health === 'empty') {
        failures.push({ source: id, repo: 'repo/' + id, message: 'skills/ came back empty' })
      }
    }
    return { files, heads, perSource, failures, health }
  }
  return { state, fetchAll }
}

/** 装一个实例 + 假远端 + 固定下载内容。 */
async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-life-'))
  const skills = join(home, 'skills')
  const service = await boot(home)
  await service.setConfig({ targetDir: skills, autoCheck: false })
  const remote = makeRemote()
  service.fetchAllSources = remote.fetchAll
  service.downloadBlob = async () => Buffer.from(SKILL_HEAD)
  return { home, skills, service, remote }
}

async function teardown(home) {
  // 等启动扫描的 persist 落定再删：否则 rm 会与它撞 ENOTEMPTY（测试清理时序问题）。
  await new Promise((resolve) => setTimeout(resolve, 200))
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

const names = async (service) => (await service.status()).installation.installed

// ── P0-1：源不可达 / 返回空树时，一个字节都不许删 ────────────────────────────────
for (const mode of ['unreachable', 'empty']) {
  test('P0-1 源 ' + mode + '：check 与 update 都不删该源的文件', async () => {
    const { home, skills, service, remote } = await setup()
    try {
      remote.state.nature.files = { 'nature-figure/SKILL.md': 'a'.repeat(40) }
      remote.state['anti-defensive'].files = { 'anti-defensive-writing/SKILL.md': 'b'.repeat(40) }
      await service.installSkills()
      assert.deepEqual(await names(service), ['anti-defensive-writing', 'nature-figure'])

      // 这一轮反防御源出问题；同时 nature 真的前进（让 update 有正事可做）。
      remote.state['anti-defensive'].health = mode
      remote.state.nature.head = 'n2'.padEnd(40, '0')
      remote.state.nature.files = { 'nature-figure/SKILL.md': 'c'.repeat(40) }

      const checked = await service.check()
      // check 必须如实报出这个源有问题，而不是假装全套就绪。
      assert.equal(checked.sourceErrors.length, 1, '源异常必须出现在 sourceErrors 里')
      assert.equal(checked.sourceErrors[0].source, 'anti-defensive')
      // 不能把它报成「上游删了技能」。
      assert.deepEqual(checked.changedSkills.filter((row) => row.removed > 0), [],
        '源异常时不允许产出任何删除变更，实际：' + JSON.stringify(checked.changedSkills))

      const updated = await service.update()
      assert.deepEqual(updated.outcome.removed, [], '源异常时不允许真的删文件')

      const disk = (await readdir(skills)).sort()
      assert.ok(disk.includes('anti-defensive-writing'), '用户已有的技能目录被删掉了：' + JSON.stringify(disk))
      // 健康的源照常更新，不能被另一个源的故障拖住。
      assert.ok(updated.outcome.updated.includes('nature-figure'), '健康源必须照常更新')
    } finally {
      await teardown(home)
    }
  })
}

test('P0-1 上游**真的**删掉技能时（源健康）仍然按语义删除用户文件', async () => {
  // 反向断言：上面的保守策略不能把"上游真删了"也一起挡住，否则用户的目录
  // 会永远留着一份上游已经不存在的东西。
  const { home, skills, service, remote } = await setup()
  try {
    remote.state.nature.files = {
      'nature-a/SKILL.md': 'a'.repeat(40),
      'nature-b/SKILL.md': 'b'.repeat(40),
    }
    await service.installSkills()
    assert.deepEqual((await readdir(skills)).sort(), ['nature-a', 'nature-b'])

    remote.state.nature.head = 'n2'.padEnd(40, '0')
    remote.state.nature.files = { 'nature-a/SKILL.md': 'a'.repeat(40) }
    const checked = await service.check()
    assert.ok(checked.changedSkills.some((row) => row.name === 'nature-b' && row.removed === 1),
      '上游删除必须如实报出来，实际：' + JSON.stringify(checked.changedSkills))

    const updated = await service.update()
    assert.deepEqual(updated.outcome.removed, ['nature-b/SKILL.md'])
    assert.deepEqual((await readdir(skills)).sort(), ['nature-a'])
  } finally {
    await teardown(home)
  }
})

// ── P0-2：补装缺失技能不许快进基线、吞掉未安装的更新 ────────────────────────────
test('P0-2 补装缺失技能后，未重新下载的技能仍报"有更新"并能更新到新内容', async () => {
  const { home, skills, service, remote } = await setup()
  try {
    let body = 'CONTENT-v1'
    service.downloadBlob = async () => Buffer.from(SKILL_HEAD + body)
    remote.state.nature.files = {
      'nature-figure/SKILL.md': 'a'.repeat(40),
      'nature-writing/SKILL.md': 'b'.repeat(40),
    }
    await service.installSkills()

    // 上游改了 nature-writing，但用户还没点更新。
    remote.state.nature.head = 'n2'.padEnd(40, '0')
    remote.state.nature.files = {
      'nature-figure/SKILL.md': 'a'.repeat(40),
      'nature-writing/SKILL.md': 'c'.repeat(40),
    }
    body = 'CONTENT-v2'
    await service.check()

    // 用户此时发现 nature-figure 目录坏了，点「自动补全缺失的 1 个」。
    await rm(join(skills, 'nature-figure'), { recursive: true, force: true })
    const inspected = await service.inspect()
    assert.deepEqual(inspected.installation.missing, ['nature-figure'])
    await service.installSkills(inspected.installation.missing)

    // 关键：补装之后，那条**没被下载**的更新必须还在。
    const after = await service.check()
    assert.ok(after.changedSkills.some((row) => row.name === 'nature-writing'),
      '补装把 nature-writing 的更新吞掉了，实际 changedSkills=' + JSON.stringify(after.changedSkills.map((r) => r.name)))
    assert.equal(after.updateAvailable, true, '红点必须还在（有真正的待更新）')

    const updated = await service.update()
    assert.ok(updated.outcome.updated.includes('nature-writing'))
    const disk = await readFile(join(skills, 'nature-writing', 'SKILL.md'), 'utf8')
    assert.ok(disk.includes('CONTENT-v2'), '磁盘内容必须是 v2，实际：' + JSON.stringify(disk.trim()))
  } finally {
    await teardown(home)
  }
})

// ── P1-3：单个文件失败必须能被后续 update 补回（基线不变量）─────────────────────
test('P1-3 单文件下载失败不进基线，网络恢复后 update 能把它补回来', async () => {
  const { home, skills, service, remote } = await setup()
  try {
    remote.state.nature.files = {
      'nature-figure/SKILL.md': 'a'.repeat(40),
      'nature-figure/scripts/audit.py': 'b'.repeat(40),
    }
    let broken = true
    service.downloadBlob = async (source, head, rel) => {
      if (broken && rel.endsWith('audit.py')) throw new Error('ECONNRESET')
      return Buffer.from(SKILL_HEAD)
    }

    const first = await service.installSkills()
    assert.equal(first.outcome.ok, false, '有文件失败必须如实报出来')
    // 基线不变量：失败的文件绝不能出现在基线里，否则"已同步"是假的。
    assert.equal(Object.keys(first.manifest.files).some((path) => path.endsWith('audit.py')), false,
      '失败文件被写进了基线：' + JSON.stringify(Object.keys(first.manifest.files)))

    broken = false
    const checked = await service.check()
    assert.ok(checked.changedSkills.some((row) => row.name === 'nature-figure'),
      '网络恢复后必须还能看见这个文件待同步')
    const updated = await service.update()
    assert.ok(updated.outcome.updated.includes('nature-figure'))
    const entries = await readdir(join(skills, 'nature-figure'))
    assert.ok(entries.includes('scripts'), '失败的文件没有被补回来，实际：' + JSON.stringify(entries))
  } finally {
    await teardown(home)
  }
})

// ── P1-4：lastCheckStatus 不再把「没装全」当成「没基线」────────────────────────
test('P1-4 只装一部分技能时 lastCheckStatus 是 upToDate，缺技能由 installation 承载', async () => {
  const { home, service, remote } = await setup()
  try {
    remote.state.nature.files = {
      'nature-a/SKILL.md': 'a'.repeat(40),
      'nature-b/SKILL.md': 'b'.repeat(40),
    }
    const result = await service.installSkills(['nature-a'])
    assert.equal(result.lastCheckStatus, 'upToDate',
      '有基线时不许报 baseline-missing（否则界面引导用户去跑 tools/baseline.cjs）')
    assert.ok(Object.keys(result.manifest.files).length > 0, '基线确实存在')
    // 缺的那部分由安装态承载，语义准确。
    assert.equal(result.installation.complete, false)
    assert.deepEqual(result.installation.missing.filter((n) => n.startsWith('nature-')), ['nature-b'])
  } finally {
    await teardown(home)
  }
})

// ── P1-5：重启后 roster / 新增提示 / 安装计数全部必须保持 ───────────────────────
test('P1-5 重启后 roster、上游新增提示、安装计数都不缩水', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-life-boot-'))
  try {
    const skills = join(home, 'skills')
    const first = await boot(home)
    await first.setConfig({ targetDir: skills })
    const remote = makeRemote()
    first.fetchAllSources = remote.fetchAll
    first.downloadBlob = async () => Buffer.from(SKILL_HEAD)

    const files = {}
    for (const name of NATURE_SKILLS) files[name + '/SKILL.md'] = 'a'.repeat(40)
    remote.state.nature.files = files
    await first.installSkills()

    // 上游新增一个技能，用户还没装 —— 这是「上游从 24 变 25」的真实形态。
    remote.state.nature.head = 'n2'.padEnd(40, '0')
    remote.state.nature.files = { ...files, 'nature-brand-new/SKILL.md': 'e'.repeat(40) }
    const checked = await first.check()
    assert.equal(checked.rosterAdded.includes('nature-brand-new'), true)
    assert.deepEqual(checked.installation.missing, ['nature-brand-new'])
    await new Promise((resolve) => setTimeout(resolve, 200))

    // 同一个 home 重新挂载 = 重启 DSH。
    const second = await boot(home)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const after = await second.inspect()

    assert.equal(after.roster.length, checked.roster.length,
      '重启后 roster 掉回去了：' + after.roster.length + ' vs ' + checked.roster.length)
    assert.deepEqual(after.rosterAdded, ['nature-brand-new'], '重启后「上游新增」提示丢了')
    assert.equal(after.installation.total, checked.installation.total, '重启后总数缩水')
    assert.equal(after.installation.complete, false, '还缺一个新技能，不能被说成"全套就绪"')
  } finally {
    await teardown(home)
  }
})

test('P1-5 重启后每源归属不退回内置清单（源行不报假技能数）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-nature-life-owner-'))
  try {
    const first = await boot(home)
    const remote = makeRemote()
    first.fetchAllSources = remote.fetchAll
    first.downloadBlob = async () => Buffer.from(SKILL_HEAD)
    remote.state.nature.files = { 'nature-figure/SKILL.md': 'a'.repeat(40) }
    remote.state['anti-defensive'].files = { 'anti-defensive-writing/SKILL.md': 'b'.repeat(40) }
    await first.installSkills()
    await new Promise((resolve) => setTimeout(resolve, 200))

    const second = await boot(home)
    const status = await second.status()
    const nature = status.sources.find((row) => row.id === 'nature')
    assert.deepEqual(nature.skills, ['nature-figure'], '重启后归属表必须恢复，实际：' + JSON.stringify(nature.skills))
    assert.equal(nature.skillsKnown, true)

    // 全新实例（从没检查过）不许退回内置 26 项：那是与磁盘无关的假数。
    const virginHome = await mkdtemp(join(tmpdir(), 'dsh-nature-life-virgin-'))
    try {
      const virgin = await boot(virginHome)
      const fresh = (await virgin.status()).sources.find((row) => row.id === 'nature')
      assert.deepEqual(fresh.skills, [], '没学到归属时不许报内置清单：' + JSON.stringify(fresh.skills))
      assert.equal(fresh.skillsKnown, false)
    } finally {
      await teardown(virginHome)
    }
  } finally {
    await teardown(home)
  }
})

// ── P1-6：远端版本必须反映远端真实 head ────────────────────────────────────────
test('P1-6 check 后远端版本前进，基线版本原地不动', async () => {
  const { home, service, remote } = await setup()
  try {
    remote.state.nature.files = { 'nature-a/SKILL.md': 'a'.repeat(40) }
    await service.installSkills()
    const baseline = (await service.status()).manifest.headSha

    remote.state.nature.head = 'n2'.padEnd(40, '0')
    remote.state.nature.files = { 'nature-a/SKILL.md': 'c'.repeat(40) }
    const checked = await service.check()

    assert.equal(checked.remoteHeads.nature, 'n2'.padEnd(40, '0'), '远端版本必须前进')
    assert.equal(checked.manifest.headSha, baseline, '基线版本必须原地不动（更新成功才前进）')
    const nature = checked.sources.find((row) => row.id === 'nature')
    assert.equal(nature.remoteHeadSha, 'n2'.padEnd(40, '0'))
    assert.equal(nature.baselineSha, baseline)
  } finally {
    await teardown(home)
  }
})

// ── P2-8：只勾选更新一部分后，待更新列表必须收敛 ────────────────────────────────
test('P2-8 只更新一部分后，已更新完的技能离开待更新列表', async () => {
  const { home, service, remote } = await setup()
  try {
    remote.state.nature.files = {
      'nature-a/SKILL.md': 'a'.repeat(40),
      'nature-b/SKILL.md': 'b'.repeat(40),
    }
    await service.installSkills()

    remote.state.nature.head = 'n2'.padEnd(40, '0')
    remote.state.nature.files = {
      'nature-a/SKILL.md': 'c'.repeat(40),
      'nature-b/SKILL.md': 'd'.repeat(40),
    }
    await service.check()

    const one = await service.update(['nature-a'])
    assert.deepEqual(one.outcome.updated, ['nature-a'])
    assert.equal(one.changedSkills.some((row) => row.name === 'nature-a'), false,
      '更新完的技能还挂在待更新列表里：' + JSON.stringify(one.changedSkills.map((r) => r.name)))
    assert.equal(one.changedSkills.some((row) => row.name === 'nature-b'), true,
      '没更新的技能必须留在列表里')
  } finally {
    await teardown(home)
  }
})

// ── P2-10：故意只装子集时红点不许常亮 ─────────────────────────────────────────
test('P2-10 用户只装一部分技能时红点不常亮，缺技能由安装态承载', async () => {
  const { home, service, remote } = await setup()
  try {
    remote.state.nature.files = {
      'nature-a/SKILL.md': 'a'.repeat(40),
      'nature-b/SKILL.md': 'b'.repeat(40),
      'nature-c/SKILL.md': 'c'.repeat(40),
    }
    await service.installSkills(['nature-a'])

    const checked = await service.check()
    assert.equal(checked.updateAvailable, false,
      '没装的技能不该点亮红点，实际 changedSkills=' + JSON.stringify(checked.changedSkills.map((r) => r.name)))
    // 但缺技能这件事必须照样说清楚。
    assert.equal(checked.installation.complete, false)
    assert.equal(checked.installation.missing.length, 2)

    // 上游真新增一个技能时，红点必须亮 —— 这是用户需要知道的。
    remote.state.nature.head = 'n2'.padEnd(40, '0')
    remote.state.nature.files = { ...remote.state.nature.files, 'nature-d/SKILL.md': 'd'.repeat(40) }
    const withNew = await service.check()
    assert.equal(withNew.updateAvailable, true, '上游新增技能必须点亮红点')
    assert.ok(withNew.rosterAdded.includes('nature-d'))
  } finally {
    await teardown(home)
  }
})

// ── 基线不变量：全局 ────────────────────────────────────────────────────────────
test('基线不变量：任何时刻基线条目都必须在磁盘上能找到对应文件', async () => {
  const { home, skills, service, remote } = await setup()
  try {
    remote.state.nature.files = {
      'nature-a/SKILL.md': 'a'.repeat(40),
      'nature-a/lib/one.md': 'b'.repeat(40),
      'nature-b/SKILL.md': 'c'.repeat(40),
    }
    let failOne = true
    service.downloadBlob = async (source, head, rel) => {
      if (failOne && rel.endsWith('one.md')) throw new Error('boom')
      return Buffer.from(SKILL_HEAD)
    }

    const invoked = async (label) => {
      const status = await service.status()
      for (const path of Object.keys(status.manifest.files)) {
        const target = join(skills, ...path.split('/'))
        const body = await readFile(target).catch(() => null)
        assert.notEqual(body, null, label + ': 基线条目在磁盘上不存在 -> ' + path)
      }
    }

    await service.installSkills()
    await invoked('install 之后')

    failOne = false
    await service.check()
    await invoked('check 之后')

    await service.update()
    await invoked('update 之后')
  } finally {
    await teardown(home)
  }
})
