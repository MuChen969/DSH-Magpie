/**
 * @local/dsh-magpie — Host half (manual-install edition).
 *
 * Uninstall follows DSH's official plugin lifecycle. apply() returns a disposer
 * that tears down what this plugin registered (HTTP routes, event listeners,
 * the running child process); DSH calls it on uninstall, update, disable and
 * shutdown. To additionally remove the engine binary, its data and the GitHub
 * mirror config ONLY on a genuine bundle uninstall, we listen to the two
 * official events from @deepseek-ai/dsh-plugin-manager:
 *   - 'plugin-manager/update-state' marks an in-progress update (step=removing)
 *   - 'plugin-manager/operation' reports settled(remove, applied, target=self)
 * An update also runs a remove internally, but it is preceded by update-state,
 * so it is excluded. No globalThis, cwd probing or fixed delays are used.
 *
 * HTTP routes (loopback only, under the DSH origin):
 *   GET  /api/dsh-magpie/status            engine + install status
 *   GET  /api/dsh-magpie/install/status    install state, mirror, duplicate detection
 *   POST /api/dsh-magpie/install/config    save GitHub mirror / settings
 *   POST /api/dsh-magpie/install           start manual download (async)
 *   GET  /api/dsh-magpie/gui               embedded GUI URL (starts engine on demand)
 *   GET  /api/dsh-magpie/models            models discovered from the Magpie gateway
 *   POST /api/dsh-magpie/sync-models       (re)register models into DSH
 *   GET  /api/dsh-magpie/ui/*              reverse proxy to the official Web UI
 *   POST /api/dsh-magpie/start / stop / reset
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  createMagpieEngine, UI_MOUNT, DEFAULT_MIRROR, normalizeMirror,
  detectExistingMagpie, managedBinaryInfo,
} from './magpie-engine.js'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DATA_DIR = join(DSH_HOME, 'dsh-magpie-engine')
const LEGACY_DATA_DIR = join(DSH_HOME, 'magpie-shell-engine')
// Plugin settings live OUTSIDE the engine data directory so a reset (which
// clears DATA_DIR/magpie) never destroys the user's mirror.
const SETTINGS_FILE = join(DSH_HOME, 'dsh-magpie-settings.json')
// Migration marker lives outside DATA_DIR so it survives engine resets and
// the one-time legacy migration is not repeated.
const LEGACY_MIGRATION_MARKER = join(DSH_HOME, '.dsh-magpie-legacy-migrated')

// The provider route name registered into @deepseek-ai/dsh-llm-pi-ai.
const MODEL_PROVIDER_ID = 'magpie'
const PI_AI_ENTRY_ID = 'llm-pi-ai'
// Bundle package name, matched against the official operation event's target.
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
  // Capture long-lived service references early; they are used by the async
  // request handlers and remain valid for the plugin's lifetime.
  const configEditor = ctx.configEditor

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

  // ---- Official-uninstall driven cleanup -----------------------------------
  // DSH's plugin manager exposes two official events (see @deepseek-ai/
  // dsh-plugin-manager). We use them to tell a genuine bundle uninstall apart
  // from an update (which internally also removes the bundle) and from a plain
  // disable / HMR reload / shutdown. State lives in this activation's closure;
  // listeners live on the root context so they survive our own disposal long
  // enough to observe the settled event, which arrives AFTER pnpm remove.
  const eventHost = ctx.root ?? ctx
  let removeStarted = false
  let updateRemoving = false
  let purgeDone = false

  function disposeUninstallEvents() {
    try { disposeUpdateState?.() } catch { /* best effort */ }
    try { disposeOperation?.() } catch { /* best effort */ }
  }

  // Remove every artifact this plugin created: the engine binary + private
  // data, the GitHub mirror settings file, the migration marker and the model
  // providers registered in DSH. Invoked only for a genuine uninstall.
  async function purgeAll() {
    const { rm } = await import('node:fs/promises')
    let lastRmError = null
    try {
      try { await engine.stop() } catch { /* best effort */ }
      try { await engine.close() } catch { /* best effort */ }
      // Windows keeps file handles briefly after the child exits; retry before
      // giving up so a transient lock does not strand the ~100 MB binary.
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          await rm(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
          lastRmError = null
          break
        } catch (error) {
          lastRmError = error
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
      }
      await rm(LEGACY_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
      await rm(SETTINGS_FILE, { force: true }).catch(() => {})
      await rm(LEGACY_MIGRATION_MARKER, { force: true }).catch(() => {})
      syncState = { synced: false, at: null, count: 0, error: null, baseURL: null }
      try {
        await removeMagpieProviders()
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-magpie] uninstall: provider cleanup failed: ${String(error?.message ?? error)}`)
      }
      if (lastRmError) {
        ctx.logger?.warn?.(`[dsh-magpie] uninstall: data removal incomplete: ${String(lastRmError?.message ?? lastRmError)}`)
        return { ok: false, error: String(lastRmError?.message ?? lastRmError) }
      }
      ctx.logger?.info?.('[dsh-magpie] uninstalled: engine, data, mirror settings and model providers removed')
      return { ok: true }
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-magpie] uninstall cleanup failed: ${String(error?.message ?? error)}`)
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  const disposeUpdateState = eventHost.on('plugin-manager/update-state', (progress) => {
    // Only an update announces step='removing' before it removes this bundle.
    if (progress && progress.step === 'removing') updateRemoving = true
  })

  const disposeOperation = eventHost.on('plugin-manager/operation', (op) => {
    if (!op || typeof op !== 'object') return
    const reason = op.reason
    const stage = op.stage
    // An install/re-enable supersedes any pending removal (update restore path).
    if (reason === 'install' || stage === 'enable') {
      removeStarted = false
      updateRemoving = false
      return
    }
    if (reason !== 'remove' || stage !== 'remove') return
    const target = String(op.target ?? '')
    // The manager reports the bare package name for a remove; tolerate an
    // empty/null target while a removal for this bundle is already pending.
    if (target !== BUNDLE_PACKAGE && !(target === '' && removeStarted)) return
    if (op.phase === 'started') {
      removeStarted = true
      return
    }
    if (op.phase === 'unknown') {
      removeStarted = false
      updateRemoving = false
      return
    }
    if (op.phase !== 'settled') return
    if (op.application === 'failed' || op.application === 'cancelled') {
      removeStarted = false
      updateRemoving = false
      return
    }
    const genuine = removeStarted && !updateRemoving && op.application === 'applied'
    removeStarted = false
    updateRemoving = false
    if (!genuine || purgeDone) {
      // Update / unrelated remove — no data purge; drop our root listeners.
      disposeUninstallEvents()
      return
    }
    purgeDone = true
    disposeUninstallEvents()
    void purgeAll()
  })

  // Bumped by install and reset so a long async operation (model sync, GUI
  // proxy) can detect that the gateway port changed mid-flight and abort
  // before writing a stale provider back into the config.
  let operationEpoch = 0
  function epochChanged(epoch) {
    return epoch !== operationEpoch
  }

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
    // /install, /start, /sync-models, etc. Requests without an Origin header
    // (curl, CLI tools) are not browser-CSRF-capable and pass.
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

        // A reset or reinstall may have changed the gateway port while we were
        // awaiting start()/fetch. Do not write a provider pointing at a stale port.
        if (epochChanged(epoch)) return { ok: false, error: 'engine changed during model sync; retry' }

        if (!force && syncState.synced && syncState.baseURL === baseURL
            && syncState.count === modelsForPiAi.length) {
          return { ok: true, changed: false, ...syncState }
        }

        const editor = ctx.configEditor
        if (!editor) throw new Error('configEditor service is unavailable')
        const entry = editor.entries().find((e) => e.options.id === PI_AI_ENTRY_ID)
        if (!entry) throw new Error(`${PI_AI_ENTRY_ID} config entry is not available`)

        await editor.edit(entry, (current) => {
          // Re-check inside the (async) edit so a concurrent reset/reinstall
          // that began after the outer check still wins.
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
          // pi-ai's openai-completions implementation refuses to dispatch ANY
          // request without an apiKey or an Authorization header — even for a
          // keyless loopback gateway (verified in the installed pi-ai source:
          // getClientApiKey throws "No API key for provider" otherwise).
          // Magpie's gateway is local and needs no real credential, so supply a
          // harmless placeholder Authorization header. dsh-llm-pi-ai only
          // requires headers to be Fetch-representable, and pi-ai treats a
          // present, non-empty Authorization as satisfied. Keep any user-supplied
          // headers, replacing only the (case-insensitive) authorization entry.
          const prevHeaders = prev.headers && typeof prev.headers === 'object' ? prev.headers : {}
          const headers = {}
          for (const [name, value] of Object.entries(prevHeaders)) {
            if (String(name).toLowerCase() !== 'authorization') headers[name] = value
          }
          headers.Authorization = 'Bearer magpie'
          providers[MODEL_PROVIDER_ID] = {
            ...prev,
            displayName: 'Magpie',
            api: 'openai-completions',
            baseURL,
            headers,
            models: modelsForPiAi,
          }
          const anthropic = providers['magpie-anthropic']
          if (anthropic && typeof anthropic === 'object') {
            const nextAnthropic = { ...anthropic, baseURL: gatewayBase }
            // Same keyless-route rule applies to anthropic-messages. Only add a
            // placeholder when the user configured no credential of their own;
            // never overwrite an existing apiKeyEnv / auth header.
            const ah = nextAnthropic.headers && typeof nextAnthropic.headers === 'object'
              ? nextAnthropic.headers : {}
            const hasAuthHeader = Object.entries(ah).some(([name, value]) =>
              ['authorization', 'x-api-key', 'cf-aig-authorization'].includes(String(name).toLowerCase())
              && value != null && String(value).trim().length > 0)
            if (nextAnthropic.apiKeyEnv === undefined && !hasAuthHeader) {
              nextAnthropic.headers = { ...ah, Authorization: 'Bearer magpie' }
            }
            providers['magpie-anthropic'] = nextAnthropic
          }
          next.providers = providers
          return next
        })

        // NOTE: intentionally does NOT touch `web-search-deepseek`. Rewriting
        // that entry's baseURL and stripping apiKeyEnv was an undocumented
        // side effect that broke users' web search and was not restored on
        // uninstall. Magpie models are exposed only through the `magpie`
        // provider above; web search configuration stays under user control.

        if (epochChanged(epoch)) return { ok: false, error: 'engine changed during model sync; retry' }
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

  // Remove Magpie provider entries from the user's own config layer. Used by
  // reset so a fresh instance does not leave a stale gateway baseURL behind.
  // Only the override layer is touched; lower-layer providers stay inherited.
  async function removeMagpieProviders() {
    const editor = configEditor
    if (!editor) return
    let lastError = null
    // A transient config-editor failure must not leave a Magpie provider
    // pointing at a dead gateway port. Retry with a short backoff before
    // giving up; the caller logs the final failure so it is not silent.
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
      const epoch = operationEpoch
      // Fire-and-forget: the UI polls /install/status for progress.
      void engine.install({ mirror, force }).then((result) => {
        // A reset or newer install may have started while the download was in
        // flight; its epoch bump wins, so we must not reset sync state.
        if (epoch !== operationEpoch) return
        // A reinstall can restart the engine on a new random gateway port,
        // invalidating any previously registered model baseURL. Invalidate
        // the sync state and bump the epoch so an in-flight sync cannot write
        // a stale port back into the config.
        operationEpoch++
        syncState = { synced: false, at: null, count: 0, error: null, baseURL: null }
        ctx.logger?.info?.(`[dsh-magpie] manual install finished: ${result.tag}`)
      }).catch((error) => {
        ctx.logger?.warn?.(`[dsh-magpie] manual install failed: ${String(error?.message ?? error)}`)
      })
      sendJson(res, 202, { ok: true, accepted: true })
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
      if (engine.isInstalling()) return sendJson(res, 503, { ok: false, error: 'Magpie engine is being reinstalled, please retry shortly' })
      const epoch = operationEpoch
      const url = new URL(req.url || '/', 'http://localhost')
      const upstreamPath = url.pathname.slice(UI_MOUNT.length) || '/'
      try {
        const deadline = Date.now() + 30000
        while (engine.status().state !== 'ready') {
          // A reset/reinstall may have changed the engine while we were waiting.
          if (epochChanged(epoch)) throw new Error('engine changed during GUI request; retry')
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
            if (epochChanged(epoch)) throw new Error('engine changed during GUI request; retry')
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
        void appendDiag(
          join(DATA_DIR, 'browser-diag.log'),
          `[${new Date().toISOString()}] ${JSON.stringify(body)}\n`,
        )
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
            const s = await engine.start()
            sendJson(res, 200, { ok: true, state: s.state, guiUrl: `${UI_MOUNT}/`, error: s.error })
          } else if (action === 'stop') {
            const s = await engine.stop()
            sendJson(res, 200, { ok: true, state: s.state })
          } else {
            const epoch = operationEpoch
            await engine.stop()
            if (epochChanged(epoch)) throw new Error('engine changed during reset; retry')
            // Reset means "clear the engine's private DATA and restart", not
            // uninstall. Delete only the engine home (config/cache/data/state)
            // and keep bin/: removing DATA_DIR wholesale also deleted the
            // verified binary, so the subsequent start() always failed.
            const { rm } = await import('node:fs/promises')
            await rm(join(DATA_DIR, 'magpie'), { recursive: true, force: true })
            if (epochChanged(epoch)) throw new Error('engine changed during reset; retry')
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

  // DSH's official plugin contract: apply() returns a disposer that DSH calls
  // on bundle uninstall, update, disable, HMR reload and shutdown. It tears
  // down only what this plugin registered — HTTP routes and the running child
  // process. Data cleanup is NOT done here because this disposer also runs on
  // updates/reloads; it is driven by the official operation event above, whose
  // 'settled' phase arrives only after pnpm has finished the uninstall.
  return () => {
    for (const disposer of disposers) disposer()
    void engine.stop()
    // The disposer runs during the remove phase, BEFORE the settled event is
    // emitted. While a removal is pending we must keep the root listeners alive
    // so the settled handler can still perform the purge. For every other
    // teardown (disable / update / HMR / shutdown with no pending removal),
    // drop them here to avoid leaking listeners on the root context.
    if (!removeStarted) disposeUninstallEvents()
  }
}
