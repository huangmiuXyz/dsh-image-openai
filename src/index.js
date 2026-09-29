/**
 * OpenAI-compatible image generation, HOST half.
 *
 * Two jobs live here, and both of them need host privileges:
 *
 * 1. **The HTTP route.** The browser cannot call a third-party image endpoint
 *    directly (CORS, and the API key must never reach the page), so every
 *    generation request travels page → host route → provider → host → page.
 *    The route also owns the filesystem, because a generated image has to be
 *    written somewhere the Session filesystem can read.
 *
 * 2. **The `generate_image` tool.** A DSH tool is registered into `ctx.tools`,
 *    which is a host service. The tool schema is the whole reason this plugin
 *    has a host half at all: `defineTool` builds a model-facing name,
 *    description and parameter schema, and the registry feeds those schemas
 *    into system-prompt assembly automatically.
 *
 * Whether the tool reaches a given agent is NOT decided here. A tool
 * registered on the host context is visible to every agent; the "inject into
 * the preset" switch the user asked for is a *composition* decision, so the
 * tool is a SEPARATE ROW (`image-openai-tool`) in this bundle's patch, and the
 * switch disables and re-enables that row through the Plugin Manager. The row
 * names this package's `./tool` subpath, so the two rows carry their own titles
 * while the installed plugin stays one package. See src/client.js for the
 * switching half.
 *
 * Settings (endpoint, key reference, model, size) are persisted through the
 * harness storage domain so they survive a restart, and read back by the
 * client over the route below.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Route prefix the client half talks to. Namespaced so it cannot collide. */
const ROUTE_BASE = '/dsh-image-openai'
/**
 * Header the client must send. A cross-origin page can POST a "simple"
 * request without a preflight, so requiring a custom header is what actually
 * forces one — the browser then blocks the call because this server answers no
 * CORS preflight. Same-origin callers (our own client half) are unaffected.
 * Same reasoning (and the same header name) as dsh-edit-retry.
 */
const HEADER = 'x-dsh-image-openai'
/**
 * Storage domain and table the settings row lives in.
 *
 * The domain name must satisfy the storage layer's `/^[a-z][a-z0-9_]*$/`, and a
 * domain is not something a profile mounts by configuration: the CONSUMER
 * declares it and opens it (`storageDomain.open(spec)`), after which other rows
 * reach it through `storageDomain.get(name)`. Reading before your own open is
 * what produces `storage domain "…" is not mounted` — a message that only ever
 * comes from this file.
 */
const DOMAIN = 'dsh_image_openai'
const TABLE = 'settings'
const SETTINGS_KEY = 'current'

/**
 * The schema DSL the tool registry accepts. Kept to the subsets the registry
 * validates for parameters and for tool output.
 */
const TOOL_NAME = 'generate_image'

/** How long one provider call may take before it is abandoned. */
const DEFAULT_TIMEOUT_MS = 180000
/**
 * Ceiling for an input image. Reading a file into memory is unavoidable for a
 * multipart upload, and the providers cap edits well below this (25MB for
 * OpenAI's), so a bigger file is a mistake worth naming rather than an
 * out-of-memory crash to diagnose.
 */
const MAX_INPUT_IMAGE_BYTES = 50 * 1024 * 1024

class ImageError extends Error {
  constructor(message, status = 500) {
    super(message)
    this.status = status
  }
}

// --- settings -----------------------------------------------------------------

/**
 * The shape the client reads and writes. Everything is optional on disk: an
 * unconfigured plugin must still answer `GET /settings` so the panel can render
 * its empty state instead of failing.
 */
const SETTINGS_DEFAULTS = {
  // WIDTHxHEIGHT, or `auto` to let the provider pick the aspect ratio.
  size: 'auto'
}

function normalizeSettings(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  const str = (key) => (typeof value[key] === 'string' ? value[key].trim() : '')
  const num = (key) => {
    const parsed = Number(value[key])
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
  }
  return {
    // The provider route whose configuration supplies baseURL + apiKeyEnv.
    // Empty means "use the endpoint and key below directly".
    provider: str('provider'),
    model: str('model'),
    baseURL: str('baseURL'),
    apiKeyEnv: str('apiKeyEnv'),
    size: str('size'),
    quality: str('quality'),
    style: str('style'),
    n: num('n'),
    timeoutMs: num('timeoutMs'),
    outputDir: str('outputDir'),
    extraJson: str('extraJson'),
    promptPrefix: str('promptPrefix')
  }
}

/**
 * The domain declaration, written out rather than built with `defineDomain` /
 * `domainTable` from `@deepseek-ai/dsh-storage-domain`.
 *
 * Two reasons. That package is not an importable dependency of a linked plugin
 * (resolving `@deepseek-ai/…` from a plugin directory would need the whole
 * harness in its own `node_modules`; this half probes every service through
 * `ctx` and imports nothing). And both helpers are identity functions — one
 * checks the literal shape, the other wraps a schema — so inlining them cannot
 * drift from what the layer reads: name, version, table names, and each table's
 * `valueSchema`.
 *
 * `layout` is omitted, which the JSON backend reads as `single`: one document
 * for the whole unit. Right for a single settings row. `valueSchema` is typed as
 * a zod schema; the layer only ever calls `parse` on it (and `safeParse` on a
 * global, which this spec does not declare). `normalizeSettings` already
 * coerces any stored JSON into the known shape, so it IS the validator — both
 * methods are provided so the contract holds either way.
 */
