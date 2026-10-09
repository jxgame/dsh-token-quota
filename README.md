# @jxgame2020/dsh-token-quota

DeepSeek Harness 的**每日按模型 Token 限额**插件：后端按模型累计当日 token 用量并持久化、达到上限时拦截请求；前端在 Web UI 右侧提供浮窗，实时显示每个被监控模型的「实际/上限」，可对每个模型单独设置限额，满额时一键或自动切换模型。此外还内置**账户余额**、**环境音乐**、**语音转录**与**便利贴**等实用能力。

A daily per-model token quota plugin for the DeepSeek Harness: the host counts each model's token usage for the day (persisted), blocks requests once a cap is reached, and a floating panel on the right side of the Web UI shows live usage/limit per monitored model, lets you set per-model caps, and switches models in one click or automatically when a model is full. It also ships with **account balance**, **ambient music**, **voice transcription** and **sticky notes**.

对 DSH 核心仓库**零改动**：不修改任何核心文件、不挂载官方 bundle、不依赖转发事件白名单；数据通过插件自有的 HTTP 路由（`GET /token-quota`）轮询读取，配置通过 settings 的 `token-quota` 命名空间读写。

Zero changes to the DSH core repo: no core file is modified, no official bundle is mounted, and no forwarded-event allowlist is required. The panel polls a plugin-owned HTTP route (`GET /token-quota`), and configuration lives in the `token-quota` settings namespace.

## 功能 / Features

- **按模型独立计数**：输入 + 输出 + 缓存 token 全部计入当日用量；重启不丢（持久化到 `$DSH_HOME/token-quota.json`）。
  **Per-model counting**: input + output + cache tokens all count toward the daily usage, persisted to `$DSH_HOME/token-quota.json` across restarts.
- **硬拦截**：达到上限后请求直接停止并提示切换，不会继续消耗额度。
  **Hard enforcement**: once a cap is hit, requests are stopped and you are prompted to switch — no extra tokens are spent.
- **满额策略**（三选一，面板设置里切换，即时生效）/ **Full-quota strategy** (pick one in the panel settings; applies immediately):
  - 停止请求并提示 / Stop and prompt
  - 自动切换到其它已监控且未满的限额模型（找不到则报错）/ Auto-switch to another monitored, capped-but-available model (errors when none)
  - 自动切换到其它已监控模型（优先限额未满，其次非限额兜底）/ Auto-switch to another monitored model — capped models with headroom first, uncapped ones as fallback
- **每日自动重置**：默认本机时区午夜；可在设置里改为任意时区（UTC−12 ~ +14）与时刻（0:00–23:55），到点清零当日计数并归档用量日志。
  **Daily auto-reset**: defaults to local midnight; pick any timezone (UTC−12 ~ +14) and time (0:00–23:55) in settings — counters reset and the finished day is archived into the usage log.
- **用量日志**：每模型每天一条（日期 / 模型 / 用量），与监控勾选无关。
  **Usage log**: one row per model per day (date / model / usage), independent of the monitored set.
- **浮窗面板**：实时显示各模型「今日已用 / 上限」，行内一键「选择」切换模型、`⚙` 折叠设置单模型限额；行可拖拽排序；面板闲置时半透明化。
  **Floating panel**: live used/limit per model, a one-click Select button per row, a folded `⚙` per-model limit editor, drag-to-reorder rows, and it dims while idle.
- **账户余额窗口**：面板笔记行右侧的 ¥ 按钮打开「账户余额」窗口（贴合面板左缘），按提供方列出可用/总额，可排序、整批或逐条手动刷新，显示最近刷新时间（`Last: MM-dd HH:mm:ss`）；自动按设定的分钟数轮询；支持未配置 KEY、网络失败、未接入查询等状态。余额接口按各提供方自身的配置自动识别，目前支持 **DeepSeek**（`/user/balance`）与 **TeamoRouter**（`teamorouter.cn/v1/billing/balance`）两家。
  **Account balance window**: the ¥ button on the panel's notes row opens a balance window docked to the panel's left edge, listing available/total per provider with sortable columns, batch or per-row manual refresh, and a last-fetch time line (`Last: MM-dd HH:mm:ss`); auto-polls at a configured interval and reports states like unconfigured key, network failure, or no balance endpoint. Each provider's endpoint is recognised from its own configuration; **DeepSeek** (`/user/balance`) and **TeamoRouter** (`teamorouter.cn/v1/billing/balance`) are supported today.
