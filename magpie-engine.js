/**
 * magpie-engine.js — embedded official Magpie engine (manual-install edition).
 *
 * Differences from the original auto-install version:
 *   - The official binary is NOT downloaded on activation. The user triggers
 *     installation explicitly from the bundle's config page.
 *   - The GitHub mirror/prefix is user-configurable.
 *   - A detection helper reports an already-installed Magpie on this machine
 *     so the UI can warn about duplicate installations.
 *
 * The engine still uses one private data directory, its own random loopback
 * ports, and a reverse proxy for the official Web UI.
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync, readFileSync, createReadStream, mkdirSync, writeFileSync,
  readdirSync, statSync,
} from 'node:fs'
import { promises as fsp } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'

const RELEASES_API = 'https://api.github.com/repos/yetone/magpie-releases/releases/latest'
export const UI_MOUNT = '/api/dsh-magpie/ui'

/** Default: no mirror. Official URLs are used as-is. */
export const DEFAULT_MIRROR = ''

/**
 * Normalize a user-supplied mirror prefix. Accepts an empty string (official),
 * a host like `gh-proxy.com`, or a full URL prefix like `https://gh-proxy.com/`.
 * Returns a normalized prefix ending with `/`, or `''`.
 */
export function normalizeMirror(input) {
  if (input == null) return ''
  let s = String(input).trim()
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`
  if (!s.endsWith('/')) s += '/'
  return s
}

/** Route a GitHub URL through the user's mirror prefix, if configured. */
function applyMirror(url, mirror) {
  const prefix = normalizeMirror(mirror)
  if (!prefix) return url
  if (url.startsWith('https://github.com/') || url.startsWith('https://api.github.com/')) {
    return prefix + url
  }
  return url
}

function targetKey() {
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  return { platform, arch }
}

function assetName() {
  const { platform, arch } = targetKey()
  return `magpie-${platform}-${arch}${platform === 'windows' ? '.exe' : ''}`
}

function engineError(message) {
  return new Error(`[magpie-engine] ${message}`)
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve)
  })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function downloadToFile(url, dest, mirror, { timeout = 180000, onProgress } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(applyMirror(url, mirror), { signal: controller.signal })
    if (!res.ok) throw engineError(`download failed: HTTP ${res.status} for ${url}`)
    const total = Number(res.headers.get('content-length') || 0)
    const chunks = []
    let received = 0
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(Buffer.from(value))
        received += value.byteLength
        if (onProgress) onProgress({ received, total })
      }
    } else {
      const buffer = Buffer.from(await res.arrayBuffer())
      chunks.push(buffer)
      received = buffer.length
      if (onProgress) onProgress({ received, total: received })
    }
    await fsp.writeFile(dest, Buffer.concat(chunks))
    return received
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve the official release and expected hash, download the binary for this
 * platform, verify it against SHA256SUMS, and store it in the managed bin dir.
 * Returns { binary, tag, sha256, downloaded }.
 */
async function ensureOfficialBinary(binDir, mirror, logger, onProgress, force = false) {
  const name = assetName()
  const dest = path.join(binDir, name)

  // SECURITY: release metadata and the checksum manifest are ALWAYS fetched
  // from the official GitHub host. Only the binary download may be routed
  // through a user-configured mirror. If the mirror could also supply the
  // SHA256SUMS, a hostile mirror could ship a tampered binary together with a
  // matching hash and the verification would be meaningless. Official
  // reachability is therefore a hard requirement; failures fail closed.
  const res = await fetch(RELEASES_API, {
    headers: { accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw engineError(`official release lookup failed: HTTP ${res.status}`)
  const release = await res.json()
  const tag = release.tag_name
  const asset = (release.assets ?? []).find((item) => item.name === name)
  if (!asset) throw engineError(`release ${tag} has no asset ${name}`)

  // SECURITY: the checksum manifest must come from an official GitHub host;
  // never from the user mirror. Prefer the release-asset API on api.github.com
  // (same trust domain as the release lookup, and reachable even where the
  // github.com release-download host is blocked). Fall back to the classic
  // github.com download URL when the API route is unavailable.
  let sums = ''
  const sumsAsset = (release.assets ?? []).find((item) => item.name === 'SHA256SUMS')
  try {
    if (!sumsAsset?.url) throw engineError('no SHA256SUMS asset in release')
    const sumsRes = await fetch(sumsAsset.url, {
      headers: { accept: 'application/octet-stream', 'user-agent': 'dsh-magpie' },
      signal: AbortSignal.timeout(20000),
    })
    if (!sumsRes.ok) throw engineError(`HTTP ${sumsRes.status}`)
    sums = await sumsRes.text()
  } catch (apiError) {
    const sumsUrl = `https://github.com/yetone/magpie-releases/releases/download/${tag}/SHA256SUMS`
    try {
      const sumsRes = await fetch(sumsUrl, { signal: AbortSignal.timeout(20000) })
      if (!sumsRes.ok) throw engineError(`HTTP ${sumsRes.status}`)
      sums = await sumsRes.text()
    } catch (fallbackError) {
      throw engineError(`official SHA256SUMS unavailable via API (${String(apiError?.message ?? apiError)}) and github.com (${String(fallbackError?.message ?? fallbackError)})`)
    }
  }
  const expected = sums.split('\n').map((line) => line.trim())
    .find((line) => line.endsWith(`  ${name}`))?.split(/\s+/)[0]
  if (!expected) throw engineError(`no SHA-256 entry for ${name} in official SHA256SUMS`)

  // Reuse a verified local copy unless force=true. A forced reinstall
  // re-downloads and re-verifies even when the cached copy is still valid.
  if (!force && existsSync(dest)) {
    try {
      const actual = await sha256File(dest)
      if (actual === expected) {
        await writeBinaryVersion(dest, tag, actual)
        return { binary: dest, tag, sha256: actual, downloaded: false }
      }
    } catch {
      // Fall through to re-download.
    }
  }

  logger?.info?.(`[magpie-engine] downloading official ${name} (${tag})`)
  await fsp.mkdir(binDir, { recursive: true })
  const tmp = `${dest}.download`
  try {
    await downloadToFile(asset.browser_download_url, tmp, mirror, { onProgress })
    const actual = await sha256File(tmp)
    if (actual !== expected) {
      throw engineError(`official SHA-256 mismatch for ${name}: got ${actual}, expected ${expected}`)
    }
    await fsp.rename(tmp, dest)
    if (process.platform !== 'win32') await fsp.chmod(dest, 0o755)
    await writeBinaryVersion(dest, tag, actual)
    logger?.info?.(`[magpie-engine] official ${name} verified (sha256 ${actual.slice(0, 16)}…)`)
    return { binary: dest, tag, sha256: actual, downloaded: true }
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/** Sidecar path holding the release tag / SHA-256 of a verified binary. */
function versionFileFor(binary) {
  return `${binary}.version.json`
}

/** Best-effort write of the verified binary's version metadata. */
async function writeBinaryVersion(binary, tag, sha256) {
  try {
    await fsp.writeFile(versionFileFor(binary), JSON.stringify({ tag, sha256 }), 'utf8')
  } catch {
    // Version metadata is informational; never fail an install over it.
  }
}

/** Read the persisted release tag for an already-installed binary. */
function readBinaryVersion(binary) {
  try {
    const parsed = JSON.parse(readFileSync(versionFileFor(binary), 'utf8'))
    return typeof parsed?.tag === 'string' ? parsed.tag : null
  } catch {
    return null
  }
}

/** Quick check: is a usable binary already present in the managed bin dir? */
export function managedBinaryInfo(dataDir) {
  const name = assetName()
  const file = path.join(dataDir, 'bin', name)
  return { name, file, exists: existsSync(file), version: existsSync(file) ? readBinaryVersion(file) : null }
}

/**
 * Detect other Magpie-related plugins installed inside DSH only.
 * Standalone installations and PATH binaries are intentionally ignored:
 * the embedded instance is isolated, so only in-DSH duplicates matter.
 * Never throws; returns a structured report.
 */
export async function detectExistingMagpie({ dataDir, selfPackageName = 'dsh-magpie' } = {}) {
  const found = []
  const notes = []
  const seenLocations = new Set()
  const addFound = (item) => {
    const key = item.path ? path.resolve(item.path).toLowerCase() : `${item.kind}:${item.name}`
    if (seenLocations.has(key)) return
    seenLocations.add(key)
    found.push(item)
  }

  // Only scan other DSH-installed plugins whose package name contains "magpie".
  try {
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const profileDir = process.env.DSH_PROFILE_DIR
    const candidates = []
    if (profileDir) candidates.push(path.join(profileDir, 'node_modules'))
    candidates.push(path.join(dshHome, 'plugins', 'node_modules'))
    for (const nodeModules of candidates) {
      if (!existsSync(nodeModules)) continue
      for (const entry of readdirSync(nodeModules)) {
        if (entry.startsWith('.')) continue
        // Expand scoped packages (@scope/name) as well as plain ones, so a
        // scoped package whose name contains "magpie" is not missed.
        let names
        if (entry.startsWith('@')) {
          try {
            names = readdirSync(path.join(nodeModules, entry)).map((sub) => `${entry}/${sub}`)
          } catch {
            continue
          }
        } else {
          names = [entry]
        }
        for (const name of names) {
          const lower = name.toLowerCase()
          if (!lower.includes('magpie')) continue
          if (name === selfPackageName || lower === selfPackageName.toLowerCase()) continue
          const pkgFile = path.join(nodeModules, name, 'package.json')
          let description = ''
          try {
            const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
            description = String(pkg.description || '')
          } catch { /* ignore */ }
          addFound({
            kind: 'dsh-plugin',
            name,
            detail: description,
            path: path.join(nodeModules, name),
          })
        }
      }
    }
  } catch (error) {
    notes.push(`plugin scan: ${String(error?.message ?? error)}`)
  }

  // Managed binary of this plugin (informational, not a duplicate).
  let managed = null
  if (dataDir) {
    const info = managedBinaryInfo(dataDir)
    managed = { name: info.name, exists: info.exists, path: info.file }
  }

  return { duplicates: found, managed, notes, hasDuplicate: found.length > 0 }
}

function loopbackFetch(url, options) {
  return fetch(url, options)
}

/**
 * Create the embedded engine controller.
 * @param {object} options
 * @param {string} options.dataDir absolute path for the engine's private home
 * @param {object} options.logger optional logger with info/warn
 * @param {function} options.getMirror optional () => string, returns configured mirror
 */
export function createMagpieEngine({ dataDir, logger, getMirror } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new TypeError('dataDir must be absolute')

  const home = path.join(dataDir, 'magpie')
  const binDir = path.join(dataDir, 'bin')
  let state = 'stopped'
  let error = null
  let child = null
  let binary = null
  let webPort = 0
  let gatewayPort = 0
  let webKey = ''
  let webURL = ''
  let webBase = ''
  let gatewayURL = ''
  let starting = null
  let closing = null
  let closed = false
  let installState = { installing: false, progress: null, lastResult: null, error: null }

  // `binary` is only populated after the first install/boot in this process,
  // so a DSH restart with an already-installed binary would otherwise report
  // available:false. Fall back to the managed binary path for both fields.
  const status = () => {
    const file = binary || managedBinaryInfo(dataDir).file
    return {
      state,
      available: Boolean(file && existsSync(file)),
      version: readBinaryVersion(file),
      webUrl: webURL,
      gatewayUrl: gatewayURL,
      error,
      install: { ...installState },
    }
  }

  function assertOpen() {
    if (closed) throw engineError('engine is closed')
  }

  function pidAlive(pid) {
    if (!pid) return false
    try { process.kill(pid, 0); return true } catch { return false }
  }

  async function stopChild() {
    const target = child
    if (!target) return
    child = null
    const pid = target.pid
    // On Windows the engine can spawn helpers that keep file handles open.
    // Kill the whole process tree with taskkill /T /F, then wait until the PID
    // is really gone before the engine is considered stopped.
    if (process.platform === 'win32' && pid) {
      try {
        const { execFile } = await import('node:child_process')
        await new Promise((resolve) => {
          execFile('taskkill', ['/PID', String(pid), '/T', '/F'],
            { timeout: 5000, windowsHide: true }, () => resolve())
        })
      } catch { /* fall through */ }
      // Poll until the process no longer exists. A surviving process keeps
      // file handles on the data directory; report it instead of letting a
      // later rm() fail with a confusing EBUSY/EPERM error.
      const deadline = Date.now() + 6000
      while (pidAlive(pid) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150))
      }
      if (pidAlive(pid)) throw engineError(`engine process ${pid} is still running after termination`)
      return
    }
    // POSIX: normal kill, then force, then wait for the exit event.
    try { target.kill() } catch { /* best effort */ }
    await new Promise((resolve) => {
      if (target.exitCode !== null || target.signalCode !== null) return resolve()
      const timer = setTimeout(() => { try { target.kill('SIGKILL') } catch {} ; resolve() }, 5000)
      target.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }

  /**
   * Manual install. Downloads and verifies the official binary.
   * Concurrent calls share the same promise.
   */
  async function install({ mirror, force = false } = {}) {
    assertOpen()
    const useMirror = mirror == null ? (getMirror?.() || DEFAULT_MIRROR) : mirror
    if (installState.installing) throw engineError('installation already in progress')
    installState = { installing: true, progress: null, lastResult: null, error: null }

    // A running engine keeps the binary file locked on Windows, so renaming
    // the freshly downloaded file over it fails with EPERM. Stop the engine
    // before replacing the binary and remember whether it was running so we
    // can bring it back afterwards.
    const resumeAfter = state === 'ready'
    try {
      if (resumeAfter) await stop()
    } catch (error) {
      // Stopping is best effort; if it fails, proceed and let the rename
      // surface a clear error rather than aborting silently.
      logger?.warn?.(`[magpie-engine] stop-before-install failed: ${String(error?.message ?? error)}`)
    }

    try {
      // ensureOfficialBinary reuses the local copy only when its SHA-256 still
      // matches the official manifest. force=true skips that reuse and
      // re-downloads even when the cached copy is valid.
      const result = await ensureOfficialBinary(binDir, useMirror, logger, (p) => {
        installState.progress = p
      }, force)
      binary = result.binary
      installState = { installing: false, progress: null, lastResult: result, error: null }
      if (resumeAfter) {
        try { await start() } catch (error) {
          logger?.warn?.(`[magpie-engine] restart-after-install failed: ${String(error?.message ?? error)}`)
        }
      }
      return { ok: true, ...result }
    } catch (error) {
      installState = { installing: false, progress: null, lastResult: null, error: String(error?.message ?? error) }
      if (resumeAfter) {
        try { await start() } catch { /* restore best effort */ }
      }
      throw error
    }
  }

  async function boot() {
    assertOpen()
    const info = managedBinaryInfo(dataDir)
    if (!info.exists) {
      throw engineError('Magpie binary is not installed. Use the install button on the plugin page first.')
    }
    binary = info.file
    await fsp.mkdir(home, { recursive: true })

    // Prepare the isolated environment once. Only the port/key values change
    // between boot attempts.
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('MAGPIE_')) delete env[key]
    // Give the embedded instance its own agent home so it never rewrites the
    // real agents' configuration on this machine.
    const agentHome = path.join(home, 'agent-home')
    const roaming = path.join(agentHome, 'AppData', 'Roaming')
    const local = path.join(agentHome, 'AppData', 'Local')
    const configDir = path.join(home, 'config')
    const cache = path.join(home, 'cache')
    const data = path.join(home, 'data')
    const stateDir = path.join(home, 'state')
    for (const dir of [agentHome, roaming, local, configDir, cache, data, stateDir, path.join(configDir, 'magpie')]) {
      await fsp.mkdir(dir, { recursive: true })
    }
    Object.assign(env, {
      HOME: agentHome, USERPROFILE: agentHome,
      APPDATA: roaming, LOCALAPPDATA: local,
      XDG_CONFIG_HOME: configDir, XDG_CACHE_HOME: cache,
      XDG_DATA_HOME: data, XDG_STATE_HOME: stateDir,
      MAGPIE_NO_SHORTCUT: '1',
    })

    // freePort() probes then releases the port, leaving a small TOCTOU window
    // before the child binds it. If another process wins that race the child
    // exits immediately. Retry with a fresh port pair a few times.
    const MAX_BOOT_ATTEMPTS = 3
    let lastError = null
    for (let attempt = 1; attempt <= MAX_BOOT_ATTEMPTS; attempt++) {
      assertOpen()
      gatewayPort = await freePort()
      webPort = await freePort()
      while (webPort === gatewayPort) webPort = await freePort()
      webKey = randomBytes(32).toString('hex')
      webBase = `http://127.0.0.1:${webPort}`
      webURL = `${webBase}/?k=${webKey}`
      gatewayURL = `http://127.0.0.1:${gatewayPort}`

      const attemptEnv = {
        ...env,
        MAGPIE_ADDR: `127.0.0.1:${gatewayPort}`,
        MAGPIE_WEB_KEY: webKey,
      }
      child = spawn(binary, ['web', '--addr', `127.0.0.1:${webPort}`, '--no-open'], {
        cwd: home, env: attemptEnv, stdio: 'ignore', shell: false, windowsHide: true,
      })
      const owned = child
      // spawn() reports a missing/unexecutable binary via an async 'error'
      // event, not a synchronous throw. Without a listener Node throws an
      // uncaught exception that can crash the host. Capture it and fail fast.
      let spawnError = null
      child.once('error', (err) => { spawnError = err })
      child.once('exit', () => {
        if (child === owned && state === 'ready') {
          state = 'error'
          error = 'Magpie engine exited'
        }
      })

      const cookie = `magpie_web_${webPort}=${webKey}`
      const deadline = Date.now() + 20000
      let attemptError = null
      while (Date.now() < deadline) {
        assertOpen()
        if (spawnError) {
          attemptError = engineError(`failed to launch Magpie binary: ${String(spawnError?.message ?? spawnError)}`)
          break
        }
        if (owned.exitCode !== null || owned.signalCode !== null) {
          attemptError = engineError('Magpie engine exited during startup (port may be in use)')
          break
        }
        try {
          const res = await loopbackFetch(`${webBase}/api/settings`, {
            headers: { cookie, accept: 'application/json' },
            redirect: 'error',
            signal: AbortSignal.timeout(1500),
          })
          const body = await res.json()
          if (res.ok && body && typeof body === 'object' && !Array.isArray(body)) {
            state = 'ready'
            error = null
            logger?.info?.('[magpie-engine] official Web UI ready')
            return status()
          }
        } catch { /* not ready yet */ }
        await new Promise((resolve) => setTimeout(resolve, 150))
      }

      lastError = attemptError || engineError('Magpie engine did not become ready in time')
      // A launch failure (missing/corrupt binary) is deterministic: retrying
      // with new ports cannot help, so fail immediately instead of 3 times.
      if (spawnError) throw lastError
      // Clean up this failed attempt (a still-running child holds ports/files)
      // before probing a fresh port pair.
      await stopChild()
    }
    throw lastError
  }

  async function start() {
    assertOpen()
    // While an install is replacing the binary, a concurrent start would
    // re-launch the old executable and keep its file handle open, causing the
    // rename on Windows to fail with EPERM. Fail fast; callers (UI proxy,
    // /gui) can surface a temporary "installing" state instead of spinning.
    if (installState.installing) throw engineError('installation in progress; engine start deferred')
    if (state === 'ready') return status()
    if (!starting) {
      starting = (async () => {
        try {
          return await boot()
        } finally {
          starting = null
        }
      })()
    }
    return starting
  }

  function isInstalling() {
    return Boolean(installState.installing)
  }

  async function stop() {
    if (closing) return closing
    closing = (async () => {
      try {
        // An in-flight start may still spawn the child after stopChild() runs;
        // wait for it so the new process cannot survive this stop.
        if (starting) {
          try { await starting } catch { /* a failed start spawned nothing to kill */ }
        }
        await stopChild()
        state = 'stopped'
        error = null
        webURL = ''
        gatewayURL = ''
        webBase = ''
        webKey = ''
        return status()
      } finally {
        // Essential: without resetting, every later stop() would
        // return this settled promise and never kill a newly started engine.
        closing = null
      }
    })()
    return closing
  }

  async function close() {
    closed = true
    // A forced termination may fail; never leak an unhandled rejection during
    // plugin disposal.
    try { await stop() } catch { /* best effort during shutdown */ }
  }

  /** Reverse-proxy the official Web UI through the DSH origin, injecting auth. */
  async function proxy(req, res, upstreamPath) {
    if (state !== 'ready') throw engineError('engine is not ready')
    const headers = { ...req.headers }
    delete headers.host
    delete headers.connection
    delete headers['content-length']
    delete headers['transfer-encoding']
    for (const key of Object.keys(headers)) {
      if (key.startsWith('sec-fetch-') || key === 'sec-gpc' || key === 'forwarded' || key === 'x-forwarded-for') delete headers[key]
    }
    headers.origin = webBase
    headers.referer = `${webBase}/`
    headers.cookie = `magpie_web_${webPort}=${webKey}`
    headers['accept-encoding'] = 'identity'

    let body
    if (!['GET', 'HEAD'].includes(req.method)) {
      const chunks = []
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      body = chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0)
      headers['content-length'] = String(body.length)
    }

    const target = `${webBase}${upstreamPath}`
    const upstream = await loopbackFetch(target, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
    })

    const location = upstream.headers.get('location')
    if (location) {
      try {
        const u = new URL(location, target)
        if (u.origin === webBase) {
          const p = u.pathname === '/' ? `${UI_MOUNT}/` : UI_MOUNT + u.pathname
          res.writeHead(302, { location: p + u.search + u.hash })
          res.end()
          return
        }
      } catch { /* pass through */ }
    }

    const contentType = upstream.headers.get('content-type') || ''
    const isHtml = /\btext\/html\b/i.test(contentType) && !['HEAD'].includes(req.method)

    for (const [key, value] of upstream.headers) {
      if (['connection', 'transfer-encoding', 'content-length', 'location', 'set-cookie', 'content-security-policy'].includes(key)) continue
      res.setHeader(key, value)
    }

    if (isHtml && upstream.ok) {
      let html = await upstream.text()
      html = html.replace(/\b(src|href|action|poster)=(\")(\/(?!\/))/gi, `$1=$2${UI_MOUNT}$3`)
        .replace(/\b(src|href|action|poster)=(')(\/(?!\/))/gi, `$1=$2${UI_MOUNT}$3`)
      const injection = `<base href="${UI_MOUNT}/"><script>${browserBridge(UI_MOUNT)}</script>`
      html = /<head\b[^>]*>/i.test(html)
        ? html.replace(/<head\b[^>]*>/i, (m) => m + injection)
        : injection + html
      res.end(html)
      return
    }

    res.statusCode = upstream.status
    if (upstream.body) {
      const reader = upstream.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
      } finally {
        res.end()
      }
    } else {
      res.end()
    }
  }

  return {
    start, stop, close, status, proxy, install, isInstalling,
    get webUrl() { return webURL },
    get gatewayUrl() { return gatewayURL },
    get binDir() { return binDir },
  }
}

/** Injected into the official page so its relative URLs go through our mount. */
function browserBridge(mount) {
  return `(() => {
const prefix = ${JSON.stringify(mount)};
const rewrite = value => {
  if (typeof value !== 'string' && !(value instanceof URL)) return value;
  const text = String(value);
  if (/^(#|data:|blob:|mailto:|javascript:)/i.test(text)) return value;
  let url; try { url = new URL(text, location.href); } catch { return value; }
  if (url.origin !== location.origin) return value;
  if (url.pathname.startsWith(prefix)) return url.pathname + url.search + url.hash;
  if (url.pathname.startsWith('/api/')) return prefix + url.pathname + url.search + url.hash;
  if (url.pathname === '/' || url.pathname === '/index.html') return prefix + '/';
  return value;
};
const report = (kind, detail, res) => {
  const send = body => { try { origFetch.call(window, '/__dsh_magpie_diag', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ kind, detail: body || detail, href: location.href }) }); } catch {} };
  if (res && typeof res.clone === 'function' && res.body) { try { res.clone().text().then(send, () => send()); } catch { send(); } } else send();
};
const origFetch = window.fetch;
window.fetch = function(input, init) {
  const shown = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
  let out;
  try {
    if (typeof input === 'string') input = rewrite(input);
    else if (input instanceof Request) { const u = rewrite(input.url); if (u !== input.url) input = new Request(new URL(u, location.href), input); }
    out = origFetch.call(this, input, init);
  } catch (e) { report('throw', shown + ' :: ' + (e && e.message)); throw e; }
  if (out && typeof out.then === 'function') {
    out.then(r => { if (!r.ok) report('http ' + r.status, shown, r); }, e => report('reject', shown + ' :: ' + (e && e.message)));
  }
  return out;
};
try { const XO = XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open = function(m, u, ...r) { return XO.call(this, m, rewrite(u), ...r); }; } catch {}
for (const name of ['EventSource', 'WebSocket']) {
  try {
    const Orig = window[name];
    if (!Orig) continue;
    window[name] = new Proxy(Orig, { construct(Target, args) { args[0] = rewrite(args[0]); return Reflect.construct(Target, args); } });
  } catch {}
}
for (const [T, p] of [[HTMLScriptElement,'src'],[HTMLLinkElement,'href'],[HTMLImageElement,'src'],[HTMLIFrameElement,'src'],[HTMLAnchorElement,'href'],[HTMLFormElement,'action'],[HTMLSourceElement,'src'],[HTMLMediaElement,'src'],[HTMLVideoElement,'poster'],[HTMLObjectElement,'data']]) {
  try { const d = Object.getOwnPropertyDescriptor(T.prototype, p); if (d?.set) Object.defineProperty(T.prototype, p, {...d, set(v) { d.set.call(this, rewrite(v)); }}); } catch {}
}
for (const name of ['pushState', 'replaceState']) {
  try { const orig = history[name]; history[name] = function (s, t, u) { return orig.call(this, s, t, u == null ? u : rewrite(u)); }; } catch {}
}
const openWindow = window.open;
try { window.open = function (u, ...a) { return openWindow.call(this, rewrite(u), ...a); }; } catch {}
const sa = Element.prototype.setAttribute;
Element.prototype.setAttribute = function(n, v) { return sa.call(this, n, /^(src|href|action|poster|data)$/i.test(n) ? rewrite(v) : v); };
})();`
}