const SETTINGS_SCHEMA = {
  parse: (raw) => normalizeSettings(raw),
  safeParse: (raw) => {
    try {
      return { success: true, data: normalizeSettings(raw) }
    } catch (error) {
      return { success: false, error }
    }
  }
}

const DOMAIN_SPEC = {
  name: DOMAIN,
  version: 1,
  tables: { [TABLE]: { valueSchema: SETTINGS_SCHEMA } }
}

/**
 * The model-facing argument schema, in the compiled form `defineTool` would have
 * produced (see `TOOL_DEFINITION` for why it is written out). `required` is the
 * JSON Schema array, and only a single scalar `type` per node: the registry
 * enforces a subset and rejects unsupported or misplaced keywords rather than
 * ignoring them.
 */
const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: 'What to draw. Be specific about subject, style, composition and lighting; the image endpoint has no conversation context.'
    },
    model: {
      type: 'string',
      description: 'Image model id. Omit to use the configured default. Only pass a different id when the user asked for one.'
    },
    size: {
      type: 'string',
      description: 'Output size as WIDTHxHEIGHT, for example 1024x1024, 1536x1024 or 1024x1536. The default "auto" lets the provider choose the aspect ratio. Omit to use the configured size.'
    },
    outputDir: {
      type: 'string',
      description: 'Absolute directory to write into. Omit to write into the Session working directory.'
    },
    image: {
      type: 'string',
      description: 'Path of an input image to edit. Pass it to run the provider\'s image-edit endpoint instead of text-to-image; relative paths resolve against the Session working directory. Omit it to generate from the prompt alone.'
    }
  },
  required: ['prompt']
}

/**
 * The declared output of `generate_image`, again already compiled.
 *
 * `additionalProperties: false` plus the exact property set is a promise the
 * runtime can check, so the object `execute` returns must not gain a field.
 */
const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    model: { type: 'string' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          mimeType: { type: 'string' }
        },
        required: ['path', 'mimeType']
      }
    }
  },
  required: ['model', 'files']
}

/** Effective provider call settings: persisted row over the plugin Config. */
function mergeSettings(config, stored) {
  const base = normalizeSettings(stored)
  const fallback = normalizeSettings(config)
  const pick = (key) => (base[key] === '' || base[key] === undefined ? fallback[key] : base[key])
  const merged = {}
  for (const key of Object.keys(base)) merged[key] = pick(key)
  // Defaults that hold when neither the settings document nor the row config
  // names a value.
  //
  // `size` defaults to `auto` because that is what the endpoint does anyway: a
  // request that omits the field is answered at the provider's own choice of
  // aspect ratio — the one image produced so far came back 1024x1536 for a
  // portrait prompt with no size configured. Naming `auto` makes that visible in
  // the settings screen instead of hiding it in an empty box. The default lives
  // here rather than only in the bundle patch, so that no patch ordering can
  // drop it.
  for (const [key, value] of Object.entries(SETTINGS_DEFAULTS)) {
    if (merged[key] === '' || merged[key] === undefined) merged[key] = value
  }
  return merged
}

/**
 * Open domains by facility.
 *
 * `open()` refuses a second open of one name (`already-open`, "domain '…' is
 * already open"), and this package is activated TWICE — once as the page row and
 * once as the tool row — so a bare open in each `apply` would race its own
 * sibling. Both rows reach the same facility instance, so the in-flight promise
 * is shared here instead. Keyed weakly: the facility dies with the profile.
 */
const openDomains = new WeakMap()

/**
 * The open settings domain, opening it on first use.
 *
 * Opening is lazy rather than done at activation so that both rows can share
 * one open without either of them having to know which one ran first: the
 * facility's own `get` resolves the case where a sibling already opened it.
 *
 * `required` separates the two callers. A read degrades to `undefined` — losing
 * a preference must never break a generation. A write cannot degrade, or the
 * settings page would report success while saving nothing, so it throws a 501
 * naming the actual reason.
 */
async function settingsDomain(ctx, required) {
  const facility = ctx.get('storageDomain')
  if (facility === undefined || facility === null || typeof facility.open !== 'function') {
    if (required) {
      throw new ImageError('this profile mounts no storage domain, so settings cannot be saved', 501)
    }
    return undefined
  }

  const live = typeof facility.get === 'function' ? facility.get(DOMAIN) : undefined
  if (live !== undefined && live !== null) return live

  let pending = openDomains.get(facility)
  if (pending === undefined) {
    pending = Promise.resolve().then(() => facility.open(DOMAIN_SPEC))
    openDomains.set(facility, pending)
  }

  try {
    return await pending
  } catch (error) {
    // A failed open must not be cached, or every later read would replay it.
    openDomains.delete(facility)
    const sibling = typeof facility.get === 'function' ? facility.get(DOMAIN) : undefined
    if (sibling !== undefined && sibling !== null) return sibling
    if (required) {
      throw new ImageError(`cannot open the settings store: ${String(error?.message ?? error)}`, 501)
    }
    return undefined
  }
}

/**
 * Read the persisted settings row, or `undefined` when there is none to read.
 *
 * Every step is probed rather than assumed: a profile that mounts no storage, or
 * whose backend refuses the open, still runs this plugin with in-memory defaults.
 */
