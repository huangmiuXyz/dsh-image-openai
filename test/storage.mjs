/**
 * Integration check for the settings store, against the REAL
 * `@deepseek-ai/dsh-storage-domain` facility.
 *
 * This is the test that was missing. The unit checks in `check.mjs` stubbed
 * `storageDomain.get()` to return a domain, so they passed while the plugin was
 * broken: on a real host nothing had ever OPENED the domain — a domain is not
 * mounted by profile configuration, its consumer declares it — so every save
 * failed with `storage domain "dsh_image_openai" is not mounted`, a message the
 * plugin itself was producing from a wrong mental model.
 *
 * So this file exercises the plugin's own `settingsDomain` / `writeSettings` /
 * `readSettings` against the genuine `DomainFacility`, a genuine spec parse, and
 * a genuine table handle. Only the backend unit is faked (an in-memory KV), so
 * the run needs no storage root and no profile.
 *
 * Plain `node` cannot resolve `@deepseek-ai/…` (they live inside the app's
 * asar), so run it through the app's own Node:
 *
 *   ELECTRON_RUN_AS_NODE=1 \
 *     "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     test/storage.mjs
 */

import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh'
const req = createRequire(`${ASAR}/package.json`)
const { DomainFacility } = req('@deepseek-ai/dsh-storage-domain')

const plugin = await import(new URL('../src/index.js', import.meta.url).href)

let failures = 0
const check = async (label, fn) => {
  try {
    await fn()
    console.log(`  ok  ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL  ${label}\n      ${error.message}`)
  }
}

// --- a real facility over a fake in-memory backend ---------------------------

/** An in-memory `kv` facet unit: the only thing faked here. */
const memoryBackend = () => {
  const writes = []
  // Units outlive a single open, so a close + reopen reads what was stored —
  // which is what lets a check seed the medium and watch it be validated.
  const units = new Map()
  return {
    writes,
    units,
    kv: {
      async open(descriptor) {
        if (!units.has(descriptor.name)) units.set(descriptor.name, { tables: new Map(), global: null })
        const unit = units.get(descriptor.name)
        return {
          descriptor,
          async loadAll() {
            return {
              tables: Object.fromEntries([...unit.tables].map(([table, records]) => [table, Object.fromEntries(records)])),
              global: unit.global
            }
          },
          async putRecord(table, key, value) {
            writes.push(`${table}/${key}`)
            if (!unit.tables.has(table)) unit.tables.set(table, new Map())
            unit.tables.get(table).set(key, structuredClone(value))
          },
          async deleteRecord(table, key) {
            return unit.tables.get(table)?.delete(key) ?? false
          },
          async setGlobal(value) { unit.global = structuredClone(value) },
          async close() {}
        }
      }
    }
  }
}

const backend = memoryBackend()

/** A facility over the faked unit, the way the real row builds one. */
const facilityOver = (unit) => new DomainFacility(
  {
    storage: { backend: { get: () => unit } },
    logger: { error() {}, warn() {}, info() {} },
    effect: () => () => {}
  },
  { backend: 'memory' }
)

const facility = facilityOver(backend)

/** A context that serves the facility the way the real one does. */
const ctxOver = (value) => ({ get: (name) => (name === 'storageDomain' ? value : undefined) })
const ctx = ctxOver(facility)

console.log('settings storage (real storage-domain layer)')
await check('the declared spec is accepted and the domain opens', async () => {
  const domain = await plugin.settingsDomain(ctx, true)
  assert.ok(domain !== undefined, 'the domain must open')
  assert.equal(domain.name, plugin.DOMAIN)
  // Opening twice must not throw `already-open`: the promise is shared.
  const again = await plugin.settingsDomain(ctx, true)
  assert.equal(again, domain, 'a second call must reuse the open domain')
})

await check('a missing profile storage degrades reads and fails writes loudly', async () => {
  const bare = { get: () => undefined }
  assert.equal(await plugin.readSettings(bare), undefined, 'a read must degrade, never throw')
  await assert.rejects(
    () => plugin.writeSettings(bare, {}),
    (error) => error.status === 501 && /no storage domain/.test(error.message),
    'a write must say why it cannot save'
  )
})

await check('a stored row round-trips through put and get', async () => {
  const written = await plugin.writeSettings(ctx, { model: 'gpt-image-1', promptPrefix: '画' })
  assert.equal(written.model, 'gpt-image-1')
  assert.deepEqual(backend.writes, [`${plugin.TABLE}/${plugin.SETTINGS_KEY}`], 'one record write, in the declared table')
  const read = await plugin.readSettings(ctx)
  // The domain validates every record through the spec's valueSchema, which is
  // normalizeSettings: unknown keys drop, known ones survive.
  assert.equal(read.model, 'gpt-image-1')
  assert.equal(read.promptPrefix, '画')
})

