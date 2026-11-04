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

test('apply: 7 个 strict descriptor（direct / json / wire=name）', () => {
  assert.equal(mounted.length, 1, '$mount called once')
  assert.equal(contribution.package, '@zws/dsh-nature')
  assert.deepEqual(
    plain(contribution.descriptors.map((d) => d.method)),
    ['status', 'inspect', 'check', 'update', 'installSkills', 'setConfig', 'openSkillsDir'],
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
  for (const method of ['status', 'inspect', 'check', 'openSkillsDir']) {
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
  const statusView = buildStatusView()
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


// ── 回归：main 槽面板必须自己当滚动容器 ─────────────────────────────────────────
// main 槽父级 .mP3x-q_centerCol 是 {flex-direction:column;overflow:hidden}，高度由
// .mP3x-q_frame{grid-template-rows:minmax(0,1fr) auto;height:100%} 定死。面板不声明
// height + overflow-y 就只能无限增高、被父级裁掉——一屏以外既看不到也滚不到
// （2026-11-04 实机复现：page clientHeight 等于内容全高，无任何可滚动祖先）。
test('滚动：main 槽面板自带 height:100% + overflow-y:auto 的滚动容器', () => {
  const cssMatch = /const CSS = `([\s\S]*?)\n`/.exec(source)
  assert.ok(cssMatch, 'CSS 常量找不到')
  const css = cssMatch[1]

  const rule = /\.dsh-nature-scroll\{([^}]*)\}/.exec(css.replace(/\n/g, ''))
  assert.ok(rule, '缺少 .dsh-nature-scroll 规则（main 槽的滚动容器）')
  const body = rule[1]
  assert.match(body, /height:100%/, '滚动容器必须 height:100%，否则跟随内容无限增高')
  assert.match(body, /overflow-y:auto/, '滚动容器必须 overflow-y:auto')
  assert.match(body, /min-height:0/, 'flex 子项必须 min-height:0，否则高度下限把内容撑开')

  // 面板根节点必须真的用上这个类，且内容居中列还在里面（两层结构）。
  const panel = /className: 'dsh-nature-scroll'[^\n]*\n(?:[^\n]*\n){0,3}[^\n]*className: 'dsh-nature-page'/.exec(source)
  assert.ok(panel, 'WorkbenchPanel 必须是 .dsh-nature-scroll > .dsh-nature-page 两层结构')
})

// ── 回归：update() 必须回完整状态，界面才不会被"更新成功"带坏 ────────────────────
// 客户端拿到动作结果直接 statusView(unwrap(remote)) 覆盖本地状态。宿主若回
// {ok,headSha,updated,...} 这种明细形状，statusView 会归一化成"未建立基线 +
// 目标目录为空"，一次更新就把页面显示成坏状态。
test('statusView: 能识别 update 明细并按 outcome 带出', () => {
  const statusView = buildStatusView()

  const full = {
    version: 1, headSha: 'a'.repeat(40), lastCheckedAt: '2026-11-04T01:00:00.000Z',
    lastCheckStatus: 'upToDate', lastError: null, updateAvailable: false,
    changedSkills: [], manifest: { headSha: 'a'.repeat(40), files: { 'x/SKILL.md': 'y' } },
    config: { autoCheck: true, intervalHours: 6, targetDir: 'C:/skills', mirror: '' },
    outcome: { ok: true, updated: ['nature-figure'], skipped: [], removed: [], failures: [] },
  }
  const view = statusView(full)
  assert.equal(view.needsBaseline, false, '完整状态不该被判成缺基线')
  assert.equal(view.config.targetDir, 'C:/skills', '目标目录必须保住')
  assert.ok(view.outcome, 'outcome 必须带出')
  assert.deepEqual(view.outcome.updated, ['nature-figure'])

  // 没有 outcome 的普通状态：字段为 null，不炸。
  assert.equal(statusView({ ...full, outcome: undefined }).outcome, null)
})

// ── 回归：目录名 ≠ 触发名的技能必须标出真实触发名 ────────────────────────────────
// DSH 的 skill 名取 SKILL.md 的 frontmatter name，不是目录名
// （dsh-skill-filesystem discoverRoot 里 `name: parsed.name`）。上游
// nature-proposal-writer 目录的 frontmatter 是 name: researchwrite。
test('catalog: 目录名与触发名不一致的技能有别名标注', () => {
  const aliasMatch = /const TRIGGER_ALIASES = \{([\s\S]*?)\n    \}/.exec(source)
  assert.ok(aliasMatch, '缺少 TRIGGER_ALIASES（目录名→触发名）')
  assert.match(aliasMatch[1], /'nature-proposal-writer': 'researchwrite'/,
    'nature-proposal-writer 的触发名是 researchwrite')

  const catalogMatch = /const CATALOG = \[([\s\S]*?)\n    \]/.exec(source)
  const names = [...catalogMatch[1].matchAll(/'(nature-[a-z0-9-]+)'/g)].map((m) => m[1])
  for (const key of Object.keys(TRIGGER_ALIAS_KEYS_FROM(aliasMatch[1]))) {
    assert.ok(names.includes(key), '别名键必须真的在目录里：' + key)
  }
  function TRIGGER_ALIAS_KEYS_FROM(text) {
    return Object.fromEntries([...text.matchAll(/'(nature-[a-z0-9-]+)':/g)].map((m) => [m[1], true]))
  }
})

// ── 回归：启动必须分段兜底，一个入口坏了不能拖垮整个 bundle ──────────────────────
// client bundle 与官方 bundle 拼成同一个脚本执行；apply() 里抛出的异常会连带
// 官方入口一起死（"插件装了但完全没有入口"）。样式 / 文案 / Remote 挂载三段
// 必须各自 try/catch，且 $mount 失败后仍要继续注册槽位。
test('apply: 样式、文案、Remote 挂载三段各自兜底，$mount 失败仍注册槽位', async () => {
  const registered = []
  const failures = []
  const brokenCtx = {
    effect(fn) {
      try { return fn() } catch (error) { failures.push(error); return () => {} }
    },
    get() { return undefined },
    locale: { register() { return () => {} }, bind() { return (key) => key } },
    // Remote 挂载直接抛错：真实场景是宿主服务没起来 / 网关拒挂。
    remote: { async $mount() { throw new Error('mount exploded') } },
    slots: {
      inject(owner, factory) { return factory() },
      register(options) { registered.push(options.name); return () => {} },
    },
  }
  const exports = registration.factory(() => React)
  // 关键断言：不抛异常。
  await exports.apply(brokenCtx)
  assert.deepEqual(
    registered.sort(),
    ['main', 'plugins.bundle.config', 'plugins.detail.badge', 'settings.section', 'sidebar.panellist'],
    '$mount 失败后五个槽位仍必须全部注册（UI 要给 remoteNotMounted 的可读提示）',
  )
})

// statusView 现在依赖 installationView 与 CATALOG_TOTAL，必须一起求值：
// 只抽 statusView 一个函数体会在 new Function 里 ReferenceError。
function buildStatusView() {
  const pick = (re, label) => {
    const m = re.exec(source)
    assert.ok(m, '找不到：' + label)
    return m[0]
  }
  const installationView = pick(/function installationView\(raw\) \{[\s\S]*?\n    \}/, 'installationView')
  const statusView = pick(/function statusView\(raw\) \{[\s\S]*?\n    \}/, 'statusView')
  const catalogMatch = /const CATALOG = \[([\s\S]*?)\n    \]/.exec(source)
  assert.ok(catalogMatch, 'CATALOG 找不到')
  const total = [...catalogMatch[1].matchAll(/'(nature-[a-z0-9-]+)'/g)].length
  const body = installationView + '\n' +
    statusView.replace('function statusView(raw) {', 'return function statusView(raw) {')
  return new Function('PLUGIN_VERSION', 'CATALOG_TOTAL', body)(pkg.version, total)
}

// ── 回归：拿不到宿主状态时，绝不能把"读不到"渲染成"0 个已安装" ──────────────────
// 实机踩到：升级后宿主未重启（旧代码没有 inspect 方法），面板显示
// 「未检测到 nature 技能 / 0 个已安装」，而本机明明装了 24 个 —— 用户会去重装。
test('installationView: 无宿主状态时 known=false，不误报成"未安装"', () => {
  const installationView = buildInstallationView()

  const unknown = installationView(undefined)
  assert.equal(unknown.known, false, 'undefined 必须被判为未知')
  assert.equal(unknown.empty, false, '未知 ≠ 空（否则页面会说"未检测到技能"）')
  assert.equal(unknown.complete, false)

  // null / 形状不对 也走未知分支
  assert.equal(installationView(null).known, false)
  assert.equal(installationView({}).known, false, '没有 installed 数组就是未知')
  assert.equal(installationView({ complete: true }).known, false, '只有 complete 不算数')

  // 真实形状才是已知
  const empty = installationView({ installed: [], missing: ['a'], complete: false })
  assert.equal(empty.known, true)
  assert.equal(empty.empty, true)
  assert.equal(empty.installedCount, 0)

  const partial = installationView({ installed: ['nature-figure'], missing: ['nature-writing'], complete: false })
  assert.equal(partial.known, true)
  assert.equal(partial.partial, true)
  assert.equal(partial.installedCount, 1)
  assert.equal(partial.empty, false)
})

function buildInstallationView() {
  const m = /function installationView\(raw\) \{[\s\S]*?\n    \}/.exec(source)
  assert.ok(m, 'installationView 找不到')
  const catalogMatch = /const CATALOG = \[([\s\S]*?)\n    \]/.exec(source)
  const total = [...catalogMatch[1].matchAll(/'(nature-[a-z0-9-]+)'/g)].length
  return new Function('CATALOG_TOTAL',
    m[0].replace('function installationView(raw) {', 'return function installationView(raw) {'))(total)
}

// ── 回归：namespaceApi 必须真的返回命名空间 ─────────────────────────────────────
// 实机踩到（P0）：编辑时把 namespaceApi 的 `return namespace` 弄丢了，
// 函数变成"只抛错不返回"，api() 永远拿到 undefined —— 于是所有远程调用都失败，
// 面板显示「宿主服务未就绪」，重启无数次都没用（宿主半其实是好的）。
// 现有测试全是源码正则断言，抓不到"少一个 return"这种逻辑错误，所以这里真跑。
test('namespaceApi: api() 必须返回命名空间对象，而不是 undefined', async () => {
  const vm = await import('node:vm')
  let reg
  const sandbox = { window: { __ModuleLoader__: { load(value) { reg = value } } }, console }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)

  const ReactStub = {
    createElement: () => null,
    useCallback: (fn) => fn,
    useEffect() {},
    useRef: (init) => ({ current: init }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  }

  const namespace = { status: async () => ({ ok: true, value: {} }) }
  const seen = []
  const slots = {
    // 真实调用链：ctx.slots.inject(owner, () => ctx.slots.register({...inject: injectApi}, Comp))
    // 先跑 factory() 触发 register，拿注册项上的 inject 工厂，再调用它 —— 等价于框架挂载那一刻。
    inject(owner, factory) {
      try { factory() } catch { /* register 已捕获 options，下面统一断言 */ }
      return () => {}
    },
    register(options) {
      if (options && typeof options.inject === 'function') {
        try {
          const injected = options.inject()
          if (injected && typeof injected.api === 'function') seen.push(injected.api)
        } catch { /* 抓不到就交给下面的断言报错 */ }
      }
      return () => {}
    },
  };

  await reg.factory(() => ReactStub).apply({
    effect(fn) { try { return fn() } catch { return () => {} } },
    get(key) { return key === 'remote.dshNature' ? namespace : undefined },
    locale: { register() { return () => {} }, bind() { return (key) => key } },
    remote: { async $mount() {} },
    slots,
  })

  assert.ok(seen.length > 0, '没有捕获到任何槽位的 api 工厂')
  for (const api of seen) {
    const resolved = api()
    assert.notEqual(resolved, undefined, 'api() 返回了 undefined —— namespaceApi 丢了 return')
    assert.equal(resolved, namespace, 'api() 必须返回 ctx.get("remote.dshNature") 的结果')
  }
})

// ── 回归：Remote 方法名不能撞 gateway 的命名空间服务 ─────────────────────────────
// 实机踩到（P0，插件完全不可用）：把安装方法命名成 install，而 gateway 的
// RemoteNamespaceService（客户端为每个命名空间建的 Service 实例）原型上就有
// install()，于是 validateContribution 抛
//   client api: method "dshNature/install" conflicts with its namespace service
// 整个命名空间挂不上 —— 表现为「宿主服务未就绪」，宿主其实是好的。
//
// 这里把 gateway 的保留名表抄成常量，逐个校验我们注册的方法名。
// 表来源：dsh-api-gateway/lib/client.browser.js 的 RemoteNamespaceService
// 原型成员 + REMOTE_NAMESPACE_FIELDS。
test('descriptor 方法名不撞 gateway 的 RemoteNamespaceService 保留名', () => {
  const RESERVED_PROTOTYPE = [
    'assertMethodAvailable', 'constructor', 'empty', 'has',
    'install', 'installDirect', 'installScoped', 'remove',
  ]
  const RESERVED_FIELDS = ['ctx', 'empty', 'invokeRemote', 'methods', 'name', 'namespace']
  const reserved = new Set([...RESERVED_PROTOTYPE, ...RESERVED_FIELDS])

  for (const descriptor of contribution.descriptors) {
    assert.equal(
      reserved.has(descriptor.method), false,
      'Remote 方法 ' + JSON.stringify(descriptor.method) + ' 撞上 gateway 命名空间服务的保留名，' +
      '整个命名空间会挂不上（表现为「宿主服务未就绪」）。换一个名字。',
    )
  }
  // 列表本身也要守：以后有人照抄官方插件把 install 加回来，这条会立刻红。
  assert.deepEqual(
    plain(contribution.descriptors.map((d) => d.method)),
    ['status', 'inspect', 'check', 'update', 'installSkills', 'setConfig', 'openSkillsDir'],
  )
})

// ── 回归：保留名自查函数真的会抛错 ──────────────────────────────────────────────
test('assertRemoteMethodName: 撞保留名立刻抛错，合法名放行', () => {
  const m = /function assertRemoteMethodName\(method\) \{([\s\S]*?)\n    \}/.exec(source)
  assert.ok(m, 'assertRemoteMethodName 找不到')
  const setMatch = /const RESERVED_REMOTE_NAMES = new Set\(\[([\s\S]*?)\n    \]\)/.exec(source)
  assert.ok(setMatch, 'RESERVED_REMOTE_NAMES 找不到')
  const names = [...setMatch[1].matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1])
  const assertFn = new Function('RESERVED_REMOTE_NAMES', 'JSON', m[0].replace(
    'function assertRemoteMethodName(method) {',
    'return function assertRemoteMethodName(method) {',
  ))(new Set(names), JSON)

  for (const bad of ['install', 'remove', 'has', 'empty', 'namespace', 'ctx']) {
    assert.throws(() => assertFn(bad), /collides with the gateway namespace service/, bad + ' 应当被拦下')
  }
  for (const good of ['status', 'inspect', 'check', 'update', 'installSkills', 'setConfig', 'openSkillsDir']) {
    assert.doesNotThrow(() => assertFn(good), good + ' 不应被拦')
  }
})

// ── 新能力：客户端目录必须跟着 roster 走（上游 24→25→26）──────────────────────
// 写死分组 + 写死总数会让「安装状态 26/26」和「目录 24 项」同屏自相矛盾。
test('installationView: total 优先用宿主下发的次数，而不是写死常量', () => {
  const installationView = buildInstallationView()

  // 宿主说 26 个（学自远端），即便内置常量是 24 也必须显示 26
  const grown = installationView({ installed: [], missing: [], total: 26, complete: false })
  assert.equal(grown.total, 26, '上游增长后 total 必须跟着变')
  assert.equal(grown.known, true)

  // 宿主没给 total（老宿主）→ 退回内置常量，不能是 undefined
  const legacy = installationView({ installed: [], missing: [], complete: false })
  assert.equal(typeof legacy.total, 'number')
  assert.ok(legacy.total > 0)
})

test('Catalog: 静态分组之外的新技能不能从目录里消失', () => {
  const fnSrc = /function Catalog\(props\) \{[\s\S]*?\n    \}/.exec(source)
  assert.ok(fnSrc, 'Catalog 找不到')
  // 目录必须读用 props.roster（动态），而不是直接躺 CATALOG
  assert.match(fnSrc[0], /const \{ t, roster \} = props/, 'Catalog 必须接收 roster')
  assert.match(fnSrc[0], /listed/, 'Catalog 必须基于 roster 计算展示集合')
  assert.match(fnSrc[0], /group\.newer/, '静态分组没覆盖的新技能要单独成组')
  // 调用点必须真的把 status.roster 传进去
  assert.match(source, /h\(Catalog, \{ t, roster: status\.roster \}\)/, 'Catalog 调用点必须传 roster')
})

test('statusView: 透传宿主的 roster 供目录渲染', () => {
  const statusView = buildStatusView()
  const view = statusView({
    roster: ['nature-a', 'nature-b'],
    installation: { installed: [], missing: [], total: 2, complete: false },
  })
  assert.deepEqual(view.roster, ['nature-a', 'nature-b'])
  // 坏形状被清洗成空数组，不是 undefined
  assert.deepEqual(statusView({ roster: 'nope' }).roster, [])
})