async function readSettings(ctx) {
  try {
    const domain = await settingsDomain(ctx, false)
    if (domain === undefined) return undefined
    const table = domain.table(TABLE)
    if (table === undefined || table === null || typeof table.get !== 'function') return undefined
    // Reads are synchronous off the domain's in-memory state.
    return table.get(SETTINGS_KEY)
  } catch {
    return undefined
  }
}

async function writeSettings(ctx, value) {
  const domain = await settingsDomain(ctx, true)
  const table = domain.table(TABLE)
  if (table === undefined || table === null || typeof table.put !== 'function') {
    throw new ImageError(`the storage domain "${DOMAIN}" declares no table "${TABLE}"`, 501)
  }
  await table.put(SETTINGS_KEY, value)
  return value
}

// --- provider resolution ------------------------------------------------------

/**
 * Resolve the endpoint and the credential for one request.
 *
 * Two sources, in order:
 *
 * - A configured provider route (e.g. the `max66` openai-completions profile
 *   from the profile patch). Its baseURL and apiKeyEnv are read straight out of
 *   the Loader's own composition via `ctx.loader`, which is what makes "choose
 *   one of the models configured in DSH" work without asking the user to retype
 *   an endpoint or a key.
 * - The plugin's own `baseURL` + `apiKeyEnv` fields, for a provider DSH does
 *   not know about.
 *
 * The key itself is read from the environment and the managed credential
 * document `$DSH_HOME/.credentials.yaml`, which is where `dsh` keeps the
 * references its Models page writes.
 */
async function resolveConnection(ctx, settings) {
  let baseURL = settings.baseURL
  let apiKeyEnv = settings.apiKeyEnv

  if (settings.provider !== '') {
    const described = describeProviderRow(ctx, settings.provider)
    if (described === undefined) {
      throw new ImageError(`no configured model provider named "${settings.provider}"`, 400)
    }
    // An explicit field in the plugin settings still wins, so one route can be
    // repointed without editing the composition.
    if (baseURL === '') baseURL = described.baseURL
    if (apiKeyEnv === '') apiKeyEnv = described.apiKeyEnv
  }

  if (baseURL === '') throw new ImageError('no image endpoint is configured', 400)

  const apiKey = apiKeyEnv === '' ? '' : await readCredential(ctx, apiKeyEnv)
  if (apiKeyEnv !== '' && apiKey === '') {
    throw new ImageError(`credential "${apiKeyEnv}" is not set`, 400)
  }
  return { baseURL, apiKeyEnv, apiKey }
}

/**
 * Pull `baseURL` and `apiKeyEnv` for one provider out of the loaded profile.
 *
 * The Loader owns the composed entry tree; the row that configures a provider
 * is the one whose `config.providers` names it. This reads composition, not
 * runtime state, so a provider that is configured but dormant is still found —
 * which is the point, because the whole plugin exists to give that provider a
 * job it did not have before.
 */
function describeProviderRow(ctx, provider) {
  const loader = ctx.get('loader')
  if (loader === undefined || loader === null || typeof loader.entries !== 'function') return undefined
  let rows
  try {
    rows = [...loader.entries()]
  } catch {
    return undefined
  }
  for (const entry of rows) {
    const config = entry?.options?.config
    if (config === null || typeof config !== 'object') continue
    const providers = config.providers
    if (providers === null || typeof providers !== 'object') continue
    const profile = providers[provider]
    if (profile === null || typeof profile !== 'object') continue
    return {
      baseURL: typeof profile.baseURL === 'string' ? profile.baseURL : '',
      apiKeyEnv: typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : '',
      api: typeof profile.api === 'string' ? profile.api : '',
      models: Array.isArray(profile.models)
        ? profile.models.map((model) => (typeof model?.id === 'string' ? model.id : '')).filter((id) => id !== '')
        : []
    }
  }
  return undefined
}

/**
 * Read one credential reference.
 *
 * Process environment first (the documented inheritance order), then the
 * managed `$DSH_HOME/.credentials.yaml` document, whose `refs` mapping is a
 * plain `NAME: value` map. The document is parsed with a deliberately small
 * reader: it is a shallow map of scalars, and pulling in a YAML parser for four
 * lines would be a dependency for nothing. A value that does not parse is
 * reported as missing rather than guessed at.
 */
async function readCredential(ctx, name) {
  // The credential seam FIRST. It is the component that knows every source in
  // the fixed precedence the product documents — the launch environment, then
  // the managed `$DSH_HOME/.credentials.yaml`, then project and home `.env`
  // files — and it is what the LLM adapters resolve `apiKeyEnv` through. A key
  // that works for the model therefore works here, including one saved through
  // the Models page after startup.
  //
  // Its method is `resolve`, not `get`: `resolve(ref)` answers `{ value, source }`
  // or `undefined`. This plugin probed `get` for a while, found no such method,
  // silently skipped the seam and then failed on its own hand-rolled fallback —
  // a two-layer mistake that surfaced as "credential is not set" for a key that
  // was right there.
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(name)
      const value = typeof hit === 'string' ? hit : hit?.value
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    } catch {
      /* an unusable seam must not be the only route to a configured key */
    }
  }

  const fromEnv = process.env[name]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()

  // Last resort, for a composition that mounts no credential provider at all.
  let text
  try {
    text = await fs.readFile(path.join(dshHome(), '.credentials.yaml'), 'utf8')
  } catch {
    return ''
  }
  const value = parseCredentialRefs(text)[name]
  return typeof value === 'string' ? value : ''
}

