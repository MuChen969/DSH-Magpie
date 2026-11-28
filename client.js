/**
 * @local/dsh-magpie — Client half (manual-install edition).
 *
 * 1. Keeps the 模型工作台 sidebar entry with the official Magpie GUI iframe.
 * 2. Adds an installation / settings card to the bundle's own page in Plugins
 *    (slot `plugins.bundle.config`, key = package name). The card lets the user
 *    manually download the Magpie binary, configure a GitHub mirror, see a
 *    duplicate-install warning and start/stop the engine.
 *
 * Uninstall is handled entirely by DSH's official plugin manager: removing this
 * bundle calls the Host disposer, which only stops the child process. This UI
 * never deletes data under DSH_HOME.
 */

window.__ModuleLoader__.load({
  id: 'dsh-magpie',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'magpie-workbench'
    const GUI_API = '/api/dsh-magpie/gui'
    const API_BASE = '/api/dsh-magpie'
    const BUNDLE_NAME = 'dsh-magpie'

    // Set in apply() from DSH's official reflection service. Calling it opens
    // this bundle's detail page directly, in one step.
    let navigateToBundle = null

    // Same workbench artwork as the package icon (icon.svg), embedded for the sidebar slot.
    // Sidebar glyph: a line-style workbench window with model nodes, matching
    // the outlined icon language of DSH sidebar entries (currentColor stroke).
    const MAGPIE_SVG = `<svg width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
<rect x="4" y="6" width="28" height="24" rx="3"/>
<path d="M4 12 H32"/>
<circle cx="8.5" cy="9" r="0.6" fill="currentColor" stroke="none"/>
<rect x="8" y="16" width="8" height="6" rx="1.2"/>
<rect x="20" y="16" width="8" height="6" rx="1.2"/>
<path d="M12 22 V26 M24 22 V26"/>
<circle cx="12" cy="27.5" r="1" fill="currentColor" stroke="none"/>
<circle cx="24" cy="27.5" r="1" fill="currentColor" stroke="none"/>
</svg>`

    function MagpieIcon(props) {
      // The sidebar slot may or may not pass a `size`; fall back to 20px so the
      // glyph keeps the same optical weight as neighbouring sidebar entries.
      const raw = props && props.size
      const size = typeof raw === 'number' && raw > 0 ? raw : 18
      const svg = MAGPIE_SVG.replace('width="36" height="36"', `width="${size}" height="${size}"`)
      return h('span', {
        'aria-hidden': true,
        style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, lineHeight: 0 },
        dangerouslySetInnerHTML: { __html: svg },
      })
    }

    // ---- Shared fetch helpers ---------------------------------------------
    async function apiGet(path) {
      const r = await fetch(`${API_BASE}${path}`, { headers: { accept: 'application/json' } })
      return r.json()
    }
    async function apiPost(path, body) {
      const r = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      return r.json()
    }

    // ---- 模型工作台面板 ----------------------------------------------------
    function WorkbenchPanel() {
      const [url, setUrl] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [navHint, setNavHint] = React.useState(null)
      const [state, setState] = React.useState('checking') // checking | need-install | starting | ready
      const navTimers = React.useRef([])

      React.useEffect(() => () => {
        navTimers.current.forEach(clearInterval)
        navTimers.current = []
      }, [])

      // Navigate to this bundle's own install card. The Plugins page is already
      // reachable from the left sidebar, so no synthetic shortcut is needed.
      // DOM lookup is done with short polling because React may mount panels
      // asynchronously; every step degrades to a clear, manual instruction.
      function findClickable(parts) {
        const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], [role="tab"]'))
        return nodes.find((n) => {
          const text = `${n.textContent || ''} ${n.getAttribute('aria-label') || ''} ${n.getAttribute('title') || ''}`
          return parts.some((p) => text.toLowerCase().includes(p.toLowerCase()))
        }) || null
      }

      function clickWhenReady(find, timeout, done) {
        const started = Date.now()
        const timer = setInterval(() => {
          const node = find()
          if (node) {
            clearInterval(timer)
            navTimers.current = navTimers.current.filter((t) => t !== timer)
            try { node.click() } catch { /* fall through to hint */ }
            done(Boolean(node))
          } else if (Date.now() - started >= timeout) {
            clearInterval(timer)
            navTimers.current = navTimers.current.filter((t) => t !== timer)
            done(false)
          }
        }, 80)
        navTimers.current.push(timer)
      }

      function openInstallPage() {
        // Preferred: DSH's own navigation service opens this bundle's detail
        // page (the install card lives there) in a single step.
        if (typeof navigateToBundle === 'function') {
          try {
            navigateToBundle(BUNDLE_NAME)
            setNavHint(null)
            return
          } catch { /* fall back to DOM navigation below */ }
        }
        // Fallback for builds where the reflection service is unavailable:
        // open the Plugins panel, then locate this bundle's entry.
        setNavHint('正在打开插件设置。')
        clickWhenReady(
          () => findClickable(['插件', 'Plugins']),
          4000,
          (opened) => {
            if (!opened) {
              setNavHint('未找到「插件」入口，请点击左侧边栏的「插件」，然后选择 DSH-Magpie。')
              return
            }
            setNavHint('已打开插件页，正在定位 DSH-Magpie。')
            clickWhenReady(
              () => findClickable(['DSH-Magpie']),
              5000,
              (found) => {
                setNavHint(found
                  ? null
                  : '请在插件列表中找到 DSH-Magpie，打开详情页后安装引擎。')
              },
            )
          },
        )
      }

      React.useEffect(() => {
        let alive = true
        // First check whether the embedded binary is installed at all.
        apiGet('/install/status').then((info) => {
          if (!alive) return
          if (!info.ok) throw new Error(info.error || 'status failed')
          if (!info.installed) {
            setState('need-install')
            return
          }
          setState('starting')
          return fetch(GUI_API, { headers: { accept: 'application/json' } })
            .then((r) => r.json())
            .then((data) => {
              if (!alive) return
              if (data.ok && data.url) {
                setUrl(data.url)
                setError(null)
                setState('ready')
              } else {
                throw new Error(data.error ?? '无法获取 Magpie 界面地址')
              }
            })
        }).catch((err) => {
          if (alive) setError(String(err?.message ?? err))
        })
        return () => { alive = false }
      }, [])

      return h(
        'div',
        { className: 'dsh-magpie-workbench' },
        h(Styles),
        error ? h('div', { className: 'dsh-magpie-notice dsh-magpie-notice--banner', 'data-tone': 'error', role: 'alert' }, error) : null,
        url
          ? h('iframe', {
              src: url,
              title: 'Magpie 模型工作台',
              style: { flex: 1, width: '100%', border: 0, background: 'var(--dsw-alias-bg-base)' },
              allow: 'clipboard-read; clipboard-write; fullscreen',
            })
          : state === 'need-install'
            ? h('div', { className: 'dsh-magpie-center' },
                h('div', { className: 'dsh-magpie-section__title' }, 'Magpie 引擎尚未安装'),
                h('div', { className: 'dsh-magpie-section__desc', style: { maxWidth: '360px' } },
                  '请点击下方按钮前往插件详情页安装引擎。'),
                h('button', {
                  className: btnClass('primary', 'md'),
                  style: { marginTop: '4px' },
                  onClick: openInstallPage,
                }, '安装引擎'),
                navHint
                  ? h('div', {
                      role: 'status',
                      className: 'dsh-magpie-notice dsh-magpie-notice--banner',
                      'data-tone': 'info',
                      style: { maxWidth: '420px', marginTop: '6px' },
                    }, navHint)
                  : null,
              )
            : state === 'checking'
              ? h('div', { className: 'dsh-magpie-center' }, '正在检查安装状态。')
              : error
                ? h('div', { className: 'dsh-magpie-center' }, '无法启动 Magpie 界面，请查看上方错误信息或在插件页检查引擎状态。')
                : h('div', { className: 'dsh-magpie-center' }, '正在启动官方 Magpie 界面。'),
      )
    }

    // ---- 插件管理页：安装 / 设置卡片 --------------------------------------
    // A tiny inline spinner used by buttons while an action is in flight.
    function Spinner({ small }) {
      return h('span', {
        'aria-hidden': true,
        className: 'dsh-magpie-spinner' + (small ? ' dsh-magpie-spinner--sm' : ''),
        style: { verticalAlign: '-3px', marginRight: '6px' },
      })
    }
    // Download progress bar: determinate when the server reports a total,
    // indeterminate shimmer when only bytes received are known.
    function DownloadProgress({ progress }) {
      const received = Number(progress?.received) || 0
      const total = Number(progress?.total) || 0
      const ratio = total > 0 ? Math.min(1, received / total) : null
      const mb = (n) => `${(n / 1048576).toFixed(1)} MB`
      const percent = ratio === null ? null : Math.round(ratio * 100)
      return h('div', { className: 'dsh-magpie-progress' },
        h('div', { className: 'dsh-magpie-progress__meta' },
          h('span', {}, '正在下载 Magpie 引擎。'),
          h('span', {}, ratio === null ? mb(received) : `${percent}%  ${mb(received)} / ${mb(total)}`),
        ),
        h('div', { className: 'dsh-magpie-progress__track' },
          h('div', {
            className: 'dsh-magpie-progress__fill' + (ratio === null ? ' dsh-magpie-progress__fill--indeterminate' : ''),
            style: ratio === null ? undefined : { width: `${ratio * 100}%` },
          }),
        ),
      )
    }

    // ---- DSH 官方风格样式 --------------------------------------------------
    // 复刻自已安装 DSH 0.2.2-rc.5 的 primitives 构建产物与官方插件管理页样式。
    // 参照 DSH 开发规范：不 require primitives 包，只复刻 markup/CSS，
    // 只保留主题 token；结构性 token 与扩展 alias 均提供 fallback。
    // 官方引擎 GUI（下方 iframe）不受这些样式影响。
    const MAGPIE_CSS = `
/* ---- Button：对齐官方 Button primitive ---- */
.dsh-magpie-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;border:none;border-radius:var(--dsw-radius-md,6px);cursor:pointer;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent;padding:0 14px;transition:background .14s ease,border-color .14s ease}
.dsh-magpie-btn--md{height:36px}
.dsh-magpie-btn--sm{height:28px;font-size:12px;line-height:18px;padding:0 10px;border-radius:var(--dsw-radius-sm,5px)}
.dsh-magpie-btn--primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-label-on-color,var(--dsw-alias-bg-base)))}
@media(hover:hover){.dsh-magpie-btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary))}}
.dsh-magpie-btn--outline{border:.5px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));background:transparent}
@media(hover:hover){.dsh-magpie-btn--outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}}
.dsh-magpie-btn--ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.dsh-magpie-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-bg-layer-2))}
.dsh-magpie-btn:disabled{cursor:not-allowed;opacity:.4}
.dsh-magpie-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
/* DSH primitives 无独立 danger 变体：动作行用描边错误色，实心错误色仅留给确认框 */
.dsh-magpie-btn--danger{border:.5px solid var(--dsw-alias-state-error-primary);background:transparent;color:var(--dsw-alias-state-error-primary)}
@media(hover:hover){.dsh-magpie-btn--danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}}
.dsh-magpie-btn--danger.dsh-magpie-btn--solid{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-label-on-color,var(--dsw-alias-bg-base)))}
@media(hover:hover){.dsh-magpie-btn--danger.dsh-magpie-btn--solid:hover:not(:disabled){filter:brightness(1.08)}}

/* ---- Input / Field：对齐官方 Input + ConfigField ---- */
.dsh-magpie-field{display:flex;flex-direction:column;gap:6px;font-size:13px}
.dsh-magpie-field__label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dsh-magpie-field__input{box-sizing:border-box;width:100%;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-md,6px);outline:none;background:var(--dsw-alias-bg-layer-1);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dsh-magpie-field__input::placeholder{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-secondary))}
.dsh-magpie-field__input:focus{border-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary))}
.dsh-magpie-field__hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
@media(pointer:coarse){.dsh-magpie-field__input{font-size:16px}}

/* ---- Tag：对齐官方 Tag primitive ---- */
.dsh-magpie-tag{display:inline-flex;align-items:center;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap}
.dsh-magpie-tag[data-tone='neutral']{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dsh-magpie-tag[data-tone='outline']{border:.5px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-secondary)}
.dsh-magpie-tag[data-tone='success']{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-state-success-primary)}
.dsh-magpie-tag[data-tone='warning']{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}

/* ---- 已安装状态卡片：对齐官方 settings-card + Tag ---- */
.dsh-magpie-status{display:flex;align-items:flex-start;gap:12px;padding:14px;border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1))}
.dsh-magpie-status__check{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-state-success-primary)}
.dsh-magpie-status__body{display:flex;flex-direction:column;gap:7px;min-width:0;flex:1}
.dsh-magpie-status__head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsh-magpie-status__title{font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.dsh-magpie-status__meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-magpie-status__code{padding:1px 7px;border-radius:var(--dsw-radius-sm,5px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:18px}

/* ---- Notice：官方设置区提示条风格 ---- */
.dsh-magpie-notice{display:flex;align-items:flex-start;gap:8px;padding:9px 12px;border-radius:var(--dsw-radius-md,6px);font-size:12px;line-height:1.6}
.dsh-magpie-notice[data-tone='error']{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,var(--dsw-alias-bg-layer-1));border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 26%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsh-magpie-notice[data-tone='warning']{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,var(--dsw-alias-bg-layer-1));border:.5px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 26%,transparent);color:var(--dsw-alias-state-warn-primary)}
.dsh-magpie-notice[data-tone='info']{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
/* banner：置于 tone 规则之后并以复合选择器保证覆盖，视觉为分隔线式提示 */
.dsh-magpie-notice.dsh-magpie-notice--banner{border-radius:0;border-width:0 0 .5px}

/* ---- Section / 布局 ---- */
.dsh-magpie-workbench{display:flex;flex-direction:column;height:100%;width:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dsh-magpie-section{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary)}
.dsh-magpie-section__title{font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.dsh-magpie-section__desc{font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-magpie-center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary)}
.dsh-magpie-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsh-magpie-list{margin:6px 0 0;padding-left:18px;color:var(--dsw-alias-label-secondary)}
.dsh-magpie-divider{height:.5px;background:var(--dsw-alias-border-l2);margin:2px 0}
.dsh-magpie-muted{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}

/* ---- Spinner：对齐官方 Spinner primitive ---- */
.dsh-magpie-spinner{display:inline-block;position:relative;flex:none;width:20px;height:20px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);animation:dsh-magpie-spin .8s linear infinite}
.dsh-magpie-spinner::after{content:"";position:absolute;inset:-2px;border-radius:50%;background:conic-gradient(var(--dsw-alias-brand-primary) 72deg,transparent 0);-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 0);mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 0)}
.dsh-magpie-spinner--sm{width:14px;height:14px;border-width:1.5px}
@keyframes dsh-magpie-spin{to{transform:rotate(360deg)}}

/* ---- Progress：DSH 无官方 primitive，采用官方 token 的细条样式 ---- */
.dsh-magpie-progress{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:var(--dsw-radius-md,6px);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2)}
.dsh-magpie-progress__meta{display:flex;justify-content:space-between;gap:12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-magpie-progress__track{height:6px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}
.dsh-magpie-progress__fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .25s ease}
.dsh-magpie-progress__fill--indeterminate{width:35%;animation:dsh-magpie-indeterminate 1.2s ease-in-out infinite}
@keyframes dsh-magpie-indeterminate{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}

/* ---- Modal：对齐官方 Modal primitive（卸载引擎确认）---- */
.dsh-magpie-modal-root{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px}
.dsh-magpie-modal-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.46));backdrop-filter:var(--dsw-mask-blur,blur(2px));animation:dsh-magpie-modal-in var(--ds-transition-duration,.16s) var(--ds-ease-in-out,ease)}
.dsh-magpie-modal{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;width:100%;max-width:420px;padding:0 0 20px;border-radius:var(--dsw-radius-panel,14px);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent,0 18px 48px rgba(0,0,0,.26));animation:dsh-magpie-modal-in var(--ds-transition-duration,.16s) var(--ds-ease-in-out,ease);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.6}
.dsh-magpie-modal:focus{outline:none}
.dsh-magpie-modal__header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:20px 14px 8px 22px}
.dsh-magpie-modal__title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dsh-magpie-modal__close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm,5px);background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:18px;line-height:1}
.dsh-magpie-modal__desc{margin:0;padding:0 22px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsh-magpie-modal__footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 22px}
@keyframes dsh-magpie-modal-in{0%{opacity:0}100%{opacity:1}}

/* ---- Toast：对齐官方 Toast primitive（顶部居中浮层，宽度随内容）---- */
.dsh-magpie-toast{position:fixed;top:40px;left:50%;z-index:1100;pointer-events:none;display:flex;align-items:center;gap:10px;width:max-content;max-width:min(640px,calc(100vw - 48px));padding:12px 16px;border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-toast-bg,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-toast-label,var(--dsw-alias-label-primary));box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.18));font-size:14px;line-height:22px;transform:translateX(-50%);animation:dsh-magpie-toast-in .16s ease-out}
.dsh-magpie-toast[data-kind='error']{color:var(--dsw-alias-state-error-primary)}
.dsh-magpie-toast[data-kind='success']{color:var(--dsw-alias-state-success-primary)}
@keyframes dsh-magpie-toast-in{0%{opacity:0;transform:translate(-50%,-6px)}100%{opacity:1;transform:translate(-50%,0)}}

@media(prefers-reduced-motion:reduce){
  .dsh-magpie-modal-mask,.dsh-magpie-modal,.dsh-magpie-toast{animation:none}
  .dsh-magpie-spinner,.dsh-magpie-progress__fill--indeterminate{animation:none}
}
`

    // 官方风格 Button 的类名拼装；Styles 在两个面板内各自注入一次样式。
    function btnClass(...parts) {
      return ['dsh-magpie-btn', ...parts.filter(Boolean).map((p) => 'dsh-magpie-btn--' + p)].join(' ')
    }
    function Styles() {
      return h('style', {}, MAGPIE_CSS)
    }

    // ---- 卸载引擎确认框：对齐官方插件管理页 ConfirmDialog -----------------
    // 官方风格：标题「卸载「X」？」+ 一行描述；取消用 outline，确认用
    // primary + danger；打开时聚焦、Esc 关闭、焦点回到触发元素。
    function TrashIcon({ size = 13 }) {
      return h('span', {
        'aria-hidden': true,
        style: { display: 'inline-flex', flex: '0 0 auto', width: size, height: size, color: 'var(--dsw-alias-state-error-primary)', lineHeight: 0 },
        dangerouslySetInnerHTML: {
          __html: `<svg style="display:block" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"/><path d="M10 11v6M14 11v6"/></svg>`,
        },
      })
    }

    function UninstallEngineDialog({ onCancel, onConfirm, busy }) {
      const cancelRef = React.useRef(null)
      const panelRef = React.useRef(null)

      React.useEffect(() => {
        const previouslyFocused = document.activeElement
        cancelRef.current?.focus()
        return () => { try { previouslyFocused?.focus?.() } catch { /* element may be gone */ } }
      }, [])

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape' && !busy) { event.preventDefault(); onCancel(); return }
          if (event.key === 'Tab') {
            const items = panelRef.current?.querySelectorAll('button:not(:disabled)')
            if (!items || items.length === 0) { event.preventDefault(); panelRef.current?.focus(); return }
            const first = items[0]
            const last = items[items.length - 1]
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
          }
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [busy, onCancel])

      return h('div', {
        className: 'dsh-magpie-modal-root',
        onClick: (event) => { if (event.target === event.currentTarget && !busy) onCancel() },
      },
        h('div', { className: 'dsh-magpie-modal-mask', 'aria-hidden': true, onClick: (event) => { if (!busy) onCancel() } }),
        h('div', {
          ref: panelRef,
          className: 'dsh-magpie-modal',
          role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dsh-magpie-uninstall-engine-title',
          tabIndex: -1,
          onClick: (event) => event.stopPropagation(),
        },
          h('div', { className: 'dsh-magpie-modal__header' },
            h('h2', { id: 'dsh-magpie-uninstall-engine-title', className: 'dsh-magpie-modal__title' },
              h('span', { style: { verticalAlign: '-4px', marginRight: '8px' } }, h(TrashIcon, { size: 16 })),
              '卸载「Magpie 引擎」？'),
            h('button', {
              type: 'button', className: 'dsh-magpie-modal__close', 'aria-label': '关闭',
              disabled: busy, onClick: onCancel,
            }, '×'),
          ),
          h('p', { className: 'dsh-magpie-modal__desc' }, '此操作将移除引擎程序及其运行数据；GitHub 镜像配置予以保留，可重新安装引擎。'),
          h('div', { className: 'dsh-magpie-modal__footer' },
            h('button', {
              ref: cancelRef, className: btnClass('outline', 'md'),
              disabled: busy, onClick: onCancel,
            }, '取消'),
            h('button', {
              className: btnClass('danger', 'solid', 'md'), disabled: busy, onClick: onConfirm,
            }, busy ? h('span', {}, h(Spinner, { small: true }), '卸载中。') : '卸载引擎'),
          )
        )
      )
    }

    // ---- 已安装状态卡片 ----------------------------------------------------
    // 对齐官方 card/panel + Tag 风格，把原来两行裸文本组织成有层次的状态摘要。
    function CheckIcon() {
      return h('span', {
        'aria-hidden': true,
        className: 'dsh-magpie-status__check',
        dangerouslySetInnerHTML: {
          __html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
        },
      })
    }

    function InstalledStatus({ info }) {
      const version = info.version || info.install?.lastResult?.tag || ''
      const running = info.engineState === 'ready'
      return h('div', { className: 'dsh-magpie-status' },
        h(CheckIcon),
        h('div', { className: 'dsh-magpie-status__body' },
          h('div', { className: 'dsh-magpie-status__head' },
            h('span', { className: 'dsh-magpie-status__title' }, 'Magpie 引擎已安装'),
            h('span', {
              className: 'dsh-magpie-tag',
              'data-tone': running ? 'success' : 'neutral',
            }, running ? '运行中' : '已就绪'),
          ),
          h('div', { className: 'dsh-magpie-status__meta' },
            h('code', { className: 'dsh-magpie-status__code' }, info.binaryName || 'magpie'),
            version ? h('span', { className: 'dsh-magpie-tag', 'data-tone': 'outline' }, version) : null,
          ),
        ),
      )
    }

    function InstallCard() {
      const [info, setInfo] = React.useState(null)
      const [mirror, setMirror] = React.useState('')
      const [confirmUninstall, setConfirmUninstall] = React.useState(false)
      const [busy, setBusy] = React.useState('') // '' or the key of the active button
      const [toast, setToast] = React.useState(null) // { kind: success|error|info, text }
      const toastTimer = React.useRef(null)

      function notify(kind, text) {
        setToast({ kind, text })
        if (toastTimer.current) clearTimeout(toastTimer.current)
        // Keep success/error messages long enough to read; info is brief.
        toastTimer.current = setTimeout(() => setToast(null), kind === 'error' ? 6000 : 3500)
      }
      React.useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])

      function refresh(options = {}) {
        const { silent = false } = options
        return apiGet('/install/status').then((data) => {
          if (!data.ok) throw new Error(data.error || 'status failed')
          setInfo(data)
          // Only sync the mirror field for user-triggered/initial refreshes.
          // Silent polling during install must not clobber an address the user
          // is currently typing into the input.
          if (!silent) setMirror(data.settings?.mirror || '')
          if (!silent) notify('info', '状态已刷新')
          return data
        }).catch((err) => {
          if (!silent) notify('error', `刷新状态失败：${err?.message ?? err}`)
          // Silent polling must not produce unhandled rejections.
          return null
        })
      }

      React.useEffect(() => {
        let alive = true
        apiGet('/install/status').then((data) => {
          if (!alive) return
          if (data.ok) {
            setInfo(data)
            setMirror(data.settings?.mirror || '')
          } else notify('error', data.error || 'status failed')
        }).catch((err) => { if (alive) notify('error', String(err?.message ?? err)) })
        return () => { alive = false }
      }, [])

      // Poll while installing — silent so it doesn't spam toasts.
      React.useEffect(() => {
        if (!info?.install?.installing) return
        const timer = setInterval(() => { void refresh({ silent: true }) }, 1200)
        return () => clearInterval(timer)
      }, [info?.install?.installing])

      async function withAction(key, fn) {
        setBusy(key)
        try {
          await fn()
        } finally {
          setBusy('')
        }
      }

      async function onInstall() {
        await withAction('install', async () => {
          notify('info', '已开始下载 Magpie 引擎，请稍候。')
          try {
            const data = await apiPost('/install', {})
            if (!data.ok) throw new Error(data.error || 'install request failed')
            await refresh({ silent: true })
            notify('success', '安装任务已提交')
          } catch (err) {
            notify('error', `安装失败：${err?.message ?? err}`)
          }
        })
      }

      async function onSave() {
        await withAction('save', async () => {
          try {
            const data = await apiPost('/install/config', { mirror })
            if (!data.ok) throw new Error(data.error || 'save failed')
            await refresh({ silent: true })
            notify('success', mirror ? 'GitHub 镜像已保存' : '已恢复官方 GitHub 地址')
          } catch (err) {
            notify('error', `保存镜像失败：${err?.message ?? err}`)
          }
        })
      }

      async function onToggleEngine() {
        await withAction('engine', async () => {
          const action = info?.engineState === 'ready' ? 'stop' : 'start'
          notify('info', action === 'stop' ? '正在停止引擎。' : '正在启动引擎。')
          try {
            const data = await apiPost(`/${action}`, {})
            if (!data.ok) throw new Error(data.error || `${action} failed`)
            await refresh({ silent: true })
            notify('success', action === 'stop' ? '引擎已停止' : '引擎已启动')
          } catch (err) {
            notify('error', `${action === 'stop' ? '停止' : '启动'}引擎失败：${err?.message ?? err}`)
          }
        })
      }

      function onUninstallEngine() {
        setConfirmUninstall(true)
      }

      async function doUninstallEngine() {
        setConfirmUninstall(false)
        await withAction('uninstall-engine', async () => {
          notify('info', '正在卸载 Magpie 引擎。')
          try {
            const data = await apiPost('/uninstall-engine', {})
            if (!data.ok) throw new Error(data.error || 'uninstall engine failed')
            await refresh({ silent: true })
            notify('success', 'Magpie 引擎已卸载，镜像配置已保留')
          } catch (err) {
            notify('error', `卸载引擎失败：${err?.message ?? err}`)
          }
        })
      }

      // Buttons dim while another action is running and show their own spinner.
      const btnContent = (key, text) => busy === key ? h('span', {}, h(Spinner, { small: true }), text) : text
      // Keep other actions visually dimmed while one is in flight (official disabled state).
      const dim = (key) => (busy && busy !== key ? { opacity: 0.4 } : undefined)

      const installed = Boolean(info?.installed)
      const installing = Boolean(info?.install?.installing)
      const progress = info?.install?.progress

      return h(
        'div',
        { className: 'dsh-magpie-section' },
        h(Styles),
        h('div', { className: 'dsh-magpie-section__title' }, 'Magpie 引擎安装与配置'),

        // 已安装：有层次的状态卡片；未安装：简短说明
        installed
          ? h(InstalledStatus, { info })
          : h('div', { className: 'dsh-magpie-section__desc' },
              '尚未安装内置 Magpie，请点击下方「安装引擎」按钮，程序将经过 SHA-256 校验。'),

        // duplicate detection — only other Magpie plugins inside DSH.
        info?.detection?.hasDuplicate
          ? h('div', { className: 'dsh-magpie-notice', 'data-tone': 'warning' },
              h('div', {}, '检测到 DSH 中已有其他 Magpie 插件。本插件使用完全独立的内置实例（独立配置目录与随机端口），不会与其冲突；请注意避免重复占用磁盘空间：'),
              h('ul', { className: 'dsh-magpie-list' },
                info.detection.duplicates.map((d, i) =>
                  h('li', { key: i }, `${d.name}${d.detail ? ` — ${d.detail}` : ''}${d.path ? ` (${d.path})` : ''}`)
                )
              )
            )
          : null,

        // install error / last result
        info?.install?.error
          ? h('div', { className: 'dsh-magpie-notice', 'data-tone': 'error' }, `上次安装失败：${info.install.error}`)
          : null,
        installing
          ? h(DownloadProgress, { progress })
          : null,

        // mirror config
        h('div', { className: 'dsh-magpie-field' },
          h('div', { className: 'dsh-magpie-row' },
            h('span', { className: 'dsh-magpie-field__label' }, 'GitHub 镜像'),
            (info?.settings?.mirror)
              ? h('span', { className: 'dsh-magpie-tag', 'data-tone': 'success' }, '已生效')
              : null,
          ),
          h('div', { className: 'dsh-magpie-row' },
            h('input', {
              type: 'text',
              className: 'dsh-magpie-field__input',
              style: { flex: '1 1 320px', minWidth: '220px', width: 'auto' },
              value: mirror,
              placeholder: '留空则使用官方 GitHub；例如 https://gh-proxy.com/',
              onChange: (e) => setMirror(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && !busy) void onSave() },
            }),
            h('button', {
              className: btnClass('outline', 'md'),
              style: dim('save'), disabled: Boolean(busy), onClick: onSave,
            }, btnContent('save', '保存')),
          ),
          h('div', { className: 'dsh-magpie-field__hint' }, '该地址作为下载链接前缀，保存后永久生效；留空则使用官方地址。'),
        ),

        // actions
        h('div', { className: 'dsh-magpie-row' },
          h('button', {
            className: btnClass('primary', 'md'),
            style: dim('install'), disabled: Boolean(busy) || installing || installed, onClick: onInstall,
            title: installed ? '引擎已安装，请先卸载引擎再安装' : undefined,
          }, btnContent('install', installing ? '正在安装。' : '安装引擎')),
          h('button', {
            className: btnClass('outline', 'md'),
            style: dim('engine'), disabled: Boolean(busy) || !installed, onClick: onToggleEngine,
          }, btnContent('engine', info?.engineState === 'ready' ? '停止引擎' : '启动引擎')),
          h('button', {
            className: btnClass('outline', 'md', 'danger'),
            style: dim('uninstall-engine'), disabled: Boolean(busy) || !installed,
            'aria-label': '卸载 Magpie 引擎', onClick: onUninstallEngine,
            title: '卸载引擎（保留镜像配置）',
          }, h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } },
            h(TrashIcon, { size: 14 }),
            btnContent('uninstall-engine', '卸载引擎'),
          )),
        ),

        // unified feedback toast for every action
        toast
          ? h('div', {
              role: 'status',
              className: 'dsh-magpie-toast',
              'data-kind': toast.kind === 'error' ? 'error' : toast.kind === 'success' ? 'success' : 'info',
            }, toast.text)
          : null,
        confirmUninstall
          ? h(UninstallEngineDialog, {
              onCancel: () => setConfirmUninstall(false),
              onConfirm: doUninstallEngine,
              busy: busy === 'uninstall-engine',
            })
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // DSH exposes an official navigation service from the Plugins panel.
        // Bind to it so "前往安装" can open this bundle's detail page directly.
        ctx.inject(['pluginNavigation'], (scope) => {
          navigateToBundle = (name) => scope.pluginNavigation.openBundle(name)
          return () => { navigateToBundle = null }
        })
        // Left sidebar entry.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 8, label: '模型工作台' },
            MagpieIcon,
          ),
        )
        // Main panel showing the official Magpie GUI.
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: PANEL_ID },
            WorkbenchPanel,
          ),
        )
        // Installation / settings card on this bundle's own Plugins page.
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            { name: 'plugins.bundle.config', key: 'dsh-magpie' },
            InstallCard,
          ),
        )
      },
    }
  },
})
