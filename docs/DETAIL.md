<div align="center">

# DSH-Magpie

> 在 DeepSeek Harness 侧边栏嵌入官方 Magpie 模型管理界面，并把 Magpie 网关模型接入 DSH 模型选择器。

[![DSH Web Plugin](https://img.shields.io/badge/DSH-Web%20Plugin-2563eb.svg)](https://github.com/MuChen969/dsh-magpie)
[![version](https://img.shields.io/badge/version-v1.0.0-4d93f8.svg)](https://github.com/MuChen969/dsh-magpie)
[![license](https://img.shields.io/badge/license-UNLICENSED-lightgrey.svg)](#许可)

🌏 [简体中文](README.md) · [English](README.en.md)

</div>

> 本插件是社区维护的第三方插件，并非 DeepSeek AI 官方产品；Magpie 官方 GUI 归其各自作者所有。

## 功能概览

在 DSH 侧边栏新增一个「模型工作台」入口，点击后在主区域以 iframe 显示官方 Magpie Web GUI —— 供应商、Agent、路由、网关、用量、脱敏、插件等功能与官方一致。引擎与模型接入则完全在 DSH 内完成配置。

| | |
|---|---|
| **🖥️ 官方模型工作台** | 侧边栏「模型工作台」入口，主区域 iframe 承载官方 Magpie GUI，功能与官方一致。 |
| **📦 手动安装引擎** | 插件激活时**不自动下载**。在插件详情页点击「下载并安装」，从 Magpie 官方 GitHub 下载对应平台程序，并用官方 `SHA256SUMS` 校验，校验失败即拒绝使用。 |
| **🔁 可配置 GitHub 镜像** | 可填写自定义镜像前缀加速二进制下载，保存后永久生效；出于安全，发布元数据与校验和始终走官方 GitHub。 |
| **🔍 重复安装检测** | 仅检测 DSH 内的其他 Magpie 插件并给出提示，避免重复占用资源。 |
| **🧩 独立内置实例** | 引擎运行在 DSH 管理的私有目录，端口随机分配，不调用、不干扰本机外部安装的 Magpie。 |
| **🔌 模型接入 DSH** | 引擎就绪后手动同步，把网关模型注册为 DSH 的 `magpie` provider，随即可在模型选择器中使用；网关地址随端口自动更新。 |
| **⚡ 按需启停** | 可手动启动/停止，打开模型工作台时也会按需启动，不随 DSH 自动运行。 |
| **🧹 卸载遵循 DSH 官方机制** | 本插件不自行删除任何本地数据。从 DSH 插件面板卸载本插件时，DSH 会调用插件的 disposer：仅停止 Magpie 子进程、注销路由与事件；引擎二进制、数据目录、镜像配置与模型 provider 均保留，由用户自行管理。 |

插件界面沿用 DSH 官方设计语言：控件样式基于宿主 token，侧边栏图标为线性描边风格，与原生入口保持一致；官方引擎 GUI 本身不做任何改动。

## 界面预览

插件详情页的安装与配置卡片：

- 已安装时显示状态卡片（文件名、版本、运行中/已就绪）
- 未安装时提供「下载并安装」入口
- GitHub 镜像配置、启动/停止、同步模型、刷新状态等操作一应俱全

模型工作台：侧边栏入口 → 主区域 iframe 显示官方 Magpie GUI；引擎未安装时可直接跳转回本插件详情页。

## 安装

需要已安装并能正常运行的 DeepSeek Harness（DSH）。仅支持通过 DSH 官方插件安装器安装：

1. 在 DSH 侧边栏打开 **插件（Plugins）** 页面，点击 **添加插件 / Add plugin**。
2. 粘贴 Git 地址：`https://github.com/MuChen969/dsh-magpie.git`
3. 安装完成后，在插件列表中启用 **模型工作台**（包名 `dsh-magpie`），重启 DSH。
4. 打开 **插件（Plugins）** 页面中的 **模型工作台** 详情页，在安装区域点击「下载并安装」。

> 桌面版 `desktop` profile 由 Electron 独占管理，无法通过命令行安装，请使用插件面板。

## 使用

1. 在插件详情页点击「下载并安装」，首次会从 GitHub 下载官方 Magpie 二进制（约 100 MB）并校验；已校验的本地副本会复用。
2. 如官方二进制下载不畅，可在「GitHub 镜像」中填入镜像地址并保存，再下载。
   > **注意**：出于安全，发布元数据与 `SHA256SUMS` 始终从官方 GitHub 获取，因此官方 GitHub 必须可达；镜像仅加速二进制文件下载，不能替代官方地址。
3. 下载完成后点击「启动引擎」，或直接从侧边栏打开「模型工作台」按需启动。
4. 点击「同步模型到 DSH」，把网关模型注册到 DSH 模型选择器。
5. 在 DSH 的模型选择器中选择 `Magpie` provider 下的模型即可对话。
6. 需要移除本插件时，在 DSH 的插件面板中卸载即可。卸载遵循 DSH 官方插件生命周期：仅停止 Magpie 子进程并注销插件资源，**不会删除** `~/.dsh/dsh-magpie-engine`、`dsh-magpie-settings.json` 等本地数据。如需彻底清理磁盘，请在卸载后手动删除这些目录/文件。更新插件不会删除数据。

## 本地接口

所有接口仅允许本机回环地址（`127.0.0.1` / `localhost`）访问：

| 接口 | 说明 |
|---|---|
| `GET /api/dsh-magpie/install/status` | 安装状态、镜像配置、重复安装检测 |
| `GET` / `POST /api/dsh-magpie/install/config` | 读取 / 保存 GitHub 镜像配置 |
| `POST /api/dsh-magpie/install` | 手动触发下载安装（异步，轮询 status 查看进度） |
| `GET /api/dsh-magpie/status` | 引擎状态与模型同步状态 |
| `GET /api/dsh-magpie/gui` | 获取界面地址，必要时按需启动 |
| `GET /api/dsh-magpie/models` | 查看从网关发现的模型 |
| `POST /api/dsh-magpie/sync-models` | 手动重新同步模型到 DSH |
| `POST /api/dsh-magpie/start` / `stop` / `reset` | 启动 / 停止 / 重置引擎 |

更详细的运行机制见 [docs/DETAIL.md](docs/DETAIL.md)。

## 常见问题

| 现象 | 说明与处理 |
|---|---|
| 下载引擎很慢或失败 | 配置可用的 GitHub 镜像前缀再下载；官方 GitHub 仍需可达（用于校验和）。 |
| 模型工作台提示引擎未安装 | 点击面板中的「前往安装」，会直接打开本插件详情页。 |
| 卸载后仍有文件残留 | 这是预期行为：按 DSH 官方插件生命周期，卸载插件不会删除本地数据。如需彻底清理，请手动删除：`~/.dsh/dsh-magpie-engine`、`~/.dsh/magpie-shell-engine`、`~/.dsh/dsh-magpie-settings.json`、`~/.dsh/.dsh-magpie-legacy-migrated`。 |
| 模型选择器里没有 Magpie 模型 | 先启动引擎，再点「同步模型到 DSH」；若网关暂无模型，请先在 Magpie GUI 中配置供应商与模型。 |
| 检测到其他 Magpie 插件 | 本插件使用完全独立的内置实例（独立目录与随机端口），不会冲突；请自行评估是否需要两份实例。 |
| 修改代码后界面未更新 | 按一次 DSH 界面的刷新（或重启 DSH）以加载最新插件代码。 |

## 目录结构

```
DSH-Magpie/
├── index.js               # Host 端：路由、安装配置、引擎生命周期、模型自动注册
├── magpie-engine.js       # 引擎：二进制下载校验、进程管理、Web UI 反向代理、重复检测
├── client.js              # Client 端：侧边栏入口、iframe 面板、插件页安装/配置卡片
├── cordis.patch.yml       # DSH Loader 补丁
├── locale/                # 中英文显示元数据
├── docs/DETAIL.md         # 插件详情页说明
├── icon.svg               # 插件图标
└── README.md              # 本说明
```

## 许可

`UNLICENSED`（见 `package.json`）。Magpie 官方图形界面与二进制归其各自作者所有，本插件仅做嵌入与集成。