- **悬停切换额度/余额**：支持余额查询的提供方，鼠标悬停某模型行时该行在「额度」与「余额」间每 3 秒翻转显示；若余额快照超过 5 分钟未刷新，悬停时立即触发刷新。
  **Hover flip quota/balance**: hovering a row of a provider with balance support toggles between quota and balance every 3 seconds; a stale balance (fetched > 5 min ago) refreshes immediately on hover.
- **音乐设置**：宿主行为（请求开始、工具调用、回合结束）驱动的环境音乐，Web Audio 或外接 MIDI 输出，可调音量与曲风，可只跟随当前会话。
  **Live music**: an ambient soundtrack composed from host actions (request starts, tool calls, turn ends) played via Web Audio or an attached MIDI output, with volume/style controls and an optional current-session-only scope.
- **语音转录（转录API）**：设置里启用后，输入框右上角出现 🎤 按钮——按下录音、再按停止并转录，识别文字直接插入输入框；接口为 OpenAI 兼容的 `POST {baseURL}/audio/transcriptions`（默认硅基流动），可配置接口地址、API Key 凭证变量与模型名。
  **Voice transcription**: once enabled in settings, a 🎤 button appears at the top-right of the composer — press to record, press again to stop and transcribe, and the recognised text is inserted into the input; the endpoint is OpenAI-compatible `POST {baseURL}/audio/transcriptions` (SiliconFlow by default), with configurable base URL, API-key credential reference and model name.

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
  - **限额 tab** / **Quota tab**：
    - **监控模型** / **Monitored models**：勾选要监控的模型（默认全部）。未勾选的模型不显示、不计入当日用量、不受限额拦截，也不会成为自动切换的目标。/ Check the models to monitor (all by default). Unchecked models are hidden, not metered, never capped, and never picked as an auto-switch target.
    - **满额后处理** / **When a model is full**：三选一（见上文「功能」）。/ one of three strategies (see Features above).
    - **每日重置时间** / **Daily reset**：时区（UTC−12 ~ UTC+14）与时刻（0:00–23:55，5 分钟步进），到点自动清零；不设置则沿用「本机时区午夜」。/ timezone (UTC−12 ~ UTC+14) and time (0:00–23:55, 5-min steps); defaults to machine-local midnight.
  - **音乐 tab** / **Music tab**：开关启用音乐 + 音量滑块 + 曲风选择 + 「仅当前会话」开关（需浏览器手势后才出声）。/ enable switch, volume slider, style picker, and a current-session-only toggle (audio only starts after a browser gesture).
  - **转录 tab** / **Transcribe tab**：开关启用语音转录；启用后显示接口地址、API Key 环境变量、模型三个输入框。/ enable switch; once on, shows base URL, API-key env var and model inputs.
  - **其它 tab** / **Other tab**：新版本检查开关、「闲置时变暗」开关等。/ update-check toggle, dim-when-idle toggle, and other misc options.
- 头部「日志」按钮（设置左侧）：用量日志弹窗，表格列出日期 / 模型 / 用量，每模型每天一条。/ The Logs button (left of Settings) opens the usage-log dialog: date / model / usage, one row per model per day.
- 模型行 / Model rows:
  - 名称后的「选择」按钮：一键切换当前会话到该模型。/ The Select button after the name switches the current session to that model.
  - 行尾 `⚙`：展开该行限额输入框（数字，`0`=不限），保存后收起。/ The `⚙` at the row end unfolds the limit editor (number, `0` = unlimited); it folds back after saving.
  - 进度条：绿 <80%，黄 80–100%，红 = 已满额。/ Progress bar: green <80%, yellow 80–100%, red = full.
  - 拖拽行首拖柄调整显示顺序；支持余额的提供方悬停时额度/余额翻转。/ Drag the row handle to reorder; rows of balance-capable providers flip between quota and balance on hover.
