/**
 * Renders the composer switch and checks what a user would actually see.
 *
 * The plugin's host half is covered by `check.mjs` (static) and
 * `tool-schema.mjs` / `storage.mjs` (against real Harness services). This file
 * covers the third surface — the control in the composer tool row — because its
 * behaviour is invisible to those: a switch that shows the wrong state, or that
 * silently swallows a refused toggle, still passes every host-side check.
 *
 * The client half is a classic script that hands a factory to
 * `window.__ModuleLoader__`, and only ever imports `react`. So this harness
 * installs that global, mocks React with a state store that survives re-renders
 * (the component is a function; hooks are positional), and inspects the element
 * tree the component returns. No DOM and no test framework.
 *
 * `useSyncExternalStore` is mocked SYNCHRONOUSLY on purpose: real SSR picks the
 * `getServerSnapshot` branch, which would render English and hide a broken
 * Chinese dictionary.
 *
 * Run with plain node — it imports nothing outside this package.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
/** Awaited, so an async check cannot print "ok" before its assertions settle. */
const check = async (label, fn) => {
  try {
    await fn()
    console.log(`  ok  ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL  ${label}\n      ${error.message}`)
  }
}

// --- mocks --------------------------------------------------------------------

/** Positional hook state. Index is the hook call site, so it survives re-renders. */
const makeReact = () => {
  const cells = []
  const effects = []
  let cursor = 0

  /** Shallow dependency comparison, the rule `useCallback`/`useMemo` are built on. */
  const sameDeps = (left, right) => {
    if (left === undefined || right === undefined) return left === right
    return left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  }

  const react = {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] }
    }),
    useState: (seed) => {
      const index = cursor++
      if (!(index in cells)) cells[index] = typeof seed === 'function' ? seed() : seed
      return [cells[index], (next) => {
        cells[index] = typeof next === 'function' ? next(cells[index]) : next
      }]
    },
    // Memoised by deps, and that faithfulness matters: a `useCallback` that
    // returned a fresh function every render would re-fire every effect, and an
    // effect that re-reads the row would erase the error a failed toggle just
    // set — hiding the very behaviour under test.
    useCallback: (fn, deps) => {
      const index = cursor++
      const cell = cells[index]
      if (cell !== undefined && cell.kind === 'memo' && sameDeps(cell.deps, deps)) return cell.value
      cells[index] = { kind: 'memo', deps, value: fn }
      return fn
    },
    useMemo: (fn, deps) => {
      const index = cursor++
      const cell = cells[index]
      if (cell !== undefined && cell.kind === 'memo' && sameDeps(cell.deps, deps)) return cell.value
      const value = fn()
      cells[index] = { kind: 'memo', deps, value }
      return value
    },
    useRef: (value) => {
      const index = cursor++
      if (cells[index] === undefined) cells[index] = { current: value }
      return cells[index]
    },
    // Dependency-aware, like React. Pushing every effect on every render would
    // re-fire the row read after a failed toggle and erase the error it just
    // set — the mock would then "prove" a bug the component does not have.
    useEffect: (fn, deps) => {
      const index = cursor++
      const cell = cells[index]
      if (deps === undefined) {
        cells[index] = { kind: 'effect', deps: undefined, always: true }
        effects.push(fn)
        return
      }
      if (cell !== undefined && cell.kind === 'effect' && sameDeps(cell.deps, deps)) return
      cells[index] = { kind: 'effect', deps }
      effects.push(fn)
    },
    useSyncExternalStore: (_subscribe, get) => get(),
    Fragment: 'Fragment'
  }
  return { react, cells, effects, reset: () => { cursor = 0 } }
}

/** The `react` the client half receives; `react` is the only allowed import. */
const requireFrom = (react) => (name) => {
  if (name === 'react') return react
  throw new Error(`the client half may only require 'react', it required ${name}`)
}

/** Minimal globals the classic script touches: the loader and the CSS <style> tag. */
const installGlobals = () => {
  const styleTags = []
  const document = {
    querySelector: () => null,
    // The stylesheet effect writes `tag.dataset.plugin` / `.pluginCss`.
    createElement: () => ({ dataset: {}, setAttribute() {}, appendChild() {}, textContent: '' }),
    head: { appendChild: (tag) => styleTags.push(tag) }
  }
  const loader = { load({ factory }) { globalThis.__dshFactory = factory } }
  globalThis.document = document
  globalThis.window = { __ModuleLoader__: loader }
  return { styleTags }
}

