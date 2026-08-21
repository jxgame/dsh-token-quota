# @jxgame2020/dsh-token-quota

DeepSeek Harness 的**每日按模型 Token 限额**插件：后端按模型累计当日 token 用量并持久化、达到上限时拦截请求；前端在 Web UI 右侧提供浮窗，实时显示每个被监控模型的「实际/上限」，可对每个模型单独设置限额，满额时一键或自动切换模型。

A daily per-model token quota plugin for the DeepSeek Harness: the host counts each model's token usage for the day (persisted), blocks requests once a cap is reached, and a floating panel on the right side of the Web UI shows live usage/limit per monitored model, lets you set per-model caps, and switches models in one click or automatically when a model is full.

对 DSH 核心仓库**零改动**：不修改任何核心文件、不挂载官方 bundle、不依赖转发事件白名单；数据通过插件自有的 HTTP 路由（`GET /token-quota`）轮询读取，配置通过 settings 的 `token-quota` 命名空间读写。

Zero changes to the DSH core repo: no core file is modified, no official bundle is mounted, and no forwarded-event allowlist is required. The panel polls a plugin-owned HTTP route (`GET /token-quota`), and configuration lives in the `token-quota` settings namespace.

## 功能 / Features

- **按模型独立计数**：输入 + 输出 + 缓存 token 全部计入当日用量；重启不丢（持久化到 `$DSH_HOME/token-quota.json`）。
  **Per-model counting**: input + output + cache tokens all count toward the daily usage, persisted to `$DSH_HOME/token-quota.json` across restarts.
- **硬拦截**：达到上限后请求直接停止并提示切换，不会继续消耗额度。
  **Hard enforcement**: once a cap is hit, requests are stopped and you are prompted to switch — no extra tokens are spent.
- **满额策略**（四选一，面板设置里切换，即时生效）/ **Full-quota strategy** (pick one in the panel settings; applies immediately):
  - 停止请求并提示 / Stop and prompt
  - 自动切换到其它已监控且未满的限额模型 / Auto-switch to another monitored, capped-but-available model
  - 自动切换到其它任意可用模型（含非限额）/ Auto-switch to any other available model (incl. uncapped)
  - 自动切换（优先非限额，其次未监控）/ Prefer uncapped models, then unmonitored ones
- **每日自动重置**：默认本机时区午夜；可在设置里改为任意时区（UTC−12 ~ +14）与时刻（0:00–23:55），到点清零当日计数并归档用量日志。
  **Daily auto-reset**: defaults to local midnight; pick any timezone (UTC−12 ~ +14) and time (0:00–23:55) in settings — counters reset and the finished day is archived into the usage log.
- **用量日志**：每模型每天一条（日期 / 模型 / 用量），与监控勾选无关。
  **Usage log**: one row per model per day (date / model / usage), independent of the monitored set.
- **浮窗面板**：实时显示各模型「今日已用 / 上限」，行内一键「选择」切换模型、`⚙` 折叠设置单模型限额。
  **Floating panel**: live used/limit per model, a one-click Select button per row, and a folded `⚙` per-model limit editor.

## 安装 / Installation

### 方式一：npm 安装（推荐）/ Option A: npm install (recommended)

在你的 web profile（`~/.dsh/profiles/web`）下安装依赖：

Install the dependency in your web profile (`~/.dsh/profiles/web`):

```bash
cd ~/.dsh/profiles/web
npm install @jxgame2020/dsh-token-quota
```

> 用 pnpm 管理 profile 的话：`pnpm add @jxgame2020/dsh-token-quota`。
> With pnpm: `pnpm add @jxgame2020/dsh-token-quota`.

在 `cordis.patch.yml` 中挂载插件：

Mount the plugin in `cordis.patch.yml`:

```yaml
- insert:
    - id: token-quota
      name: '@jxgame2020/dsh-token-quota'
```

重启 `dsh web`，浏览器右侧出现「每日 Token 限额」浮窗即安装成功。

Restart `dsh web`; the floating panel appears on the right side once installed.

### 方式二：从 GitHub 源码安装 / Option B: install from source (GitHub)

适合想改源码、离线分发或审阅代码的情况。源码仓库不提交构建产物（`lib/`），clone 后需在本机构建（工具链来自 DSH 仓库的 workspace）。

For modifying the source, offline distribution, or code review. The source repo does not ship build output (`lib/`); clone and build locally (the toolchain resolves from the DSH repo workspace).

1. 克隆到与 `deepseek-harness` 同级的开发目录 / Clone next to your `deepseek-harness` checkout:

   ```bash
   git clone https://github.com/jxgame/dsh-token-quota.git deepseek-harness-package/dsh-token-quota
   ```

2. 在 `deepseek-harness/pnpm-workspace.yaml` 的 `packages:` 下注册该包（让 peer 依赖从仓库 workspace 解析）/ Register the package under `packages:` in `deepseek-harness/pnpm-workspace.yaml` so peer deps resolve from the repo workspace:

   ```yaml
   packages:
     - ../deepseek-harness-package/dsh-token-quota/packages/token-quota
   ```

   然后在仓库根执行 `cd deepseek-harness && pnpm install`。/ Then run `cd deepseek-harness && pnpm install`.

