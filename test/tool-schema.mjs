/**
 * Verifies the hand-written tool schema against the Harness's own compiler.
 *
 * `generate_image` cannot use `defineTool`: that helper is a module export of
 * `@deepseek-ai/dsh-tools`, and a plugin installed from outside the app cannot
 * import it. Bare specifiers resolve from the profile directory (no
 * `@deepseek-ai/*` there), and a symlink into the app archive fails one step
 * later — Node's ESM package resolver reads `package.json` through unpatched
 * internals, so it cannot see inside an asar and reports `ERR_MODULE_NOT_FOUND`
 * for a file that is present.
 *
 * So the plugin writes the COMPILED schema directly, which is only safe if
 * "compiled" is exactly what `defineTool` would have produced. That is what this
 * file checks, by running the real compiler over the equivalent DSL and
 * comparing. If a Harness upgrade changes either projection, this fails loudly
 * instead of the tool quietly losing a parameter.
 *
 * Plain `node` cannot resolve `@deepseek-ai/…`, so run it through the app's Node:
 *
 *   ELECTRON_RUN_AS_NODE=1 \
 *     "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     test/tool-schema.mjs
 */

import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh'
const req = createRequire(`${ASAR}/package.json`)
const { defineTool, assertSupportedJsonSchema, parameterSchemaSpecToJsonSchema, valueSchemaSpecToJsonSchema } = req('@deepseek-ai/dsh-tools')

const plugin = await import(new URL('../src/index.js', import.meta.url).href)

let failures = 0
/**
 * Awaited, so an async check cannot "pass" by printing its label before its
 * assertions settle. Every call site must await this.
 */
const check = async (label, fn) => {
  try {
    await fn()
    console.log(`  ok  ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL  ${label}\n      ${error.message}`)
  }
}

console.log('generate_image schema (against the real compiler)')

/**
 * The DSL this plugin used before, kept here as the reference source of truth.
 * It is the definition's INTENT; the plugin ships the compiled form.
 */
const REFERENCE_DSL = {
  name: plugin.TOOL_NAME,
  description: 'x',
  parameters: {
    prompt: {
      type: 'string',
      required: true,
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
      description: "Path of an input image to edit. Pass it to run the provider's image-edit endpoint instead of text-to-image; relative paths resolve against the Session working directory. Omit it to generate from the prompt alone."
    }
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        model: { type: 'string', required: true },
        files: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              mimeType: { type: 'string', required: true }
            }
          }
        }
      }
    },
    render: () => []
  },
  async execute() { return { model: '', files: [] } }
}

const compiled = defineTool(REFERENCE_DSL)

await check('the shipped parameter schema equals what defineTool compiles', () => {
  assert.deepEqual(plugin.TOOL_PARAMETERS, compiled.parameters)
})

await check('the shipped output schema equals what defineTool compiles', () => {
  assert.deepEqual(plugin.TOOL_OUTPUT_SCHEMA, compiled.output.schema)
})

await check('the step-by-step projections agree too, not just the whole object', () => {
  // Compared per projection as well, so a failure names which half drifted.
  assert.deepEqual(plugin.TOOL_PARAMETERS, parameterSchemaSpecToJsonSchema(REFERENCE_DSL.parameters))
  assert.deepEqual(plugin.TOOL_OUTPUT_SCHEMA, valueSchemaSpecToJsonSchema(REFERENCE_DSL.output.schema))
})

await check('both schemas are inside the subset the registry enforces', () => {
  // `tools.register` rejects an unsupported schema outright, so a schema outside
  // the subset fails the whole registration — the tool simply would not exist.
  assertSupportedJsonSchema(plugin.TOOL_OUTPUT_SCHEMA)
  // Parameters are model-facing only, but the same subset keeps them renderable.
  assertSupportedJsonSchema(plugin.TOOL_PARAMETERS)
})

await check('the schemas are lossless JSON, as schema projection requires', () => {
  // `schemaOf` throws "parameters must be lossless JSON before schema projection"
  // for anything JSON.stringify cannot round-trip (a function, undefined, a cycle).
  for (const [label, schema] of [['parameters', plugin.TOOL_PARAMETERS], ['output', plugin.TOOL_OUTPUT_SCHEMA]]) {
    assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema, `${label} is not lossless JSON`)
  }
})

await check('the definition a registry would accept is complete', () => {
  // Mirrors the checks `tools.register` performs before inserting: an output
  // object carrying a render function, and a supported output schema.
  const definition = plugin.TOOL_DEFINITION?.({ logger: {} }, { config: {}, stored: undefined })
  if (definition === undefined) return // not exported: covered by the static suite
  assert.equal(typeof definition.name, 'string')
  assert.equal(definition.name, plugin.TOOL_NAME)
  assert.equal(typeof definition.description, 'string')
  assert.equal(typeof definition.output, 'object')
  assert.equal(typeof definition.output.render, 'function')
  assert.equal(typeof definition.execute, 'function')
  assertSupportedJsonSchema(definition.output.schema)
  assert.deepEqual(definition.output.render({}, { files: [{ path: '/tmp/a.png' }] }), [{ type: 'text', text: 'Generated /tmp/a.png' }])
})