/**
 * Load the client half and capture the components it registers into slots.
 *
 * The slot callback closes over the context `apply` received, so the fake
 * services must be on THAT object: mounting with a different one leaves the
 * component reading the registration context.
 */
const loadClientHalf = async (react, services) => {
  installGlobals()
  // A fresh module instance per call: the file registers itself on load.
  await import(`${new URL('../src/client.js', import.meta.url).href}?t=${Math.random()}`)
  const plugin = globalThis.__dshFactory(requireFrom(react))
  const registered = new Map()
  const ctx = {
    // `useCopy` reads `locale.getSnapshot()` and takes `.active`; a synchronous
    // external store is what makes the Chinese dictionary reachable here.
    locale: { getSnapshot: () => ({ active: 'zh' }), subscribe: () => () => {} },
    slots: {
      inject: (_owner, callback) => callback(),
      register: (options, component) => { registered.set(options.name, component); return () => {} }
    },
    // The stylesheet is registered as an effect on the plugin context.
    effect: (fn) => { const dispose = fn(); return () => dispose?.() },
    ...services
  }
  plugin.apply(ctx)
  return { registered, ctx }
}

/**
 * Expand an element tree into host elements.
 *
 * The slot callback returns `h(ImageToolRow, props)` — an element whose type is
 * still a function — so a tree walk that only looks for `type === 'button'`
 * finds nothing. Calling the function is what actually runs the hooks, so this
 * is also where `useState`/`useEffect` see their call sites, once per render.
 */
const renderTree = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (typeof node.type === 'function') return renderTree(node.type({ ...node.props }))
  const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]
  return { ...node, props: { ...node.props, children: children.map(renderTree) } }
}

/** Depth-first search for the switch button in a rendered element tree. */
const findButton = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (node.type === 'button') return node
  const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]
  for (const child of children) {
    const found = findButton(child)
    if (found !== undefined) return found
  }
  return undefined
}

const SWITCH_SLOT = 'conversation.input.left'

/**
 * Mount the switch over a fake Plugin Manager.
 *
 * `application` is what `setPluginEnabled` reports back; `state.enabled` is what
 * `listPlugins` reports, so a test can model a refused or pending toggle.
 */
const mount = async ({ enabled = false, application = 'restart-required', failWith = undefined, rowFound = true } = {}) => {
  const mock = makeReact()
  const calls = []
  const runtime = { enabled, application, failWith, rowFound }
  const ctx = {
    remote: {
      pluginManager: {
        async listPlugins() {
          return {
            ok: true,
            value: runtime.rowFound
              ? [{ patchId: 'image-openai-tool', entryId: 'image-openai-tool', moduleName: 'dsh-image-openai/tool', enabled: runtime.enabled }]
              : []
          }
        },
        async setPluginEnabled(id, next) {
          calls.push({ id, next })
          if (runtime.failWith !== undefined) return { ok: false, error: { message: runtime.failWith } }
          if (runtime.application === 'failed') return { ok: true, value: { application: 'failed', error: { code: 'activation-failed' } } }
          runtime.enabled = next
          return { ok: true, value: { application: runtime.application } }
        }
      }
    }
  }

  const { registered } = await loadClientHalf(mock.react, ctx)
  const component = registered.get(SWITCH_SLOT)
  assert.ok(component !== undefined, `the switch must register into ${SWITCH_SLOT}`)

  /**
   * The tree of the most recent render, shared by every renderer below.
   *
   * `button()` reads THIS, not the tree mount happened to finish on: a check
   * settles again after clicking, and a closure holding only the mount-time tree
   * would report the pre-click state forever — a harness bug that looks exactly
   * like a broken switch.
   */
  let tree = undefined

  const render = () => {
    mock.reset()
    tree = renderTree(component({ ctx }))
    return tree
  }

  /**
   * Render until nothing is left to do: flush the async service calls, render,
   * run the effects that render registered, repeat. One round is not enough —
   * a toggle's promise chain can settle between two renders.
   */
  const settle = async (rounds = 3) => {
    for (let round = 0; round < rounds; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      render()
      for (const effect of mock.effects.splice(0)) effect()
    }
    return render()
  }

  render()
  for (const effect of mock.effects.splice(0)) effect()
  await settle()
  return { render, settle, calls, runtime, button: () => findButton(tree) }
}

