// OpenAI-compatible image generation — CLIENT half.
//
// Two things render in the page:
//
// 1. **A switch in the composer's own tool row** (`conversation.input.left`,
//    the left group of the row that holds the permission picker, the model
//    picker and the send button). It decides whether the `generate_image` tool
//    is *composed into the agent preset*.
//
//    Not under the card: that strip is ambient read-only telemetry (token rate,
//    cache hits, context meter). A control that decides what the model may do
//    belongs with the other composer controls.
//
//    The switch is not a plugin-local flag, and it does not filter a tool at
//    call time. "Injected into the preset" means the tool's Loader row is
//    enabled, which is a composition decision and therefore the exact thing the
//    Plugin Manager already owns. The switch reads that row and calls the same
//    `setPluginEnabled` the Plugin Manager's own row switch calls, so the two
//    can never disagree, and the effect is what the user asked for: the tool
//    row is genuinely mounted into (or removed from) every preset that composes.
//
// 2. **A settings page** on the Plugins screen, hung off this bundle's own row
//    through `plugins.row.config`. It lists the model providers *already
//    configured in DSH* — read from the host half, which reads the Loader's own
//    composition — so the user picks a route and a model instead of retyping an
//    endpoint. It also offers a prompt box that generates an image on the spot,
//    through the same host operation the `generate_image` tool calls.
//
// Only `react` comes from the browser module table. No Harness Client package
// is imported: a plain-JS plugin has no type check, and a throwing component
// blanks the slot entry. Styles use `--dsw-*` theme tokens only, so light and
// dark both come for free.
window.__ModuleLoader__.load({
  id: 'dsh-image-openai',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    /**
     * Where the inject switch sits: the composer's own tool row, in the left
     * group right after the permission and plan controls. This is the row that
     * also holds the model picker and the send button, which is where a control
     * that decides what the model can do belongs — not in the ambient strip
     * below the card, where the token rate and the context meter live.
     */
    const SLOT = 'conversation.input.left'
    /**
     * The settings page on the Plugins screen.
     *
     * Not `plugins.item`: that slot's contract reserves it for the official
     * settings pages and says outright that "a bundle's configuration belongs in
     * `plugins.bundle.config` or `plugins.row.config` instead". This is a bundle
     * row's configuration, so it registers there — keyed
     * `<package name>#<row id>`, the spelling the Plugin Manager dispatches. The
     * effect is that this bundle's row grows a configure control, and the page it
     * opens is the body below.
     */
    const CONFIG_SLOT = 'plugins.row.config'
    const CONFIG_KEY = 'dsh-image-openai#image-openai'
    /**
     * The patch row the switch enables and disables.
     *
     * A ROW, not a bundle. The row id is what the Plugin Manager's override is
     * written under, so this is the identity to look for in `listPlugins()`.
     * Switching a row leaves `dsh.profile.bundles` alone, which is what keeps the
     * switch itself — and the client half it is served from — out of reach of the
     * toggle.
     */
    const TOOL_ROW = 'image-openai-tool'
    /** Route the host half registers, and the header it insists on. */
    const ROUTE = '/dsh-image-openai'
    const HEADER = 'x-dsh-image-openai'

    // --- copy -------------------------------------------------------------------
    // Read through the `locale` service on every render so the switch follows the
    // Harness language without taking on a namespace registration.
    const ZH = {
      label: '生成图片',
      on: '生成图片：已注入到预设',
      off: '生成图片：未注入到预设',
      title: '图像生成（OpenAI 兼容接口）',
      injecting: '正在切换…',
      provider: '模型提供商',
      model: '图像模型',
      size: '尺寸',
      quality: '质量',
      baseURL: '接口地址（Base URL）',
      apiKeyEnv: '密钥引用（留空即可）',
      outputDir: '输出目录',
      prefix: '提示词前缀',
      extra: '额外参数（JSON）',
      save: '保存',
      saved: '已保存',
      saving: '正在读取…',
      prompt: '描述你想生成的图片',
      generate: '生成图片',
      generating: '正在生成…',
      noProvider: '不指定（使用下面的地址）',
      manual: '手动填写',
      hint: '开关决定 generate_image 是否被组合进预设；模型在「设置 → 插件」里配置。',
      pending: '生成图片：重启后生效',
      pendingHint: '已保存，但这个 profile 没有热重载：重启 DSH 后才会真正组合，重启前模型看不到这个工具。',
      summary: '通过任意 OpenAI 兼容接口生成图片，并在这里选择模型。给 generate_image 传 image 参数时改走 /images/edits，编辑你给的那张图。',
      rowMissing: '找不到工具行，插件可能没有正确加载。',
      rowUnaddressable: '这一行无法通过插件页开关（DSH 报告为不可寻址）。',
      failed: '失败：'
    }
    const EN = {
      label: 'Generate image',
      on: 'Generate image: injected into the preset',
      off: 'Generate image: not injected into the preset',
      title: 'Image generation (OpenAI-compatible)',
      injecting: 'Switching…',
      provider: 'Model provider',
      model: 'Image model',
      size: 'Size',
      quality: 'Quality',
      baseURL: 'Base URL',
      apiKeyEnv: 'Credential reference (leave empty)',
      outputDir: 'Output directory',
      prefix: 'Prompt prefix',
      extra: 'Extra parameters (JSON)',
      save: 'Save',
      saved: 'Saved',
      saving: 'Loading…',
      prompt: 'Describe the image you want',
      generate: 'Generate',
      generating: 'Generating…',
      noProvider: 'None (use the URL below)',
      manual: 'Manual',
      hint: 'The switch composes generate_image into the preset; the model is configured in Settings → Plugins.',
      pending: 'Generate image: applies after a restart',
      pendingHint: 'Saved, but this profile has no HMR: the tool is composed at the next start, so the model cannot see it before then.',
      summary: 'Generate images through any OpenAI-compatible endpoint, with the model chosen here. Passing `image` to generate_image switches the call to /images/edits.',
      rowMissing: 'The tool row is missing; this plugin may not have loaded correctly.',
      rowUnaddressable: 'This row cannot be switched from here (DSH reports it unaddressable).',
      failed: 'Failed: '
    }

    /**
     * The two dictionaries, selected from the locale service's live snapshot.
     *
     * The locale face is a `getSnapshot`/`subscribe` pair, so it is read through
     * `useSyncExternalStore` — that is exactly the store shape React wants, and
     * subscribing means a language switch re-renders this row.
     */
    function useCopy(ctx) {
      // `locale` is reached as a PROPERTY, like `slots` and `remote`; a Cordis
      // context resolves services through the proxy, and `ctx.get(...)` is the
      // host-side spelling. Both are tried so the row still renders (in English)
      // if the locale service is absent.
      const locale = ctx.locale ?? ctx.get?.('locale')
      const subscribe = useCallback((notify) => {
        if (typeof locale?.subscribe !== 'function') return () => {}
        return locale.subscribe(notify)
      }, [locale])
      const snapshot = React.useSyncExternalStore(
        subscribe,
        () => (typeof locale?.getSnapshot === 'function' ? locale.getSnapshot() : undefined),
        () => undefined
      )
      const language = snapshot?.active ?? 'en'
      return String(language).toLowerCase().startsWith('zh') ? ZH : EN
    }

    /** One message shape for anything thrown, including a non-Error. */
    const messageOf = (error) => (error instanceof Error ? error.message : String(error))

    /**
     * The message carried by a failed `RemoteResult` envelope.
     *
     * A Remote call resolves even when the Host refused: the failure rides in
     * the envelope as `{ ok: false, error: { message } }` rather than as a
     * rejection, so callers that only try/catch would read the refusal as
     * success.
     */
    const remoteMessage = (answer) => answer?.error?.message ?? answer?.error?.code ?? 'remote call failed'

    // --- host transport ---------------------------------------------------------
    const call = async (path, init) => {
      const response = await fetch(`${ROUTE}${path}`, {
        ...init,
        headers: { [HEADER]: '1', 'content-type': 'application/json', ...(init?.headers ?? {}) }
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
      return payload
    }

    // --- the switch -------------------------------------------------------------
    /**
     * Track, and flip, whether the TOOL ROW is enabled.
     *
     * `ctx.remote.pluginManager` is the same Remote namespace the Plugin Manager
     * page itself calls, which is why the switch and that page can never disagree
     * about the state. The declarations below list it in `inject`, so this plugin
     * simply does not activate on a profile that has no Plugin Manager — better
     * than rendering a control that cannot work.
     *
     * The row, not the bundle. `setPluginEnabled` writes a profile patch override
     * (`- id: image-openai-tool`), which is the same thing the Plugin Manager's own
     * row switch does; `setBundleEnabled` would instead add and remove this
     * package's entry in `dsh.profile.bundles`, and a reconciliation pass that
     * did not yet see the package dropped it — silently turning the tool off.
     * Toggling the row never touches the bundle list, so the switch cannot be
     * pruned away by the machinery that composes the profile.
     *
     * Rows are identified by `entryId`, which the Loader assigns, and addressed
     * for writes by `patchId`, the row id this bundle's patch declares. Both of
     * this bundle's rows name the same package (`dsh-image-openai` and its
     * `./tool` subpath), and `moduleName` would not separate a package from its
     * own subpath cleanly anyway — `patchId` is the identity that does. A row the
     * manager could not address reports no `patchId` and
     * `readOnlyReason` instead — then the switch has nothing to write to, and
     * says so rather than pretending to work.
     *
     * Every Remote call answers a `RemoteResult` envelope — `{ ok: true, value }`
     * or `{ ok: false, error }` — NOT the bare payload. Reading `.value` off the
     * envelope is what the shipped Plugin Manager does too; treating the envelope
     * as the payload is how `bundles.find is not a function` happens.
     */
    function useToolRowState(ctx, copy) {
      const [state, setState] = useState({ status: 'loading', enabled: false, error: '', pending: false })

      const findRow = useCallback(async () => {
        const answer = await ctx.remote.pluginManager.listPlugins()
        if (!answer?.ok) throw new Error(remoteMessage(answer))
        const row = [...(answer.value ?? [])].find((item) => item.patchId === TOOL_ROW)
        if (row === undefined) {
          const named = [...(answer.value ?? [])].filter((item) => item.moduleName === 'dsh-image-openai')
          // `readOnlyReason` is an internal token ('unaddressable',
          // 'management-required'); show the localized wording instead of it.
          throw new Error(named.length === 0 ? copy.rowMissing : copy.rowUnaddressable)
        }
        return row
      }, [ctx, copy])

      const read = useCallback(async (pending = false) => {
        try {
          const row = await findRow()
          setState({ status: 'ready', enabled: row.enabled === true, error: '', pending })
        } catch (error) {
          setState({ status: 'error', enabled: false, error: messageOf(error), pending: false })
        }
      }, [findRow])

      useEffect(() => { read() }, [read])

      const toggle = useCallback(async (next) => {
        setState((current) => ({ ...current, status: 'busy', error: '' }))
        try {
          const row = await findRow()
          const answer = await ctx.remote.pluginManager.setPluginEnabled(row.entryId, next)
          if (!answer?.ok) throw new Error(remoteMessage(answer))
          const application = answer.value?.application
          if (application === 'failed') {
            setState({ status: 'ready', enabled: !next, error: answer.value?.error?.code ?? 'failed', pending: false })
            return
          }
          // `restart-required` is a success, and on this profile it is the ONLY
          // outcome: the desktop profile has no HMR, so a composition change is
          // saved to the profile patch and applied at the next start. Reporting
          // it as applied would be a lie the user only discovers by asking the
          // model — so the switch says so instead, and keeps saying so until the
          // host restarts and re-reads the row.
          await read(application === 'restart-required')
        } catch (error) {
          setState({ status: 'ready', enabled: !next, error: messageOf(error) })
        }
      }, [ctx, read])

      return { ...state, toggle }
    }

    // --- styles -----------------------------------------------------------------
    // One inline stylesheet, registered as an effect so unmounting removes it.
    const CSS_ID = 'dsh-image-openai/ImageTool.css'
    const CSS = `
/* In the composer tool row: a compact control beside the permission picker, so
   no box, no full width, and the same 20px line height as its neighbours. */
.dsio-inline { display: inline-flex; align-items: center; min-width: 0; }
.dsio-switch { display: inline-flex; align-items: center; gap: 6px; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 20px; padding: 2px 6px; border-radius: var(--dsw-radius-md, 6px); cursor: pointer; }
.dsio-switch:hover { background: var(--dsw-alias-bg-l2); color: var(--dsw-alias-label-primary); }
.dsio-switch[aria-checked="true"] { color: var(--dsw-alias-label-primary); }
.dsio-track { position: relative; flex: none; width: 28px; height: 16px; border-radius: 8px; background: var(--dsw-alias-border-l2); transition: background 120ms ease; }
.dsio-switch[aria-checked="true"] .dsio-track { background: var(--dsw-alias-brand-primary); }
.dsio-knob { position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--dsw-alias-bg-base, #fff); transition: transform 120ms ease; }
.dsio-switch[aria-checked="true"] .dsio-knob { transform: translateX(12px); }
/* Saved but not yet live (this profile has no HMR): the knob has moved, the
   track is outlined rather than filled, so "on but pending" cannot be mistaken
   for "on and working". */
.dsio-switch[data-pending="true"] .dsio-track { background: transparent; box-shadow: inset 0 0 0 1px var(--dsw-alias-brand-primary); }
.dsio-switch[data-pending="true"] .dsio-knob { background: var(--dsw-alias-brand-primary); }
.dsio-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The settings page body on the Plugins screen. No outer chrome of its own: the
   page already sits inside the row's section, so it must not draw a second card. */
.dsio-page { box-sizing: border-box; display: flex; flex-direction: column; gap: 10px; width: 100%; }
.dsio-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px 12px; }
.dsio-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dsio-label { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.dsio-input, .dsio-select, .dsio-area { box-sizing: border-box; width: 100%; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md, 6px); background: var(--dsw-alias-bg-base, transparent); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 20px; padding: 4px 8px; }
.dsio-area { resize: vertical; min-height: 56px; }
.dsio-input:focus, .dsio-select:focus, .dsio-area:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsio-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsio-button { border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md, 6px); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 20px; padding: 4px 12px; cursor: pointer; }
.dsio-button:hover:not(:disabled) { background: var(--dsw-alias-bg-l2); }
.dsio-button[data-primary="true"] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-inverted, #fff); }
.dsio-button:disabled { opacity: 0.5; cursor: default; }
.dsio-status { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.dsio-error { color: var(--dsw-alias-label-error, #d93025); font-size: 11px; line-height: 16px; overflow-wrap: anywhere; }
.dsio-files { display: flex; flex-direction: column; gap: 6px; }
.dsio-file { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; overflow-wrap: anywhere; }
.dsio-thumb { max-width: 160px; max-height: 160px; border-radius: var(--dsw-radius-md, 6px); border: 1px solid var(--dsw-alias-border-l1); }
`
    function useStyles() {
      useEffect(() => {
        if (document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) !== null) return undefined
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-image-openai'
        tag.dataset.pluginCss = CSS_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => { tag.remove() }
      }, [])
    }

    // --- settings + generation --------------------------------------------------
    function useImageState(ctx, copy) {
      const [config, setConfig] = useState(null)
      const [draft, setDraft] = useState(null)
      const [status, setStatus] = useState('')
      const [error, setError] = useState('')
      const [prompt, setPrompt] = useState('')
      const [busy, setBusy] = useState(false)
      const [files, setFiles] = useState([])

      useEffect(() => {
        let cancelled = false
        call('/settings')
          .then((payload) => {
            if (cancelled) return
            setConfig(payload)
            setDraft(payload.settings ?? {})
          })
          .catch((failure) => { if (!cancelled) setError(String(failure.message ?? failure)) })
        return () => { cancelled = true }
      }, [])

      const save = useCallback(async () => {
        setStatus(copy.saving); setError('')
        try {
          await call('/settings', { method: 'POST', body: JSON.stringify({ settings: draft }) })
          setStatus(copy.saved)
          const payload = await call('/settings')
          setConfig(payload)
          setDraft(payload.settings ?? {})
        } catch (failure) {
          setStatus(''); setError(String(failure.message ?? failure))
        }
      }, [draft, copy])

      const generate = useCallback(async () => {
        setBusy(true); setError(''); setFiles([])
        try {
          const payload = await call('/generate', { method: 'POST', body: JSON.stringify({ prompt }) })
          setFiles(payload.files ?? [])
        } catch (failure) {
          setError(String(failure.message ?? failure))
        } finally {
          setBusy(false)
        }
      }, [prompt])

      const set = useCallback((key) => (event) => {
        const value = event?.target?.value ?? ''
        setDraft((current) => ({ ...(current ?? {}), [key]: value }))
      }, [])

      return { config, draft, set, setDraft, save, generate, prompt, setPrompt, busy, files, status, error }
    }

    // --- the settings page on the Plugins screen ---------------------------------
    /**
     * The configuration body the Plugin Manager opens from this bundle's row.
     *
     * The owner calls this component twice with different `view`s: `summary` for
     * the row's one-liner, and `page` for the body of the row's own page. `form`
     * is absent, because this plugin's settings are its own storage document
     * rather than a Host-served config namespace, so the page draws its own
     * controls and talks to the routes in the host half.
     */
    function ImageSettings(props) {
      const { ctx, copy, state, view } = props
      const { config, draft, set, setDraft, save, generate, prompt, setPrompt, busy, files, status, error } = state

      if (view === 'summary') return h('span', null, copy.summary)

      if (draft === null) {
        return h('div', { className: 'dsio-page' },
          h('div', { className: 'dsio-status' }, error === '' ? copy.saving : `${copy.failed}${error}`))
      }

      const providers = config?.providers ?? []
      const selected = providers.find((provider) => provider.id === (draft.provider ?? ''))
      const models = selected?.models ?? []

      const field = (label, key, options = {}) => h('label', { className: 'dsio-field', key },
        h('span', { className: 'dsio-label' }, label),
        h('input', {
          className: 'dsio-input',
          value: draft[key] ?? '',
          placeholder: options.placeholder ?? '',
          onChange: set(key),
          spellCheck: false
        })
      )

      return h('div', { className: 'dsio-page' },
        h('div', { className: 'dsio-grid' },
          h('label', { className: 'dsio-field' },
            h('span', { className: 'dsio-label' }, copy.provider),
            h('select', {
              className: 'dsio-select',
              value: draft.provider ?? '',
              onChange: (event) => setDraft((current) => ({ ...current, provider: event.target.value, model: '' }))
            },
              h('option', { value: '' }, copy.noProvider),
              ...providers.map((provider) => h('option', { key: provider.id, value: provider.id }, `${provider.id} (${provider.api || 'openai-completions'})`))
            )
          ),
          h('label', { className: 'dsio-field' },
            h('span', { className: 'dsio-label' }, copy.model),
            models.length > 0
              ? h('select', { className: 'dsio-select', value: draft.model ?? '', onChange: set('model') },
                  h('option', { value: '' }, copy.manual),
                  ...models.map((model) => h('option', { key: model.id, value: model.id }, model.name))
                )
              : h('input', { className: 'dsio-input', value: draft.model ?? '', onChange: set('model'), spellCheck: false })
          ),
          field(copy.baseURL, 'baseURL', { placeholder: selected?.baseURL || 'https://api.openai.com/v1' }),
          field(copy.apiKeyEnv, 'apiKeyEnv', { placeholder: selected?.apiKeyEnv || 'OPENAI_API_KEY' }),
          // The effective default is `auto`, so the empty box shows exactly that:
          // an empty size is not "unset", it is the provider's own choice.
          field(copy.size, 'size', { placeholder: 'auto' }),
          field(copy.quality, 'quality', { placeholder: 'standard' }),
          field(copy.outputDir, 'outputDir', { placeholder: '~/.dsh/dsh-image-openai' }),
          field(copy.prefix, 'promptPrefix')
        ),
        h('label', { className: 'dsio-field' },
          h('span', { className: 'dsio-label' }, copy.extra),
          h('input', { className: 'dsio-input', value: draft.extraJson ?? '', onChange: set('extraJson'), spellCheck: false, placeholder: '{"style":"vivid"}' })
        ),
        h('div', { className: 'dsio-actions' },
          h('button', { className: 'dsio-button', type: 'button', onClick: save }, copy.save),
          status === '' ? null : h('span', { className: 'dsio-status' }, status)
        ),
        h('div', { className: 'dsio-actions' },
          h('input', {
            className: 'dsio-input',
            style: { flex: '1 1 240px' },
            value: prompt,
            placeholder: copy.prompt,
            onChange: (event) => setPrompt(event.target.value)
          }),
          h('button', {
            className: 'dsio-button',
            type: 'button',
            'data-primary': 'true',
            disabled: busy || prompt.trim() === '',
            onClick: generate
          }, busy ? copy.generating : copy.generate)
        ),
        error === '' ? null : h('div', { className: 'dsio-error' }, `${copy.failed}${error}`),
        files.length === 0 ? null : h('div', { className: 'dsio-files' },
          ...files.map((file) => h('div', { className: 'dsio-file', key: file.path },
            h('div', null, file.path),
            h('img', { className: 'dsio-thumb', alt: '', src: `data:${file.mimeType};base64,${file.base64 ?? ''}` })
          ))
        )
      )
    }

    /**
     * The registration entry for the Plugins screen.
     *
     * It owns the hooks so `ImageSettings` can stay a plain render function: the
     * owner calls the entry once per view, and each view needs its own settings
     * state. `useImageState` reads the document from the host routes either way,
     * so the two views never disagree about what is saved.
     */
    function ImageSettingsPage(props) {
      const ctx = props.ctx ?? props.useCtx?.()
      const copy = useCopy(ctx)
      useStyles()
      const state = useImageState(ctx, copy)
      return h(ImageSettings, { ctx, copy, state, view: props.view ?? 'page' })
    }

    // --- the composer switch -----------------------------------------------------
    /**
     * The row under the composer: the inject switch and nothing else.
     *
     * The settings deliberately do not live here. They are this bundle row's
     * configuration, so they belong on the Plugins screen, reachable from the
     * row's configure control — one home for them instead of two that can
     * disagree.
     */
    function ImageToolRow(props) {
      const ctx = props.ctx ?? props.useCtx?.()
      const copy = useCopy(ctx)
      useStyles()
      const bundle = useToolRowState(ctx, copy)

      const onToggle = useCallback(() => { bundle.toggle(!bundle.enabled) }, [bundle])

      // The face is four characters: this control shares a crowded row with
      // the permission picker and the model picker. The state is still carried
      // three other ways — the track's colour and knob position, `aria-checked`,
      // and the tooltip — so nothing is lost, it just is not spelled inline.
      const state = bundle.status === 'busy'
        ? copy.injecting
        : bundle.pending ? copy.pending : bundle.enabled ? copy.on : copy.off

      // No wrapper box of its own: the composer tool row already provides the
      // flex row, the gap and the vertical rhythm. An extra padded container
      // here made the switch taller than the permission control beside it.
      return h('div', { className: 'dsio-inline' },
        h('button', {
          className: 'dsio-switch',
          type: 'button',
          role: 'switch',
          'aria-checked': bundle.enabled ? 'true' : 'false',
          // A saved-but-not-live choice is neither on nor off yet, so it gets its
          // own visual state: an outlined track with the knob already moved.
          'data-pending': bundle.pending ? 'true' : 'false',
          'aria-label': state,
          title: bundle.error === ''
            ? `${state}。${bundle.pending ? copy.pendingHint : copy.hint}`
            : bundle.error,
          disabled: bundle.status === 'busy' || bundle.status === 'error',
          onClick: onToggle
        },
          h('span', { className: 'dsio-track' }, h('span', { className: 'dsio-knob' })),
          h('span', { className: 'dsio-text' }, copy.label)
        )
      )
    }

    return {
      // Every service this plugin touches, spelled out.
      //
      // BOTH segments of a nested namespace are required, not just the leaf:
      // Cordis resolves each property through its own inject entry, so naming
      // only `remote.pluginManager` throws "cannot get property remote without
      // inject" on the first access. The shipped Plugin Manager declares
      // `remote` and `remote.pluginManager` side by side for exactly this
      // reason.
      //
      // Declaring them also means this plugin stays inactive on a profile with
      // no Plugin Manager, instead of rendering a switch that throws on click.
      inject: ['slots', 'locale', 'remote', 'remote.pluginManager'],
      apply(ctx) {
        // The switch under the composer.
        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          id: 'dsh-image-openai',
          order: 40
        }, (props) => h(ImageToolRow, { ...props, ctx })))

        // The settings page, hung on this bundle's own row on the Plugins screen.
        // The component is mounted once per view, so the shared state below is
        // created per view rather than per page.
        ctx.slots.inject(CONFIG_SLOT, () => ctx.slots.register({
          name: CONFIG_SLOT,
          key: CONFIG_KEY
        }, (props) => h(ImageSettingsPage, { ...props, ctx })))
      }
    }
  }
})
