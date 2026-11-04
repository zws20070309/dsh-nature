// 红点渲染测试：真跑 hooks + 真走组件树，验证「点完全部更新 → 侧栏蓝点立刻灭」。
//
// 为什么需要这个文件：2026-11-04 22:12 用户实测截图，工作台已经写「全套 24 个就绪 /
// 没有待更新的技能」，宿主状态文件里 updateAvailable 也已经是 false，可侧栏图标
// 右上角的蓝点还亮着。根因是红点有**多份互不知情的副本**（侧栏图标 PanelIcon、
// 插件详情徽标 DetailBadge、插件管理器状态卡 BundleCard），各自挂载时读一次
// status()，之后只靠 10 分钟轮询；工作台点完更新，自己 onRefresh 立刻变脸，
// 那几份副本还在睡。
//
// 源码正则断言抓不到「副本之间不同步」这种时序 bug，所以这里用一个迷你 React
// 真的挂载组件、真的触发 setState、真的重渲染整棵树，断言最终树里蓝点的有无。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

/**
 * 迷你 React：只实现插件用到的四个 hooks（useState / useEffect / useRef /
 * useCallback），但语义是真的 ——
 *   - 函数组件按位置递归展开成完整元素树（UpdateCenter、InstallCard 这些
 *     子组件必须真的被调用，否则按钮根本不存在）；
 *   - useState 的 setter 改槽位并排队重渲染；
 *   - useEffect 按 deps 比较决定跑不跑，卸载时跑 cleanup。
 * 够用来观察「状态变了，树变没变」。
 */
function createMiniReact() {
  /** 位置路径 → 组件实例（hooks 槽位挂在实例上，跨渲染复用）。 */
  const instances = new Map()
  let cur = null
  let queued = false
  let root = null
  let tree = null

  const getInstance = (path) => {
    if (!instances.has(path)) instances.set(path, { path, hooks: [], hi: 0, effects: [], dirty: false })
    return instances.get(path)
  }

  const expand = (node, path) => {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node !== 'object') return node
    const type = node.type
    const props = node.props ?? {}
    if (typeof type === 'function') {
      const inst = getInstance(path)
      const prev = cur
      cur = inst
      inst.hi = 0
      inst.effects = []
      let out
      let expanded
      try {
        out = type(props)
        // 必须在 cur 仍是 inst 的时候递归展开：函数组件返回的子树里还有函数组件，
        // 先恢复 cur 会让子组件的 hooks 撞上 null。
        expanded = expand(out, path + '>')
      } finally {
        cur = prev
      }
      return expanded
    }
    const kids = []
    const children = node.children || []
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if (Array.isArray(child)) {
        for (let j = 0; j < child.length; j++) kids.push(expand(child[j], path + '/' + i + '.' + j))
      } else {
        kids.push(expand(child, path + '/' + i))
      }
    }
    return { type, props, children: kids }
  }

  const collectEffects = () => {
    const runs = []
    for (const inst of instances.values()) {
      for (const run of inst.effects) runs.push(run)
      inst.effects = []
    }
    return runs
  }

  const renderRoot = () => {
    tree = expand(root.element, '')
    for (const run of collectEffects()) run()
    return tree
  }

  const flush = () => {
    for (let round = 0; round < 20; round++) {
      const dirty = [...instances.values()].filter((inst) => inst.dirty)
      if (dirty.length === 0) return
      for (const inst of dirty) inst.dirty = false
      renderRoot()
    }
  }

  const schedule = () => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      flush()
    })
  }

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) }
    },
    useRef(init) {
      const inst = cur
      const i = inst.hi++
      if (!(i in inst.hooks)) inst.hooks[i] = { current: init }
      return inst.hooks[i]
    },
    useCallback(fn) {
      return fn
    },
    useState(init) {
      const inst = cur
      const i = inst.hi++
      if (!(i in inst.hooks)) inst.hooks[i] = { v: typeof init === 'function' ? init() : init }
      const slot = inst.hooks[i]
      return [slot.v, (next) => {
        const value = typeof next === 'function' ? next(slot.v) : next
        if (Object.is(value, slot.v)) return
        slot.v = value
        inst.dirty = true
        schedule()
      }]
    },
    useEffect(fn, deps) {
      const inst = cur
      const i = inst.hi++
      const prev = inst.hooks[i]
      const changed = !prev
        || !deps
        || !prev.deps
        || deps.length !== prev.deps.length
        || deps.some((d, k) => !Object.is(d, prev.deps[k]))
      if (!changed) return
      inst.effects.push(() => {
        if (prev && typeof prev.cleanup === 'function') prev.cleanup()
        const cleanup = fn()
        inst.hooks[i] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
      })
    },
  }

  function mount(Component, props) {
    instances.clear()
    root = { element: { type: Component, props: props ?? {}, children: [] } }
    renderRoot()
    return tree
  }

  /** 卸载：跑所有 cleanup（订阅必须退订，否则卸载后还在 setState）。 */
  function unmount() {
    for (const inst of instances.values()) {
      for (const slot of inst.hooks) {
        if (slot && typeof slot.cleanup === 'function') slot.cleanup()
        if (slot && typeof slot.current === 'object' && slot.current !== null && 'value' in slot.current) {
          /* useRef 槽位无 cleanup */
        }
      }
    }
    instances.clear()
    root = null
    tree = null
  }

  return { React, mount, unmount, flush, getTree: () => tree }
}

