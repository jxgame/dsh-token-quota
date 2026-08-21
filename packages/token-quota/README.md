# @jxgame2020/dsh-token-quota

DeepSeek Harness 的**每日按模型 Token 限额**插件：后端按模型累计当日 token 用量并持久化、
达到上限时拦截请求；前端在 Web UI 右侧提供浮窗，实时显示每个被监控模型的
「实际/上限」，可对每个模型单独设置限额，满额时一键或自动切换模型。

对 DSH 核心仓库**零改动**：不修改任何核心文件、不挂载官方 bundle、不依赖转发事件
白名单；数据通过插件自有的 HTTP 路由（`GET /token-quota`）轮询读取，配置通过
settings 的 `token-quota` 命名空间读写。

## 功能

- **按模型独立计数**：输入 + 输出 + 缓存 token 全部计入当日用量；重启不丢
  （持久化到 `$DSH_HOME/token-quota.json`）。
- **硬拦截**：达到上限后请求直接停止并提示切换，不会继续消耗额度。
- **满额策略**（四选一，面板设置里切换，即时生效）：
  - 停止请求并提示
  - 自动切换到其它已监控且未满的限额模型
  - 自动切换到其它任意可用模型（含非限额）
  - 自动切换（优先非限额，其次未监控）
- **每日自动重置**：默认本机时区午夜；可在设置里改为任意时区（UTC−12 ~ +14）
  与时刻（0:00–23:55），到点清零当日计数并归档用量日志。
- **用量日志**：每模型每天一条（日期 / 模型 / 用量），与监控勾选无关。
- **浮窗面板**：实时显示各模型「今日已用 / 上限」，行内一键「选择」切换模型、
  `⚙` 折叠设置单模型限额。

## 安装

### 方式一：npm 安装（推荐）

在你的 web profile（`~/.dsh/profiles/web`）下：

```bash
cd ~/.dsh/profiles/web
npm install @jxgame2020/dsh-token-quota
```

> 用 pnpm 管理 profile 的话：`pnpm add @jxgame2020/dsh-token-quota`。

在 `cordis.patch.yml` 中挂载插件：

```yaml
- insert:
    - id: token-quota
      name: '@jxgame2020/dsh-token-quota'
```

重启 `dsh web`，浏览器右侧出现「每日 Token 限额」浮窗即安装成功。

### 方式二：从 GitHub 源码安装

适合想改源码、离线分发或审阅代码的情况。源码仓库不提交构建产物（`lib/`），
clone 后需在本机构建（工具链来自 DSH 仓库的 workspace）。

1. 克隆到与 `deepseek-harness` 同级的开发目录：

   ```bash
   git clone https://github.com/jxgame/dsh-token-quota.git deepseek-harness-package/dsh-token-quota
   ```

2. 在 `deepseek-harness/pnpm-workspace.yaml` 的 `packages:` 下注册该包（让它的
   peer 依赖从仓库 workspace 解析）：

   ```yaml
   packages:
     - ../deepseek-harness-package/dsh-token-quota/packages/token-quota
   ```

   然后在仓库根执行 `cd deepseek-harness && pnpm install`。

3. 构建：

   ```bash
   cd deepseek-harness-package/dsh-token-quota/packages/token-quota
   pnpm exec tsc -p tsconfig.json    # 类型检查 + 产出 lib/types
   pnpm exec tsdown                  # 产出 lib/index.js + lib/client.js
   ```

4. 挂载到 profile：`~/.dsh/profiles/web/package.json` 的 dependencies 使用本地路径：

   ```json
   "@jxgame2020/dsh-token-quota": "link:/<绝对路径>/deepseek-harness-package/dsh-token-quota/packages/token-quota"
   ```

   然后 `cd ~/.dsh/profiles/web && pnpm install`；`cordis.patch.yml` 挂载与
   方式一相同；重启 `dsh web`。

## 使用

- 头部「设置」弹窗（改动即时自动保存，右上角 × 关闭）
  - **监控模型**：勾选要监控的模型（默认全部）。未勾选的模型不显示、
    不计入当日用量、不受限额拦截（切换时仍可选）。
  - **满额后处理**：四选一（见上文「功能」）。
  - **每日重置时间**：时区（UTC−12 ~ UTC+14）与时刻（0:00–23:55，5 分钟步进），
    到点自动清零；不设置则沿用「本机时区午夜」。
- 头部「日志」按钮（设置左侧）：用量日志弹窗，表格列出日期 / 模型 / 用量，
  每模型每天一条。
- 模型行：
  - 名称后的「选择」按钮：一键切换当前会话到该模型。
  - 行尾 `⚙`：展开该行限额输入框（数字，`0`=不限），保存后收起。
  - 进度条：绿 <80%，黄 80–100%，红 = 已满额。

## 数据与重置

- 计数文件：`$DSH_HOME/token-quota.json`（默认 `~/.dsh/token-quota.json`）。
- 重置周期默认「本机时区午夜」；可改为任意时区与时刻。跨过重置时刻时当日计数
  清零并归档进用量日志。
- 限额与面板配置保存在 `~/.dsh/settings.yaml` 的 `token-quota` 命名空间
  （`limits` / `monitored` / `onFull` / `reset`）。
- 面板数据读取：`GET /token-quota`（当前快照）、`GET /token-quota/log`（历史用量）。

## 目录结构

```
dsh-token-quota/
└── packages/token-quota/
    ├── src/
    │   ├── index.ts            # Host 服务：计量/持久化/拦截/HTTP 快照路由
    │   ├── types.ts            # 共享类型与 wire 常量
    │   ├── invariant.ts        # 运行时守卫
    │   └── client/             # 浏览器面板（shell.overlay 浮窗）
    │       ├── index.ts        # apply：轮询 + 满额策略 + 面板注册
    │       ├── TokenQuotaPanel.tsx
    │       ├── store.ts
    │       ├── locales.ts
    │       └── TokenQuotaPanel.module.css
    ├── tsconfig.json           # host + client 一起编译
    └── tsdown.config.ts        # host 库 + 浏览器 bundle（closure-factory）
```

## License

MIT
