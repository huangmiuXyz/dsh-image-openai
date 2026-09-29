/**
 * Exercises both provider calls for real, with `fetch` stubbed.
 *
 * `check.mjs` asserts the shape of the source and `tool-schema.mjs` asserts the
 * model-facing schema; neither would notice a request that goes to the wrong
 * path, a multipart body the provider cannot parse, or an input file that is
 * read after the call. So this file runs the whole operation against a fake
 * `fetch` that records what was sent and answers with a real one-pixel PNG.
 *
 * Nothing here needs the app: the plugin imports no Harness package. Run it with
 * plain node.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
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

// --- fixtures -----------------------------------------------------------------

/** A 1x1 PNG, so the written file is a real image and not a stub. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
)

/** A file that is not an image, for the rejection path. */
const NOT_AN_IMAGE = Buffer.from('this is not a picture\n', 'utf8')

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-image-openai-'))
const inputPng = path.join(workspace, 'photo.png')
const inputJpegNamedPng = path.join(workspace, 'actually-jpeg.png')
const inputText = path.join(workspace, 'notes.txt')
await fs.writeFile(inputPng, PNG)
// JPEG magic bytes under a .png name: the upload must be relabelled by content.
await fs.writeFile(inputJpegNamedPng, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]))
await fs.writeFile(inputText, NOT_AN_IMAGE)

/** Capture every request and answer with one image. */
const withFetch = async (run, { status = 200, body, onRequest } = {}) => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    const recorded = onRequest?.(calls) ?? { status, body }
    const text = recorded.body ?? JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] })
    return {
      ok: (recorded.status ?? 200) >= 200 && (recorded.status ?? 200) < 300,
      status: recorded.status ?? 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => text,
      arrayBuffer: async () => PNG
    }
  }
  try {
    return { result: await run(calls), calls }
  } finally {
    globalThis.fetch = original
  }
}

/** A context with no storage and no loader: settings come from the row config. */
const context = () => ({
  get: () => undefined,
  logger: { warn() {} }
})

const state = () => ({
  config: { baseURL: 'http://images.invalid/v1', model: 'gpt-image-test', outputDir: workspace },
  stored: undefined
})

const outDir = path.join(workspace, 'out')

// --- checks -------------------------------------------------------------------

console.log('generate_image request building')

await check('a call without an image posts JSON to /images/generations', async () => {
  const { result, calls } = await withFetch((all) => plugin.generateImages(context(), state(), { prompt: 'a cat', cwd: workspace, outputDir: outDir }))
  assert.equal(calls.length, 1, 'exactly one provider call')
  assert.equal(calls[0].url, 'http://images.invalid/v1/images/generations')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.prompt, 'a cat')
  assert.equal(body.model, 'gpt-image-test')
  assert.equal(body.response_format, 'b64_json')
  assert.equal(result.mode, 'generations')
  const written = await fs.readFile(result.files[0].path)
  assert.deepEqual(written, PNG, 'the decoded image must reach the disk')
})

await check('a call with an image posts multipart to /images/edits', async () => {
  const { result, calls } = await withFetch((all) => plugin.generateImages(context(), state(), { prompt: 'make it blue', image: inputPng, cwd: workspace, outputDir: outDir }))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://images.invalid/v1/images/edits')
  assert.equal(result.mode, 'edits')
  assert.equal(result.inputImage, inputPng)
})

await check('the multipart body carries the file, and content-type is left to fetch', async () => {
  // Setting `content-type: multipart/form-data` by hand omits the boundary and
  // the provider cannot parse the form at all — the classic way to break an edit
  // call while looking correct.
  const { calls } = await withFetch(() => plugin.generateImages(context(), state(), { prompt: 'make it blue', image: inputPng, cwd: workspace, outputDir: outDir }))
  const { init } = calls[0]
  assert.equal(init.headers['content-type'], undefined, 'fetch must own the multipart content-type')
  assert.ok(init.body instanceof FormData, 'the body must be a FormData instance')
  assert.equal(init.body.get('prompt'), 'make it blue')
  assert.equal(init.body.get('model'), 'gpt-image-test')
  assert.equal(init.body.get('response_format'), 'b64_json')
  const file = init.body.get('image')
  assert.ok(file instanceof Blob, 'the image field must be a file, not a path')
  assert.equal(file.type, 'image/png')
  assert.equal(file.name, 'photo.png')
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG)
})