/**
 * The harness home: `$DSH_HOME`, else `~/.dsh`.
 *
 * One definition, because the desktop host runs WITHOUT `DSH_HOME` set — only
 * `HOME` — and a second implementation that insisted on the variable is exactly
 * how the credential lookup above started returning nothing.
 */
function dshHome() {
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') return home
  return path.join(process.env.HOME ?? '.', '.dsh')
}

/**
 * Extract the `refs:` block from the credentials document.
 *
 * The block is either a flow mapping on one line or an indented block mapping;
 * both spellings appear in practice because the file is written by the product
 * but hand-edited by users. Later `refs:` blocks do not exist in the format, so
 * the first one wins and the scan stops at the next top-level key.
 */
function parseCredentialRefs(text) {
  const out = {}
  // A flow mapping may be spelled on the `refs:` line itself or on the next one
  // (`refs:\n  { A: 1 }`), so one absorber serves both.
  const absorbFlow = (body) => {
    for (const pair of body.split(',')) {
      const match = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*?)\s*$/.exec(pair)
      if (match !== null) out[match[1]] = unquote(match[2])
    }
  }
  const lines = text.split('\n')
  let inRefs = false
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (!inRefs) {
      const flow = /^\s*refs:\s*\{(.*)\}\s*$/.exec(line)
      if (flow !== null) {
        absorbFlow(flow[1])
        return out
      }
      if (/^\s*refs:\s*$/.test(line)) {
        inRefs = true
        continue
      }
      continue
    }
    if (/^\S/.test(line)) break
    const flowLine = /^\s*\{(.*)\}\s*$/.exec(line)
    if (flowLine !== null) {
      absorbFlow(flowLine[1])
      continue
    }
    const match = /^\s+([A-Za-z0-9_.-]+)\s*:\s*(.*?)\s*$/.exec(line)
    if (match === null) continue
    out[match[1]] = unquote(match[2])
  }
  return out
}

function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

// --- the provider call --------------------------------------------------------

/**
 * Call an OpenAI-compatible image endpoint.
 *
 * Two shapes are spoken, and the argument decides which:
 *
 * - **no input image** — `POST <baseURL>/images/generations`, JSON body. This is
 *   the shape every OpenAI-compatible image service speaks.
 * - **an input image** — `POST <baseURL>/images/edits`, `multipart/form-data`
 *   with the file under `image`. Editing takes a file upload, not a URL, so this
 *   is the only way to hand the provider a local picture.
 *
 * `apiKey` is omitted rather than sent empty when no credential is configured,
 * because a local server behind no auth rejects the header.
 *
 * The response may carry `b64_json` or a `url`; both are accepted, because
 * gateways disagree about which one to return. Anything else is reported with
 * the provider's own message, since a wrong model name is by far the most
 * common failure and the provider words it best.
 */
async function requestImages(connection, settings, prompt, image, signal) {
  const editing = image !== undefined
  const url = joinURL(connection.baseURL, editing ? 'images/edits' : 'images/generations')

  const headers = { accept: 'application/json' }
  if (connection.apiKey !== '') headers.authorization = `Bearer ${connection.apiKey}`

  let body
  if (editing) {
    // `fetch` must set content-type itself here: it is the one that knows the
    // multipart boundary, and a hand-written `multipart/form-data` WITHOUT a
    // boundary makes the provider fail to parse the form at all.
    body = editForm(settings, prompt, image)
  } else {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(generationBody(settings, prompt))
  }

  const timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('image request timed out')), timeoutMs)
  const abort = () => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  }

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal
    })
  } catch (error) {
    if (controller.signal.aborted && !(signal?.aborted ?? false)) {
      throw new ImageError(`image request timed out after ${timeoutMs}ms`, 504)
    }
    throw new ImageError(`image request failed: ${messageOf(error)}`, 502)
  } finally {
    clearTimeout(timer)
    if (signal !== undefined) signal.removeEventListener('abort', abort)
  }

  const text = await response.text()
  if (!response.ok) {
    // A provider without the edit route answers 404, which is otherwise
    // indistinguishable from a wrong base URL — name the likely cause.
    const hint = editing && response.status === 404
      ? ' (this provider does not implement /images/edits, so it cannot edit an input image)'
      : ''
    throw new ImageError(`image provider returned ${response.status}${hint}: ${trimForMessage(text)}`, 502)
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new ImageError(`image provider returned a non-JSON body: ${trimForMessage(text)}`, 502)
  }
  const data = Array.isArray(payload?.data) ? payload.data : []
  if (data.length === 0) throw new ImageError(`image provider returned no images: ${trimForMessage(text)}`, 502)

  const images = []
  for (const entry of data) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.b64_json === 'string' && entry.b64_json !== '') {
      images.push({ base64: entry.b64_json, mimeType: 'image/png' })
      continue
    }
    if (typeof entry.url === 'string' && entry.url !== '') {
      images.push(await downloadImage(entry.url, controller.signal))
    }
  }
  if (images.length === 0) throw new ImageError('image provider returned no usable image data', 502)
  return { images, usage: payload?.usage }
}