3. 构建 / Build:

   ```bash
   cd deepseek-harness-package/dsh-token-quota/packages/token-quota
   pnpm exec tsc -p tsconfig.json    # 类型检查 + 产出 lib/types / type-check + emit lib/types
   pnpm exec tsdown                  # 产出 lib/index.js + lib/client.js
   ```

4. 挂载到 profile：`~/.dsh/profiles/web/package.json` 的 dependencies 使用本地路径 / Mount into the profile with a local path dependency:

   ```json
   "@jxgame2020/dsh-token-quota": "link:/<absolute-path>/deepseek-harness-package/dsh-token-quota/packages/token-quota"
   ```

   然后 `cd ~/.dsh/profiles/web && pnpm install`；`cordis.patch.yml` 挂载与方式一相同；重启 `dsh web`。/ Then `cd ~/.dsh/profiles/web && pnpm install`; the `cordis.patch.yml` mount is the same as Option A; restart `dsh web`.

## 使用 / Usage

- 头部「设置」弹窗（改动即时自动保存，右上角 × 关闭）/ The header Settings dialog (changes auto-save instantly; close with × at the top-right):
  - **监控模型** / **Monitored models**：勾选要监控的模型（默认全部）。未勾选的模型不显示、不计入当日用量、不受限额拦截（切换时仍可选）。/ Check the models to monitor (all by default). Unchecked models are hidden, not metered, and never capped (they remain selectable).
  - **满额后处理** / **When a model is full**：四选一（见上文「功能」）。/ one of four strategies (see Features above).
  - **每日重置时间** / **Daily reset**：时区（UTC−12 ~ UTC+14）与时刻（0:00–23:55，5 分钟步进），到点自动清零；不设置则沿用「本机时区午夜」。/ timezone (UTC−12 ~ UTC+14) and time (0:00–23:55, 5-min steps); defaults to machine-local midnight.
- 头部「日志」按钮（设置左侧）：用量日志弹窗，表格列出日期 / 模型 / 用量，每模型每天一条。/ The Logs button (left of Settings) opens the usage-log dialog: date / model / usage, one row per model per day.
- 模型行 / Model rows:
  - 名称后的「选择」按钮：一键切换当前会话到该模型。/ The Select button after the name switches the current session to that model.
  - 行尾 `⚙`：展开该行限额输入框（数字，`0`=不限），保存后收起。/ The `⚙` at the row end unfolds the limit editor (number, `0` = unlimited); it folds back after saving.
  - 进度条：绿 <80%，黄 80–100%，红 = 已满额。/ Progress bar: green <80%, yellow 80–100%, red = full.

## 数据与重置 / Data & Reset

- 计数文件：`$DSH_HOME/token-quota.json`（默认 `~/.dsh/token-quota.json`）。/ Counter file: `$DSH_HOME/token-quota.json` (default `~/.dsh/token-quota.json`).
- 重置周期默认「本机时区午夜」；可改为任意时区与时刻。跨过重置时刻时当日计数清零并归档进用量日志。/ The reset cycle defaults to machine-local midnight and can be changed to any timezone/time; crossing the reset moment zeroes the counters and archives the finished day into the usage log.
- 限额与面板配置保存在 `~/.dsh/settings.yaml` 的 `token-quota` 命名空间（`limits` / `monitored` / `onFull` / `reset`）。/ Limits and panel preferences live in the `token-quota` namespace of `~/.dsh/settings.yaml` (`limits` / `monitored` / `onFull` / `reset`).
- 面板数据读取：`GET /token-quota`（当前快照）、`GET /token-quota/log`（历史用量）。/ Panel data endpoints: `GET /token-quota` (live snapshot), `GET /token-quota/log` (usage history).

## 目录结构 / Project Structure

```
dsh-token-quota/
└── packages/token-quota/
    ├── src/
    │   ├── index.ts            # Host 服务：计量/持久化/拦截/HTTP 快照路由 / host service: metering, persistence, enforcement, snapshot route
    │   ├── types.ts            # 共享类型与 wire 常量 / shared types and wire constants
    │   ├── invariant.ts        # 运行时守卫 / runtime guards
    │   └── client/             # 浏览器面板（shell.overlay 浮窗）/ browser panel (shell.overlay)
    │       ├── index.ts        # apply：轮询 + 满额策略 + 面板注册 / polling + full-quota strategy + registration
    │       ├── TokenQuotaPanel.tsx
    │       ├── store.ts
    │       ├── locales.ts
    │       └── TokenQuotaPanel.module.css
    ├── tsconfig.json           # host + client 一起编译 / compiles host + client
    └── tsdown.config.ts        # host 库 + 浏览器 bundle（closure-factory）/ host lib + browser bundle
```

## License / 许可证

MIT