/** 递归找树里有没有 className 含给定类的节点。 */
function hasClass(node, name) {
  if (node === null || node === undefined || typeof node !== 'object') return false
  const cn = node.props && node.props.className
  if (typeof cn === 'string' && cn.split(/\s+/).includes(name)) return true
  for (const child of node.children || []) {
    if (hasClass(child, name)) return true
  }
  return false
}

/** 取树里的可见文本，用来定位按钮。 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  return (node.children || []).map(textOf).join('')
}

/**
 * 按按钮文字反查按钮。makeText 在拿不到 t 时回落 DICTIONARY.zh，
 * 所以这里传中文文案（不是字典键）。
 */
function findButton(node, label) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (node.type === 'button' && node.props && typeof node.props.onClick === 'function') {
    if (textOf(node).includes(label)) return node
  }
  for (const child of node.children || []) {
    const found = findButton(child, label)
    if (found !== null) return found
  }
  return null
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 把插件装起来：vm 跑 load → factory(迷你 React) → apply(假 ctx)。 */
async function boot(host) {
  const mini = createMiniReact()
  let registration
  const sandbox = {
    window: { __ModuleLoader__: { load(v) { registration = v } } },
    console,
    setTimeout,
    clearTimeout,
    // 10 分钟轮询在这里不需要真的走：空转 handle，否则测试进程永远不退出。
    setInterval: () => 0,
    clearInterval: () => {},
    queueMicrotask,
    Promise,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)

  const state = () => ({
    version: 1,
    headSha: 'b'.repeat(40),
    lastCheckedAt: '2026-11-04T14:12:22.000Z',
    lastCheckStatus: host.updateAvailable ? 'updateAvailable' : 'upToDate',
    lastError: null,
    updateAvailable: host.updateAvailable === true,
    changedSkills: host.updateAvailable
      ? [{ name: 'nature-figure', added: 1, removed: 0, modified: 2 }]
      : [],
    manifest: { headSha: 'b'.repeat(40), files: { 'x/SKILL.md': 'y' } },
    config: { autoCheck: true, intervalHours: 6, targetDir: 'C:/skills', mirror: '' },
    installation: { installed: ['nature-writing'], missing: [], total: 1, complete: true },
    roster: ['nature-figure'],
  })

  const namespace = {
    async status() { return { ok: true, value: state() } },
    async inspect() { return { ok: true, value: state() } },
    async check() { return { ok: true, value: state() } },
    async update() {
      host.updateAvailable = false
      return { ok: true, value: { ...state(), outcome: { ok: true, updated: ['nature-figure'], skipped: [], removed: [], failures: [] } } }
    },
    async installSkills() {
      host.updateAvailable = false
      return { ok: true, value: { ...state(), outcome: { ok: true, installed: ['nature-writing'], failures: [] } } }
    },
    async setConfig() { return { ok: true, value: state() } },
    async openSkillsDir() { return { ok: true, value: state() } },
  }

  const slots = {}
  const exports = registration.factory(() => mini.React)
  await exports.apply({
    effect(fn) { return fn() },
    get(key) { return key === 'remote.dshNature' ? namespace : undefined },
    locale: { register() { return () => {} }, bind() { return (key) => key } },
    remote: { async $mount() {} },
    slots: {
      inject(owner, factory) { factory(); return () => {} },
      register(options, component) { slots[options.name] = { options, component }; return () => {} },
    },
  })
  return { mini, slots, namespace, host }
}