/** The JSON body of a text-to-image call. */
function generationBody(settings, prompt) {
  const body = { model: settings.model, prompt, n: settings.n ?? 1, response_format: 'b64_json' }
  if (settings.size !== '') body.size = settings.size
  if (settings.quality !== '') body.quality = settings.quality
  if (settings.style !== '') body.style = settings.style
  for (const [key, value] of Object.entries(parseExtra(settings.extraJson))) {
    body[key] = value
  }
  return body
}

/**
 * The multipart form of an image-edit call.
 *
 * `style` is deliberately absent: it belongs to the text-to-image API (and to
 * DALL·E 3), and sending an unsupported field is the fastest way to have a
 * gateway reject the whole request. `extraJson` is still there for a provider
 * that wants something more.
 */
function editForm(settings, prompt, image) {
  const form = new FormData()
  form.append('model', settings.model)
  form.append('prompt', prompt)
  form.append('image', new Blob([image.bytes], { type: image.mimeType }), image.filename)
  form.append('n', String(settings.n ?? 1))
  form.append('response_format', 'b64_json')
  if (settings.size !== '') form.append('size', settings.size)
  if (settings.quality !== '') form.append('quality', settings.quality)
  for (const [key, value] of Object.entries(parseExtra(settings.extraJson))) {
    // Form fields are strings; a nested value keeps its shape as JSON.
    form.append(key, typeof value === 'string' ? value : JSON.stringify(value))
  }
  return form
}

/**
 * Normalise the size a single call asked for.
 *
 * Models spell it with full-width multiplication signs and stray spaces often
 * enough that passing it straight through would earn a provider error about a
 * JSON field. A malformed size is also worth catching here, where the message
 * can name the accepted form, rather than after a round trip.
 */
function parseCallSize(value) {
  // Absent or blank means "use the configured default" — the same reading the
  // input image gets. A model that fills in an empty string is declining to
  // choose, not asking for a size of "".
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const text = value.trim().replace(/[×✕✖]/g, 'x').replace(/\s+/g, '').toLowerCase()
  if (text === 'auto') return 'auto'
  if (!/^\d+x\d+$/.test(text)) {
    throw new ImageError(`size "${value.trim()}" is not a WIDTHxHEIGHT pair such as 1024x1024 (or "auto")`, 400)
  }
  return text
}

/**
 * Read the input image for an edit call.
 *
 * The bytes decide the type, not the file extension: the multipart filename is
 * what the provider inspects, so a PNG named `.dat` would be rejected while a
 * `photo.png` that actually holds JPEG would be mislabelled. The extension in
 * the upload is therefore the sniffed one.
 */
async function readInputImage(value, cwd) {
  const given = typeof value === 'string' ? value.trim() : ''
  if (given === '') return undefined

  const expanded = given.startsWith('~') ? path.join(os.homedir(), given.slice(1)) : given
  // A relative path is relative to the caller's working directory, the same rule
  // `outputDir` follows, so the model can name a file it can also read.
  const target = path.isAbsolute(expanded) ? expanded : path.resolve(cwd !== '' ? cwd : process.cwd(), expanded)

  let stats
  try {
    stats = await fs.stat(target)
  } catch {
    throw new ImageError(`input image not found: ${target}`, 400)
  }
  if (!stats.isFile()) throw new ImageError(`input image is not a file: ${target}`, 400)
  if (stats.size > MAX_INPUT_IMAGE_BYTES) {
    throw new ImageError(`input image is larger than ${Math.round(MAX_INPUT_IMAGE_BYTES / (1024 * 1024))}MB: ${target}`, 400)
  }

  const bytes = await fs.readFile(target)
  const type = sniffImageType(bytes)
  if (type === undefined) {
    throw new ImageError(`input image must be PNG, JPEG, WebP or GIF: ${target}`, 400)
  }
  const stem = path.basename(target, path.extname(target)) || 'input'
  return { bytes, mimeType: type.mime, filename: `${stem}.${type.extension}`, path: target }
}

/** Identify an image by its magic bytes. */
function sniffImageType(bytes) {
  const ascii = (start, end) => bytes.toString('latin1', start, end)
  if (bytes.length > 8 && bytes[0] === 0x89 && ascii(1, 4) === 'PNG') {
    return { mime: 'image/png', extension: 'png' }
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', extension: 'jpg' }
  }
  if (bytes.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return { mime: 'image/webp', extension: 'webp' }
  }
  if (bytes.length > 6 && ascii(0, 4) === 'GIF8') {
    return { mime: 'image/gif', extension: 'gif' }
  }
  return undefined
}

/** Fetch a provider-hosted image and turn it into bytes. */
async function downloadImage(url, signal) {
  let response
  try {
    response = await fetch(url, { signal })
  } catch (error) {
    throw new ImageError(`could not download the generated image: ${messageOf(error)}`, 502)
  }
  if (!response.ok) {
    throw new ImageError(`could not download the generated image: HTTP ${response.status}`, 502)
  }
  const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim() || 'image/png'
  const buffer = Buffer.from(await response.arrayBuffer())
  return { base64: buffer.toString('base64'), mimeType }
}

function joinURL(base, suffix) {
  return `${base.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`
}

/** A free-form JSON object the user may use for provider-specific fields. */
function parseExtra(text) {
  if (typeof text !== 'string' || text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    throw new ImageError('the extra JSON field is not valid JSON', 400)
  }
}

