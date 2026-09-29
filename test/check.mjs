/**
 * Offline self-check. Zero dependencies, no network.
 *
 * The fakes below are written against the real contracts rather than invented
 * shapes: `storageDomain` tables, the Loader entry tree, and the tool registry
 * are all shaped the way the installed Harness shapes them, because a fake that
 * invents its own data shape verifies nothing.
 *
 * Run: node test/check.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

const manifest = JSON.parse(read('package.json'))
const host = read('src/index.js')
const client = read('src/client.js')
const patch = read('cordis.patch.yml')

// The tool layer is this package's `./tool` SUBPATH, named by a second row of
// this bundle's patch. It is reached only through the specifier, declares no
// `dsh.bundle` and no `dsh.client`, so it never appears as a second installed
// entry. See cordis.patch.yml.
const toolRoot = path.join(root, 'tool')
const toolRead = (relative) => fs.readFileSync(path.join(toolRoot, relative), 'utf8')
const toolManifest = JSON.parse(toolRead('package.json'))
const toolHost = toolRead('index.js')
const toolZh = JSON.parse(toolRead('locale/zh.json'))

let failures = 0
/**
 * Every check is settled before the summary, so a check that happens to be
 * `async` cannot report its failure after "all checks passed" — or, worse, lose
 * it to an unhandled rejection. Call sites stay unchanged: the promise is
 * collected here and awaited once at the end.
 */
const pending = []
const check = (label, fn) => {
  const settled = Promise.resolve()
    .then(fn)
    .then(
      () => console.log(`  ok  ${label}`),
      (error) => {
        failures += 1
        console.error(`FAIL  ${label}\n      ${error.message}`)
      }
    )
  pending.push(settled)
  return settled
}

console.log('manifest')

check('declares a bundle patch that exists', () => {
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(fs.existsSync(path.join(root, 'cordis.patch.yml')))
})

check('declares a web client half and exports it', () => {
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'], './src/client.js')
  assert.ok(fs.existsSync(path.join(root, 'src/client.js')))
})

check('the client half declares no Harness Client package as a runtime import', () => {
  // `inject` only orders activation; importing one would break on any release.
  const injected = manifest.dsh.client.inject ?? []
  assert.ok(injected.every((name) => name.startsWith('@deepseek-ai/dsh-client-ui-')))
  assert.ok(!/require\(['"]@deepseek-ai\//.test(client), 'client.js must only require react')
  assert.ok(/require\(['"]react['"]\)/.test(client))
})

check('icon is declared and lives inside the package', () => {
  assert.equal(manifest.icon, './icon.svg')
  assert.ok(fs.existsSync(path.join(root, 'icon.svg')))
})

console.log('bundle patch')

check('the patch inserts exactly two rows, both naming this package', () => {
  const rows = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)\s*\n\s*name:\s*'([^']+)'/gm)].map((match) => ({ id: match[1], name: match[2] }))
  assert.deepEqual(rows, [
    { id: 'image-openai', name: 'dsh-image-openai' },
    { id: 'image-openai-tool', name: 'dsh-image-openai/tool' }
  ])
  // The tool row names this package's subpath, so it resolves to this package.
  assert.equal(rows[1].name.split('/')[0], manifest.name, 'the tool row must name this package')
})

check('the tool subpath is exported, along with the two resources that label it', () => {
  // `readPluginMeta` resolves `<specifier>/locale/<language>.json` and
  // `<specifier>/package.json` through the FULL specifier, so a subpath row only
  // carries its own title and icon if `exports` lets both through. Without the
  // locale entry the row silently falls back to the package name; without the
  // manifest entry it loses the icon.
  assert.equal(manifest.exports['./tool'], './tool/index.js')
  assert.equal(manifest.exports['./tool/package.json'], './tool/package.json')
  assert.equal(manifest.exports['./tool/locale/*.json'], './tool/locale/*.json')
  assert.ok(fs.existsSync(path.join(toolRoot, 'index.js')))
  assert.ok(fs.existsSync(path.join(toolRoot, 'locale', 'zh.json')))
  assert.ok(fs.existsSync(path.join(toolRoot, 'icon.svg')))
  // Both are shipped, or an install would lose the row's label.
  assert.ok(manifest.files.includes('tool'), 'the subpath must be published')
})

check('the tool subpath declares no bundle and no client half', () => {
  // The Plugins screen lists profile dependencies that ARE bundles, and installs
  // one entry. Declaring no `dsh.bundle` is what keeps that list at one entry;
  // declaring no `dsh.client` is what keeps the composer at one switch.
  assert.equal(toolManifest.dsh, undefined, 'the subpath must declare no dsh block')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
})

check('each row can describe itself, so the two rows are not identical', () => {
  // Regression: two rows naming ONE specifier rendered as two entries with the
  // same title and description, because the Plugins screen titles a row with the
  // metadata of the specifier it names (`packages.metaOf`). A subpath carries its
  // own locale directory, which is what lets a row say what it is.
  const frontZh = JSON.parse(read('locale/zh.json'))
  const frontTitle = frontZh.meta.title
  const toolTitle = toolZh.meta.title
  assert.ok(typeof frontTitle === 'string' && frontTitle.length > 0)
  assert.ok(typeof toolTitle === 'string' && toolTitle.length > 0)
  assert.notEqual(toolTitle, frontTitle, 'the two rows would read identically')
  assert.notEqual(toolZh.meta.description, frontZh.meta.description, 'their descriptions must differ too')
})

check('the switch toggles the TOOL ROW, never the bundle list', () => {
  // Regression. The client half is discovered from THIS package's Loader row, so
  // a switch that disabled its own row (or removed its own bundle) would delete
  // the entry the switch is served from — off would be a one-way door with no
  // way back. Toggling the OTHER row also keeps `dsh.profile.bundles` untouched,
  // so no reconciliation pass can prune the switch away.
  assert.ok(client.includes("const TOOL_ROW = 'image-openai-tool'"))
  assert.ok(client.includes('setPluginEnabled('), 'the row switch is the supported write')
  assert.ok(!client.includes('setBundleEnabled('), 'the bundle list must not be touched')
  assert.ok(!/const TOOL_ROW = 'dsh-image-openai'/.test(client), 'the switch must not toggle its own package')
  // The patch declares both rows' ids, so the `patchId` is the only identity
  // that tells the tool row from the page row.
  assert.ok(client.includes('item.patchId === TOOL_ROW'))
})

check('the row id the client toggles is the row id the patch declares', () => {
  // Client and host are separate module graphs: the client cannot import the
  // host's constant, so the two spellings are pinned here. If they drift the
  // switch finds no row at all and reports "row missing" forever.
  const declared = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map((match) => match[1])
  const clientRow = /const TOOL_ROW = '([^']+)'/.exec(client)[1]
  const hostRow = /export const TOOL_ROW = '([^']+)'/.exec(host)[1]
  assert.ok(declared.includes(clientRow), `the client toggles ${clientRow}, which the patch does not declare`)
  assert.equal(clientRow, hostRow, 'the two halves disagree about the tool row id')
  assert.equal(clientRow, 'image-openai-tool')
})