// --- the settings PANEL, driven through the real request handler -------------
//
// The panel and the store used to be fed from two different reads: the route
// answered its `settings` field out of a cached `state.stored`, while its own
// `stored` field carried the document it had just read. A page opened before the
// boot-time warm-up landed therefore received the row config alone — an empty
// form that read as "my save did not persist" while the document sat on disk the
// whole time. So the request handler is driven directly here.

const fakeRequest = (method, body, route = '/settings') => {
  const handlers = new Map()
  return {
    method,
    // `routePath` reads the URL, so the request has to carry one.
    url: `${plugin.ROUTE_BASE}${route}`,
    headers: { [plugin.HEADER]: '1' },
    on(event, handler) {
      handlers.set(event, handler)
      // `readBody` subscribes to `data` before `end`, and both fire at once here.
      if (event === 'data' && body !== undefined) handler(body)
      if (event === 'end') handler()
      return this
    },
    destroy() {}
  }
}

const fakeResponse = () => {
  const captured = { status: 0, body: undefined }
  return {
    captured,
    res: {
      headersSent: false,
      writeHead(status) { captured.status = status; this.headersSent = true },
      end(text) { captured.body = text === undefined ? undefined : JSON.parse(text) }
    }
  }
}

const askSettings = async (state, method = 'GET', body) => {
  const { captured, res } = fakeResponse()
  await plugin.handle(ctx, state, fakeRequest(method, body), res, '/settings')
  return captured
}

await check('a cold settings request answers with the stored document', async () => {
  await plugin.writeSettings(ctx, { model: 'gpt-image-2.5-sunburst', quality: 'max', size: 'auto' })
  // Cold on purpose: an empty row config and no cache — exactly the state a page
  // sees when it opens right after a restart.
  const captured = await askSettings({ config: {} })
  assert.equal(captured.status, 200)
  assert.equal(captured.body.settings.model, 'gpt-image-2.5-sunburst', 'the panel must be handed what is on disk')
  assert.equal(captured.body.settings.quality, 'max', 'and not the row config')
  assert.equal(captured.body.stored.model, 'gpt-image-2.5-sunburst', 'the two fields must agree')
})

await check('the row config fills only what the document leaves blank', async () => {
  await plugin.writeSettings(ctx, { model: 'gpt-image-2.5-sunburst', outputDir: '' })
  const captured = await askSettings({ config: { outputDir: '/tmp/from-the-row', size: 'auto' } })
  assert.equal(captured.body.settings.model, 'gpt-image-2.5-sunburst', 'a stored value wins')
  assert.equal(captured.body.settings.outputDir, '/tmp/from-the-row', 'a blank field falls back to the row')
  assert.equal(captured.body.settings.size, 'auto', 'and an unset field takes the shipped default')
})

await check('a save is visible to the very next read', async () => {
  // The whole user-visible loop: press save, the panel re-reads, the values are
  // still there.
  const saved = await askSettings({ config: {} }, 'POST', JSON.stringify({ settings: { model: 'made-up-model', promptPrefix: '画' } }))
  assert.equal(saved.status, 200)
  assert.equal(saved.body.stored.model, 'made-up-model')
  const reread = await askSettings({ config: {} })
  assert.equal(reread.body.settings.model, 'made-up-model', 'the panel must see its own save')
  assert.equal(reread.body.settings.promptPrefix, '画')
})

await check('a panel opened right after boot sees the stored settings', async () => {
  // The reported failure, end to end: restart the host, open the settings page,
  // and the saved values are apparently gone. A previous session had written the
  // document; `apply` ran; the page asked.
  //
  // The timing is the whole point: at apply time the profile has NOT mounted its
  // storage yet, so a warm-up issued then reads nothing. The panel, however, is
  // answered from the document the request itself reads — so it is right either
  // way.
  const fresh = memoryBackend()
  const freshFacility = facilityOver(fresh)
  await plugin.writeSettings(ctxOver(freshFacility), { model: 'gpt-image-2.5-sunburst', quality: 'max' })

  const services = { webServer: { register: (route) => { routes.push(route); return () => {} } } }
  const routes = []
  const deferred = []
  const bootCtx = {
    get: (name) => services[name],
    inject: (names, callback) => {
      const run = () => callback({ get: (name) => services[name] })
      if (names.every((name) => services[name] !== undefined)) run()
      else deferred.push(run) // what cordis does when the service appears later
    },
    logger: { warn() {} },
    effect: (fn) => fn(),
    on: () => () => {}
  }

  plugin.apply(bootCtx, {})
  assert.ok(routes.length >= 2, 'the bundle must register its routes')
  services.storageDomain = freshFacility // mounted a moment later, as the profile does

  const ask = async () => {
    const { captured, res } = fakeResponse()
    await routes[0].handler(fakeRequest('GET'), res)
    return captured
  }

  const beforeWarmUp = await ask()
  assert.equal(beforeWarmUp.status, 200)
  assert.equal(beforeWarmUp.body.settings.model, 'gpt-image-2.5-sunburst', 'the panel must show the stored model right after boot')
  assert.equal(beforeWarmUp.body.settings.quality, 'max')

  // And the deferred warm-up landing later must not change the answer.
  for (const run of deferred) run()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const afterWarmUp = await ask()
  assert.equal(afterWarmUp.body.settings.model, 'gpt-image-2.5-sunburst', 'a warm-up must never overwrite what a request reports')
})