function trimForMessage(text) {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim()
  return collapsed.length > 400 ? `${collapsed.slice(0, 400)}…` : collapsed
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

// --- writing the file ---------------------------------------------------------

const EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif'
}

/**
 * Write one generated image where the Session filesystem can read it.
 *
 * The destination is the Session working directory when the caller names one
 * and the plugin is configured with no explicit directory, because a path the
 * model can later `present` from its own workspace is worth more than one under
 * the harness home. Everything else lands in `outputDir` (or the harness home
 * default) so a caller with no workspace still gets a file.
 */
async function writeImage(image, { outputDir, cwd, index }) {
  const directory = outputDir !== '' ? outputDir : cwd !== '' ? cwd : defaultOutputDir()
  await fs.mkdir(directory, { recursive: true })
  const extension = EXTENSIONS[image.mimeType] ?? 'png'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const name = `image-${stamp}-${index + 1}.${extension}`
  const target = path.join(directory, name)
  await fs.writeFile(target, Buffer.from(image.base64, 'base64'))
  return target
}

function defaultOutputDir() {
  return path.join(dshHome(), 'dsh-image-openai')
}

// --- the operation, shared by the route and the tool --------------------------

/**
 * Generate images and write them to disk. This is the single implementation
 * behind both callers — the page's button and the model's `generate_image`
 * tool — so the two can never drift.
 *
 * @returns the written files plus the provider's own usage block, if any.
 */
async function generateImages(ctx, state, input, signal) {
  const stored = await readSettings(ctx)
  const settings = mergeSettings(state.config, stored)
  if (settings.model === '') throw new ImageError('no image model is configured', 400)

  const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : ''
  if (prompt === '') throw new ImageError('a prompt is required', 400)

  // A caller may override the model for one call; the tool exposes this so the
  // model can pick between the models the user configured.
  const perCall = input?.model
  if (typeof perCall === 'string' && perCall.trim() !== '') settings.model = perCall.trim()

  // Same for the size: the stored value is the default, a call may name its own.
  const perCallSize = input?.size
  if (typeof perCallSize === 'string' && perCallSize.trim() !== '') {
    settings.size = parseCallSize(perCallSize)
  }

  const cwd = typeof input?.cwd === 'string' ? input.cwd : ''
  // Passing an input image is what turns this into an edit call; resolving it
  // happens before the request so a bad path fails without spending a call.
  const image = await readInputImage(input?.image, cwd)

  const connection = await resolveConnection(ctx, settings)
  const finalPrompt = settings.promptPrefix === '' ? prompt : `${settings.promptPrefix}\n\n${prompt}`

  const { images, usage } = await requestImages(connection, settings, finalPrompt, image, signal)
  // An explicit directory in the call wins; otherwise a workspace call writes
  // into the workspace and a workspace-less call uses the configured directory.
  const outputDir = typeof input?.outputDir === 'string' && input.outputDir.trim() !== ''
    ? input.outputDir.trim()
    : cwd === ''
      ? settings.outputDir
      : ''

  const files = []
  // Named `output`, not `image`: that name now belongs to the input picture, and
  // reusing it for the provider's answer reads as a mistake even where it works.
  for (const [index, output] of images.entries()) {
    files.push({ path: await writeImage(output, { outputDir, cwd, index }), mimeType: output.mimeType })
  }
  return {
    files,
    model: settings.model,
    usage,
    endpoint: connection.baseURL,
    apiKeyEnv: connection.apiKeyEnv,
    // Which endpoint answered, so the page can say "edited" rather than "made".
    mode: image === undefined ? 'generations' : 'edits',
    inputImage: image?.path
  }
}

/** The models a caller can choose from: everything configured, plus the default. */
/**
 * What the settings panel needs to render: the provider routes the profile
 * declares, and the settings that are actually in force.
 *
 * The stored document is a PARAMETER. It used to be read off a cached
 * `state.stored`, while the route had just read the document for its own
 * `stored` field — two sources for one answer. On a page opened before the
 * boot-time warm-up landed, the cache was still empty, so the panel was handed
 * the row config alone: an empty form that read as "my save did not persist"
 * while the document sat on disk the whole time.
 */
function describeSelection(ctx, state, stored) {
  const settings = mergeSettings(state.config, stored)
  const loader = ctx.get('loader')
  const providers = []
  if (loader !== undefined && loader !== null && typeof loader.entries === 'function') {
    try {
      for (const entry of loader.entries()) {
        const config = entry?.options?.config
        if (config === null || typeof config !== 'object') continue
        const map = config.providers
        if (map === null || typeof map !== 'object') continue
        for (const [id, profile] of Object.entries(map)) {
          if (profile === null || typeof profile !== 'object') continue
          providers.push({
            id,
            api: typeof profile.api === 'string' ? profile.api : '',
            baseURL: typeof profile.baseURL === 'string' ? profile.baseURL : '',
            apiKeyEnv: typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : '',
            models: Array.isArray(profile.models)
              ? profile.models
                  .filter((model) => typeof model?.id === 'string')
                  .map((model) => ({
                    id: model.id,
                    name: typeof model.name === 'string' ? model.name : model.id,
                    input: Array.isArray(model.input) ? model.input : []
                  }))
              : []
          })
        }
      }
    } catch {
      /* a loader that cannot enumerate leaves the panel with the manual fields */
    }
  }
  return { providers, settings }
}