console.log('route contract')

check('the route and header are spelled identically in both halves', () => {
  // Client and host are separate module graphs with no shared import, so the
  // two spellings are asserted equal here — otherwise this feature 404s.
  const route = /const ROUTE_BASE = '([^']+)'/.exec(host)[1]
  const header = /const HEADER = '([^']+)'/.exec(host)[1]
  assert.ok(client.includes(`const ROUTE = '${route}'`), `client route must be ${route}`)
  assert.ok(client.includes(`const HEADER = '${header}'`), `client header must be ${header}`)
})

check('every route the host handles is one the client calls', () => {
  const handled = new Set([...host.matchAll(/route === '(\/[a-z]+)'/g)].map((match) => match[1]))
  const called = new Set([...client.matchAll(/call\('(\/[a-z]+)'/g)].map((match) => match[1]))
  for (const path of called) assert.ok(handled.has(path), `client calls ${path}, host does not handle it`)
  assert.ok(handled.has('/settings'))
  assert.ok(handled.has('/generate'))
})

check('both the exact route and its prefix are registered', () => {
  assert.ok(host.includes("kind: 'exact'"))
  assert.ok(host.includes("kind: 'prefix'"))
})

check('the custom header gates every request', () => {
  const gate = host.indexOf('missing ${HEADER} header')
  assert.ok(gate > 0)
  // The gate must run before any route is dispatched.
  assert.ok(gate < host.indexOf("route === '/settings'"))
})

check('the handler derives its own sub-path, because the server passes only (req, res)', () => {
  // webServer invokes `route.handler(req, res)`; a handler that expects a third
  // pathname argument would receive undefined and 404 every request.
  assert.ok(/const handler = \(req, res\)/.test(host))
  assert.ok(host.includes('routePath(req)'))
  assert.ok(host.includes('function routePath('))
})

check('the four spellings the client uses all resolve to a handled route', () => {
  const routePath = (url) => {
    const rest = url.slice('/dsh-image-openai'.length).replace(/\/+$/, '')
    return rest === '' ? '/' : rest
  }
  assert.equal(routePath('/dsh-image-openai/settings'), '/settings')
  assert.equal(routePath('/dsh-image-openai/generate'), '/generate')
  assert.equal(routePath('/dsh-image-openai'), '/')
  assert.equal(routePath('/dsh-image-openai/'), '/')
})

check('the route base is stripped exactly once', () => {
  // Regression: `dispatch` hands `handle` an already-stripped sub-path, so a
  // second slice inside `handle` turned "/settings" into "ttings" and every
  // request 404'd. Count the strip sites; there must be one.
  const strips = [...host.matchAll(/slice\(ROUTE_BASE\.length\)/g)]
  assert.equal(strips.length, 1, `ROUTE_BASE is stripped ${strips.length} times`)
  assert.ok(/async function handle\(ctx, \w+, req, res, route\)/.test(host))
})

console.log('settings')

check('the settings route answers from the document it just read', () => {
  // The panel was fed from a cached `state.stored` while the route's own `stored`
  // field carried a fresh read. On a page opened before the boot-time warm-up
  // landed the cache was empty, so the panel got the row config alone — an empty
  // form that read as "my save did not persist" while the document was on disk.
  // `test/storage.mjs` drives the real handler for this; this is the cheap guard
  // against reintroducing the cache.
  assert.ok(!/state\.stored/.test(host) || /state\.stored`/.test(host), 'no settings cache may be consulted')
  assert.ok(/const state = \{ config: config \?\? \{\} \}/.test(host), 'the row state carries the config only')
  assert.match(host, /const stored = await readSettings\(ctx\)[\s\S]{0,200}describeSelection\(ctx, state, stored\)/, 'the freshly read document must be the one described')
  assert.match(host, /function describeSelection\(ctx, state, stored\)/, 'and describeSelection must take it as an argument')
  // And the boot-time warm-up must wait for the service to exist: at apply time
  // the profile has usually not mounted its storage yet, so a read issued then
  // warms nothing.
  assert.match(host, /ctx\.inject\(\['storageDomain'\][\s\S]{0,240}readSettings\(scope\)/, 'the warm-up belongs behind an injection')
})

check('the size defaults to auto, in code and in the shipped patch', async () => {
  const module = await import(path.join(root, 'src/index.js'))
  // `auto` is what an absent size means anyway — the one image generated so far
  // came back 1024x1536 for a portrait prompt with no size configured. Naming it
  // makes the behaviour visible instead of hiding it in an empty box.
  assert.equal(module.SETTINGS_DEFAULTS.size, 'auto', 'the code default must be auto')
  assert.equal(module.mergeSettings({}, {}).size, 'auto', 'nothing configured still means auto')
  assert.equal(module.mergeSettings({}, { size: '512x512' }).size, '512x512', 'a stored size must win over the default')
  assert.equal(module.mergeSettings({ size: '1024x1536' }, {}).size, '1024x1536', 'the row config must win over the default')
  // Shipped too, so the profile shows the intended default rather than an empty
  // field that only the code knows the meaning of.
  assert.match(patch, /- id: image-openai\n      name: 'dsh-image-openai'\n      config:\n        size: auto/, 'the bundle patch must declare the default')
  // And the box says so, without a sentence underneath it.
  assert.match(client, /field\(copy\.size, 'size', \{ placeholder: 'auto' \}\)/, 'the size field must show its default')
  assert.ok(!/field\(copy\.size, 'size', \{ placeholder: '1024x1024' \}\)/.test(client), 'the old placeholder implied a default that was never sent')
})

check('a size is a WIDTHxHEIGHT pair, and blank means "use the configured default"', async () => {
  const module = await import(path.join(root, 'src/index.js'))
  assert.equal(module.parseCallSize('1024x1024'), '1024x1024')
  assert.equal(module.parseCallSize(' 1536 × 1024 '), '1536x1024', 'spaces and a multiplication sign are tolerated')
  assert.equal(module.parseCallSize('3592X1280'), '3592x1280', 'case is not part of a size')
  assert.equal(module.parseCallSize('auto'), 'auto')
  // Blank is a model declining to choose, not a request for a size of "".
  assert.equal(module.parseCallSize(''), undefined)
  assert.equal(module.parseCallSize('   '), undefined)
  assert.equal(module.parseCallSize(undefined), undefined)
  assert.throws(() => module.parseCallSize('huge'), /is not a WIDTHxHEIGHT pair/, 'a wrong size must be refused, not guessed')
})

check('normalizeSettings trims strings and drops non-positive numbers', async () => {
  const module = await import(path.join(root, 'src/index.js'))
  const value = module.normalizeSettings({
    provider: '  max66  ',
    model: ' gpt-image-1 ',
    n: '2',
    timeoutMs: -5,
    junk: 'ignored'
  })
  assert.equal(value.provider, 'max66')
  assert.equal(value.model, 'gpt-image-1')
  assert.equal(value.n, 2)
  assert.equal(value.timeoutMs, undefined)
  assert.equal(value.junk, undefined)
})

check('normalizeSettings survives a null row', async () => {
  const module = await import(path.join(root, 'src/index.js'))
  assert.equal(module.normalizeSettings(null).provider, '')
})

check('mergeSettings lets a stored value win over the plugin config', async () => {
  const module = await import(path.join(root, 'src/index.js'))
  const merged = module.mergeSettings(
    { provider: 'from-config', model: 'from-config', size: '' },
    { provider: '', model: 'from-store', size: '512x512' }
  )
  assert.equal(merged.provider, 'from-config')
  assert.equal(merged.model, 'from-store')
  assert.equal(merged.size, '512x512')
})

console.log('credentials document')

check('parses the flow-mapping spelling', async () => {
  const module = await import(path.join(root, 'src/index.js'))
  const refs = module.parseCredentialRefs('version: 1\nrefs:\n  { MAX66_API_KEY: sk-abc, OPENAI_API_KEY: sk-def }\n')
  assert.equal(refs.MAX66_API_KEY, 'sk-abc')
  assert.equal(refs.OPENAI_API_KEY, 'sk-def')
})

check('parses the block-mapping spelling and stops at the next top-level key', async () => {
  const module = await import(path.join(root, 'src/index.js'))
  const refs = module.parseCredentialRefs('refs:\n  A_KEY: sk-1\n  B_KEY: "sk-2"\nrecords:\n  C_KEY: not-a-credential\n')
  assert.equal(refs.A_KEY, 'sk-1')
  assert.equal(refs.B_KEY, 'sk-2')
  assert.equal(refs.C_KEY, undefined)
})

check('returns nothing for a document with no refs block', async () => {
  const module = await import(path.join(root, 'src/index.js'))
  assert.deepEqual(module.parseCredentialRefs('version: 1\nrecords: {}\n'), {})
})

console.log('tool registration')

check('the tool definition is built without defineTool', () => {
  // Regression, and the reason the model reported no image tool. `defineTool` is
  // a module export of `@deepseek-ai/dsh-tools`, and an out-of-tree plugin cannot
  // import it: bare specifiers resolve from the profile directory (which holds no
  // `@deepseek-ai/*`), and a symlink into the app archive fails in Node's ESM
  // package resolver, which cannot see inside an asar. The registry consumes
  // `parameters` as JSON Schema regardless — `schemaOf` snapshots it verbatim —
  // so the compiled form is written out here and proven equal by
  // test/tool-schema.mjs.
  assert.ok(host.includes("const TOOL_NAME = 'generate_image'"))
  assert.ok(host.includes('TOOL_PARAMETERS'), 'the argument schema must be a named constant')
  assert.ok(host.includes('TOOL_OUTPUT_SCHEMA'), 'the output schema must be a named constant')
  assert.ok(!/defineTool\(/.test(host), 'defineTool is unreachable from a plugin; do not pretend otherwise')
  assert.ok(!host.includes("'dsh-tools'"), 'there is no `dsh-tools` service — that guess produced a silent no-op')
  assert.ok(/output:\s*\{\s*schema: TOOL_OUTPUT_SCHEMA/.test(host), 'the output schema must be the compiled one')
  assert.ok(host.includes('render:'), 'a tool must declare output.render')
  assert.ok(/export\s*\{[\s\S]*registerTool/.test(host), 'registerTool must be exported for the tool layer')
})

check('the schema constants are compiled JSON Schema, not the DSL', () => {
  // The DSL spelling (`required: true` inside a property) is not JSON Schema;
  // `tools.register` rejects it outright, which would leave the tool unregistered.
  const parameters = /const TOOL_PARAMETERS = \{([\s\S]*?)\n\}/.exec(host)
  const output = /const TOOL_OUTPUT_SCHEMA = \{([\s\S]*?)\n\}/.exec(host)
  assert.ok(parameters !== null && output !== null, 'both schemas must be declared')
  for (const [label, body] of [['parameters', parameters[1]], ['output', output[1]]]) {
    assert.ok(/type: 'object'/.test(body), `${label} must be an object schema`)
    assert.ok(/required: \[/.test(body), `${label} must use the JSON Schema required ARRAY`)
    assert.ok(!/required: true/.test(body), `${label} still uses the DSL spelling`)
  }
})

check('a tool that cannot register says so instead of failing silently', () => {
  // The original defect was inaudible: the row activated, nothing logged, and the
  // model simply had no tool. Every early exit must announce itself.
  assert.ok(/ctx\.logger\?\.warn\?\./.test(host), 'the failure must be logged')
  assert.ok(/generate_image was not registered/.test(host), 'the log must name the tool')
  assert.ok(/function toolsService\(ctx\)/.test(host), 'the service lookup must be shared, not inlined')
  assert.ok(/typeof candidate\.register === 'function'/.test(host), 'the registry must be shape-checked')
})

check('registration is owned by an effect and the row declares its dependency', () => {
  assert.ok(host.includes('ctx.effect('), 'registrations must be effect-owned')
  assert.ok(host.includes("ctx.get('tools')"), 'the named lookup is the fallback for the property form')
  // The tool row injects `tools`, so a profile without it leaves the row inactive
  // rather than half-applied — the documented form for a required service.
  assert.ok(/export const inject = \['tools'\]/.test(toolHost), 'the tool row must declare inject')
  assert.ok(!/export const inject/.test(host), 'the page half needs no service to serve its routes')
})

check('the route handler answers a missing service instead of throwing', () => {
  // registerRoutes must not assume webServer exists (a terminal profile has none).
  assert.ok(host.includes("ctx.get('webServer')"))
  assert.ok(host.includes('ctx.inject('))
})

check('neither half provides a context service', () => {
  // Regression: `ctx.set(name, value)` only OVERWRITES an already-provided
  // service, so using it to publish a new one aborts activation with
  // `cannot set property "dsh-image-openai" without provide` — the whole plugin
  // goes dark, taking the routes and the switch with it. Shared state travels as
  // a closure argument instead.
  for (const [label, source] of [['page', host], ['tool', toolHost]]) {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.ok(!/ctx\.set\(/.test(code), `${label}: ctx.set must not publish a service`)
    assert.ok(!/ctx\.provide\(/.test(code), `${label}: needs no service of its own`)
    assert.ok(/function apply\(ctx, config\)/.test(code), `${label}: must export apply`)
  }
  assert.ok(/registerRoutes\(ctx, state\)/.test(host), 'state must reach the routes')
  // Match a CALL STATEMENT, not the `function registerTool(ctx, state)`
  // definition the page still exports for the tool subpath to import.
  assert.ok(!/^\s*registerTool\(ctx, state\)/m.test(host), 'the page must not register the tool')
  assert.ok(/^\s*registerTool\(ctx, state\)/m.test(toolHost), 'the tool subpath must register it')
})

console.log('settings storage')

check('the settings domain is declared and opened by this plugin', () => {
  // Regression, and the bug this section exists for. A storage domain is NOT
  // mounted by profile configuration: the consumer declares it and calls
  // `storageDomain.open(spec)`. The plugin instead read `storageDomain.get(…)`
  // first, found nothing, and reported `storage domain "dsh_image_openai" is not
  // mounted` — a message it was inventing from a wrong mental model, so the
  // diagnostics pointed at the profile instead of at the plugin.
  assert.ok(/const DOMAIN_SPEC = \{[\s\S]*?name: DOMAIN[\s\S]*?version: 1[\s\S]*?tables: \{ \[TABLE\]/.test(host), 'the domain must be declared')
  assert.ok(host.includes('facility.open(DOMAIN_SPEC)'), 'the consumer must open it')
  assert.ok(host.includes('typeof facility.open !=='), 'the service must be probed, not assumed')
  const code = host.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/is not mounted/.test(code), 'the wrong mental model must not come back in a thrown message')
})

check('one open is shared, because this package activates twice', () => {
  // Both the page row and the tool row activate this module, and `open()` refuses
  // a second open of one name (`already-open`, "domain '…' is already open"), so
  // the in-flight promise is shared rather than raced.
  assert.ok(host.includes('const openDomains = new WeakMap()'))
  assert.ok(/openDomains\.get\(facility\)/.test(host))
  assert.ok(/openDomains\.set\(facility/.test(host))
  assert.ok(/openDomains\.delete\(facility\)/.test(host), 'a failed open must not be cached and replayed')
  assert.ok(/facility\.get\(DOMAIN\)/.test(host), 'a sibling may already have opened it')
})

check('a read degrades and a write fails loudly', () => {
  // Losing a preference must never break a generation; reporting a save that did
  // not happen would be worse than refusing it.
  assert.ok(/await settingsDomain\(ctx, false\)/.test(host), 'the read path is the tolerant one')
  assert.ok(/await settingsDomain\(ctx, true\)/.test(host), 'the write path is the strict one')
  assert.ok(/no storage domain, so settings cannot be saved/.test(host))
  assert.ok(/cannot open the settings store/.test(host))
  assert.ok(/table\.get\(SETTINGS_KEY\)/.test(host), 'reads come off the open domain')
  assert.ok(/table\.put\(SETTINGS_KEY, value\)/.test(host))
})

check('the spec matches what the storage layer actually reads', () => {
  // name, version, table names and each table's valueSchema are the whole
  // contract; `layout` is omitted, which the JSON backend reads as `single` —
  // right for one settings row.
  assert.ok(/valueSchema: SETTINGS_SCHEMA/.test(host))
  assert.ok(/parse: \(raw\) => normalizeSettings\(raw\)/.test(host))
  assert.ok(host.includes('safeParse:'), 'the zod contract needs both methods')
  assert.ok(!/layout:/.test(host), 'an absent layout is what one settings document wants')
})

console.log('client half')

check('both Remote answers are unwrapped from their envelope', () => {
  // Regression: a Remote call answers `{ ok, value }`, so reading the result as
  // the payload made `.find` blow up with "bundles.find is not a function" and
  // made a refused toggle look like a success.
  assert.ok(client.includes('answer?.ok'), 'the envelope must be checked')
  assert.ok(client.includes('answer.value ?? []'), 'the bundle array lives under .value')
  assert.ok(client.includes('answer.value?.application'), 'the application outcome lives under .value')
  assert.ok(!/const bundles = await/.test(client), 'the envelope must not be treated as the array')
  assert.ok(client.includes('remoteMessage('), 'a refused envelope must be reported')
})

check('the envelope error shape matches the real RemoteResult', () => {
  // The shipped Plugin Manager reads `answer.error.message`.
  assert.ok(client.includes('answer?.error?.message'))
})

check('a restart-required toggle is shown as pending, not as applied', () => {
  // Only `failed` is an error, but `restart-required` is not "done" either: on a
  // profile without HMR it is the ONLY outcome, so reporting it as applied told
  // the user the tool was live when the model still could not see it. The switch
  // now distinguishes the two, and the pending face keeps the four characters.
  assert.ok(/application === 'failed'/.test(client), 'a failed activation is still the error case')
  assert.ok(/application === 'restart-required'/.test(client), 'the pending outcome must be detected')
  assert.ok(/data-pending/.test(client), 'the pending state must be visible, not only in the tooltip')
  assert.ok(/pendingHint/.test(client), 'the tooltip must explain WHY it is not live yet')
  const zh = /pending: '生成图片：重启后生效'/.test(client)
  const en = /pending: 'Generate image: applies after a restart'/.test(client)
  assert.ok(zh && en, 'both dictionaries must name the pending state')
})

check('an input image switches the call to the edit endpoint', () => {
  // The whole point of the `image` parameter: its presence selects
  // `POST /images/edits`, its absence keeps text-to-image. Both endpoints must
  // stay reachable from the same operation.
  assert.ok(/images\/generations/.test(host), 'the text-to-image endpoint must remain')
  assert.ok(/images\/edits/.test(host), 'the edit endpoint must exist')
  assert.ok(/const editing = image !== undefined/.test(host), 'the input image must select the endpoint')
  assert.ok(/image: \{\s*\n\s*type: 'string'/.test(host), 'the tool must accept an image path')
  assert.ok(host.includes('readInputImage(input?.image, cwd)'), 'the path must resolve against the working directory')
})

check('the edit call is multipart, with the boundary left to fetch', () => {
  // Writing `content-type: multipart/form-data` by hand omits the boundary and
  // the provider cannot parse the form — it looks right and always fails.
  assert.ok(/body = editForm\(settings, prompt, image\)/.test(host), 'the edit body must be built by editForm')
  assert.ok(/new FormData\(\)/.test(host), 'the edit body must be a FormData')
  assert.ok(/new Blob\(\[image\.bytes\], \{ type: image\.mimeType \}\)/.test(host), 'the file must be uploaded as bytes')
  const editBranch = /if \(editing\) \{([\s\S]*?)\n  \} else \{/.exec(host)
  assert.ok(editBranch !== null, 'the two bodies must be a single branch')
  // Comments explain why it is omitted, so only live code is inspected.
  const editCode = editBranch[1].replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/content-type/.test(editCode), 'the edit branch must not set content-type itself')
  assert.ok(/headers\['content-type'\] = 'application\/json'/.test(host), 'only the JSON branch sets it')
})

check('the input image is typed by its bytes and capped', () => {
  // The multipart filename is what the provider inspects, so the upload is
  // relabelled from the magic bytes rather than the file extension.
  for (const signature of ['0x89', 'bytes[1] === 0xd8', 'RIFF', 'GIF8']) {
    assert.ok(host.includes(signature), `the sniff must recognise ${signature}`)
  }
  assert.ok(/MAX_INPUT_IMAGE_BYTES/.test(host), 'a runaway file must be refused, not read into memory')
  assert.ok(/input image not found:/.test(host), 'a bad path must fail before the provider call')
  assert.ok(/input image must be PNG, JPEG, WebP or GIF/.test(host), 'an unsupported type must say which are allowed')
  assert.ok(/given === ''\) return undefined/.test(host), 'an empty argument means "no image", not an error')
})

check('style is not sent to the edit endpoint', () => {
  // `style` belongs to text-to-image (DALL·E 3). An unsupported field is the
  // fastest way to have a gateway reject the whole request.
  const form = /function editForm\(settings, prompt, image\) \{([\s\S]*?)\n\}/.exec(host)
  assert.ok(form !== null, 'editForm must exist')
  assert.ok(!/style/.test(form[1]), 'editForm must not send style')
  assert.ok(/extraJson/.test(form[1]), 'a provider needing more can still be served by extraJson')
})

check('a provider without the edit route is named in the failure', () => {
  assert.ok(/does not implement \/images\/edits/.test(host), 'a 404 on edits must point at the endpoint')
})

check('credentials resolve through the harness seam, not a guessed API', () => {
  // The seam answers `resolve(ref)` with `{ value, source }`. This plugin first
  // called `credentials.get(name)`, which does not exist: the probe found a
  // service with no such method, skipped the seam in silence, and then failed on
  // its own fallback. `test/credential.mjs` now asserts, against the REAL
  // provider, that `get` is absent and `resolve` is what answers.
  assert.ok(/typeof credentials\.resolve === 'function'/.test(host), 'the seam must be probed by its real method')
  assert.ok(/await credentials\.resolve\(name\)/.test(host), 'the seam must be asked to resolve the reference')
  assert.ok(/hit\?\.value/.test(host), 'the answer is an envelope: { value, source }')
  assert.ok(!/credentials\.get\(/.test(host), 'credentials.get() does not exist — do not reintroduce it')
  // The seam is tried before the process environment, matching the documented
  // precedence (launch environment over the managed document, with .env layers).
  assert.ok(host.indexOf('credentials.resolve(name)') < host.indexOf('const fromEnv = process.env[name]'), 'the seam must precede the environment')
})

check('the harness home falls back to ~/.dsh when DSH_HOME is unset', () => {
  // The desktop host runs with HOME only — no DSH_HOME. A second implementation
  // that insisted on the variable is what made a configured key read as missing.
  assert.ok(/function dshHome\(\)/.test(host), 'the home must have one definition')
  const body = /function dshHome\(\) \{([\s\S]*?)\n\}/.exec(host)
  assert.ok(body !== null, 'dshHome must exist')
  assert.ok(/process\.env\.DSH_HOME/.test(body[1]), 'the variable is preferred when set')
  assert.ok(/process\.env\.HOME/.test(body[1]), 'and HOME is the fallback')
  // No third place may read either variable directly.
  const readers = [...host.matchAll(/process\.env\.(DSH_HOME|HOME)/g)]
  assert.equal(readers.length, 2, `only dshHome may read the home variables, found ${readers.length} reads`)
  assert.ok(/path\.join\(dshHome\(\), 'dsh-image-openai'\)/.test(host), 'the default output directory must share the resolver')
})

check('the credential field offers no advice and never shows a value', () => {
  // The field used to carry a sentence explaining that empty means "use the
  // selected provider's key". It was removed: the box is a reference, the
  // provider's own name is already the grey placeholder, and a paragraph under
  // every field is noise. What must stay true is the part that is not cosmetic —
  // the value itself never reaches the browser.
  assert.ok(!/credentialNote|keyProvider|dsio-note/.test(client), 'the hint must be gone, not merely hidden')
  assert.ok(/apiKeyEnv: '密钥引用（留空即可）'/.test(client), 'the label still says it can be left empty')
  assert.ok(!/credentials?\.(get|read|resolve)\(/.test(client), 'the client must never fetch a credential value')
})

check('the switch calls the real Remote namespace through a bare property access', () => {
  // The shipped Plugin Manager calls `ctx.remote.pluginManager.setPluginEnabled`.
  // Awaiting the namespace (`await ctx.remote.pluginManager`) would break it.
  assert.ok(client.includes('ctx.remote.pluginManager.listPlugins()'))
  assert.ok(client.includes('ctx.remote.pluginManager.setPluginEnabled(row.entryId, next)'))
  // Only a BARE namespace await is wrong; awaiting a method call on it is fine.
  assert.ok(
    !/await\s+ctx\.remote\.pluginManager\s*[\n;)]/.test(client),
    'the namespace is a property, not a promise'
  )
})

check('the plugin declares the remote namespace it needs, so it stays inert without one', () => {
  assert.ok(/inject:\s*\[[^\]]*'remote\.pluginManager'/.test(client))
})

check('every dotted service is inject-declared segment by segment', () => {
  // Regression: naming only the leaf (`remote.pluginManager`) throws
  // `cannot get property "remote" without inject` at first access, because
  // Cordis resolves each property through its own inject entry. The shipped
  // Plugin Manager declares `remote` and `remote.pluginManager` side by side.
  const declared = new Set(
    (/inject:\s*\[([^\]]*)\]/.exec(client)[1].match(/'[^']+'/g) ?? []).map((s) => s.slice(1, -1))
  )
  // Context built-ins: these are always present and are not services.
  const BUILT_IN = new Set(['get', 'set', 'on', 'effect', 'inject', 'provide', 'emit', 'waterfall', 'parallel', 'bail', 'start', 'stop', 'scope', 'isolate'])
  const accessed = new Set([...client.matchAll(/ctx\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g)].map((m) => m[1]))
  for (const path of accessed) {
    if (path === 'slots' || path.startsWith('slots.')) continue
    const segments = path.split('.')
    if (BUILT_IN.has(segments[0])) continue
    // Check every prefix along the chain: remote.pluginManager.listBundles
    // needs `remote` and `remote.pluginManager`, never the method name.
    for (let i = 0; i < segments.length; i += 1) {
      const prefix = segments.slice(0, i + 1).join('.')
      if (declared.has(prefix)) continue
      // The deepest segment is a method on the declared namespace, not a service.
      if (declared.has(segments.slice(0, i).join('.'))) break
      assert.fail(`ctx.${prefix} is accessed but "${prefix}" is not in inject (declared: ${[...declared].join(', ')})`)
    }
  }
})

check('the locale snapshot is read through its real getSnapshot/subscribe pair', () => {
  assert.ok(client.includes('useSyncExternalStore'))
  assert.ok(client.includes('locale.getSnapshot()'))
  assert.ok(client.includes('locale.subscribe('))
})

check('the client reaches services as properties, not through ctx.get', () => {
  // A Cordis context resolves services through its proxy, so `ctx.locale` works
  // and `ctx.get('locale')` returns undefined on the client side. Reading the
  // locale that way silently pinned the row to English.
  const uses = [...client.matchAll(/ctx\.get\??\.\(/g)]
  assert.equal(uses.length, 1, `ctx.get used ${uses.length} times; only the locale fallback is allowed`)
  assert.ok(client.includes('ctx.locale ??'), 'the primary locale read must be a property access')
})

check('the switch registers into the composer tool row, beside the permission picker', () => {
  // `conversation.composer.dock` is the ambient strip BELOW the card, where the
  // token rate and the context meter live — the switch was there and was asked
  // to move. `conversation.input.left` is the left group of the composer's own
  // tool row, which is the row holding the permission picker and the model
  // picker, i.e. the controls it belongs with.
  const slot = /const SLOT = '([^']+)'/.exec(client)[1]
  assert.equal(slot, 'conversation.input.left')
  assert.ok(!client.includes("'conversation.composer.dock'"), 'the ambient strip must no longer host the switch')
  assert.ok(client.includes('ctx.slots.inject(SLOT'))
  assert.ok(client.includes('ctx.slots.register('))
  // It shares the row with the shipped permission control, so it must not draw
  // a padded full-width box of its own.
  assert.ok(client.includes('dsio-inline'), 'the inline container is what fits the tool row')
  assert.ok(!client.includes('dsio-wrap'), 'the old full-width container must be gone')
})

check('the settings page hangs on this bundle row, on the Plugins screen', () => {
  // `plugins.item` is the wrong slot: its contract reserves it for the official
  // settings pages and routes a bundle's configuration to `plugins.row.config`.
  assert.ok(client.includes("const CONFIG_SLOT = 'plugins.row.config'"), 'must use the row-config slot')
  assert.ok(!client.includes("'plugins.item'"), 'plugins.item is reserved for official settings pages')
  // Keyed `<package name>#<row id>`, exactly as rowConfigKey() spells it.
  assert.equal(/const CONFIG_KEY = '([^']+)'/.exec(client)[1], `${manifest.name}#image-openai`)
  assert.ok(client.includes('key: CONFIG_KEY'))
})

check('the composer row holds only the switch, not the settings', () => {
  // The panel under the composer was removed on purpose: the settings have one
  // home, the row's page on the Plugins screen.
  assert.ok(!client.includes('dsio-panel'), 'the old inline panel must be gone')
  assert.ok(!/copy\.settings\b/.test(client), 'the composer row must not offer a settings button')
  assert.ok(client.includes('ImageSettingsPage'), 'the settings component must exist')
})

check('the settings page answers both views the owner asks for', () => {
  // The same entry is rendered twice: `summary` as the row's one-liner and
  // `page` as the body of the row's own page.
  assert.ok(/view === 'summary'/.test(client))
  assert.ok(client.includes("view: props.view ?? 'page'"))
})

check('registers with an id and an order so it cannot collide with the shipped owner', () => {
  assert.ok(/id:\s*'dsh-image-openai'/.test(client))
  assert.ok(/order:\s*\d+/.test(client))
})

check('the switch face stays short, and the state lives elsewhere', () => {
  // It shares the composer's tool row with the permission and model pickers, so
  // the face must stay a few characters. The state is still carried by the
  // track's colour and knob position, by aria-checked, and by the tooltip.
  const labels = [...client.matchAll(/^\s*label: '([^']+)',/gm)].map((match) => match[1])
  assert.deepEqual(labels, ['生成图片', 'Generate image'], 'one short face per dictionary')
  // The Chinese face is the four characters that were asked for; the English
  // one cannot be four characters, so it is bounded by words instead.
  assert.equal(labels[0], '生成图片')
  assert.ok(labels[1].split(' ').length <= 2, `the English face is too long: ${labels[1]}`)
  assert.ok(client.includes("h('span', { className: 'dsio-text' }, copy.label)"), 'the face must be the constant label')
  assert.ok(client.includes("'aria-label': state"), 'the accessible name must carry the state')
  assert.ok(client.includes('title: bundle.error === '), 'the tooltip must carry the state or the failure')
})

check('the switch is a real switch for assistive technology', () => {
  assert.ok(client.includes("role: 'switch'"))
  assert.ok(client.includes("'aria-checked'"))
})

check('styling uses only theme tokens, never a literal colour', () => {
  const css = /const CSS = `([\s\S]*?)`/.exec(client)[1]
  const colourLiterals = css.replace(/var\(--dsw-[^)]*\)/g, '').match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) ?? []
  assert.deepEqual(colourLiterals, [], `literal colours in the stylesheet: ${colourLiterals.join(', ')}`)
  assert.ok(css.includes('--dsw-alias-'))
})

check('the stylesheet is removed when the entry unmounts', () => {
  assert.ok(client.includes('tag.remove()'), 'the injected style tag must be cleaned up')
})

check('the module registers through the client-modules protocol', () => {
  assert.ok(client.includes('window.__ModuleLoader__.load({'))
  assert.ok(client.includes("id: 'dsh-image-openai'"))
  assert.ok(client.includes('factory:') || client.includes('factory('))
})

await Promise.all(pending)

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
