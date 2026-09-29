/**
 * The optional half of dsh-image-openai: the `generate_image` tool, and nothing
 * else. The switch in the composer, the settings page and the HTTP routes all
 * live in the parent module; this one exists so the tool can be switched off
 * without switching off the control that turns it back on.
 *
 * ## Why a subpath and not a second package
 *
 * The Plugins screen titles a Loader row with the display metadata of the
 * specifier that row names (`packages.metaOf(row.name, base)`), and that lookup
 * reads `<specifier>/locale/<language>.json` plus `<specifier>/package.json`
 * THROUGH THE SPECIFIER — not through the bare package name. So a subpath
 * specifier carries its own title, description and icon while remaining one
 * package:
 *
 *     dsh-image-openai        -> locale/*.json        "Image generation"
 *     dsh-image-openai/tool   -> tool/locale/*.json   "Image tool row (optional)"
 *
 * Two rows of one package would otherwise render with one title, which is the
 * only reason the tool once lived in a sibling package. A subpath gets the same
 * distinct labelling without the second package, the second `node_modules`
 * entry, or the `link:` dependency between them.
 *
 * Two `exports` entries make that work, and both are load-bearing:
 * `./tool/locale/*.json` (the label lookup resolves every language through the
 * full specifier) and `./tool/package.json` (the icon is read from the manifest
 * that specifier resolves to). Miss either and the row silently falls back to
 * the package name, or loses its icon.
 *
 * ## What it deliberately does not declare
 *
 * No `dsh.bundle` — a profile dependency that IS a bundle is listed as
 * installed, so staying out of that list keeps the Plugins screen at one
 * installed entry. No `dsh.client` either, so `dsh.client` has exactly one
 * declarer and the composer gets exactly one switch.
 *
 * It owns no behaviour. It builds the same closure state the page's routes use
 * and hands it to `registerTool` from the parent module — one implementation of
 * the image call and one settings document, so the settings page's button and
 * the model's tool cannot drift apart.
 */

import { readSettings, registerTool, TOOL_NAME } from '../src/index.js'

export const name = 'dsh-image-openai/tool'

/**
 * This row is useless without the tool registry, so it declares the dependency
 * instead of probing for it: a profile without `tools` leaves the row inactive
 * rather than half-applied.
 *
 * The page half declares nothing — it only serves HTTP routes and the client
 * switch, and must keep working for a user who never enables the tool.
 */
export const inject = ['tools']

/**
 * Register `generate_image` for this profile.
 *
 * `config` is the patch row's config, so a profile can pin a default model or
 * prefix here exactly as it can on the page's own row. `stored` is the settings
 * document both halves read, warmed here so the first tool call does not pay
 * for a storage read.
 */
export function apply(ctx, config) {
  const state = {
    config: config ?? {},
    stored: undefined
  }

  // Absent storage is normal and does not reject; a rejection is a real failure,
  // so it is reported rather than swallowed.
  readSettings(ctx)
    .then((stored) => { state.stored = stored })
    .catch((error) => { ctx.logger?.warn?.('dsh-image-openai/tool: settings could not be read; using the row config only', error) })

  registerTool(ctx, state)
}

export { TOOL_NAME }