// --- the tool -----------------------------------------------------------------

/**
 * Register `generate_image`.
 *
 * The tool is deliberately thin: it validates its arguments, hands them to
 * `generateImages`, and renders one line per file. It carries no provider
 * knowledge, so the page and the model can never generate differently.
 *
 * `ctx.tools` is a host service, but a tool registered here is visible to every
 * agent in the profile. Making it visible to *one* preset is the bundle-layer
 * switch in src/client.js, not a registration trick.
 */
function registerTool(ctx, state) {
  const tools = toolsService(ctx)
  if (tools === undefined) {
    // Never fail silently: a tool that does not register is invisible to the
    // model, and "the model says it has no such tool" is otherwise unattributable.
    ctx.logger?.warn?.('dsh-image-openai: no `tools` service in this profile, so generate_image was not registered')
    return
  }

  ctx.effect(() => tools.register(TOOL_DEFINITION(ctx, state)), 'dsh-image-openai: generate_image tool')
}

/**
 * Resolve the tool registry.
 *
 * `ctx.tools` is the property form a plugin sees after declaring
 * `inject = ['tools']`; `ctx.get('tools')` is the same service by name. Both are
 * probed because reading an uninjected service property can throw, and neither
 * is assumed — the caller logs when both fail.
 */
function toolsService(ctx) {
  const usable = (candidate) =>
    candidate !== undefined && candidate !== null && typeof candidate.register === 'function'
  try {
    if (usable(ctx.tools)) return ctx.tools
  } catch {
    // Reading an uninjected service property throws; the named lookup below is
    // the fallback, not a second guess at the same mistake.
  }
  try {
    const named = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
    return usable(named) ? named : undefined
  } catch {
    return undefined
  }
}

/**
 * The definition handed to `tools.register`.
 *
 * Built here, without `defineTool`, and that is forced rather than preferred:
 * `defineTool` is a module export of `@deepseek-ai/dsh-tools`, and a plugin
 * installed from outside the app cannot import it. Bare specifiers resolve from
 * the profile directory (which holds no `@deepseek-ai/*`), and a symlink into
 * the app archive fails one step later — Node's ESM package resolver reads
 * `package.json` with unpatched internals and cannot see inside an asar
 * (`ERR_MODULE_NOT_FOUND` even when the file is there).
 *
 * So the DSL is not available, and `defineTool`'s only real work is compiling it:
 * `parameters` and `output.schema` are consumed by the registry AS JSON Schema
 * (`schemaOf` snapshots `definition.parameters` verbatim and requires it to be
 * lossless JSON). Writing the compiled form directly is therefore the same
 * definition, and `test/tool-schema.mjs` proves it: it compiles the equivalent
 * DSL with the harness's own `defineTool` and asserts these constants are
 * identical to the result.
 *
 * What is given up is `defineTool`'s automatic argument validation (`ToolArgsError`
 * before `execute`). `execute` validates instead, and a throw becomes an error
 * tool result exactly as before.
 */
function TOOL_DEFINITION(ctx, state) {
  return {
    name: TOOL_NAME,
    description: 'Generate or edit images through the configured OpenAI-compatible image endpoint, and write the results to disk as PNG files. Use it when the user asks for a picture, an illustration, a poster, or any other generated image. Pass `image` with the path of an existing picture to edit it instead of generating from scratch. The written paths can be handed to `present`.',
    parameters: TOOL_PARAMETERS,
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: value.files.map((file) => `Generated ${file.path}`).join('\n')
      }]
    },
    async execute(args, exec) {
      const cwd = exec?.agent?.session?.header?.cwd ?? ''
      const result = await generateImages(ctx, state, { ...args, cwd }, exec?.signal)
      return {
        model: result.model,
        files: result.files.map((file) => ({ path: file.path, mimeType: file.mimeType }))
      }
    }
  }
}

// --- http ---------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  })
  res.end(body)
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > limit) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

async function readJson(req) {
  try {
    const body = await readBody(req)
    if (body === '') return {}
    const parsed = JSON.parse(body)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new ImageError('bad json body', 400)
  }
}

/**
 * Answer one route request.
 *
 * `route` is the sub-path under the route base, already normalised by
 * `routePath()` — `/settings`, `/generate`, or `/`. Every mutation is gated on
 * the custom header, and every read is too: the route must never become a way
 * for another page to spend the user's image quota. A same-origin request from
 * our own client half always carries it.
 */
async function handle(ctx, state, req, res, route) {
  if (req.headers === undefined || req.headers === null || req.headers[HEADER] === undefined) {
    sendJson(res, 403, { ok: false, error: `missing ${HEADER} header` })
    return
  }

  if (route === '/settings') {
    if (req.method === 'GET') {
      const stored = await readSettings(ctx)
      sendJson(res, 200, { ok: true, ...describeSelection(ctx, state, stored), stored: stored ?? null })
      return
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      const payload = await readJson(req)
      const saved = await writeSettings(ctx, normalizeSettings(payload.settings ?? payload))
      sendJson(res, 200, { ok: true, stored: saved })
      return
    }
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }

  if (route === '/generate') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const payload = await readJson(req)
    const controller = new AbortController()
    req.on('aborted', () => controller.abort(new Error('client aborted')))
    const result = await generateImages(ctx, state, payload, controller.signal)
    sendJson(res, 200, { ok: true, ...result })
    return
  }

  sendJson(res, 404, { ok: false, error: 'unknown route' })
}