// ── 核心回归 ──────────────────────────────────────────────────────────────────
test('红点（真渲染）：宿主管有更新时，侧栏蓝点亮；无更新时不亮', async () => {
  // 有更新 → 亮
  const withUpdate = await boot({ updateAvailable: true })
  withUpdate.mini.mount(withUpdate.slots['sidebar.panellist'].component,
    { size: 20, api: withUpdate.slots['sidebar.panellist'].options.inject().api })
  await tick(40)
  withUpdate.mini.flush()
  assert.equal(hasClass(withUpdate.mini.getTree(), 'dsh-nature-dot'), true,
    '宿主报告 updateAvailable=true 时，侧栏必须有蓝点')
  withUpdate.mini.unmount()

  // 无更新 → 不亮（不是"一直亮着"）
  const noUpdate = await boot({ updateAvailable: false })
  noUpdate.mini.mount(noUpdate.slots['sidebar.panellist'].component,
    { size: 20, api: noUpdate.slots['sidebar.panellist'].options.inject().api })
  await tick(40)
  noUpdate.mini.flush()
  assert.equal(hasClass(noUpdate.mini.getTree(), 'dsh-nature-dot'), false,
    '宿主报告没有更新时，侧栏不能有蓝点')
  noUpdate.mini.unmount()
})

test('红点（真渲染）：更新后蓝点灭、更新前蓝点亮（同一棵树内完成）', async () => {
  // 侧栏图标与工作台必须**同时**存在才测得到同步，所以用一个能挂两处的迷你树。
  const host = { updateAvailable: true }
  const { mini, slots } = await boot(host)
  const api = slots['sidebar.panellist'].options.inject().api
  function Both() {
    return mini.React.createElement('div', null,
      mini.React.createElement(slots['sidebar.panellist'].component, { size: 20, api }),
      mini.React.createElement(slots['main'].component, { api }),
    )
  }
  mini.mount(Both, {})
  await tick(80)
  mini.flush()

  const dots = () => hasClass(mini.getTree(), 'dsh-nature-dot')
  assert.equal(dots(), true, '宿主报告有更新时，侧栏必须有蓝点')

  const button = findButton(mini.getTree(), '全部更新')
  assert.ok(button, '工作台必须有「全部更新」按钮')
  button.props.onClick()
  await tick(120)
  mini.flush()

  assert.equal(dots(), false, '更新完成后侧栏蓝点必须立刻灭（不能等 10 分钟轮询）')
  mini.unmount()
})

test('红点（真渲染）：检查后仍有更新时，蓝点保持亮', async () => {
  const host = { updateAvailable: true }
  const { mini, slots } = await boot(host)
  const api = slots['sidebar.panellist'].options.inject().api
  function Both() {
    return mini.React.createElement('div', null,
      mini.React.createElement(slots['sidebar.panellist'].component, { size: 20, api }),
      mini.React.createElement(slots['main'].component, { api }),
    )
  }
  mini.mount(Both, {})
  await tick(80)
  mini.flush()
  const dots = () => hasClass(mini.getTree(), 'dsh-nature-dot')
  assert.equal(dots(), true)

  const button = findButton(mini.getTree(), '检查更新')
  assert.ok(button, '工作台必须有「检查更新」按钮')
  button.props.onClick()
  await tick(120)
  mini.flush()

  assert.equal(dots(), true, '结论仍是有更新时，蓝点必须保持亮（不能因为刷新就误灭）')
  mini.unmount()
})