await check('a request without the plugin header is refused', async () => {
  const { captured, res } = fakeResponse()
  await plugin.handle(ctx, { config: {} }, { method: 'GET', headers: {} }, res, '/settings')
  assert.equal(captured.status, 403, 'the route is not a bare public endpoint')
})

await check('the stored medium is validated by the spec on open', async () => {
  // `put` writes what it is given; the spec's `valueSchema` runs when a domain
  // LOADS its records at open. So a record the plugin never wrote — a
  // hand-edited medium, or a row left by an older version — must come back
  // through `normalizeSettings` rather than as raw JSON.
  const domain = await plugin.settingsDomain(ctx, true)
  // Seed the medium behind the open domain's back, then reopen it.
  const unit = backend.units.get(plugin.DOMAIN)
  unit.tables.set(plugin.TABLE, new Map([[plugin.SETTINGS_KEY, { model: 'x', nonsense: true }]]))
  await domain.close()

  const reopened = facilityOver(backend)
  const read = await plugin.readSettings(ctxOver(reopened))
  assert.equal(read.model, 'x', 'a known field must survive a reopen')
  assert.equal(read.nonsense, undefined, 'the spec schema must strip unknown keys')
})

await check('the domain name and table satisfy the storage layer name rule', () => {
  // `/^[a-z][a-z0-9_]*$/` — a name outside it throws at spec construction.
  for (const name of [plugin.DOMAIN_SPEC.name, ...Object.keys(plugin.DOMAIN_SPEC.tables)]) {
    assert.match(name, /^[a-z][a-z0-9_]*$/, `${name} is not a legal unit name`)
  }
  assert.ok(Number.isInteger(plugin.DOMAIN_SPEC.version) && plugin.DOMAIN_SPEC.version >= 0)
  assert.equal(typeof plugin.DOMAIN_SPEC.tables[plugin.TABLE].valueSchema.parse, 'function')
})

// --- the same path with NOTHING faked: the real JSON backend on disk ---------

console.log('\nsettings storage (real JSON backend, on disk)')

const { JsonStorageBackend } = req('@deepseek-ai/dsh-storage-json')
const { mkdtemp, readFile, rm } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

const root = await mkdtemp(join(tmpdir(), 'dsh-image-openai-'))
const realBackend = new JsonStorageBackend(root)
const realCtx = ctxOver(facilityOver(realBackend))

await check('a saved row reaches disk and comes back after a full reopen', async () => {
  await plugin.writeSettings(realCtx, { model: 'gpt-image-1', size: '1024x1024', promptPrefix: '画一只猫' })
  // A backend unit has exactly one live handle ("unit '…' is already open"), so
  // the reopen that proves durability needs the first domain closed first.
  await (await plugin.settingsDomain(realCtx, true)).close()
  const reopened = ctxOver(facilityOver(realBackend))
  const read = await plugin.readSettings(reopened)
  assert.ok(read !== undefined, 'the reopen must find the domain')
  assert.equal(read.model, 'gpt-image-1', 'the model must survive a reopen')
  assert.equal(read.promptPrefix, '画一只猫', 'non-ASCII must survive a reopen')
})

await check('the medium is the domain file the spec declares', async () => {
  const file = join(root, `${plugin.DOMAIN}.json`)
  const parsed = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(parsed.unit.name, plugin.DOMAIN)
  assert.equal(parsed.unit.version, plugin.DOMAIN_SPEC.version)
  assert.equal(parsed.tables[plugin.TABLE][plugin.SETTINGS_KEY].model, 'gpt-image-1')
})

await rm(root, { recursive: true, force: true })

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
