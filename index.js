/**
 * @local/dsh-magpie — Host half (manual-install edition).
 *
 * Changes from the original:
 *   - No automatic engine start or model sync on activation. The user installs
 *     the binary and starts the engine explicitly from the UI.
 *   - New local routes for manual install, GitHub mirror config and duplicate
 *     installation detection.
 *
 * HTTP routes (loopback only, under the DSH origin):
 *   GET  /api/dsh-magpie/status            engine + install status
 *   GET  /api/dsh-magpie/install/status    install state, mirror, duplicate detection
 *   POST /api/dsh-magpie/install/config    save GitHub mirror / settings
 *   POST /api/dsh-magpie/install           start manual download (async)
 *   POST /api/dsh-magpie/uninstall         fully remove engine, data and provider
 *   GET  /api/dsh-magpie/gui               embedded GUI URL (starts engine on demand)
 *   GET  /api/dsh-magpie/models            models discovered from the Magpie gateway
 *   POST /api/dsh-magpie/sync-models       (re)register models into DSH
 *   GET  /api/dsh-magpie/ui/*              reverse proxy to the official Web UI
 *   POST /api/dsh-magpie/start / stop / reset
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  createMagpieEngine, UI_MOUNT, DEFAULT_MIRROR, normalizeMirror,
  detectExistingMagpie, managedBinaryInfo,
} from './magpie-engine.js'

// Directory holding this plugin's own package. pnpm removes it only on a real
// bundle uninstall; it briefly disappears and returns during an update, which
// gives us a reliable second signal that cleanup is actually wanted.
const SELF_DIR = fileURLToPath(new URL('.', import.meta.url))

// Uninstall coordination is kept on globalThis so it survives HMR reloads and
// module re-evaluation: the disposing instance and the freshly applied one
// must observe the same pending state.
const UNINSTALL_STATE_KEY = Symbol.for('dsh-magpie.uninstall-state')
// Grace window after a remove operation before purging. An update removes and
// immediately reinstalls the bundle; this window lets its `install` event land
// so we can cancel. The self-directory check is a second guard.
const PURGE_DELAY_MS = 12000

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DATA_DIR = join(DSH_HOME, 'dsh-magpie-engine')
const LEGACY_DATA_DIR = join(DSH_HOME, 'magpie-shell-engine')
// Plugin settings live OUTSIDE the engine data directory so uninstalling the
// engine (which deletes DATA_DIR entirely) never destroys the user's mirror.
const SETTINGS_FILE = join(DSH_HOME, 'dsh-magpie-settings.json')
// Migration marker lives outside DATA_DIR: uninstalling the engine deletes
// DATA_DIR, and we must not re-create it on the next DSH start.
const LEGACY_MIGRATION_MARKER = join(DSH_HOME, '.dsh-magpie-legacy-migrated')

// The provider route name registered into @deepseek-ai/dsh-llm-pi-ai.
const MODEL_PROVIDER_ID = 'magpie'
const PI_AI_ENTRY_ID = 'llm-pi-ai'
// Bundle package name, used to recognise a genuine uninstall operation.
const BUNDLE_PACKAGE = 'dsh-magpie'

const DEFAULT_SETTINGS = {
  mirror: DEFAULT_MIRROR,
}

// Only these keys are persisted/exposed. Keeps the settings file free of
// abandoned fields (e.g. the old `autoStart`, which is not implemented).
function sanitizeSettings(input) {
  const source = input && typeof input === 'object' ? input : {}
  return {
    mirror: normalizeMirror(source.mirror ?? DEFAULT_MIRROR),
  }
}

/**
 * One-time migration from the pre-rename data directory. Copies user-owned
 * Magpie state (config, agent home, plugins) into the new directory while
 * keeping the new directory's already-downloaded binary and cache.
 */
async function migrateLegacyData(logger) {
  const marker = LEGACY_MIGRATION_MARKER
  try {
    const { access } = await import('node:fs/promises')
    await access(marker)
    return // already migrated
  } catch {
    // no marker yet — continue
  }
  try {
    const { access, mkdir, cp, writeFile, readdir } = await import('node:fs/promises')
    await access(LEGACY_DATA_DIR)
    await mkdir(DATA_DIR, { recursive: true })
    for (const name of ['config', 'agent-home', 'data', 'state']) {
      const from = join(LEGACY_DATA_DIR, 'magpie', name)
      const to = join(DATA_DIR, 'magpie', name)
      try {
        await access(from)
        const entries = await readdir(from)
        await mkdir(to, { recursive: true })
        let copied = 0
        for (const entry of entries) {
          try {
            await cp(join(from, entry), join(to, entry), { recursive: true, force: true })
            copied++
          } catch {
            // Skip locked/unreadable entry; the engine will recreate it.
          }
        }
        if (copied) logger?.info?.(`[dsh-magpie] migrated legacy ${name} (${copied} entries)`)
      } catch {
        // Missing in legacy dir — nothing to migrate for this part.
      }
    }
    await writeFile(marker, new Date().toISOString(), 'utf8')
  } catch {
    // Legacy directory absent or unreadable — nothing to migrate.
  }
}