await check('an image is typed by its bytes, not by its file extension', async () => {
  const { calls } = await withFetch(() => plugin.generateImages(context(), state(), { prompt: 'edit', image: inputJpegNamedPng, cwd: workspace, outputDir: outDir }))
  const file = calls[0].init.body.get('image')
  assert.equal(file.type, 'image/jpeg', 'the magic bytes must win over the .png name')
  assert.equal(file.name, 'actually-jpeg.jpg', 'and the upload name must match the real type')
})

await check('a relative image path resolves against the working directory', async () => {
  const { calls } = await withFetch(() => plugin.generateImages(context(), state(), { prompt: 'edit', image: 'photo.png', cwd: workspace, outputDir: outDir }))
  assert.equal(calls[0].init.body.get('image').name, 'photo.png')
})

await check('a missing input image fails before the provider is called', async () => {
  const { calls } = await withFetch(async () => {
    await assert.rejects(
      () => plugin.generateImages(context(), state(), { prompt: 'edit', image: path.join(workspace, 'nope.png'), cwd: workspace }),
      /input image not found/
    )
  })
  assert.equal(calls.length, 0, 'a bad path must not spend a provider call')
})

await check('a file that is not an image is rejected by name', async () => {
  await assert.rejects(
    () => plugin.generateImages(context(), state(), { prompt: 'edit', image: inputText, cwd: workspace }),
    /must be PNG, JPEG, WebP or GIF/
  )
})

await check('a directory is refused as an input image', async () => {
  await assert.rejects(
    () => plugin.generateImages(context(), state(), { prompt: 'edit', image: workspace, cwd: workspace }),
    /is not a file/
  )
})

await check('an empty image argument means text-to-image, not an error', async () => {
  // A model that fills every field may send `image: ""`; that is not a request
  // to edit, and failing it would be a puzzling refusal.
  const { result, calls } = await withFetch(() => plugin.generateImages(context(), state(), { prompt: 'a cat', image: '', cwd: workspace, outputDir: outDir }))
  assert.equal(calls[0].url, 'http://images.invalid/v1/images/generations')
  assert.equal(result.mode, 'generations')
})

await check('a provider without the edit route is named in the error', async () => {
  // A bare "404 page not found" from a text-to-image-only gateway is otherwise
  // indistinguishable from a wrong base URL.
  await assert.rejects(
    () => withFetch(
      () => plugin.generateImages(context(), state(), { prompt: 'edit', image: inputPng, cwd: workspace, outputDir: outDir }),
      { status: 404, body: '404 page not found' }
    ),
    (error) => /images\/edits/.test(error.message) && /does not implement/.test(error.message)
  )
})

await check('the api key header is only sent when a credential resolved', async () => {
  const { calls } = await withFetch(() => plugin.generateImages(context(), state(), { prompt: 'a cat', cwd: workspace, outputDir: outDir }))
  assert.equal(calls[0].init.headers.authorization, undefined, 'no credential, no header')
})

await check('the prompt prefix is applied on both endpoints', async () => {
  const prefixed = () => ({ config: { ...state().config, promptPrefix: 'house style' }, stored: undefined })
  const one = await withFetch(() => plugin.generateImages(context(), prefixed(), { prompt: 'a cat', cwd: workspace, outputDir: outDir }))
  assert.match(JSON.parse(one.calls[0].init.body).prompt, /^house style/)
  const two = await withFetch(() => plugin.generateImages(context(), prefixed(), { prompt: 'edit', image: inputPng, cwd: workspace, outputDir: outDir }))
  assert.match(two.calls[0].init.body.get('prompt'), /^house style/)
})

