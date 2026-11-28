<div align="center">

# DSH-Magpie

> Embed the official Magpie model management GUI in the DeepSeek Harness sidebar, and register Magpie gateway models into the DSH model picker.

[![DSH Web Plugin](https://img.shields.io/badge/DSH-Web%20Plugin-2563eb.svg)](https://github.com/MuChen969/dsh-magpie)
[![version](https://img.shields.io/badge/version-v1.0.0-4d93f8.svg)](https://github.com/MuChen969/dsh-magpie)
[![license](https://img.shields.io/badge/license-UNLICENSED-lightgrey.svg)](#license)

🌏 [简体中文](README.md) · [English](README.en.md)

</div>

> This is a community-maintained third-party plugin, not an official DeepSeek AI product. The official Magpie GUI belongs to its respective authors.

## Features

Add a **Model workbench** entry to the DSH sidebar. Clicking it shows the official Magpie Web GUI in an iframe in the main area — providers, agents, routes, gateway, usage, desensitization, plugins and more, identical to upstream. Engine setup and model registration are configured entirely inside DSH.

| | |
|---|---|
| **🖥️ Official model workbench** | A "Model workbench" sidebar entry whose iframe hosts the official Magpie GUI, with full upstream functionality. |
| **📦 Manual engine install** | The plugin does **not** download anything on activation. In the plugin detail page click **Download & install** to fetch the matching binary from Magpie's official GitHub, verified against the official `SHA256SUMS`; a failed check is rejected. |
| **🔁 Configurable GitHub mirror** | Set a custom mirror prefix to speed up binary downloads; saved permanently. For security, release metadata and checksums always come from official GitHub. |
| **🔍 Duplicate detection** | Detects only other Magpie plugins inside DSH and warns you, avoiding duplicated resources. |
| **🧩 Self-contained instance** | The engine runs in a DSH-managed private directory with random ports; it never calls or interferes with an external Magpie installation. |
| **🔌 Model registration** | Once ready, sync models on demand to register them as the `magpie` provider in DSH, available in the model picker. Gateway address follows port changes automatically. |
| **⚡ On-demand start/stop** | Start or stop manually, or start automatically when opening the workbench; no autostart with DSH. |
| **🧹 Uninstall follows DSH's official mechanism** | When you remove the bundle from the DSH plugin panel, the plugin detects the genuine uninstall through the official `plugin-manager/operation` event (`settled/remove/applied`) and then stops the Magpie child process and removes the engine binary, private data directory, GitHub mirror config and model providers. Updates, disabling, HMR reloads and DSH shutdown do not trigger cleanup. |

The plugin UI follows DSH's official design language: controls use host theme tokens and the sidebar glyph is an outlined icon matching native entries. The official engine GUI itself is left untouched.

## Preview

Install & configuration card on the plugin detail page:

- When installed: a status card with binary name, version and running/ready badge
- When not installed: a **Download & install** entry
- GitHub mirror config, start/stop, sync models and refresh status in one place

Model workbench: sidebar entry → main-area iframe with the official Magpie GUI; if the engine is missing, the panel offers a direct jump back to this plugin's detail page.

## Installation

Requires a working DeepSeek Harness (DSH) installation. Install only through the official DSH plugin installer:

1. Open **Plugins** in the DSH sidebar and click **Add plugin**.
2. Paste the Git URL: `https://github.com/MuChen969/dsh-magpie.git`
3. Enable **Model workbench** (package name `dsh-magpie`) in the plugin list, then restart DSH.
4. Open the **Model workbench** detail page under **Plugins** and click **Download & install** in the install area.

> The desktop `desktop` profile is managed exclusively by Electron and cannot be installed from the command line — use the plugin panel.

## Usage

1. Click **Download & install** in the plugin detail page. On first run it downloads the official Magpie binary (~100 MB) from GitHub and verifies it; an already verified local copy is reused.
2. If the official download is slow, set a GitHub mirror prefix under **GitHub mirror** and save, then download again.
   > **Note**: for security, release metadata and `SHA256SUMS` are always fetched from official GitHub, so official GitHub must be reachable; the mirror only accelerates the binary download and cannot replace it.
3. After download, click **Start engine**, or open **Model workbench** from the sidebar to start on demand.
4. Click **Sync models to DSH** to register gateway models into the DSH model picker.
5. Select a model under the `Magpie` provider in the DSH model picker to chat.
6. To remove this plugin, uninstall it from DSH's plugin panel. Removal follows DSH's official plugin lifecycle: the plugin watches the official uninstall event and, once the removal settles, stops the Magpie child process and removes `~/.dsh/dsh-magpie-engine`, `~/.dsh/magpie-shell-engine`, `~/.dsh/dsh-magpie-settings.json`, the migration marker and the magpie model providers in DSH — leaving no residue. Updates, disabling, HMR reloads and DSH shutdown keep all data.

## Local API

All endpoints only accept loopback addresses (`127.0.0.1` / `localhost`):

| Endpoint | Description |
|---|---|
| `GET /api/dsh-magpie/install/status` | Install status, mirror config, duplicate detection |
| `GET` / `POST /api/dsh-magpie/install/config` | Read / save GitHub mirror config |
| `POST /api/dsh-magpie/install` | Trigger manual download (async; poll status for progress) |
| `GET /api/dsh-magpie/status` | Engine state and model sync state |
| `GET /api/dsh-magpie/gui` | Get the GUI URL, starting the engine on demand |
| `GET /api/dsh-magpie/models` | List models discovered from the gateway |
| `POST /api/dsh-magpie/sync-models` | Re-sync models into DSH manually |
| `POST /api/dsh-magpie/start` / `stop` / `reset` | Start / stop / reset the engine |

See [docs/DETAIL.md](docs/DETAIL.md) for more implementation details.

## FAQ

| Symptom | Explanation & fix |
|---|---|
| Engine download is slow or fails | Set a working GitHub mirror prefix and retry; official GitHub must still be reachable for checksums. |
| Workbench says the engine is not installed | Click **Go to install** in the panel to open this plugin's detail page directly. |
| Files remain after uninstall | Uninstall removes the engine, data, mirror config and model providers; on Windows a brief file lock is retried. If residue remains after a moment, delete manually: `~/.dsh/dsh-magpie-engine`, `~/.dsh/magpie-shell-engine`, `~/.dsh/dsh-magpie-settings.json`, `~/.dsh/.dsh-magpie-legacy-migrated`. |
| No Magpie models in the picker | Start the engine, then click **Sync models to DSH**; if the gateway has no models yet, configure providers/models in the Magpie GUI first. |
| Another Magpie plugin detected | This plugin uses a fully independent instance (own directory and random ports), so there is no conflict; decide whether you need two instances. |
| UI did not update after code changes | Press DSH's refresh button once (or restart DSH) to load the latest plugin code. |

## Structure

```
DSH-Magpie/
├── index.js               # Host: routes, install config, engine lifecycle, model registration
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
