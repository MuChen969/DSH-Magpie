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
 *   POST /api/dsh-magpie/uninstall-engine  manually remove the engine (keeps mirror settings)
 *   GET  /api/dsh-magpie/gui               embedded GUI URL (starts engine on demand)
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

export const inject = ['webServer']

export function apply(ctx) {
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
  // data, the GitHub mirror settings file and the migration marker.
  // Invoked only for a genuine uninstall.
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
      if (lastRmError) {
        ctx.logger?.warn?.(`[dsh-magpie] uninstall: data removal incomplete: ${String(lastRmError?.message ?? lastRmError)}`)
        return { ok: false, error: String(lastRmError?.message ?? lastRmError) }
      }
      ctx.logger?.info?.('[dsh-magpie] uninstalled: engine, data and mirror settings removed')
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

  // Bumped by install and reset so a long async operation (GUI proxy) can
  // detect that the gateway port changed mid-flight and abort.
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
    // /install, /start, etc. Requests without an Origin header
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
      const epoch = operationEpoch
      // Fire-and-forget: the UI polls /install/status for progress.
      void engine.install({ mirror }).then((result) => {
        // A reset or newer install may have started while the download was in
        // flight; its epoch bump wins, so we must not apply stale results.
        if (epoch !== operationEpoch) return
        operationEpoch++
        ctx.logger?.info?.(`[dsh-magpie] manual install finished: ${result.tag}`)
      }).catch((error) => {
        ctx.logger?.warn?.(`[dsh-magpie] manual install failed: ${String(error?.message ?? error)}`)
      })
      sendJson(res, 202, { ok: true, accepted: true })
    },
  })

  // Manual "uninstall engine": remove only the engine binary and its private
  // data. The plugin, its GitHub mirror settings and the migration marker are
  // kept so the engine can be installed again without losing configuration.
  // Unlike purgeAll (whole bundle uninstall), this leaves SETTINGS_FILE in place.
  registerRoute({
    kind: 'exact',
    path: '/api/dsh-magpie/uninstall-engine',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      if (!admit(req, res)) return
      const { rm } = await import('node:fs/promises')
      let lastRmError = null
      try {
        try { await engine.stop() } catch { /* best effort */ }
        // Windows keeps file handles briefly after the child exits; retry.
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
        if (lastRmError) {
          ctx.logger?.warn?.(`[dsh-magpie] uninstall-engine: data removal incomplete: ${String(lastRmError?.message ?? lastRmError)}`)
          return sendJson(res, 500, {
            ok: false,
            error: `数据目录仍被占用，请稍后重试：${DATA_DIR}`,
          })
        }
        ctx.logger?.info?.('[dsh-magpie] engine uninstalled: binary and data removed (mirror settings kept)')
        return sendJson(res, 200, { ok: true, uninstalled: true })
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-magpie] uninstall-engine failed: ${String(error?.message ?? error)}`)
        return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
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
            operationEpoch++
            sendJson(res, 200, { ok: true, state: s.state, guiUrl: `${UI_MOUNT}/` })
          }
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    })
  }

  // Load settings on activation. NO automatic engine start — the user drives
  // installation and startup from the UI.
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
