// client 形状测试：node:test 零依赖，只读 lib/client.js 源码断言 + vm 实跑注册面。
// 运行：node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

// ── 顶层一次性装配：vm 跑 load → factory(react 替身) → apply(ctx 替身) ──────────
let registration
{
  const window = { __ModuleLoader__: { load(value) { registration = value } } }
  vm.runInNewContext(source, { window, console })
}

/** 极简 React 替身：只提供组件用到的 hooks（useState 的函数式惰性初始化要真的执行）。 */
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useCallback(fn) {
    return fn
  },
  useEffect() {},
  useRef(initial) {
    return { current: initial }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
}

const locales = new Map()
const mounted = []
const registered = []
{
  const exports = registration.factory((specifier) => {
    assert.equal(specifier, 'react', 'the browser half requires nothing but react')
    return React
  })
  const remoteStub = { async status() { return { ok: true, value: {} } } }
  const ctx = {
    effect(fn) {
      return fn()
    },
    get(name) {
      return name === 'remote.dshNature' ? remoteStub : undefined
    },
    locale: {
      register(namespace, dicts) {
        locales.set(namespace, dicts)
        return () => {}
      },
      bind(namespace) {
        const entry = locales.get(namespace)
        return (key) => (entry && entry.zh[key]) || key
      },
    },
    remote: {
      async $mount(contribution) {
        mounted.push(contribution)
      },
    },
    slots: {
      inject(owner, factory) {
        return factory()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  await exports.apply(ctx)
}

const dict = locales.get('nature')
const contribution = mounted[0]
const plain = (value) => JSON.parse(JSON.stringify(value))

// ── 静态形状（ask F 点名的四条断言）─────────────────────────────────────────────
test('bundle shape: 首行开始即 window.__ModuleLoader__.load 语句', () => {
  const firstLine = source.split('\n')[0]
  assert.equal(
    firstLine.startsWith('window.__ModuleLoader__.load'),
    true,
    '首行必须是 load 语句（不能有文件头注释）：' + firstLine,
  )
})

test('bundle shape: 不含顶层 import 语句（client 半无构建步骤，只 require）', () => {
  assert.doesNotMatch(source, /(^|\n)import[\s("']/, '任何行都不许以 import 开头')
  assert.match(source, /require\('react'\)/, 'react 经 require 引入')
})

test('bundle shape: 包含四个 UI 槽名 + plugins.bundle.config + $mount', () => {
  for (const slot of ["'sidebar.panellist'", "'settings.section'", "'plugins.detail.badge'", "'main'", "'plugins.bundle.config'"]) {
    assert.ok(source.includes(slot), '缺少槽名 ' + slot)
  }
  assert.ok(source.includes('$mount'), '缺少 ctx.remote.$mount(CONTRIBUTION)')
})

// ── 注册面 ──────────────────────────────────────────────────────────────────────
test('registration: id 与 exports 三件套', () => {
  assert.equal(registration.id, '@zws/dsh-nature')
  const exports = registration.factory(() => React)
  assert.deepEqual(plain(exports.inject), ['slots', 'locale', 'remote'])
  assert.equal(typeof exports.apply, 'function')
})

test('apply: 字典双语注册且键集一致', () => {
  assert.ok(dict && dict.zh && dict.en, 'zh/en dictionaries are registered')
  assert.deepEqual(Object.keys(dict.zh).sort(), Object.keys(dict.en).sort(), 'zh/en key sets match')
  assert.equal(dict.zh.nav, 'Nature 写作')
  assert.equal(dict.en.nav, 'Nature Writing')
})

test('apply: 5 个 strict descriptor（direct / json / wire=name）', () => {
  assert.equal(mounted.length, 1, '$mount called once')
  assert.equal(contribution.package, '@zws/dsh-nature')
  assert.deepEqual(
    plain(contribution.descriptors.map((d) => d.method)),
    ['status', 'check', 'update', 'setConfig', 'openSkillsDir'],
  )
  for (const descriptor of contribution.descriptors) {
    assert.equal(descriptor.service, 'dshNature', descriptor.method)
    assert.equal(descriptor.namespace, 'dshNature', descriptor.method)
    assert.equal(descriptor.invocation.kind, 'direct', descriptor.method)
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.codec.mode, 'strict', descriptor.method + '/' + parameter.wire)
      assert.equal(parameter.source, 'json', descriptor.method + '/' + parameter.wire)
      assert.equal(parameter.name, parameter.wire, 'SRC 兜底按参数名发字段，wire 必须等于 name')
    }
    assert.equal(descriptor.result.mode, 'strict', descriptor.method)
  }
})

test('descriptor 参数形状与 strict codec 真的能校验', () => {
  const byMethod = Object.fromEntries(contribution.descriptors.map((d) => [d.method, d]))
  assert.deepEqual(plain(byMethod.update.parameters.map((p) => p.wire)), ['skillNames'])
  assert.deepEqual(plain(byMethod.setConfig.parameters.map((p) => p.wire)), ['patch'])
  for (const method of ['status', 'check', 'openSkillsDir']) {
    assert.deepEqual(plain(byMethod[method].parameters), [], method + ' 不带参数')
  }

  const skillNamesCodec = byMethod.update.parameters[0].codec
  assert.equal(skillNamesCodec.create().parse(undefined), undefined, 'update 省略参数 = 全部变化技能')
  assert.deepEqual(skillNamesCodec.create().parse(['nature-figure']), ['nature-figure'])
  assert.throws(() => skillNamesCodec.create().parse('nature-figure'), /array/)
  assert.throws(() => skillNamesCodec.create().parse(['']), /non-empty/)

  const configPatchCodec = byMethod.setConfig.parameters[0].codec
  assert.deepEqual(
    configPatchCodec.create().parse({ autoCheck: true, intervalHours: 6, targetDir: 'C:/x', mirror: '' }),
    { autoCheck: true, intervalHours: 6, targetDir: 'C:/x', mirror: '' },
  )
  assert.throws(() => configPatchCodec.create().parse({ nope: 1 }), /unknown config key/)
  assert.throws(() => configPatchCodec.create().parse({ intervalHours: -1 }), /non-negative/)
  assert.throws(() => configPatchCodec.create().parse({ targetDir: '  ' }), /non-empty/)
})

test('slots: 五个座位，id/key/order 与契约一致', () => {
  assert.deepEqual(
    plain(registered.map((row) => row.options.name)).sort(),
    ['main', 'plugins.bundle.config', 'plugins.detail.badge', 'settings.section', 'sidebar.panellist'],
  )
  const bySlot = Object.fromEntries(registered.map((row) => [row.options.name, row]))
  assert.equal(bySlot['sidebar.panellist'].options.id, 'dsh-nature')
  assert.equal(bySlot['sidebar.panellist'].options.order, 45)
  assert.equal(bySlot['main'].options.key, 'dsh-nature', 'main 槽 key 即侧栏入口 id')
  assert.equal(bySlot['settings.section'].options.id, 'dsh-nature')
  assert.equal(bySlot['settings.section'].options.order, 80)
  assert.equal(bySlot['plugins.detail.badge'].options.id, 'dsh-nature')
  assert.equal(bySlot['plugins.bundle.config'].options.key, '@zws/dsh-nature', 'bundle.config 的 key 是包名')
  for (const row of registered) {
    assert.equal(row.options.locale, 'nature')
    assert.equal(row.options.registrant, '@zws/dsh-nature')
    assert.equal(typeof row.component, 'function')
    const injection = row.options.inject()
    assert.equal(typeof injection.api, 'function', row.options.name + ' 的 inject 工厂给 api')
  }
})

// ── 文案同步：locale/*.json 与运行时字典逐键一致 ────────────────────────────────
test('locale files: zh/en JSON 与 client 内联字典逐键同步（meta 除外）', async () => {
  for (const lang of ['zh', 'en']) {
    const json = JSON.parse(await readFile(new URL('../locale/' + lang + '.json', import.meta.url), 'utf8'))
    const jsonKeys = Object.keys(json).filter((key) => key !== 'meta').sort()
    assert.deepEqual(jsonKeys, Object.keys(dict[lang]).sort(), lang + ' JSON 键集与字典不一致')
    for (const key of Object.keys(dict[lang])) {
      assert.equal(json[key], dict[lang][key], lang + '.' + key + ' 的值漂移了')
    }
    assert.ok(typeof json.meta.title === 'string' && json.meta.title.length > 0, lang + ' meta.title 缺失')
    assert.ok(typeof json.meta.description === 'string' && json.meta.description.length > 0, lang + ' meta.description 缺失')
  }
})

// ── 版本同步：client 内联的 PLUGIN_VERSION 必须等于 package.json 的 version ─────
test('PLUGIN_VERSION 与 package.json version 同步', () => {
  const match = /const PLUGIN_VERSION = '([^']+)'/.exec(source)
  assert.ok(match, 'PLUGIN_VERSION 常量找不到')
  assert.equal(match[1], pkg.version, 'client.js 的 PLUGIN_VERSION 与 package.json version 漂移')
})

// ── 技能目录：24 项，每项都有双语一句话定位，字典键与目录一一对应 ────────────────
test('catalog: 24 个技能、skill.* 文案与目录一一对应', () => {
  const catalogMatch = /const CATALOG = \[([\s\S]*?)\n    \]/.exec(source)
  assert.ok(catalogMatch, 'CATALOG 找不到')
  const names = [...catalogMatch[1].matchAll(/'(nature-[a-z0-9-]+)'/g)].map((m) => m[1])
  assert.equal(names.length, 24, '目录必须是 24 项，当前 ' + names.length)
  assert.equal(new Set(names).size, 24, '技能名不许重复')
  for (const name of names) {
    assert.ok(dict.zh['skill.' + name], '缺 zh 一句话定位：' + name)
    assert.ok(dict.en['skill.' + name], '缺 en 一句话定位：' + name)
  }
  for (const key of Object.keys(dict.zh)) {
    if (key.startsWith('skill.')) {
      assert.ok(names.includes(key.slice('skill.'.length)), '字典里多出的 skill 文案：' + key)
    }
  }
})

// ── statusView：对宿主真实形状（lib/index.js:498-511）的归一化 ───────────────────
test('statusView: 宿主状态形状归一化（baseline/needsBaseline/lastError）', async () => {
  // statusView 不在 exports 上，经渲染 WorkbenchPanel 不现实；直接从源码取函数做单元调用。
  const fnMatch = /function statusView\(raw\) \{([\s\S]*?)\n    \}/.exec(source)
  assert.ok(fnMatch, 'statusView 找不到')
  const statusView = new Function(
    'PLUGIN_VERSION',
    fnMatch[0].replace('function statusView(raw) {', 'return function statusView(raw) {'),
  )(pkg.version)
  // 宿主首装形状：没清单、没检查过。
  const fresh = statusView({
    version: 1, headSha: null, lastCheckedAt: null, lastCheckStatus: 'never', lastError: null,
    updateAvailable: false, changedSkills: [], manifest: { headSha: null, files: {} },
    config: { autoCheck: true, intervalHours: 6, targetDir: 'C:/skills', mirror: '' },
  })
  assert.equal(fresh.needsBaseline, true, '无清单 = 需要基线')
  assert.equal(fresh.baselineSha, null)
  assert.equal(fresh.remoteSha, null)
  assert.equal(fresh.pluginVersion, pkg.version, '宿主不带版本时回退内联常量')

  // 宿主检查后的形状：baseline-missing 与 error 都要被认出来。
  const missing = statusView({ lastCheckStatus: 'baseline-missing', manifest: { headSha: null, files: {} } })
  assert.equal(missing.needsBaseline, true)
  const failed = statusView({ lastCheckStatus: 'error', lastError: 'boom', manifest: { headSha: 'a'.repeat(40), files: { 'nature-figure/SKILL.md': 'x' } } })
  assert.equal(failed.needsBaseline, false, '有清单就不算缺基线')
  assert.equal(failed.lastCheckError, 'boom', 'lastError 归一化进 lastCheckError')
  const updated = statusView({
    headSha: 'b'.repeat(40), lastCheckStatus: 'updateAvailable', updateAvailable: true,
    changedSkills: [{ name: 'nature-figure', added: 1, removed: 0, modified: 2 }, { name: 42 }],
    manifest: { headSha: 'a'.repeat(40), files: {} },
  })
  assert.equal(updated.updateAvailable, true)
  assert.equal(updated.remoteSha, 'b'.repeat(40))
  assert.equal(updated.baselineSha, 'a'.repeat(40))
  assert.equal(updated.changedSkills.length, 1, '形状不对的行被丢弃')
  assert.deepEqual(updated.changedSkills[0], { name: 'nature-figure', added: 1, removed: 0, modified: 2 })
})