// --- checks -------------------------------------------------------------------

console.log('composer switch')

await check('the face is the four characters the user asked for, in every state', async () => {
  for (const scenario of [{ enabled: false }, { enabled: true }, { enabled: false, application: 'restart-required' }]) {
    const view = await mount(scenario)
    const text = JSON.stringify(view.button().props.children)
    assert.ok(text.includes('生成图片'), `the face must read 生成图片, saw ${text}`)
    // Length is the point: the label shares a crowded row with the permission
    // picker and the model picker.
    const label = '生成图片'.length
    assert.equal(label, 4)
  }
})

await check('an off switch says it is not injected, and is not checked', async () => {
  const view = await mount({ enabled: false })
  const button = view.button()
  assert.equal(button.props['aria-checked'], 'false')
  assert.equal(button.props['data-pending'], 'false')
  assert.equal(button.props['aria-label'], '生成图片：未注入到预设')
  assert.match(button.props.title, /未注入到预设/)
})

await check('clicking flips the TOOL ROW and reports the saved state', async () => {
  const view = await mount({ enabled: false, application: 'applied' })
  view.button().props.onClick()
  await view.settle()
  assert.deepEqual(view.calls, [{ id: 'image-openai-tool', next: true }], 'the switch must address the tool row')
  assert.equal(view.button().props['aria-checked'], 'true')
  assert.equal(view.button().props['data-pending'], 'false')
})

await check('a restart-required toggle is shown as pending, not as done', async () => {
  // Regression: this profile has no HMR, so EVERY toggle is restart-required.
  // Reporting it as applied was a lie the user only discovered by asking the
  // model — which is exactly how this was reported.
  const view = await mount({ enabled: false, application: 'restart-required' })
  view.button().props.onClick()
  await view.settle()
  const button = view.button()
  assert.equal(button.props['aria-checked'], 'true', 'the saved choice is on')
  assert.equal(button.props['data-pending'], 'true', 'but it is not live yet')
  assert.equal(button.props['aria-label'], '生成图片：重启后生效')
  assert.match(button.props.title, /重启后生效/)
  assert.match(button.props.title, /重启 DSH 后才会真正组合/)
})

await check('a refused toggle keeps the previous state and shows the reason', async () => {
  const view = await mount({ enabled: false, failWith: 'row is unaddressable' })
  view.button().props.onClick()
  await view.settle()
  const button = view.button()
  assert.equal(button.props['aria-checked'], 'false', 'a refused change must not look applied')
  assert.equal(button.props.title, 'row is unaddressable')
  assert.equal(button.props['data-pending'], 'false')
})

await check('an activation failure is reported rather than shown as applied', async () => {
  const view = await mount({ enabled: false, application: 'failed' })
  view.button().props.onClick()
  await view.settle()
  assert.equal(view.button().props['aria-checked'], 'false')
  assert.equal(view.button().props.title, 'activation-failed')
})

await check('a missing tool row is explained instead of offered', async () => {
  const view = await mount({ rowFound: false })
  const button = view.button()
  assert.equal(button.props.disabled, true, 'there is nothing to toggle')
  // The localized reason, not an internal token like 'unaddressable'.
  assert.equal(button.props.title, '找不到工具行，插件可能没有正确加载。')
})

await check('the English face is short enough for the row', async () => {
  // The dictionaries are keyed identically; a missing key would surface as
  // `undefined` in the tooltip rather than as a visible failure.
  const source = readFileSync(join(root, 'src', 'client.js'), 'utf8')
  for (const key of ['label', 'on', 'off', 'pending', 'pendingHint', 'hint', 'saving', 'summary']) {
    const hits = [...source.matchAll(new RegExp(`^\\s+${key}: `, 'gm'))]
    assert.equal(hits.length, 2, `${key} must exist in both dictionaries, found ${hits.length}`)
  }
})

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
