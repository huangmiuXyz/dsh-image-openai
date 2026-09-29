/**
 * Resolves credentials through the REAL credential provider.
 *
 * This file exists because the plugin got this wrong twice over, and neither
 * mistake was visible to any other suite:
 *
 * 1. it called `credentials.get(name)`, which does not exist — the seam answers
 *    `resolve(ref)` with `{ value, source } | undefined`. The wrong name meant the
 *    seam was silently skipped, and a stubbed service in a unit test cannot
 *    notice a method that is never called.
 * 2. its fallback insisted on `$DSH_HOME`, and the desktop host runs WITHOUT that
 *    variable (only `HOME`), so it gave up and reported "credential is not set"
 *    for a key sitting in `~/.dsh/.credentials.yaml`.
 *
 * So the provider is mounted for real — `@deepseek-ai/dsh-credentials-local`,
 * over a throwaway document with a fake key — and the plugin has to prove it
 * found it, all the way to the `authorization` header of a provider call. The
 * user's own credentials file is never read: a fake key is written to a temp
 * directory, so a failure message cannot leak a real one.
 *
 * Needs the app's Node to resolve `@deepseek-ai/*`:
 *
 *   ELECTRON_RUN_AS_NODE=1 \
 *     "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     test/credential.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh'
const req = createRequire(`${ASAR}/package.json`)
const cordis = req('@deepseek-ai/cordis')
const LocalCredentialProvider = req('@deepseek-ai/dsh-credentials-local').default

const plugin = await import(new URL('../src/index.js', import.meta.url).href)

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

const tick = () => new Promise((resolve) => setTimeout(resolve, 60))

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-image-openai-cred-'))
const FAKE_KEY = 'sk-test-2f4d9c1b7a5e8f3d6c0b9a8e7d6c5b4a3'

/** A credentials document in the shape the product writes: `refs` by env name. */
const writeCredentials = async (file, refs) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const body = ['version: 1', 'refs:']
  for (const [name, value] of Object.entries(refs)) body.push(`  ${name}: ${value}`)
  body.push('records: {}', '')
  // 0600: the provider refuses a document any other user could read.
  await fs.writeFile(file, body.join('\n'), { mode: 0o600 })
}

/** Mount the real provider over `file` and return a context that reaches it. */
const mountProvider = async (file) => {
  const root = new cordis.Context()
  root.plugin(LocalCredentialProvider, { path: file })
  await tick()
  const service = root.get('credentials')
  assert.ok(service !== undefined, 'the real credential provider must activate')
  return { root, service }
}

/** Run one provider call with `fetch` stubbed, and report the headers sent. */
const callWith = async (ctx, config = {}) => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ data: [{ b64_json: 'AAAA' }] }),
      arrayBuffer: async () => new ArrayBuffer(0)
    }
  }
  try {
    await plugin.generateImages(
      ctx,
      { config: { baseURL: 'http://images.invalid/v1', model: 'm', outputDir: workspace, ...config }, stored: undefined },
      { prompt: 'a cat', cwd: workspace }
    )
  } finally {
    globalThis.fetch = original
  }
  return calls[0].init.headers
}

// --- checks -------------------------------------------------------------------

console.log('credential resolution (real provider)')

await check('the seam answers resolve(), the method the plugin now uses', async () => {
  const file = path.join(workspace, 'seam', '.credentials.yaml')
  await writeCredentials(file, { TEST_SEAM_KEY: FAKE_KEY })
  const { service } = await mountProvider(file)
  const hit = await service.resolve('TEST_SEAM_KEY')
  assert.equal(typeof hit?.value, 'string', 'resolve must answer { value, source }')
  assert.equal(hit.value, FAKE_KEY)
  // And the method the plugin used to call is genuinely absent — the probe was
  // not merely unlucky, it was looking for an API that does not exist.
  assert.equal(typeof service.get, 'undefined', 'there is no credentials.get()')
})

await check('a key in the managed document reaches the request header', async () => {
  const file = path.join(workspace, 'seam', '.credentials.yaml')
  await writeCredentials(file, { TEST_SEAM_KEY: FAKE_KEY })
  const { root } = await mountProvider(file)
  const ctx = { get: (name) => root.get(name), logger: { warn() {} } }
  // The reference has to be named somewhere: here it is the settings document's
  // `apiKeyEnv`, the same field a selected provider would have supplied.
  const headers = await callWith(ctx, { apiKeyEnv: 'TEST_SEAM_KEY' })
  assert.equal(headers.authorization, `Bearer ${FAKE_KEY}`, 'the key must be sent, and only as a bearer token')
})