// --- registration into the REAL ToolRuntime ---------------------------------
//
// The check that matters most. The plugin used to fetch `defineTool` from a
// non-existent `dsh-tools` service and RETURN SILENTLY when it was missing, so
// `tools.register` was never reached: the row activated, nothing errored, and
// the model simply had no such tool. Only registering into the real runtime
// proves the definition is one the registry accepts.

console.log('\nregistration into the real ToolRuntime')

const cordis = req('@deepseek-ai/cordis')
const ToolRuntime = req('@deepseek-ai/dsh-tools').default

/** A root context with the one service ToolRuntime injects. */
const runtimeContext = () => {
  const root = new cordis.Context()
  // ToolRuntime declares `static inject = ['systemPrompt']`; a stub is enough to
  // let the real service activate, and nothing here reads the prompt.
  root.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 0 })
  root.plugin(ToolRuntime)
  return root
}

await check('the real registry accepts the definition and the model sees the tool', async () => {
  const root = runtimeContext()
  await new Promise((resolve) => setTimeout(resolve, 80))
  const tools = root.get('tools')
  assert.ok(tools !== undefined, 'the real ToolRuntime must activate')

  const warnings = []
  plugin.registerTool(
    { tools, effect: (fn) => fn(), logger: { warn: (message) => warnings.push(message) } },
    { config: {}, stored: undefined }
  )

  const visible = [...tools.view(undefined).visible.keys()]
  assert.ok(visible.includes(plugin.TOOL_NAME), `generate_image must be registered, saw ${JSON.stringify(visible)}`)
  assert.deepEqual(warnings, [], 'registration must not need to warn')

  const projected = tools.schemas(undefined).find((schema) => schema.name === plugin.TOOL_NAME)
  assert.ok(projected !== undefined, 'the tool must project to a model-facing schema')
  assert.deepEqual(projected.parameters.required, ['prompt'], 'the required argument must survive projection')
  assert.ok(projected.description.length > 0, 'the model needs a description')
  // A per-call size survives projection too, with `auto` named as the default.
  const size = projected.parameters.properties.size
  assert.ok(size !== undefined, 'the model must be told about the size parameter')
  assert.equal(size.type, 'string')
  assert.match(size.description, /"auto" is|default "auto"/)
  // The edit capability is only reachable if the parameter survives projection.
  const image = projected.parameters.properties.image
  assert.ok(image !== undefined, 'the model must be told about the image parameter')
  assert.equal(image.type, 'string')
  assert.match(image.description, /image-edit endpoint/)
})

await check("the tool subpath's own apply registers the tool end to end", async () => {
  // The closest thing to what the host does at boot: import the specifier the
  // tool ROW names and run ITS apply. This covers the parts the unit checks above
  // cannot — that `dsh-image-openai/tool` actually resolves through the package's
  // `exports` (the row would fail to load if the subpath were not exported), that
  // the module's own `import { readSettings, registerTool } from '../src/index.js'`
  // works, that the exported `inject` matches the service the registry uses, and
  // that nothing in the row's wiring throws before registration.
  const subpath = new URL('../tool/index.js', import.meta.url).href
  const toolPackage = await import(subpath)
  assert.deepEqual(toolPackage.inject, ['tools'], 'the row must declare the registry it needs')
  // The row names this specifier, so the module's own `name` must match it.
  assert.equal(toolPackage.name, 'dsh-image-openai/tool')

  const root = runtimeContext()
  await new Promise((resolve) => setTimeout(resolve, 80))
  const tools = root.get('tools')
  assert.ok(tools !== undefined)

  const warnings = []
  const ctx = {
    tools,
    // No storageDomain here: reads must degrade rather than throw, because the
    // tool has to work in a profile whose settings were never written.
    get: (name) => (name === 'tools' ? tools : undefined),
    effect: (fn) => fn(),
    logger: { warn: (message) => warnings.push(message) }
  }
  toolPackage.apply(ctx, {})
  await new Promise((resolve) => setTimeout(resolve, 20))

  const visible = [...tools.view(undefined).visible.keys()]
  assert.ok(visible.includes('generate_image'), `generate_image must be visible, saw ${JSON.stringify(visible)}`)
  assert.deepEqual(warnings, [], 'the row must register without warning')
})

await check('a missing tools service warns instead of failing silently', () => {
  // The bug's actual shape: no error, no tool, nothing to diagnose.
  const warnings = []
  plugin.registerTool({ get: () => undefined, logger: { warn: (message) => warnings.push(message) } }, { config: {}, stored: undefined })
  assert.equal(warnings.length, 1, 'a tool that cannot register must say so')
  assert.match(warnings[0], /generate_image was not registered/)
})

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)