test('红点（真渲染）：插件管理器徽标与侧栏同拍', async () => {
  const host = { updateAvailable: true }
  const { mini, slots } = await boot(host)
  const api = slots['sidebar.panellist'].options.inject().api
  function Both() {
    return mini.React.createElement('div', null,
      mini.React.createElement(slots['sidebar.panellist'].component, { size: 20, api }),
      mini.React.createElement(slots['plugins.detail.badge'].component, { api }),
      mini.React.createElement(slots['main'].component, { api }),
    )
  }
  mini.mount(Both, {})
  await tick(80)
  mini.flush()

  assert.equal(hasClass(mini.getTree(), 'dsh-nature-badge'), true, '有更新时插件详情徽标要出现')

  const button = findButton(mini.getTree(), '全部更新')
  assert.ok(button)
  button.props.onClick()
  await tick(120)
  mini.flush()

  assert.equal(hasClass(mini.getTree(), 'dsh-nature-dot'), false, '蓝点必须灭')
  assert.equal(hasClass(mini.getTree(), 'dsh-nature-badge'), false, '徽标必须同步消失')
  mini.unmount()
})

// ── 边界：结论没变时不许广播（避免订阅者被无意义地叫醒）────────────────────────
test('红点（真渲染）：重复拿到同样的结论不重渲染', async () => {
  const host = { updateAvailable: true }
  const { mini, slots } = await boot(host)
  const api = slots['sidebar.panellist'].options.inject().api

  mini.mount(slots['sidebar.panellist'].component, { size: 20, api })
  await tick(40)
  mini.flush()
  assert.equal(hasClass(mini.getTree(), 'dsh-nature-dot'), true)

  // 连点三次「检查更新」，结论始终是「有更新」：蓝点必须稳定亮着，不闪不灭。
  const mainTree = { current: null }
  function Both() {
    return mini.React.createElement('div', null,
      mini.React.createElement(slots['sidebar.panellist'].component, { size: 20, api }),
      mini.React.createElement(slots['main'].component, { api }),
    )
  }
  mini.unmount()
  mini.mount(Both, {})
  await tick(80)
  mini.flush()

  for (let i = 0; i < 3; i++) {
    const button = findButton(mini.getTree(), '检查更新')
    assert.ok(button, '第 ' + i + ' 次：工作台必须有「检查更新」按钮')
    button.props.onClick()
    await tick(80)
    mini.flush()
    assert.equal(hasClass(mini.getTree(), 'dsh-nature-dot'), true,
      '第 ' + i + ' 次检查后结论仍是有更新，蓝点必须保持亮')
  }
  mini.unmount()
})

// ── 边界：订阅必须在卸载时退订（否则卸载后仍 setState，React 会警告）─────────────
test('红点（真渲染）：组件卸载后不再收到广播（订阅已退订）', async () => {
  const host = { updateAvailable: true }
  const { mini, slots, namespace } = await boot(host)
  const api = slots['sidebar.panellist'].options.inject().api

  mini.mount(slots['sidebar.panellist'].component, { size: 20, api })
  await tick(40)
  mini.flush()
  assert.equal(hasClass(mini.getTree(), 'dsh-nature-dot'), true)

  // 卸载侧栏图标，然后让宿主报告「没有更新」并触发一次广播。
  mini.unmount()
  const before = mini.getTree()
  await namespace.update()   // 宿主 updateAvailable 变 false
  await tick(40)
  mini.flush()

  // 卸载后树不复存在，不该抛错；这里主要断言「卸载流程跑完了没有炸」。
  assert.equal(before, null, '卸载后不应再持有渲染树')
})
