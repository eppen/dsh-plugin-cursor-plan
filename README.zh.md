# dsh-plugin-cursor-plan

[English](README.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）用的 cordis 插件：注册一个**只读**工具 `cursor_plan`，让 harness 里的模型能列出 / 读取 Cursor（编辑器）Plan 模式产出的 `*.plan.md` 计划文件。

- 纯 ESM，零依赖，只用 `node:fs` / `node:path` / `node:os`
- 不 import 任何 `@deepseek-ai/*`，按 dsh-tools 的工具契约实现
- 只读：不写、不改、不删任何文件（本插件唯一的写操作方是 harness 的会话日志，与本插件无关）

## 安装

### 一行安装（git 源，推荐）

```bash
dsh plugin --profile web add "github:eppen/dsh-plugin-cursor-plan#main"
```

`dsh plugin` 会在 profile 目录里跑 `pnpm add`，装完后自动把本包（声明了 `dsh.bundle`）挂进 profile 的 bundle 层栈，无需手改 `cordis.patch.yml`。然后**重启** `dsh web` 生效（web profile 的 `hmr` 被 `dsh-web-app` patch 成 `disabled: true`，改插件不会热加载）。

> 需要本机装有 `pnpm`（`dsh plugin` 是 pnpm 转发器）。

### 本地开发（file:/// 直挂）

不装进 profile 的 `node_modules`，直接把源码挂进用户层 patch。把下面这一段插进 `~/.dsh/profiles/web/cordis.patch.yml`（该文件本身是一个 YAML 数组）：

```yaml
- insert:
    - id: cursor-plan
      name: 'file:///D:/Tools/dsh-plugin-cursor-plan/index.mjs'
```

然后**重启** `dsh web`。

用 `file:///` 是有原因的：cordis 的 loader 对**不以 `.` 开头**的 specifier 直接 `import(name)`，裸写 `D:/...` 会被当成包名而失败。

> 两种方式二选一：bundle 安装后请删掉用户层里同 `id` 的 `file:///` insert（用户层在 bundle 层之后应用，会覆盖它）。

### 验证

```bash
dsh --profile web --dump-config | grep -A3 cursor-plan
```

期望看到 `id: cursor-plan` 与 `name: 'dsh-plugin-cursor-plan'`（bundle 安装）或 `name: 'file:///...'`（本地直挂），并且 `id: tools`、`id: plan-mode` 等原有节点仍在。

## 卸载

- bundle 安装：`dsh plugin --profile web remove dsh-plugin-cursor-plan`，重启 `dsh web`
- 本地直挂：删掉 `cordis.patch.yml` 里那段 `insert`（数组重新变回 `[]` 也可以），重启 `dsh web`

## 工具签名

名字：`cursor_plan`

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `action` | `"list"` \| `"read"` | 是 | 列出 / 读取 |
| `match` | string | 否 | `list` 时按 name / overview / 文件名做**不区分大小写**子串过滤 |
| `limit` | integer | 否 | `list` 时最多返回条数，默认 `20`，硬上限 `100`（超出按 100 处理，`<=0` 回落到 20） |
| `file` | string | 否 | `read` 时用：计划绝对路径，必须落在下面的来源目录之内 |
| `basename` | string | 否 | `read` 时用：计划文件名（如 `Plan-642d0fd6.plan.md`），或用 `list` 返回的 `name` |

`read` 的 `file` 与 `basename` 二选一；两个都给时以 `file` 为准。

返回给模型的是文本，形如：

```
Cursor plans: 20/1082 (limit 20)
roots: C:\Users\<你>\.cursor\plans | D:\work\proj\.cursor\plans
1. [home] 计划名 — overview 摘要 (文件名.plan.md, 2026-11-18 11:33)
   file: C:\Users\<你>\.cursor\plans\文件名.plan.md
… 1062 more not shown; narrow with match or raise limit (max 100)
```

`read` 返回 `name` / `overview` / `todos` 清单（`[status] id: content`）与正文 Markdown；正文超过 20000 字符会截断并给出提示。

## 来源目录（白名单）

只扫描、只允许读这两个位置：

1. `~/.cursor/plans` —— scope `home`
2. 当前**会话工作目录**下的 `.cursor/plans` —— scope `workspace`。会话目录取自 dsh 的 `workingDirectory` 服务（会话里切换目录后即时生效）；该服务不可用时（工具被程序化直接调用、未挂载该服务）回落到 dsh 进程启动目录 `process.cwd()`。两个根解析到同一目录时会去重：`roots` 只显示一份，列表也不会重复。

`read` 的路径校验：`path.resolve(file)` 后用 `path.relative` 判定必须位于上面某个目录**之内**；`..` 穿越、软链之外的任意路径一律拒绝，返回 `error: "path-not-allowed"`。

解析规则要点：

- frontmatter 允许被一行前导 HTML 注释（Cursor 写的 `<!-- uuid -->`）和空行隔开 —— 真实文件就是这种形态
- frontmatter 没有收尾 `---` 时，整份文件当正文，不吞内容
- `todos` 支持 `[]` 空数组、`- id/content/status` 缩进列表；`overview` 支持 `|` / `>` 块标量
- 单文件读取上限 200KB（超过返回 `error: "too-big"`）；列表只读每个文件头部 32KB

错误码（都写进规范值，不抛异常）：`bad-action` / `path-not-allowed` / `not-found` / `ambiguous` / `not-file` / `too-big` / `read-failed`。

## 发布到插件市场

dsh **没有官方市场**。Web UI 的 **Discover** 标签页只列用户自己添加的**索引源**——官方文档 `docs/user/guide/plugin-market.md` 原话："DSH ships no index source"。插件索引就是一份 UTF-8 JSON（**format 1**），列出可安装 bundle 的标题、图标、作者与版本，由任意静态站点托管。官方 README 唯一给出的可发现性渠道，是**单数**的 `dsh-plugin` GitHub topic。

本包两条渠道都配好了：

- `package.json` 声明了 `dsh.bundle.patch`，且**没有** `"private": true`（生成器会跳过设了它的 git 源包）
- `engines.dsh` 声明兼容范围
- `locale/en.json` / `locale/zh.json` 提供市场卡片标题与描述
- `market/index.json` 是可直接托管的 format 1 索引；仓库已带 `dsh-plugin` topic

### 本仓库的索引

`market/index.json` 由 `package.json` + git tag 生成：

```bash
npm run build:index     # node scripts/build-index.mjs
npm run check:index     # 离线逐条检查 format 1 规则
```

每个版本都钉在 40 位 commit 上（`source.type: "git"`），安装规格是 `git+https://github.com/eppen/dsh-plugin-cursor-plan.git#<commit>`。**打完 tag 再生成索引，不要反过来**——否则某个版本会指向一份 `package.json` 还是旧版本号的 commit。

`npm run check:index` 只是官方规则的本地实现；真正的校验器（`@deepseek-ai/dsh-plugin-market-index`）在 dsh 的 `app.asar` 里跑，端到端确认只有一条：在 Discover 里加 URL 看能不能列出来。本索引已用该包的 `parseMarketIndex` 验过。

### 托管

图标内联为约 0.5 KB 的 `data:` URL，所以索引是自包含的单个文件，任意静态托管都行：

| 托管方式 | 加为索引源的 URL |
|---|---|
| jsDelivr 直读 GitHub（免配置） | `https://cdn.jsdelivr.net/gh/eppen/dsh-plugin-cursor-plan@main/market/index.json` |
| GitHub Pages（仓库 Settings → Pages） | `https://eppen.github.io/dsh-plugin-cursor-plan/market/index.json` |
| 自有站点 / 对象存储 | 任何能返回 `market/index.json` 的 https 地址 |

dsh 给一个索引源只有 15 秒，能走 CDN 就别用慢源。打 tag 后 URL 可钉版本：`.../@v0.1.2/market/index.json`（从 `v0.1.2` 起，`market/index.json` 也进了该版本自己的源码树，装下去拿到的 commit 里就带着它发布时的那份索引）。

### 用户侧

1. Plugins → **Experimental plugins** → 开启 **Custom plugin indexes**
2. **Discover** → **Add index source** → 粘贴上面的 URL
3. 选卡片 → **Install** → 确认来源 → 重启 `dsh web`

### 其他渠道

- **`dsh-plugin` topic**（单数——官方 README 要的不是复数的 `dsh-plugins`）。所有自动扫描器读的是它；npm 的 `keywords` **不会**替你设置 GitHub topic。
- **[`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)**：多数市场消费的策展列表，`dsh-market` / `dshmarket` 只读它的 `plugins.json`、其它来源一律拒绝，所以想进这些市场只能走这里。投稿 = 一个 PR 加 `data/plugins/<owner>__<repo>.yml`（不要往市场应用仓库提条目）。
- 另有一批市场实时扫 `topic:dsh-plugin`，无需任何投稿。

## 本地开发 / 自测

```bash
cd /d/Tools/dsh-plugin-cursor-plan
node --test test/                 # 23 个用例：13 解析层 + 10 index/工作区根
node -e "import('./index.mjs').then(m=>console.log(m.name, Object.keys(m.cursorPlanTool)))"
```

不用真的起 dsh 也能试工具：

```bash
node -e "
import('./index.mjs').then(async (m) => {
  const t = m.cursorPlanTool;
  const v = await t.execute({ action: 'list', match: 'plan', limit: 3 });
  console.log(t.output.render({ action: 'list' }, v)[0].text);
});"
```

## 与 dsh 内置能力的边界

- 本插件**不**联动 harness 自带的 `plan-mode`（`exit_plan_mode` / `/plan` 命令），也不注入任何 system prompt；它只是多一个读取 Cursor 计划的只读工具。
- 不做 Cursor 会话（composer / chat 记录）读取，只认 `*.plan.md`。
- 不做任何写入：新建 / 修改 / 删除计划、回写 todos 状态都不在本插件范围内。
