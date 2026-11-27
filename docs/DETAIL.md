# DSH-Magpie

在 DeepSeek Harness 侧边栏新增「模型工作台」入口。打开后，主区域以 iframe 显示官方 Magpie 图形界面，功能与官方一致：供应商、Agent、路由、网关、用量、脱敏、插件等。

## 手动安装（不再自动下载）

插件激活时**不会**下载或启动 Magpie。请在插件管理页面本插件的详情页中操作：

- **下载并安装**：从 Magpie 官方 GitHub 仓库（`yetone/magpie-releases`）下载对应平台的程序，并用官方 SHA256SUMS 校验；校验失败则拒绝使用。已校验的本地副本会复用。
- **GitHub 镜像**：可填写自定义镜像前缀（如 `https://gh-proxy.com/`），留空使用官方地址。镜像**仅作用于二进制下载**；发布元数据与 SHA256SUMS 始终从官方 GitHub 获取（防止恶意镜像同时提供伪造哈希使校验失效），因此官方 GitHub 必须可达。配置保存在 DSH 目录下的独立文件 `dsh-magpie-settings.json` 中，保存后永久生效；引擎的启动/停止/重置不影响此配置，只有彻底卸载（卸载引擎或卸载整个插件）才会将其一并删除。
- **重复安装检测**：安装区域仅检测 DSH 内其他 Magpie 相关插件，并给出提示，避免重复安装。

## 运行方式

- Magpie 作为完全独立的内置实例运行，不调用、不干扰本机外部安装的 Magpie。
- 程序运行在 DSH 管理的私有数据目录中，拥有独立的配置、缓存与 agent 家目录，不会改写本机其他工具的配置。
- 网关端口与 Web 端口在启动时随机分配，不占用固定端口。
- 引擎按需启动：点击「启动引擎」或从侧边栏打开「模型工作台」时启动；可手动停止。
- 官方 Web UI 通过 DSH 同源路径反向代理并注入桥接脚本，使其在侧边栏 iframe 中正常工作。

## 模型接入 DSH

引擎就绪后，点击「同步模型到 DSH」：

- 从 Magpie 网关的 `/models` 接口拉取当前可用模型；
- 将模型 ID、显示名、上下文窗口、最大输出、输入模态与推理档位转换为 DSH 的模型描述；
- 以当前网关地址（含随机端口）写入 `dsh-llm-pi-ai` 的 `magpie` provider 路由，使这些模型出现在 DSH 的模型选择器中；
- 网关是本机回环服务，不需要 API Key；旧的硬编码端口/密钥配置会被自动纠正。

同步失败不会影响引擎本身；可通过安装区域或下面的接口重试。

## 管理接口

插件在 DSH 回环地址下提供以下本地接口（仅允许 127.0.0.1 / localhost 访问）：

- `GET /api/dsh-magpie/install/status`：安装状态、镜像配置与重复安装检测
- `GET /api/dsh-magpie/install/config` / `POST /api/dsh-magpie/install/config`：读取/保存 GitHub 镜像配置
- `POST /api/dsh-magpie/install`：手动触发下载安装（异步，通过 status 轮询进度）
- `GET /api/dsh-magpie/status`：查看引擎状态与模型同步状态
- `GET /api/dsh-magpie/gui`：获取界面地址，必要时按需启动
- `GET /api/dsh-magpie/models`：查看从网关发现的模型
- `POST /api/dsh-magpie/sync-models`：手动重新同步模型到 DSH
- `POST /api/dsh-magpie/start`：启动引擎
- `POST /api/dsh-magpie/stop`：停止引擎
- `POST /api/dsh-magpie/reset`：停止并清空私有数据后重新启动
- `POST /api/dsh-magpie/uninstall`：一键彻底卸载引擎（任意状态下均可）：停止当前引擎、清除所有属于本插件的残留进程、删除整个私有数据目录（含二进制、配置、缓存与诊断日志）、删除镜像配置文件 `dsh-magpie-settings.json` 与迁移标记 `.dsh-magpie-legacy-migrated`、并移除 DSH 中的 magpie 模型 provider，做到零残留。即使引擎从未启动或存在遗留进程也能完成。从 DSH 插件面板卸载整个插件时，会自动执行同样的彻底清理（延迟约 12 秒，确认不是插件更新或热重载后才删除）；更新插件不会删除任何数据。