await check('a named but unset credential fails by name, without a request', async () => {
  // Naming a credential is a promise that one exists. Sending the call anyway
  // would trade a clear local error for a provider 401.
  const file = path.join(workspace, 'empty', '.credentials.yaml')
  // The document exists and holds a key — just not the one this call names.
  await writeCredentials(file, { UNRELATED_KEY: FAKE_KEY })
  const { root } = await mountProvider(file)
  const ctx = { get: (name) => root.get(name), logger: { warn() {} } }
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error('must not be reached') }
  try {
    await assert.rejects(
      () => plugin.generateImages(
        ctx,
        { config: { baseURL: 'http://images.invalid/v1', model: 'm', apiKeyEnv: 'SOME_OTHER_KEY', outputDir: workspace }, stored: undefined },
        { prompt: 'a cat', cwd: workspace }
      ),
      /credential "SOME_OTHER_KEY" is not set/
    )
  } finally {
    globalThis.fetch = original
  }
  assert.equal(calls.length, 0, 'a missing credential must not spend a request')
})

await check('a missing credential is reported by name', async () => {
  const ctx = {
    get: () => undefined,
    logger: { warn() {} },
    // No seam, no environment, and a home that holds no document.
    ...{}
  }
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(workspace, 'nowhere')
  try {
    await assert.rejects(
      () => plugin.generateImages(ctx, { config: { baseURL: 'http://images.invalid/v1', model: 'm', apiKeyEnv: 'DEFINITELY_MISSING_KEY', outputDir: workspace }, stored: undefined }, { prompt: 'a cat', cwd: workspace }),
      /credential "DEFINITELY_MISSING_KEY" is not set/
    )
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

await check('without DSH_HOME the fallback still finds ~/.dsh', async () => {
  // The desktop host runs with HOME set and DSH_HOME unset. Insisting on the
  // variable is what made a configured key read as missing.
  const home = path.join(workspace, 'fakehome')
  await writeCredentials(path.join(home, '.dsh', '.credentials.yaml'), { TEST_HOME_KEY: FAKE_KEY })
  const previousHome = process.env.HOME
  const previousDshHome = process.env.DSH_HOME
  delete process.env.DSH_HOME
  process.env.HOME = home
  try {
    assert.equal(plugin.dshHome(), path.join(home, '.dsh'), 'the home resolver must fall back to HOME')
    const resolved = await plugin.readCredential({ get: () => undefined, logger: { warn() {} } }, 'TEST_HOME_KEY')
    assert.equal(resolved, FAKE_KEY, 'the managed document must be found without DSH_HOME')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  }
})

await check('DSH_HOME wins over HOME when both are set', async () => {
  const dshHome = path.join(workspace, 'explicit')
  await writeCredentials(path.join(dshHome, '.credentials.yaml'), { TEST_EXPLICIT_KEY: FAKE_KEY })
  const previousHome = process.env.HOME
  const previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  process.env.HOME = path.join(workspace, 'fakehome')
  try {
    assert.equal(plugin.dshHome(), dshHome)
    assert.equal(await plugin.readCredential({ get: () => undefined }, 'TEST_EXPLICIT_KEY'), FAKE_KEY)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  }
})

await check('the process environment is still read when no seam is mounted', async () => {
  process.env.TEST_ENV_KEY = FAKE_KEY
  try {
    assert.equal(await plugin.readCredential({ get: () => undefined }, 'TEST_ENV_KEY'), FAKE_KEY)
  } finally {
    delete process.env.TEST_ENV_KEY
  }
})

await check('an unusable seam falls through instead of throwing', async () => {
  // A provider that exists but rejects the reference must not become the only
  // route to a key that the environment can still supply.
  process.env.TEST_FALLBACK_KEY = FAKE_KEY
  try {
    const broken = {
      get: () => ({ resolve: async () => { throw new Error('ref not addressable') } }),
      logger: { warn() {} }
    }
    assert.equal(await plugin.readCredential(broken, 'TEST_FALLBACK_KEY'), FAKE_KEY)
  } finally {
    delete process.env.TEST_FALLBACK_KEY
  }
})

await fs.rm(workspace, { recursive: true, force: true })

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