/**
 * Register the routes.
 *
 * `webServer` is optional — a terminal-only profile never provides it — so when
 * it is absent the routes are registered if and when the service appears,
 * instead of holding the plugin's own activation open on a service that will
 * never come.
 *
 * A route handler is invoked as `handler(req, res)`: the server matches the
 * path but does not pass it, so the sub-path is derived from the request URL
 * here. The exact route serves the bare base, the prefix route serves anything
 * under it, and both funnel into the same dispatcher.
 */
function registerRoutes(ctx, state) {
  const register = (host, scope) => {
    if (host === undefined || host === null || typeof host.register !== 'function') return
    const handler = (req, res) => dispatch(ctx, state, req, res)
    scope.effect(
      () => host.register({ kind: 'exact', path: ROUTE_BASE, handler }),
      'dsh-image-openai: exact route'
    )
    scope.effect(
      () => host.register({ kind: 'prefix', path: ROUTE_BASE, handler }),
      'dsh-image-openai: prefix route'
    )
  }
  const server = ctx.get('webServer')
  if (server !== undefined) register(server, ctx)
  else ctx.inject(['webServer'], (scope) => register(scope.webServer, scope))
}

/** The request's sub-path under the route base, normalised to `/…`. */
function routePath(req) {
  const raw = typeof req?.url === 'string' ? req.url : ROUTE_BASE
  const pathname = raw.split('?')[0].split('#')[0]
  const rest = pathname.startsWith(ROUTE_BASE) ? pathname.slice(ROUTE_BASE.length) : ''
  const trimmed = rest.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/** Route failures become status codes, never an unhandled rejection. */
async function dispatch(ctx, state, req, res) {
  try {
    await handle(ctx, state, req, res, routePath(req))
  } catch (error) {
    const status = error instanceof ImageError ? error.status : 500
    if (!res.headersSent) sendJson(res, status, { ok: false, error: messageOf(error) })
    else res.end()
  }
}

// --- plugin entry -------------------------------------------------------------

export const name = 'dsh-image-openai'

/**
 * The row ids this bundle's patch declares. The switch addresses the tool by
 * `TOOL_ROW`; the Plugin Manager writes its override under the same id, which is
 * why the two spellings are pinned against each other in the checks.
 */
export const PAGE_ROW = 'image-openai'
export const TOOL_ROW = 'image-openai-tool'

/**
 * The page-facing half: the HTTP routes and the client switch. It does NOT
 * register the image tool; this package's `./tool` subpath does, in the row this
 * bundle's patch declares beside its own.
 *
 * Two rows, ONE package, and the reason is display: the Plugins screen labels a
 * Loader row with the metadata of the specifier that row names, resolved through
 * the specifier itself (`<specifier>/locale/<language>.json`). A subpath
 * therefore carries its own title and description, so the two rows do not read
 * as identical entries — which was the only reason the tool once lived in a
 * sibling package. It declares no `dsh.bundle`, so it never shows up as a second
 * installed entry; only this bundle is installed, and its patch names both
 * modules.
 *
 * Toggling the tool row (rather than this whole bundle) is what keeps the switch
 * safe: the client half is discovered from THIS row, so a switch that disabled
 * its own row would delete the control that turns it back on. The write is
 * addressed by `entryId`/`patchId`, never by specifier, so both rows naming one
 * package changes nothing about how the switch works.
 *
 * `config` and the cached settings row travel to the routes as a closure
 * argument. They briefly travelled through a context service, which was wrong
 * twice over: `ctx.set` only OVERWRITES an already-provided service
 * (`cannot set property "dsh-image-openai" without provide`), and a service
 * nobody else consumes is machinery for nothing.
 */
export function apply(ctx, config) {
  const state = { config: config ?? {} }

  // Open the settings domain as soon as the profile mounts one, so the first
  // request off the routes does not pay for it.
  //
  // Injected rather than read here: at apply time the storage facility is often
  // not mounted yet, so a read issued now would find nothing and warm nothing.
  // The value is deliberately NOT cached — every read answers from the document
  // itself, which is what keeps the panel and the store in step. A profile
  // WITHOUT a storage domain is a normal shape: the callback simply never runs,
  // and reads degrade to the row config.
  ctx.inject(['storageDomain'], (scope) => {
    readSettings(scope)
      .catch((error) => { ctx.logger?.warn?.('dsh-image-openai: settings could not be read; using the row config only', error) })
  })

  registerRoutes(ctx, state)
}

export {
  generateImages,
  handle,
  describeSelection,
  TOOL_PARAMETERS,
  TOOL_OUTPUT_SCHEMA,
  TOOL_DEFINITION,
  SETTINGS_DEFAULTS,
  parseCredentialRefs,
  normalizeSettings,
  mergeSettings,
  readSettings,
  writeSettings,
  readCredential,
  dshHome,
  parseCallSize,
  settingsDomain,
  registerTool,
  DOMAIN,
  TABLE,
  SETTINGS_KEY,
  DOMAIN_SPEC,
  ROUTE_BASE,
  HEADER,
  TOOL_NAME
}