- 账户余额 / Account balance:
  - 面板笔记行右侧的 ¥ 按钮打开/关闭「账户余额」窗口（dock 在面板左缘）。/ The ¥ button on the notes row toggles the balance window (docked to the panel's left edge).
  - 窗口列出每个已接入提供方的余额（可用 / 总额），点击列头可排序；右上角图标整批刷新，每行按钮单独刷新；底部显示最近刷新时间。/ The window lists each wired provider's balance (available / total), sortable by column headers; the top-right icon refreshes all, per-row buttons refresh one, and a footer shows the last-fetch time.
  - 余额由宿主按设置里的轮询分钟数自动刷新；余额低于阈值、未配置 KEY、网络失败、未接入查询等状态会在行内标注。/ The host auto-refreshes balances at the configured poll interval; low-balance, unconfigured-key, network-failure and no-endpoint states are annotated inline.
- 笔记 / Notes:
  - 面板笔记行（标题行下一行）右侧「+」新建便利贴：可拖动、缩放、折叠/关闭；内容、位置与大小自动保存。/ The notes row (below the header line) has a "+" to create sticky notes — draggable, resizable, collapsible/closeable, all persisted automatically.
- 语音转录 / Voice transcription:
  - 设置里启用后，输入框（内容编辑器）右上角出现 🎤；按下开始录音（按钮变红脉动），再按停止并发送转录，识别文字追加到输入框；转录中按钮显示 `…`；错误（麦克风权限、空录音、接口报错）在按钮旁短暂提示。/ Once enabled, a 🎤 appears at the top-right of the composer; press to record (button pulses red), press again to stop and transcribe, and the recognised text is appended to the input; while transcribing the button shows `…`; errors (mic permission, empty recording, endpoint failure) flash beside the button.
  - API Key 通过凭证解析（环境变量名 → 凭证值 → `.env` 回退），未配置时请求返回错误提示。/ The API key resolves through the credential seam (env var name → credential file → `.env` fallback); a missing key surfaces a clear error.

## 数据与重置 / Data & Reset

- 计数文件：`$DSH_HOME/token-quota.json`（默认 `~/.dsh/token-quota.json`）。/ Counter file: `$DSH_HOME/token-quota.json` (default `~/.dsh/token-quota.json`).
- 重置周期默认「本机时区午夜」；可改为任意时区与时刻。跨过重置时刻时当日计数清零并归档进用量日志。/ The reset cycle defaults to machine-local midnight and can be changed to any timezone/time; crossing the reset moment zeroes the counters and archives the finished day into the usage log.
- 限额与面板配置保存在 `~/.dsh/settings.yaml` 的 `token-quota` 命名空间（`limits` / `monitored` / `onFull` / `reset` / `balance` / `music` / `transcribe` / `notes` / `order`）。/ Limits and panel preferences live in the `token-quota` namespace of `~/.dsh/settings.yaml` (`limits` / `monitored` / `onFull` / `reset` / `balance` / `music` / `transcribe` / `notes` / `order`).
  - `balance`: `{ enabled, pollMinutes }`（余额显示与轮询分钟数）。/ balance display toggle and poll interval.
  - `music`: `{ enabled, volume, style, onlyCurrentSession }`（环境音乐）。/ ambient music settings.
  - `transcribe`: `{ enabled, baseURL, apiKeyEnv, model }`（语音转录）。/ voice transcription settings.
  - `notes` / `order`：便利贴数组 / 模型显示顺序。/ sticky notes array / model display order.
- 面板数据读取：`GET /token-quota`（当前快照）、`GET /token-quota/log`（历史用量）。/ Panel data endpoints: `GET /token-quota` (live snapshot), `GET /token-quota/log` (usage history).
- 面板动作：`POST /token-quota/refresh-balance`（余额整批或单提供方刷新）、`POST /token-quota/transcribe`（录音 → 转录文本）。/ Panel actions: `POST /token-quota/refresh-balance` (refresh all or one provider's balance), `POST /token-quota/transcribe` (audio → transcribed text).

## 目录结构 / Project Structure

```
dsh-token-quota/
└── packages/token-quota/
    ├── src/
    │   ├── index.ts            # Host 服务：计量/持久化/拦截/余额/转写/HTTP 路由 / host service: metering, persistence, enforcement, balances, transcription, HTTP routes
    │   ├── types.ts            # 共享类型与 wire 常量 / shared types and wire constants
    │   ├── invariant.ts        # 运行时守卫 / runtime guards
    │   └── client/             # 浏览器端 / browser side
    │       ├── index.ts        # apply：轮询 + 满额策略 + 面板与麦克风插槽注册 / polling + full-quota strategy + panel/mic slot registration
    │       ├── TokenQuotaPanel.tsx
    │       ├── TokenQuotaPanel.module.css
    │       ├── mic.tsx         # 输入框右上角麦克风：录音 + 转录 + 插入输入框 / composer mic: record + transcribe + insert
    │       ├── mic.module.css
    │       ├── store.ts
    │       ├── music.ts        # 宿主动作驱动的环境音乐引擎 / host-action-driven music engine
    │       ├── locales.ts
    │       └── ...
    ├── tsconfig.json           # host + client 一起编译 / compiles host + client
    └── tsdown.config.ts        # host 库 + 浏览器 bundle（closure-factory）/ host lib + browser bundle
```

## License / 许可证

MIT