export const inject = ['webServer', 'configEditor']

export function apply(ctx) {
  // Capture long-lived service references early. During disposal these may no
  // longer be reachable from `ctx`, but a deferred purge still needs them.
  const logger = ctx.logger
  const configEditor = ctx.configEditor

  // ---- Uninstall intent tracking ------------------------------------------
  // The plugin disposer also runs on DSH restart, HMR reload, plugin disable
  // and bundle update. Deleting the ~100 MB engine in any of those cases would
  // be destructive, so we only purge when a real `remove` operation was seen,
  // and cancel if an `install` follows (an update removes then reinstalls).
  const uninstallState = (globalThis[UNINSTALL_STATE_KEY] ??= {
    removing: false,
    generation: 0,
  })
  // A stale listener from a previous activation would keep its own closures
  // alive; dispose it and install a fresh one bound to this activation.
  uninstallState.disposeListener?.()
  const onManagerOperation = (op) => {
    if (!op || typeof op !== 'object') return
    const target = String(op.target ?? '')
    // Only events about this bundle matter. Installs of a Git-sourced bundle
    // may report a null target, so while a removal is pending treat those as
    // ours; a null target never starts a removal on its own.
    const isSelf = target === BUNDLE_PACKAGE || (target === '' && uninstallState.removing)
    if (!isSelf) return
    if (op.phase === 'started') {
      if (op.reason === 'remove' && op.stage === 'remove') {
        uninstallState.removing = true
        uninstallState.generation++
      } else if (op.reason === 'install' || op.stage === 'enable') {
        // A reinstall/update or re-enable supersedes the removal.
        uninstallState.removing = false
        uninstallState.generation++
      }
      return
    }
    // A failed or cancelled removal must not leave a stale intent that a
    // later, unrelated disposal could act on.
    if (op.phase === 'settled' && op.reason === 'remove' && op.stage === 'remove'
        && (op.application === 'failed' || op.application === 'cancelled')) {
      uninstallState.removing = false
      uninstallState.generation++
    }
  }
  // Register on the root event bus so the listener survives this plugin's own
  // disposal (needed to observe the reinstall/update event that arrives after
  // the remove phase disposes us). Fall back to ctx on runtimes without root.
  const eventHost = ctx.root ?? ctx
  uninstallState.disposeListener = eventHost.on('plugin-manager/operation', onManagerOperation)

  // Migration must finish before any engine work.
  const migration = migrateLegacyData(ctx.logger).catch((error) => {
    ctx.logger?.warn?.(`[dsh-magpie] legacy data migration failed: ${String(error?.message ?? error)}`)
  })

  // ---- Settings persistence (mirror, etc.) --------------------------------
  let settings = { ...DEFAULT_SETTINGS }

  async function loadSettings() {
    const { readFile, unlink } = await import('node:fs/promises')
    try {
      const text = await readFile(SETTINGS_FILE, 'utf8')
      settings = sanitizeSettings(JSON.parse(text))
    } catch {
      // One-time migration: older versions stored settings inside DATA_DIR.
      // Pull the mirror out, then remove the stale file so nothing is left over.
      try {
        const text = await readFile(join(DATA_DIR, 'settings.json'), 'utf8')
        settings = sanitizeSettings(JSON.parse(text))
        await saveSettings(settings)
        await unlink(join(DATA_DIR, 'settings.json')).catch(() => {})
        ctx.logger?.info?.('[dsh-magpie] migrated settings out of engine data directory')
      } catch {
        settings = { ...DEFAULT_SETTINGS }
      }
    }
    return settings
  }

  async function saveSettings(next) {
    const { writeFile } = await import('node:fs/promises')
    settings = sanitizeSettings({ ...settings, ...next })
    await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8')
    return settings
  }

  const engine = createMagpieEngine({
    dataDir: DATA_DIR,
    logger: ctx.logger,
    getMirror: () => settings.mirror,
  })

  const disposers = []

  // Set while the data directory is removed (and kept until a fresh install)
  // so leftover GUI/iframe requests cannot restart the engine and re-create
  // the directory in the middle of an uninstall.
  let engineDisabled = false
  // Incremented whenever an uninstall begins. Long async operations capture
  // the current value and re-check it before side effects, so an uninstall
  // that starts mid-flight cannot be undone by a late writeback or a late
  // engine restart (which would recreate the data directory being deleted).
  let operationEpoch = 0
  function epochChanged(epoch) {
    return engineDisabled || epoch !== operationEpoch
  }

  // A locked data directory (common on Windows just after the child exits)
  // can make a purge partial. Retry a bounded number of times in the
  // background so a transient lock cannot leave the engine directory behind.
  let purgeRetryCount = 0

  function sendJson(res, code, body) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  function isLoopbackHost(host) {
    return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(String(host ?? ''))
  }

  // The DSH GUI origin, used to reject cross-site state-changing requests.
  // Computed lazily because the webServer service may settle after apply().
  function dshOrigin() {
    try {
      const raw = ctx.webServer?.getOrigin?.()
      return raw ? new URL(raw).origin : null
    } catch {
      return null
    }
  }

  function admit(req, res) {
    const host = String(req.headers.host ?? '')
    if (!isLoopbackHost(host)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return false
    }
    // CSRF defence for state-changing methods. Browsers attach Origin on
    // cross-site POST/PUT/...; a malicious page must not be able to drive
    // /install, /uninstall, /start, /sync-models, etc. Requests without an
    // Origin header (curl, CLI tools) are not browser-CSRF-capable and pass.
    const method = String(req.method || 'GET').toUpperCase()
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      // Sec-Fetch-Site is set by the browser and cannot be forged by page JS.
      // Reject explicit cross-site requests even without an Origin header.
      const site = req.headers['sec-fetch-site']
      if (site && site !== 'same-origin' && site !== 'none') {
        sendJson(res, 403, { ok: false, error: 'forbidden site' })
        return false
      }
      const origin = req.headers.origin
      if (origin) {
        let originOrigin = null
        try { originOrigin = new URL(origin).origin } catch { /* malformed */ }
        // A genuine same-origin request's Origin always equals scheme://Host.
        // Accept both http and https variants of this Host, plus the DSH-
        // advertised origin when available.
        const sameOrigin = originOrigin === `http://${host}` || originOrigin === `https://${host}`
        const advertisedOrigin = dshOrigin()
        const advertised = advertisedOrigin && originOrigin === advertisedOrigin
        if (!originOrigin || !(sameOrigin || advertised)) {
          sendJson(res, 403, { ok: false, error: 'forbidden origin' })
          return false
        }
      }
    }
    return true
  }

  const MAX_BODY_BYTES = 1024 * 1024
  async function readBody(req) {
    const chunks = []
    let size = 0
    let tooLarge = false
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buf.length
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        // Keep draining without retaining data, so a multi-byte UTF-8 sequence
        // is never split across chunks and decoded twice into replacement chars.
        continue
      }
      if (!tooLarge) chunks.push(buf)
    }
    if (tooLarge || chunks.length === 0) return {}
    // Decode once, as a whole: per-chunk toString() corrupts multi-byte chars
    // that straddle a TCP chunk boundary.
    const body = Buffer.concat(chunks).toString('utf8')
    try { return JSON.parse(body) } catch { return {} }
  }

  const MAX_DIAG_BYTES = 2 * 1024 * 1024
  async function appendDiag(file, line) {
    // Keep diagnostic logs bounded: rotate to .1 once they exceed the cap.
    // Best effort only — never let logging affect the request path.
    try {
      const { appendFile, stat, rename, rm } = await import('node:fs/promises')
      try {
        const info = await stat(file)
        if (info.size > MAX_DIAG_BYTES) {
          await rm(`${file}.1`, { force: true }).catch(() => {})
          await rename(file, `${file}.1`).catch(() => {})
        }
      } catch { /* file absent — fine */ }
      await appendFile(file, line, 'utf8')
    } catch { /* logging must never throw */ }
  }

  function diag(line) {
    void appendDiag(join(DATA_DIR, 'host-diag.log'), `[${new Date().toISOString()}] ${line}\n`)
  }

  // ---- Automatic model registration into DSH -------------------------------
  let syncState = { synced: false, at: null, count: 0, error: null, baseURL: null }
  let syncing = null

  function magpieModelsToPiAi(models) {
    return models.map((m) => {
      const entry = {
        id: String(m.id),
        name: String(m.magpie_label || m.display_name || m.id),
      }
      const ctxWindow = Number(m.context_window || m.context_length || 0)
      if (ctxWindow > 0) entry.contextWindow = ctxWindow
      const maxTokens = Number(m.max_output_tokens || 0)
      if (maxTokens > 0) entry.maxTokens = maxTokens
      const input = Array.isArray(m.modalities?.input) ? m.modalities.input : []
      if (input.length) entry.input = input
      const levels = Array.isArray(m.reasoning_levels) ? m.reasoning_levels.filter(Boolean) : []
      if (levels.length) {
        const efforts = {}
        const allowed = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
        for (const level of levels) {
          const key = String(level) === 'none' ? 'off' : String(level)
          if (allowed.has(key)) efforts[key] = String(level)
        }
        if (Object.keys(efforts).length) entry.reasoningEfforts = efforts
      }
      return entry
    })
  }

  async function syncModels({ force = false } = {}) {
    if (syncing) return syncing
    const epoch = operationEpoch
    syncing = (async () => {
      try {
        if (engineDisabled) return { ok: false, error: 'Magpie engine is not installed' }
        if (engine.isInstalling()) return { ok: false, error: 'Magpie engine is being reinstalled, please retry shortly' }
        if (engine.status().state !== 'ready') await engine.start()
        const status = engine.status()
        if (status.state !== 'ready' || !status.gatewayUrl) {
          throw new Error(`engine not ready (${status.state})`)
        }
        const gatewayBase = status.gatewayUrl.replace(/\/+$/, '')
        const modelsRes = await fetch(`${gatewayBase}/models`, {
          signal: AbortSignal.timeout(10000),
        })
        if (!modelsRes.ok) throw new Error(`models request failed: HTTP ${modelsRes.status}`)
        const payload = await modelsRes.json()
        const models = Array.isArray(payload?.data) ? payload.data : []
        if (!models.length) throw new Error('Magpie gateway returned no models')

        const modelsForPiAi = magpieModelsToPiAi(models)
        const baseURL = `${gatewayBase}/v1`

        // An uninstall may have started while we were awaiting start()/fetch.
        // Do not write a provider back into a config the uninstall just cleaned.
        if (epochChanged(epoch)) return { ok: false, error: 'engine was uninstalled during model sync' }

        if (!force && syncState.synced && syncState.baseURL === baseURL
            && syncState.count === modelsForPiAi.length) {
          return { ok: true, changed: false, ...syncState }
        }

        const editor = ctx.configEditor
        if (!editor) throw new Error('configEditor service is unavailable')
        const entry = editor.entries().find((e) => e.options.id === PI_AI_ENTRY_ID)
        if (!entry) throw new Error(`${PI_AI_ENTRY_ID} config entry is not available`)

        await editor.edit(entry, (current) => {
          // Re-check inside the (async) edit so a concurrent uninstall that
          // began after the outer check still wins.
          if (epochChanged(epoch)) return current
          const next = { ...current }
          // Only mutate the user's own override providers. Spreading
          // `inherited.providers` here would freeze lower-layer config into the
          // override, blocking upstream updates and bloating the file.
          const providers = {
            ...((current.providers && typeof current.providers === 'object') ? current.providers : {}),
          }
          const prev = providers[MODEL_PROVIDER_ID] && typeof providers[MODEL_PROVIDER_ID] === 'object'
            ? { ...providers[MODEL_PROVIDER_ID] } : {}
          delete prev.apiKeyEnv
          providers[MODEL_PROVIDER_ID] = {
            ...prev,
            displayName: 'Magpie',
            api: 'openai-completions',
            baseURL,
            models: modelsForPiAi,
          }
          const anthropic = providers['magpie-anthropic']
          if (anthropic && typeof anthropic === 'object') {
            providers['magpie-anthropic'] = { ...anthropic, baseURL: gatewayBase }
          }
          next.providers = providers
          return next
        })

        // NOTE: intentionally does NOT touch `web-search-deepseek`. Rewriting
        // that entry's baseURL and stripping apiKeyEnv was an undocumented
        // side effect that broke users' web search and was not restored on
        // uninstall. Magpie models are exposed only through the `magpie`
        // provider above; web search configuration stays under user control.

        if (epochChanged(epoch)) return { ok: false, error: 'engine was uninstalled during model sync' }
        syncState = { synced: true, at: new Date().toISOString(), count: modelsForPiAi.length, error: null, baseURL }
        ctx.logger?.info?.(`[dsh-magpie] registered ${modelsForPiAi.length} Magpie models into DSH (${MODEL_PROVIDER_ID})`)
        return { ok: true, changed: true, ...syncState }
      } catch (error) {
        syncState = { ...syncState, error: String(error?.message ?? error) }
        ctx.logger?.warn?.(`[dsh-magpie] model sync failed: ${String(error?.message ?? error)}`)
        return { ok: false, error: syncState.error }
      } finally {
        syncing = null
      }
    })()
    return syncing
  }

  // Remove Magpie provider entries from the user's own config layer. Shared
  // by uninstall and reset so neither leaves a stale gateway baseURL behind.
  // Only the override layer is touched; lower-layer providers stay inherited.
  async function removeMagpieProviders() {
    const editor = configEditor
    if (!editor) return
    let lastError = null
    // A transient config-editor failure must not leave a Magpie provider
    // pointing at a dead gateway port. Retry with a short backoff before
    // giving up; purgeAll reports the final failure so it is not silent.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const entry = editor.entries().find((e) => e.options.id === PI_AI_ENTRY_ID)
        if (!entry) return
        await editor.edit(entry, (current) => {
          const next = { ...current }
          const providers = { ...((current.providers && typeof current.providers === 'object') ? current.providers : {}) }
          delete providers[MODEL_PROVIDER_ID]
          delete providers['magpie-anthropic']
          next.providers = providers
          return next
        })
        return
      } catch (error) {
        lastError = error
        if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
      }
    }
    throw lastError
  }

  // Remove every artifact this plugin has ever created. Used both by the
  // in-app "uninstall engine" button and by a genuine bundle uninstall, so the
  // two paths can never diverge and leave different residue behind. All steps
  // are best effort: a locked Windows directory must not abort logical cleanup.
  async function purgeAll() {
    const { rm } = await import('node:fs/promises')
    let lastRmError = null
    try {
      // 1. Stop the engine and sweep stray processes first so file handles are
      //    free. Works whether or not the engine was ever started.
      try { await engine.uninstall() } catch (error) {
        logger?.warn?.(`[dsh-magpie] purge: engine stop failed: ${String(error?.message ?? error)}`)
      }
      // 2. Delete the entire private data directory (binary, config, cache,
      //    data, state, diagnostics). Windows keeps handles briefly after a
      //    process exits, so retry and re-sweep in the middle.
      for (let attempt = 0; attempt < 12; attempt++) {
        try {
          await rm(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
          lastRmError = null
          break
        } catch (error) {
          lastRmError = error
          if (attempt === 2 || attempt === 6) await engine.killStrayProcesses?.()
          await new Promise((resolve) => setTimeout(resolve, 400))
        }
      }
      // 3. Delete the legacy pre-rename data directory if one was left behind.
      try {
        await rm(LEGACY_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
      } catch { /* legacy dir absent — fine */ }
      // 4. Delete the settings file and the migration marker. Both live
      //    outside DATA_DIR precisely so an engine-only uninstall kept them;
      //    here we are removing the whole plugin, so they must go too.
      await rm(SETTINGS_FILE, { force: true }).catch(() => {})
      await rm(LEGACY_MIGRATION_MARKER, { force: true }).catch(() => {})
      // 5. Reset in-memory state so the process never reports a stale install.
      syncState = { synced: false, at: null, count: 0, error: null, baseURL: null }
      try {
        await removeMagpieProviders()
      } catch (error) {
        logger?.warn?.(`[dsh-magpie] purge: provider cleanup failed: ${String(error?.message ?? error)}`)
      }
      if (lastRmError) {
        logger?.warn?.(`[dsh-magpie] purge: data directory removal incomplete: ${String(lastRmError?.message ?? lastRmError)}`)
        // Windows can keep handles on the directory briefly after the child
        // exits. Retry a few times in the background so a transient lock does
        // not leave ~100 MB behind; the UI still reports the current failure.
        if (purgeRetryCount < 3) {
          purgeRetryCount++
          const retry = setTimeout(() => { void purgeAll() }, 5000)
          retry.unref?.()
        }
        return { ok: false, error: `数据目录仍被占用，请稍后重试或手动删除：${DATA_DIR}`, dataDir: DATA_DIR }
      }
      purgeRetryCount = 0
      logger?.info?.('[dsh-magpie] fully purged: engine, data, settings, markers and model providers')
      return { ok: true }
    } catch (error) {
      logger?.warn?.(`[dsh-magpie] purge failed: ${String(error?.message ?? error)}`)
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  function registerRoute(route) {
    try {
      disposers.push(ctx.webServer.register(route))
    } catch (error) {
      if (!String(error?.message ?? error).includes('duplicate')) throw error
    }
  }

  // ---- Install / settings / detection routes ------------------------------

  registerRoute({
    kind: 'exact',
    path: '/api/dsh-magpie/install/status',
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      if (!admit(req, res)) return
      const s = engine.status()
      const managed = managedBinaryInfo(DATA_DIR)
      const detection = await detectExistingMagpie({ dataDir: DATA_DIR })
      sendJson(res, 200, {
        ok: true,
        installed: managed.exists,
        binaryName: managed.name,
        binaryPath: managed.file,
        version: s.version,
        engineState: s.state,
        install: s.install,
        settings: { ...settings },
        detection,
        modelSync: { ...syncState },
      })
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/dsh-magpie/install/config',
    handler: async (req, res) => {
      if (!admit(req, res)) return
      if (req.method === 'GET' || req.method === 'HEAD') {
        return sendJson(res, 200, { ok: true, settings: { ...settings } })
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        try {
          const body = await readBody(req)
          const next = {}
          if (body.mirror !== undefined) next.mirror = normalizeMirror(body.mirror)
          const saved = await saveSettings(next)
          return sendJson(res, 200, { ok: true, settings: saved })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      }
      return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/dsh-magpie/install',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      if (!admit(req, res)) return
      const body = await readBody(req)
      const mirror = body.mirror === undefined ? undefined : normalizeMirror(body.mirror)
      const force = Boolean(body.force)
      // Remember the pre-install gate state so a failed reinstall restores it
      // instead of leaving the engine permanently marked as not installed.
      const wasDisabled = engineDisabled
      const epoch = operationEpoch
      // Fire-and-forget: the UI polls /install/status for progress.
      void engine.install({ mirror, force }).then((result) => {
        // An uninstall/reset may have started while the download was in
        // flight. Its epoch bump wins: never re-enable the engine or reset
        // sync state after the data directory was removed. Compare the epoch
        // number directly — `epochChanged()` also tests engineDisabled, which
        // is legitimately true right after an uninstall followed by a fresh
        // install.
        if (epoch !== operationEpoch) return
        engineDisabled = false
        // A reinstall can restart the engine on a new random gateway port,
        // invalidating any previously registered model baseURL. Invalidate
        // the sync state and bump the epoch so an in-flight sync cannot write
        // a stale port back into the config.
        operationEpoch++
        syncState = { synced: false, at: null, count: 0, error: null, baseURL: null }
        ctx.logger?.info?.(`[dsh-magpie] manual install finished: ${result.tag}`)
      }).catch((error) => {
        // Only restore the pre-install gate when no uninstall/reset superseded
        // this install; otherwise keep the gate state that cleanup chose.
        if (epoch === operationEpoch) engineDisabled = wasDisabled
        ctx.logger?.warn?.(`[dsh-magpie] manual install failed: ${String(error?.message ?? error)}`)
      })
      sendJson(res, 202, { ok: true, accepted: true })
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/dsh-magpie/uninstall',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      if (!admit(req, res)) return
      const wasDisabled = engineDisabled
      engineDisabled = true
      operationEpoch++
      // A user-triggered uninstall is also a removal from this bundle's point
      // of view: cancel any pending deferred purge so the two paths cannot
      // race, then perform one authoritative zero-residue cleanup.
      uninstallState.removing = false
      uninstallState.generation++
      try {
        const result = await purgeAll()
        if (!result.ok) {
          // Keep the gate consistent: the binary may still exist, so a
          // reinstall must remain possible rather than reporting "not
          // installed" forever.
          engineDisabled = wasDisabled
          return sendJson(res, 500, {
            ok: false,
            uninstalled: false,
            error: result.error ?? 'uninstall failed',
            ...(result.dataDir ? { dataDir: result.dataDir } : {}),
          })
        }
        sendJson(res, 200, { ok: true, uninstalled: true })
      } catch (error) {
        engineDisabled = wasDisabled
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/dsh-magpie/status',
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      if (!admit(req, res)) return
      const s = engine.status()
      sendJson(res, 200, {
        ok: true,
        state: s.state,
        available: s.available,
        version: s.version,
        error: s.error,
        guiUrl: `${UI_MOUNT}/`,
        gatewayUrl: s.gatewayUrl,
        dataDir: DATA_DIR,
        install: s.install,
        modelSync: { ...syncState },
      })
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/dsh-magpie/gui',
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      if (!admit(req, res)) return
      if (engineDisabled) return sendJson(res, 503, { ok: false, error: 'Magpie engine is not installed' })
      if (engine.isInstalling()) return sendJson(res, 503, { ok: false, error: 'Magpie engine is being reinstalled, please retry shortly' })
      if (engine.status().state !== 'ready') {
        try { await engine.start() } catch (error) {
          return sendJson(res, 503, { ok: false, error: String(error?.message ?? error) })
        }
      }
      sendJson(res, 200, { ok: true, url: `${UI_MOUNT}/` })
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/dsh-magpie/models',
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      if (!admit(req, res)) return
      if (engineDisabled) return sendJson(res, 503, { ok: false, error: 'Magpie engine is not installed' })
      if (engine.isInstalling()) return sendJson(res, 503, { ok: false, error: 'Magpie engine is being reinstalled, please retry shortly' })
      try {
        if (engine.status().state !== 'ready') await engine.start()
        const base = engine.status().gatewayUrl.replace(/\/+$/, '')
        const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(10000) })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const payload = await r.json()
        sendJson(res, 200, { ok: true, models: magpieModelsToPiAi(payload?.data ?? []), sync: { ...syncState } })
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/dsh-magpie/sync-models',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      if (!admit(req, res)) return
      const result = await syncModels({ force: true })
      sendJson(res, result.ok ? 200 : 502, result)
    },
  })

  registerRoute({
    kind: 'prefix',
    path: UI_MOUNT,
    handler: async (req, res) => {
      if (!admit(req, res)) return
      if (engineDisabled) return sendJson(res, 503, { ok: false, error: 'Magpie engine is not installed' })
      if (engine.isInstalling()) return sendJson(res, 503, { ok: false, error: 'Magpie engine is being reinstalled, please retry shortly' })
      const epoch = operationEpoch
      const url = new URL(req.url || '/', 'http://localhost')
      const upstreamPath = url.pathname.slice(UI_MOUNT.length) || '/'
      try {
        const deadline = Date.now() + 30000
        while (engine.status().state !== 'ready') {
          // An uninstall may have started while we were waiting. Do not let a
          // late start() recreate the data directory being deleted.
          if (epochChanged(epoch)) throw new Error('engine was uninstalled during GUI request')
          if (Date.now() > deadline) throw new Error('engine did not become ready in time')
          await engine.start()
          if (engine.status().state === 'ready') break
          await new Promise((resolve) => setTimeout(resolve, 150))
        }
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await engine.proxy(req, res, upstreamPath + url.search)
            return
          } catch (error) {
            diag(`proxy attempt ${attempt} failed: ${String(error?.message ?? error)} | method=${req.method} path=${upstreamPath}`)
            if (res.headersSent) throw error
            if (attempt === 2) throw error
            if (epochChanged(epoch)) throw new Error('engine was uninstalled during GUI request')
            await engine.start()
            await new Promise((resolve) => setTimeout(resolve, 150))
          }
        }
      } catch (error) {
        diag(`ui route failed: ${String(error?.message ?? error)} | method=${req.method} path=${upstreamPath}`)
        if (!res.headersSent) sendJson(res, 503, { ok: false, error: String(error?.message ?? error) })
        else res.end()
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/__dsh_magpie_diag',
    handler: async (req, res) => {
      if (!admit(req, res)) return
      if (req.method === 'POST') {
        const body = await readBody(req)
        // Never re-create the data directory once the engine was uninstalled:
        // a still-mounted iframe keeps POSTing diagnostics here.
        if (!engineDisabled) {
          void appendDiag(
            join(DATA_DIR, 'browser-diag.log'),
            `[${new Date().toISOString()}] ${JSON.stringify(body)}\n`,
          )
        }
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    },
  })

  for (const action of ['start', 'stop', 'reset']) {
    registerRoute({
      kind: 'exact',
      path: `/api/dsh-magpie/${action}`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        if (!admit(req, res)) return
        try {
          if (action === 'start') {
            if (engineDisabled) throw new Error('Magpie engine is not installed. Download and install it first.')
            const s = await engine.start()
            sendJson(res, 200, { ok: true, state: s.state, guiUrl: `${UI_MOUNT}/`, error: s.error })
          } else if (action === 'stop') {
            const s = await engine.stop()
            sendJson(res, 200, { ok: true, state: s.state })
          } else {
            const epoch = operationEpoch
            if (engineDisabled) throw new Error('Magpie engine is not installed. Download and install it first.')
            await engine.stop()
            if (epochChanged(epoch)) throw new Error('engine was uninstalled during reset')
            // Reset means "clear the engine's private DATA and restart", not
            // uninstall. Delete only the engine home (config/cache/data/state)
            // and keep bin/: removing DATA_DIR wholesale also deleted the
            // verified binary, so the subsequent start() always failed.
            const { rm } = await import('node:fs/promises')
            await rm(join(DATA_DIR, 'magpie'), { recursive: true, force: true })
            if (epochChanged(epoch)) throw new Error('engine was uninstalled during reset')
            const s = await engine.start()
            // Restart uses a fresh random gateway port; invalidate model sync.
            operationEpoch++
            syncState = { synced: false, at: null, count: 0, error: null, baseURL: null }
            // Reset wipes Magpie's own config, so previously synced models are
            // gone. Drop the stale provider first (it points at the dead port),
            // then register whatever the fresh instance exposes — possibly
            // nothing, in which case no provider is left behind.
            try {
              await removeMagpieProviders()
            } catch (error) {
              ctx.logger?.warn?.(`[dsh-magpie] provider cleanup after reset failed: ${String(error?.message ?? error)}`)
            }
            let sync = null
            try {
              sync = await syncModels({ force: true })
            } catch (error) {
              ctx.logger?.warn?.(`[dsh-magpie] model re-sync after reset failed: ${String(error?.message ?? error)}`)
            }
            sendJson(res, 200, { ok: true, state: s.state, guiUrl: `${UI_MOUNT}/`, sync })
          }
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    })
  }

  // Load settings on activation. NO automatic engine start and NO automatic
  // model sync — the user drives installation and startup from the UI.
  void migration.then(() => loadSettings()).catch((error) => {
    ctx.logger?.warn?.(`[dsh-magpie] settings load failed: ${String(error?.message ?? error)}`)
  })

  // `disposer()` runs on bundle uninstall, bundle update, plugin disable,
  // HMR reload and DSH shutdown. It is NOT by itself a signal to delete data.
  // Only act when a genuine `remove` operation was observed and was not
  // superseded (update/reinstall/re-enable) in the meantime.
  return () => {
    for (const disposer of disposers) disposer()
    // Always stop the engine process so no Magpie child survives teardown,
    // regardless of whether data will be purged.
    void engine.close()

    const removing = uninstallState.removing
    const generation = uninstallState.generation
    if (!removing) return

    // `exit` handlers must be synchronous. If the user quits DSH during the
    // grace window, the deferred purge below would be skipped entirely and
    // strand ~100 MB of engine data; do a best-effort synchronous sweep here.
    // Same guards as the async path: a cancelled remove or a still-present
    // package directory (update / hot reload) must never touch user data.
    const syncSweep = () => {
      if (uninstallState.generation !== generation || !uninstallState.removing) return
      if (existsSync(SELF_DIR)) return
      try {
        rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        rmSync(LEGACY_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        rmSync(SETTINGS_FILE, { force: true, maxRetries: 5, retryDelay: 200 })
        rmSync(LEGACY_MIGRATION_MARKER, { force: true, maxRetries: 5, retryDelay: 200 })
      } catch { /* best effort during exit */ }
    }
    process.once('exit', syncSweep)

    // Defer the destructive part. During an update the manager removes then
    // reinstalls the bundle; the resulting `install` event flips `removing`
    // and bumps `generation`, cancelling the pending purge.
    const tryPurge = (attempt) => {
      if (uninstallState.generation !== generation || !uninstallState.removing) return
      // Second guard: pnpm deletes this plugin's own package directory only
      // on a real uninstall. If it is still present, this was a reload or a
      // remove that got restored, so keep the user's data. A slow pnpm remove
      // may need one more beat, so retry once before giving up.
      if (existsSync(SELF_DIR)) {
        if (attempt >= 1) return
        const retry = setTimeout(() => tryPurge(attempt + 1), 10000)
        retry.unref?.()
        return
      }
      // Detach the root-level listener now that this bundle is gone.
      const disposeListener = uninstallState.disposeListener
      uninstallState.disposeListener = null
      try { disposeListener?.() } catch { /* best effort */ }
      void purgeAll().then((result) => {
        // On a partial failure keep the exit sweep armed so one last retry
        // happens if DSH is closed later. On success, clear the cross-HMR
        // intent so a later, unrelated disposal cannot act on stale state.
        if (result && result.ok === false) return
        uninstallState.removing = false
        uninstallState.generation++
      }).catch(() => {
        // Leave the sweep armed when purge itself threw unexpectedly.
      })
    }
    const timer = setTimeout(() => tryPurge(0), PURGE_DELAY_MS)
    // Do not hold the process open purely for this cleanup on shutdown.
    timer.unref?.()
  }
}