await check('every file written lands in the requested directory', async () => {
  const { result } = await withFetch(() => plugin.generateImages(context(), state(), { prompt: 'a cat', cwd: workspace, outputDir: outDir }))
  assert.ok(result.files.every((file) => path.dirname(file.path) === outDir), 'all outputs go to outputDir')
  assert.match(result.files[0].path, /\.png$/)
})

await check('the size defaults to auto, so the provider picks the aspect ratio', async () => {
  // What the endpoint does with an absent size anyway — the one image produced so
  // far came back 1024x1536 for a portrait prompt that configured no size.
  const { calls } = await withFetch(() => plugin.generateImages(context(), state(), { prompt: 'a cat', cwd: workspace, outputDir: outDir }))
  assert.equal(JSON.parse(calls[0].init.body).size, 'auto')
})

await check('a configured size is sent on both endpoints', async () => {
  const sized = () => ({
    config: { baseURL: 'http://images.invalid/v1', model: 'gpt-image-test', outputDir: workspace, size: '1536x1024' },
    stored: undefined
  })
  const one = await withFetch(() => plugin.generateImages(context(), sized(), { prompt: 'a cat', cwd: workspace, outputDir: outDir }))
  assert.equal(JSON.parse(one.calls[0].init.body).size, '1536x1024')
  const two = await withFetch(() => plugin.generateImages(context(), sized(), { prompt: 'a cat', image: inputPng, cwd: workspace, outputDir: outDir }))
  assert.equal(two.calls[0].init.body.get('size'), '1536x1024', 'the edit form carries it too')
})

await check('the quality defaults to auto, so the provider picks the level', async () => {
  // Same rule as the size: an omitted `quality` is the provider's own choice, so
  // naming `auto` states the behaviour instead of leaving it implicit.
  const { calls } = await withFetch(() => plugin.generateImages(context(), state(), { prompt: 'a cat', cwd: workspace, outputDir: outDir }))
  assert.equal(JSON.parse(calls[0].init.body).quality, 'auto')
})

await check('a configured quality is sent on both endpoints', async () => {
  const leveled = () => ({
    config: { baseURL: 'http://images.invalid/v1', model: 'gpt-image-test', outputDir: workspace, quality: 'high' },
    stored: undefined
  })
  const one = await withFetch(() => plugin.generateImages(context(), leveled(), { prompt: 'a cat', cwd: workspace, outputDir: outDir }))
  assert.equal(JSON.parse(one.calls[0].init.body).quality, 'high')
  const two = await withFetch(() => plugin.generateImages(context(), leveled(), { prompt: 'a cat', image: inputPng, cwd: workspace, outputDir: outDir }))
  assert.equal(two.calls[0].init.body.get('quality'), 'high', 'the edit form carries it too')
})

await check('a per-call size wins, and a blank one keeps the configured size', async () => {
  const one = await withFetch(() => plugin.generateImages(context(), state(), { prompt: 'a cat', size: '1024 × 1536', cwd: workspace, outputDir: outDir }))
  assert.equal(JSON.parse(one.calls[0].init.body).size, '1024x1536', 'a per-call size must normalise and win')
  // A model that fills in an empty string is declining to choose, not asking for
  // a size of "".
  const two = await withFetch(() => plugin.generateImages(context(), state(), { prompt: 'a cat', size: '', cwd: workspace, outputDir: outDir }))
  assert.equal(JSON.parse(two.calls[0].init.body).size, 'auto', 'blank must keep the configured default')
})

await check('an impossible size is refused before the provider is called', async () => {
  let recorded = []
  await withFetch(async (all) => {
    recorded = all
    await assert.rejects(
      () => plugin.generateImages(context(), state(), { prompt: 'a cat', size: 'huge', cwd: workspace, outputDir: outDir }),
      /is not a WIDTHxHEIGHT pair/
    )
  })
  assert.equal(recorded.length, 0, 'a rejected size must not spend a request')
})

await check('the module builds no request without a prompt', async () => {
  await assert.rejects(() => plugin.generateImages(context(), state(), { prompt: '  ' }), /a prompt is required/)
})

await fs.rm(workspace, { recursive: true, force: true })

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
