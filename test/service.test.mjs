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
