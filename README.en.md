<div align="center">

# DSH-Magpie

> Embed the official Magpie model management GUI in the DeepSeek Harness sidebar.

[![DSH Web Plugin](https://img.shields.io/badge/DSH-Web%20Plugin-2563eb.svg)](https://github.com/MuChen969/dsh-magpie)
[![version](https://img.shields.io/badge/version-v1.0.0-4d93f8.svg)](https://github.com/MuChen969/dsh-magpie)
[![license](https://img.shields.io/badge/license-UNLICENSED-lightgrey.svg)](#license)

🌏 [简体中文](README.md) · [English](README.en.md)

</div>

> This is a community-maintained third-party plugin, not an official DeepSeek AI product. The official Magpie GUI belongs to its respective authors.

## Features

Add a **Model workbench** entry to the DSH sidebar. Clicking it shows the official Magpie Web GUI in an iframe in the main area — providers, agents, routes, gateway, usage, desensitization, plugins and more, identical to upstream. Engine installation, startup and configuration are handled entirely inside DSH.

| | |
|---|---|
| **🖥️ Official model workbench** | A "Model workbench" sidebar entry whose iframe hosts the official Magpie GUI, with full upstream functionality. |
| **📦 Manual engine install** | The plugin does **not** download anything on activation. In the plugin detail page click **Install engine** to fetch the matching binary from Magpie's official GitHub, verified against the official `SHA256SUMS`; a failed check is rejected. The button is disabled while the engine is installed (uninstall it first to install again). |
| **🔁 Configurable GitHub mirror** | Set a custom mirror prefix to speed up binary downloads; saved permanently. For security, release metadata and checksums always come from official GitHub. |
| **🔍 Duplicate detection** | Detects only other Magpie plugins inside DSH and warns you, avoiding duplicated resources. |
| **🧩 Self-contained instance** | The engine runs in a DSH-managed private directory with random ports; it never calls or interferes with an external Magpie installation. |
| **⚡ On-demand start/stop** | Start or stop manually, or start automatically when opening the workbench; no autostart with DSH. |
| **🗑️ Manual engine uninstall** | An "Uninstall engine" button on the plugin detail page removes the engine binary and private data, while **keeping** the GitHub mirror config; click **Install engine** again to reinstall. |
| **🧹 Uninstall follows DSH's official mechanism** | When you remove the bundle from the DSH plugin panel, the plugin detects the genuine uninstall through the official `plugin-manager/operation` event (`settled/remove/applied`) and then stops the Magpie child process and removes the engine binary, private data directory and GitHub mirror config. Updates, disabling, HMR reloads and DSH shutdown do not trigger cleanup. |

The plugin UI follows DSH's official design language: controls use host theme tokens and the sidebar glyph is an outlined icon matching native entries. The official engine GUI itself is left untouched.

## Preview

Install & configuration card on the plugin detail page:

- When installed: a status card with binary name, version and running/ready badge
- An **Install engine** entry (disabled while the engine is installed; uninstall the engine first to install again)
- GitHub mirror config, start/stop and uninstall engine in one place

Model workbench: sidebar entry → main-area iframe with the official Magpie GUI; if the engine is missing, the panel offers a direct jump back to this plugin's detail page.

## Installation

Requires a working DeepSeek Harness (DSH) installation. Install only through the official DSH plugin installer:

1. Open **Plugins** in the DSH sidebar and click **Add plugin**.
2. Paste the Git URL: `https://github.com/MuChen969/dsh-magpie.git`
3. Enable **Model workbench** (package name `dsh-magpie`) in the plugin list, then restart DSH.
4. Open the **Model workbench** detail page under **Plugins** and click **Install engine** in the install area.

> The desktop `desktop` profile is managed exclusively by Electron and cannot be installed from the command line — use the plugin panel.

## Usage

1. When the engine is not installed, click **Install engine** in the plugin detail page. It downloads the official Magpie binary (~100 MB) from GitHub and verifies it. While installed, the button is disabled; uninstall the engine first to install again.
2. If the official download is slow, set a GitHub mirror prefix under **GitHub mirror** and save, then download again.
   > **Note**: for security, release metadata and `SHA256SUMS` are always fetched from official GitHub, so official GitHub must be reachable; the mirror only accelerates the binary download and cannot replace it.
3. After download, click **Start engine**, or open **Model workbench** from the sidebar to start on demand.
4. To remove only the engine but keep the plugin, click **Uninstall engine** on the detail page and confirm: this removes the engine binary and private data, but **keeps** the GitHub mirror config; click **Install engine** again to reinstall the engine.
5. To remove this plugin, uninstall it from DSH's plugin panel. Removal follows DSH's official plugin lifecycle: the plugin watches the official uninstall event and, once the removal settles, stops the Magpie child process and removes `~/.dsh/dsh-magpie-engine`, `~/.dsh/magpie-shell-engine`, `~/.dsh/dsh-magpie-settings.json` and the migration marker — leaving no residue. Updates, disabling, HMR reloads and DSH shutdown keep all data.

## Local API

All endpoints only accept loopback addresses (`127.0.0.1` / `localhost`):

| Endpoint | Description |
|---|---|
| `GET /api/dsh-magpie/install/status` | Install status, mirror config, duplicate detection |
| `GET` / `POST /api/dsh-magpie/install/config` | Read / save GitHub mirror config |
| `POST /api/dsh-magpie/install` | Trigger manual download (async; poll status for progress) |
| `POST /api/dsh-magpie/uninstall-engine` | Manually uninstall the engine: removes the binary and private data, **keeps** the GitHub mirror config |
| `GET /api/dsh-magpie/status` | Engine state |
| `GET /api/dsh-magpie/gui` | Get the GUI URL, starting the engine on demand |
| `POST /api/dsh-magpie/start` / `stop` / `reset` | Start / stop / reset the engine |

See [docs/DETAIL.md](docs/DETAIL.md) for more implementation details.

## FAQ

| Symptom | Explanation & fix |
|---|---|
| Engine download is slow or fails | Set a working GitHub mirror prefix and retry; official GitHub must still be reachable for checksums. |
| Workbench says the engine is not installed | Click **Go to install** in the panel to open this plugin's detail page directly. |
| Files remain after uninstall | Uninstall removes the engine, data and mirror config; on Windows a brief file lock is retried. If residue remains after a moment, delete manually: `~/.dsh/dsh-magpie-engine`, `~/.dsh/magpie-shell-engine`, `~/.dsh/dsh-magpie-settings.json`, `~/.dsh/.dsh-magpie-legacy-migrated`. |
| Another Magpie plugin detected | This plugin uses a fully independent instance (own directory and random ports), so there is no conflict; decide whether you need two instances. |
| UI did not update after code changes | Press DSH's refresh button once (or restart DSH) to load the latest plugin code. |

## Structure

```
DSH-Magpie/
├── index.js               # Host: routes, install config, engine lifecycle
├── magpie-engine.js       # Engine: download & verify, process management, UI reverse proxy, duplicate detection
├── client.js              # Client: sidebar entry, iframe panel, install/config card
├── cordis.patch.yml       # DSH Loader patch
├── locale/                # English & Chinese display metadata
├── docs/DETAIL.md         # Plugin detail page document
├── icon.svg               # Plugin icon
└── README.md              # This document (中文: README.md / English: README.en.md)
```

## License

`UNLICENSED` (see `package.json`). The official Magpie GUI and binaries belong to their respective authors; this plugin only embeds and integrates them.
